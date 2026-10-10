"""Persistent Local OWNER supervisor. No network or credential creation defaults.

The guardian remains the only recovery writer. This supervisor can initialize,
open once, heartbeat and request closure; it never retries an uncertain write.
Worker-side permit/EOF watchdogs remain necessary while this loop awaits I/O.
"""
import json
import os
import re
import uuid
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from .adapters import digest, encoded
from .lifecycle import Denied, parse, may_use


class Receipt:
    """Private append-only fsynced, hash-chained journal + actual OS writer lock.

    A crashed process releases the OS lock. Resume is cleanup-only, never a new
    job, firewall opening, bootstrap or DB command. The chain rejects truncation
    of an individual record and changed configuration; full-file backup restore
    still requires the operator's original cloud journal, never fresh execution.
    """
    def __init__(self,directory,expected_directory_digest,configuration_digest):
        p=Path(directory)
        if not p.is_absolute() or p.is_symlink() or not p.is_dir() or str(p.resolve())!=str(p):raise Denied('receipt_directory')
        if digest(str(p))!=expected_directory_digest:raise Denied('receipt_directory_binding')
        self.path=p/'trial-session.jsonl';self.lock_path=p/'trial-session.lock'
        if self.path.is_symlink() or self.lock_path.is_symlink():raise Denied('receipt_symlink')
        self.lock=open(self.lock_path,'a+b');self.lock.seek(0);self.lock.write(b'0');self.lock.flush();self.lock.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.lock.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except Exception:
            self.lock.close();raise Denied('concurrent_writer') from None
        try:
            self.records=[];self.previous='0'*64
            if self.path.exists():
                if self.path.stat().st_size>16*1024*1024:raise Denied('receipt_limit')
                raw=self.path.read_bytes()
                if raw and not raw.endswith(b'\n'):raise Denied('receipt_partial_record')
                for line in raw.splitlines():
                    row=json.loads(line);proof=row.pop('hash',None)
                    if row.get('sequence')!=len(self.records) or row.get('previous')!=self.previous or digest(row)!=proof:raise Denied('receipt_chain')
                    self.previous=proof;self.records.append(row)
            if self.records and self.records[0].get('value')!={'configuration_digest':configuration_digest}:raise Denied('receipt_configuration')
            self.stream=open(self.path,'ab',buffering=0)
            if not self.records:self.append('configuration',{'configuration_digest':configuration_digest})
        except Exception:
            self.lock.close();raise

    def append(self,event,value=None):
        if len(self.records)>=15000 or not re.fullmatch('[a-z_]{1,40}',event):raise Denied('receipt_limit')
        row={'sequence':len(self.records),'previous':self.previous,'event':event,'value':value}
        proof=digest(row);self.stream.write(encoded({**row,'hash':proof})+b'\n');os.fsync(self.stream.fileno())
        self.previous=proof;self.records.append(row)

    def find(self,event):return [r['value'] for r in self.records if r['event']==event]
    def count(self,kind):return sum(r['value'].get('kind')==kind for r in self.records if r['event']=='request')
    def consume(self,kind,limit):
        if self.count(kind)>=limit:raise Denied('request_budget')
        self.append('request',{'kind':kind})
    def close(self):self.stream.close();self.lock.close()


def closure_proven(s):
    """A closed flag, GET404 or worker exit alone is not a cleanup receipt."""
    try:
        if s['status']!='closed' or s['usage_allowed'] or s['cleanup_responsibility_retained'] or not s['rule_absent']:return False
        p,d=s['put'],s['delete'];e=s['closure_evidence']
        for op in (p,d):
            if op is not None and (op['terminal'] not in ('succeeded','failed','canceled') or op.get('proof') not in
                    ('write_response','operation_status','verified_activity_event','local_not_sent')):return False
        if p is not None and p['terminal']=='succeeded' and (d is None or d['terminal']!='succeeded'):return False
        after=max([parse(s['prepared_at'])]+[parse(op['terminal_at']) for op in (p,d) if op])
        return (e['rule']=='absent' and e['http']==200 and e['exact_http']==404 and e['complete_list'] is True and
            e['listed_absent'] is True and e['existing_rules_unchanged'] is True and e['network_unchanged'] is True and
            e['rule_id']==s['rule_id'] and e['lifecycle_id']==s['lifecycle_id'] and after<=parse(e['at'])<=parse(s['closed_at']))
    except (KeyError,TypeError,ValueError):return False


class Workflow:
    """One execution: start -> prepare -> DB work -> remove -> prove -> handoff.

    Starter protocol: start(request_id), recover(request_id,execution_id).
    Session factory accepts verified runtime, returns persistent OwnerSession.
    Worker protocol: start(window,permit), permit(permit), poll(), stop()->bool.
    poll returns None while running, True only on positive complete receipt.
    """
    def __init__(self,receipt,starter,session_factory,worker,clock,sleep,report=lambda _:None):
        self.r,self.starter,self.session_factory,self.worker=receipt,starter,session_factory,worker
        self.clock,self.sleep,self.report=clock,sleep,report
        self.wall,self.mono=clock.utc(),clock.monotonic()
        self.closing=False;self.worker_started=False;self.work_complete=False;self.worker_stopped=True
        self.interrupted=False;self.warned=False;self.session=None;self.failures=0
        self.result=None

    def now(self):
        actual=self.clock.utc();derived=self.wall+timedelta(seconds=max(0,self.clock.monotonic()-self.mono))
        if actual<self.wall:self.closing=True
        self.wall,self.mono=max(actual,derived,self.wall),self.clock.monotonic()
        return self.wall

    def interrupt(self):
        self.interrupted=True;self.closing=True
        # No network from a signal handler. Worker also has independent EOF and
        # absolute permit watchdogs, so blocked network cannot extend DB access.

    def _event(self,event,value=None):
        self.r.append(event,value)
        try:self.report({'status':event})
        except Exception:pass

    def _stop(self):
        if self.worker_started and not self.worker_stopped:
            self.worker_stopped=self.worker.stop() is True
            if self.worker_stopped:self._event('worker_stopped')
        return self.worker_stopped

    def _abort(self):
        self.closing=True
        try:self._stop()
        except Exception:self.worker_stopped=False
        if self.session and not self.r.find('close_intent'):
            self._event('close_intent')
            try:self.session.action('close');self._event('close_ack')
            except Exception:self._event('close_unknown')

    def run(self):
        resume=bool(self.r.find('start_intent'))
        if resume:self.closing=True  # Resume is cleanup-only even after a clean child exit.
        request_id=self.r.find('start_intent')[0]['request_id'] if resume else str(uuid.uuid4())
        if not resume:self._event('start_intent',{'request_id':request_id})
        try:
            if resume:
                saved=self.r.find('start_ack');runtime=self.starter.recover(request_id,saved[-1]['execution_id'] if saved else None)
            else:
                try:runtime=self.starter.start(request_id)
                except Exception:
                    self.closing=True;self._event('start_unknown');runtime=self.starter.recover(request_id,None)
            self._event('start_ack',{'execution_id':runtime['execution_id'],'runtime_digest':digest(runtime),'runtime':deepcopy(runtime)})
            start=parse(runtime['job_started_at']);end=parse(runtime['job_deadline'])
            if end-start!=timedelta(minutes=30) or self.now()<start or (not self.closing and self.now()>=end):raise Denied('job_window')
            self.end=end;self.cutoff=start+timedelta(minutes=10)
            self.session=self.session_factory(runtime,self.closing)
            self.expected=deepcopy(self.session.initial)
            if not self.r.find('initialize_intent') and not self.closing:
                self._event('initialize_intent')
                try:self.session.action('initialize');self._event('initialize_ack')
                except Exception:self.closing=True;self._event('initialize_unknown')
            elif not self.r.find('initialize_ack'):self.closing=True
            self.next_heartbeat=self.now()+timedelta(seconds=2)
            if self.now()>=self.end:
                self.step()
                if self.result is not None:return self.result
            while self.now()<self.end:
                try:self.step()
                except (KeyboardInterrupt,SystemExit):self.interrupt();self._abort()
                except Exception:
                    self.failures+=1;self._abort()
                    # No raw errors, IDs, SQL or private payload enter reporting.
                    if self.failures==1:self._event('observation_unavailable')
                if self.result is not None:return self.result
                self.sleep(2 if not self.closing else 5)
            self._abort();self._event('deadline_unresolved',{'cleanup_responsibility_retained':True,'successor':False})
            return {'status':'cleanup_required','cleanupConfirmed':False,'workComplete':False}
        except (Exception,KeyboardInterrupt,SystemExit):
            self._abort();self._event('execution_unresolved',{'cleanup_responsibility_retained':True,'successor':False})
            return {'status':'cleanup_required','cleanupConfirmed':False,'workComplete':False}

    def _permit(self,s):
        if any(s.get(k)!=self.expected.get(k) for k in ('binding_digest','lifecycle_id','rule_id','cleanup_at','cloud_guard')):raise Denied('snapshot_binding')
        self.wall=max(self.now(),parse(s['last_now']))
        if not may_use(s,at=self.now().isoformat(),lifecycle_id=self.expected['lifecycle_id']):return None
        until=parse(s['use_lease_until']);begin=parse(s['use_lease_from'])
        if until-begin>timedelta(seconds=10) or until>self.cutoff or until-self.now()<timedelta(seconds=3):return None
        return {'type':'permit','lifecycleId':s['lifecycle_id'],'bindingDigest':s['binding_digest'],
            'guardianNonce':s['cloud_guard']['nonce'],'useUntil':parse(s['cleanup_at']).isoformat().replace('+00:00','Z'),
            'permitUntil':until.isoformat().replace('+00:00','Z')}

    def step(self):
        now=self.now()
        if now>=self.end-timedelta(minutes=5) and not self.warned:
            self.warned=True;self._event('cleanup_deadline_warning')
        if self.interrupted or now>=self.cutoff:self.closing=True
        if self.worker_started and not self.worker_stopped:
            done=self.worker.poll()
            if done is not None:
                self.worker_stopped=True;self.work_complete=done is True
                self._event('work_complete' if self.work_complete else 'work_unknown');self.closing=True
        if self.closing:self._abort()
        action='heartbeat' if not self.closing and now>=self.next_heartbeat else 'status'
        if action=='heartbeat':
            self.r.consume('owner_heartbeat_attempt',1050);self.next_heartbeat=now+timedelta(seconds=2)
        value=self.session.action(action);s=value['snapshot']
        if s.get('blocked') or s.get('close_requested'):self.closing=True
        if s.get('status')=='closed':
            self._abort()
            if not closure_proven(s):raise Denied('closure_unproven')
            if not self.worker_stopped:raise Denied('worker_stop_unconfirmed')
            self._event('absence_confirmed',{'evidence_digest':digest(s['closure_evidence']),'journal_version':s['version']})
            self._event('handoff_complete' if self.work_complete else 'closed_work_incomplete',
                {'cleanup_responsibility_retained':False,'successor':False})
            self.result={'status':'completed' if self.work_complete else 'reconciliation_required','cleanupConfirmed':True,'workComplete':self.work_complete}
            return
        if self.closing:return
        if not self.r.find('open_intent') and s.get('guardian_ready'):
            self._event('open_intent')
            try:self.session.action('open');self._event('open_ack')
            except Exception:self.closing=True;self._event('open_unknown');self._abort()
            return
        permit=self._permit(s)
        if not permit:return
        if not self.worker_started:
            if not self.r.find('open_ack') or self.r.find('work_intent'):raise Denied('work_resume_denied')
            self._event('work_intent')
            # Mark before spawn: if startup raises after creating the process,
            # stop() must still be called and no second spawn is permitted.
            self.worker_started=True;self.worker_stopped=False
            window={'lifecycleId':s['lifecycle_id'],'bindingDigest':s['binding_digest'],'guardianNonce':s['cloud_guard']['nonce'],
                'ruleId':s['rule_id'],'journalUrl':self.session.journal.url,
                'jobStartedAt':parse(s['cloud_guard']['job_started_at']).isoformat().replace('+00:00','Z'),
                'useUntil':parse(s['cleanup_at']).isoformat().replace('+00:00','Z')}
            self.worker.start(window,permit)
        else:self.worker.permit(permit)
