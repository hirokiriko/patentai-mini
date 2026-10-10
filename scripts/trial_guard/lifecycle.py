"""Transport-independent, journalled firewall-window controller.

This module has no credentials, network client, process launcher or live default.
Transports must enforce the supplied total timeout and return exact operation
proofs. A real transport is NOT enabled by passing the offline tests.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import uuid


class Denied(Exception):
    pass


class Conflict(Exception):
    pass


def parse(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone_required')
    return result.astimezone(timezone.utc)


def initial(*, at, rule_id, lifecycle_id, guardian_pid, independent_guard_verified,
            cleanup_seconds=None, cloud_guard=None, ready_seconds=300, cleanup_strategy='handoff'):
    at = parse(at)
    if cleanup_seconds is not None and not 0 < cleanup_seconds <= 5 * 3600:
        raise ValueError('invalid_early_cleanup')
    if cleanup_strategy not in ('single_job','handoff','rehearsal'):
        raise ValueError('cleanup_strategy')
    if cleanup_strategy=='rehearsal':
        if cloud_guard is None or parse(cloud_guard['job_started_at'])!=at or parse(cloud_guard['job_deadline'])!=at+timedelta(seconds=300):
            raise ValueError('rehearsal_window')
        return {'version':0,'owner_access':None,'lifecycle_id':lifecycle_id,'rule_id':rule_id,'cleanup_strategy':'rehearsal','prepared_at':at.isoformat(),
            'cleanup_at':at.isoformat(),'deadline':(at+timedelta(seconds=300)).isoformat(),'ready_until':(at+timedelta(seconds=300)).isoformat(),
            'last_now':at.isoformat(),'cloud_guard':deepcopy(cloud_guard),'guardian_kind':'azure_job','guardian_pid':None,
            'independent_guard_verified':True,'status':'rehearsal','close_requested':True,'usage_allowed':False,'put':None,'delete':None,
            'delete_attempts':0,'blocked':None,'cleanup_responsibility_retained':False,'tick_count':0}
    if cleanup_strategy == 'single_job' and (cloud_guard is None or cleanup_seconds != 600 or
            parse(cloud_guard['job_started_at']) != at or parse(cloud_guard['job_deadline']) != at+timedelta(minutes=30)):
        raise ValueError('single_job_window')
    result = {'version': 0,'owner_access':None, 'lifecycle_id': lifecycle_id, 'rule_id': rule_id, 'cleanup_strategy':cleanup_strategy,
            'prepared_at': at.isoformat(), 'cleanup_at': (at + timedelta(seconds=cleanup_seconds or 5*3600)).isoformat(),
            'deadline': (at + timedelta(hours=6)).isoformat(), 'last_now': at.isoformat(),
            'guardian_pid': guardian_pid, 'independent_guard_verified': independent_guard_verified,
            'status': 'prepared', 'close_requested': False, 'usage_allowed': False,
            'put': None, 'delete': None, 'delete_attempts': 0, 'blocked': None,
            'cleanup_responsibility_retained': True, 'tick_count': 0}
    if cloud_guard is not None:
        required = {'execution_id','replica_name','image_digest','principal_id','nonce',
                    'job_started_at','job_deadline'}
        if set(cloud_guard) != required or not all(isinstance(v,str) and v for v in cloud_guard.values()):
            raise ValueError('invalid_cloud_guard_binding')
        if not 0 < ready_seconds <= 300 or cleanup_seconds is None:
            raise ValueError('cloud_deadlines_required')
        job_start, job_end = parse(cloud_guard['job_started_at']), parse(cloud_guard['job_deadline'])
        if not (job_start <= at < job_end and timedelta(0) < job_end-job_start <= timedelta(minutes=30)
                and at+timedelta(seconds=cleanup_seconds) <= job_end-timedelta(minutes=15)
                and ready_seconds <= cleanup_seconds):
            raise ValueError('cloud_job_cleanup_margin')
        result.update(guardian_kind='azure_job', cloud_guard=deepcopy(cloud_guard),
            ready_until=(at+timedelta(seconds=ready_seconds)).isoformat())
    return result


def may_use(snapshot, *, at, lifecycle_id):
    """Every DB/work request must check this short lease, never the boolean alone."""
    try:
        current = parse(at)
        return (snapshot['lifecycle_id'] == lifecycle_id and snapshot['usage_allowed'] is True
                and snapshot['close_requested'] is False and not snapshot['blocked']
                and parse(snapshot['use_lease_from']) <= current < parse(snapshot['use_lease_until'])
                and current < parse(snapshot['cleanup_at']))
    except (KeyError, TypeError, ValueError):
        return False


class Controller:
    """Every public operation is serialized by the journal's OS-backed lock.

    Journal protocol: nonblocking locked(), load(), save(candidate, expected_version).
    Clock protocol: utc(), monotonic(). Guardian protocol: callable returning
    alive/pid/lifecycle_id/at/process_handle_verified. Transport protocol:
    send/poll/recover/inspect with a TOTAL timeout, no internal write retries.
    """
    def __init__(self, journal, transport, clock, guardian, actor_id=None):
        self.journal, self.transport, self.clock, self.guardian = journal, transport, clock, guardian
        self.actor_id = actor_id
        self.anchor_wall, self.anchor_mono = clock.utc(), clock.monotonic()

    def _save(self, **fields):
        candidate = deepcopy(self.state)
        candidate.update(fields)
        # Persist the newest observed time, including time spent inside this
        # tick. A restarted process must not roll back a lease's high-water mark.
        candidate['last_now'] = max(parse(candidate['last_now']), self.at).isoformat()
        candidate['version'] += 1
        # A failed durable save leaves self.state unchanged, so no network write
        # can follow a failed intent commit.
        self.journal.save(candidate, expected_version=self.state['version'])
        self.state = candidate

    def _load(self):
        self.state = self.journal.load()
        s = self.state
        if s.get('cleanup_strategy')=='rehearsal':raise Denied('rehearsal_read_only')
        if s.get('writer_actor') is not None and s['writer_actor'] != self.actor_id:
            raise Denied('writer_fenced')
        prepared, cleanup, deadline = map(parse, (s['prepared_at'], s['cleanup_at'], s['deadline']))
        if not prepared < cleanup <= deadline - timedelta(minutes=30):
            raise ValueError('invalid_cleanup_margin')
        if not timedelta(0) < deadline - prepared <= timedelta(hours=6):
            raise ValueError('window_exceeds_approval')
        if s.get('guardian_kind') == 'azure_job':
            job_start, job_end = map(parse,(s['cloud_guard']['job_started_at'],s['cloud_guard']['job_deadline']))
            ready = parse(s['ready_until'])
            if not (job_start <= prepared < job_end and timedelta(0) < job_end-job_start <= timedelta(minutes=30)
                    and cleanup <= job_end-timedelta(minutes=15)
                    and prepared < ready <= min(prepared+timedelta(minutes=5),cleanup)):
                raise ValueError('cloud_job_deadlines_changed')
            if s.get('cleanup_strategy') == 'single_job' and (prepared != job_start or cleanup != job_start+timedelta(minutes=10) or job_end != job_start+timedelta(minutes=30)):
                raise ValueError('single_job_window_changed')
        current = self.clock.utc()
        previous = parse(s['last_now'])
        elapsed = max(0, self.clock.monotonic() - self.anchor_mono)
        self.at = max(current, previous, self.anchor_wall + timedelta(seconds=elapsed))
        self.anchor_wall,self.anchor_mono=self.at,self.clock.monotonic()
        self.tick_end = self.clock.monotonic() + 20
        reason = None
        if current < previous:
            reason = 'clock_rollback'
        if s.get('guardian_kind') == 'azure_job' and s['put'] is None and self.at >= parse(s['ready_until']):
            reason = 'ready_expired'
        if self.at >= cleanup:
            reason = 'cleanup_cutoff'
        if self.at >= deadline:
            reason = 'deadline_expired'
        self._save(last_now=self.at.isoformat(), tick_count=s['tick_count'] + 1,
                   close_requested=s['close_requested'] or reason is not None,
                   usage_allowed=False,
                   attention=reason or s.get('attention'))

    def _refresh(self):
        self.at = max(self.at, self.clock.utc(), self.anchor_wall + timedelta(seconds=max(0, self.clock.monotonic() - self.anchor_mono)))
        self.anchor_wall,self.anchor_mono=self.at,self.clock.monotonic()
        if (self.state.get('guardian_kind') == 'azure_job' and self.state['put'] is None
                and self.at >= parse(self.state['ready_until'])):
            self._save(close_requested=True, usage_allowed=False, attention='ready_expired')
        if self.at >= parse(self.state['cleanup_at']):
            self._save(close_requested=True, usage_allowed=False,
                       attention='deadline_expired' if self.at >= parse(self.state['deadline']) else 'cleanup_cutoff')

    def _guard_ok(self):
        try:
            g = self.guardian()
            self.at = max(self.at, self.clock.utc(), self.anchor_wall + timedelta(seconds=max(0, self.clock.monotonic() - self.anchor_mono)))
            age = (self.at - parse(g['at'])).total_seconds()
            if self.state.get('guardian_kind') == 'azure_job':
                expected = self.state['cloud_guard']
                return (self.state['independent_guard_verified'] is True
                    and g.get('kind') == 'azure_job' and g.get('alive') is True
                    and g.get('runtime_verified') is True
                    and all(g.get(k) == v for k,v in expected.items())
                    and g.get('lifecycle_id') == self.state['lifecycle_id']
                    and self.at < parse(expected['job_deadline'])
                    and 0 <= age <= 15)
            return (self.state['independent_guard_verified'] is True and g['alive'] is True
                    and g['process_handle_verified'] is True
                    and g['pid'] == self.state['guardian_pid']
                    and g['lifecycle_id'] == self.state['lifecycle_id'] and 0 <= age <= 30)
        except Exception:
            return False

    def _budget(self):
        self._refresh()
        total = min(20, self.tick_end - self.clock.monotonic())
        # Before expiry, no call may consume time beyond the absolute deadline.
        # After expiry this is a bounded remediation slice, NOT a new use window.
        remaining = (parse(self.state['deadline']) - self.at).total_seconds()
        if remaining > 0:
            total = min(total, remaining)
        if total <= 0:
            raise TimeoutError('tick_budget_exhausted')
        return total

    def _call(self, method, **values):
        budget = self._budget()
        if method == 'send' and values['operation']['method'] == 'PUT' and self.state['close_requested']:
            raise Denied('put_cutoff_before_transport')
        if (method == 'send' and values['operation']['method'] == 'PUT'
                and self.state.get('guardian_kind') == 'azure_job'
                and self.at >= parse(self.state['ready_until'])):
            self._save(close_requested=True,usage_allowed=False,attention='ready_expired')
            raise Denied('ready_cutoff_before_transport')
        if method=='send' and values['operation']['method']=='PUT' and self.state.get('cleanup_strategy')=='single_job':
            end=min(parse(self.state['ready_until']),parse(self.state['cleanup_at']),parse(self.state['guardian_ready']['at'])+timedelta(seconds=15))
            budget=min(budget,(end-self.at).total_seconds())
            if budget<=0:raise Denied('ready_send_budget_expired')
        if hasattr(self.transport,'observe'):self.transport.observe(self.at)
        begin = self.clock.monotonic()
        result = getattr(self.transport, method)(timeout=budget, **values)
        spent = self.clock.monotonic() - begin
        if spent > budget:
            self._save(close_requested=True, usage_allowed=False, attention='transport_timeout_contract_violation')
            raise TimeoutError('transport_total_timeout_exceeded')
        self.at = max(self.at, self.clock.utc(), self.anchor_wall + timedelta(seconds=self.clock.monotonic() - self.anchor_mono))
        if self.at >= parse(self.state['cleanup_at']):
            self._save(close_requested=True, usage_allowed=False,
                       attention='deadline_expired' if self.at >= parse(self.state['deadline']) else 'cleanup_cutoff')
        return result

    def _outcome(self, field, result):
        op = deepcopy(self.state[field])
        # A terminal observation must bind to the exact durable intent. An
        # adapter may not manufacture this from an unqualified resource GET.
        if (result.get('request_id') != op['request_id'] or
                result.get('rule_id') != self.state['rule_id'] or result.get('method') != op['method']):
            self._save(blocked='operation_proof_mismatch', close_requested=True, usage_allowed=False)
            return
        http = result.get('http')
        if http in (401, 403):
            self._save(blocked='authorization_denied', close_requested=True, usage_allowed=False)
            return
        if result.get('operation_url'):
            op['operation_url'] = result['operation_url']
            if result.get('operation_receipt'):
                op['operation_receipt'] = result['operation_receipt']
        terminal = result.get('terminal')
        if terminal in ('succeeded', 'failed', 'canceled'):
            if result.get('proof') not in ('write_response', 'operation_status', 'verified_activity_event'):
                self._save(blocked='terminal_proof_missing', close_requested=True, usage_allowed=False)
                return
            op.update(terminal=terminal, terminal_at=self.at.isoformat(), proof=result['proof'],
                      error_code=result.get('error_code') if result.get('error_code') == 'ServerIsBusy' else None)
            if field == 'delete' and terminal == 'failed' and op['error_code'] == 'ServerIsBusy':
                op['retry_after'] = (self.at + timedelta(seconds=15)).isoformat()
        self._save(**{field: op})

    def _single_ready(self):
        if self.state.get('cleanup_strategy') != 'single_job':
            return True
        try:
            g=self.state['cloud_guard']; r=self.state['guardian_ready']
            return (r['actor']==g['principal_id']+':'+g['execution_id'] and
                    r['lifecycle_id']==self.state['lifecycle_id'] and r['tick']>0 and
                    all(r.get(k)==v for k,v in g.items()) and
                    parse(self.state['prepared_at'])<=parse(r['at'])<=self.at and
                    0<=(self.at-parse(r['at'])).total_seconds()<=15 and
                    self.at<parse(self.state['ready_until']))
        except (KeyError,TypeError,ValueError):
            return False

    def _send(self, field):
        op = {'method': 'PUT' if field == 'put' else 'DELETE', 'request_id': str(uuid.uuid4()),
              'intent_at': self.at.isoformat(), 'terminal': None, 'operation_url': None}
        fields = {field: op, 'usage_allowed': False, 'status': 'creating' if field == 'put' else 'removing'}
        if field == 'delete':
            fields['delete_attempts'] = self.state['delete_attempts'] + 1
        self._save(**fields)
        if field == 'put':
            healthy = self._guard_ok()
            self._refresh()
            if not healthy or not self._single_ready() or self.state['close_requested'] or self.clock.monotonic() >= self.tick_end:
                # The intent was committed but transmission never started; this
                # is positively known locally and cannot be confused with loss
                # of a response after send.
                op.update(terminal='canceled', terminal_at=self.at.isoformat(),
                          proof='local_not_sent', sent=False)
                self._save(put=op, close_requested=True, usage_allowed=False,
                           attention='pre_send_conditions_changed')
                return
        try:
            response = self._call('send', operation=deepcopy(op), rule_id=self.state['rule_id'])
        except Denied:
            op.update(terminal='canceled', terminal_at=self.at.isoformat(), proof='local_not_sent', sent=False)
            self._save(**{field: op}, close_requested=True, usage_allowed=False, attention='pre_send_conditions_changed')
            return
        except (OSError, TimeoutError):
            self._save(status='recovery_pending', close_requested=True, usage_allowed=False,
                       attention=field + '_response_unknown')
            return
        self._outcome(field, response)

    def _resolve(self, field):
        op = self.state[field]
        if op is None or op['terminal'] is not None:
            return True
        try:
            method = 'poll' if op.get('operation_url') else 'recover'
            response = self._call(method, operation=deepcopy(op), rule_id=self.state['rule_id'])
        except (OSError, TimeoutError):
            self._save(status='recovery_pending', usage_allowed=False, close_requested=True,
                       attention=field + '_reconciliation_unavailable')
            return False
        self._outcome(field, response)
        if self.state[field]['terminal'] is None:
            self._save(status='recovery_pending', usage_allowed=False, close_requested=True,
                       attention=field + '_terminal_unconfirmed')
            return False
        return True

    def _inspect(self):
        try:
            value = self._call('inspect', rule_id=self.state['rule_id'], lifecycle_id=self.state['lifecycle_id'])
        except (OSError, TimeoutError):
            self._save(status='cleanup_pending', attention='readback_unavailable')
            return None
        if value.get('http') in (401, 403):
            self._save(blocked='authorization_denied', close_requested=True, usage_allowed=False)
            return None
        if value.get('rule') == 'foreign':
            self._save(blocked='ownership_or_settings_changed', close_requested=True, usage_allowed=False)
            return None
        if not (value.get('http') == 200 and value.get('rule') in ('owned', 'absent')
                and value.get('exact_http') == (200 if value.get('rule') == 'owned' else 404)):
            self._save(status='cleanup_pending', attention='readback_unconfirmed')
            return None
        try:
            fresh_after = max(parse(self.state[k]['terminal_at']) for k in ('put', 'delete')
                              if self.state[k] and self.state[k].get('terminal_at'))
        except ValueError:
            fresh_after = parse(self.state['prepared_at'])
        try:
            fresh = fresh_after <= parse(value['at']) <= self.at
        except (KeyError, TypeError, ValueError):
            fresh = False
        if not (fresh and value.get('rule_id') == self.state['rule_id']
                and value.get('lifecycle_id') == self.state['lifecycle_id']):
            self._save(blocked='readback_binding_or_time_mismatch', usage_allowed=False)
            return None
        if value.get('rule') == 'foreign' or value.get('existing_rules_unchanged') is not True or value.get('network_unchanged') is not True:
            self._save(blocked='ownership_or_settings_changed', close_requested=True, usage_allowed=False)
            return None
        return value

    def start(self):
        with self.journal.locked():
            self._load()
            if self.state['put'] is not None:
                raise Denied('durable_put_intent_already_exists')
            if self.state['blocked'] or self.state['close_requested'] or not self._guard_ok() or not self._single_ready():
                raise Denied('start_preconditions_failed')
            baseline = self._inspect()
            if (not baseline or baseline['rule'] != 'absent' or baseline.get('complete_list') is not True
                    or baseline.get('listed_absent') is not True or not baseline.get('server_ready')):
                raise Denied('exact_absent_baseline_required')
            self._send('put')
            return deepcopy(self.state)



    def request_close(self):
        with self.journal.locked():
            self._load()
            self._save(close_requested=True, usage_allowed=False)

    def tick(self):
        with self.journal.locked():
            self._load()
            if self.state['status'] == 'closed':
                return deepcopy(self.state)
            if self.state['blocked']:
                # Responsibility is retained; denied operations are never retried.
                self._save(usage_allowed=False, close_requested=True, status='attention_required')
                return deepcopy(self.state)
            if not self._guard_ok():
                self._save(close_requested=True, usage_allowed=False, attention='guardian_unhealthy')
            if (self.state.get('guardian_kind') == 'azure_job' and self.state['put'] is None
                    and not self.state['close_requested']):
                if self.at < parse(self.state['ready_until']):
                    self._save(status='ready_waiting', usage_allowed=False)
                    return deepcopy(self.state)
                self._save(close_requested=True, usage_allowed=False, attention='ready_expired')
            if not self._resolve('put') or self.state['blocked']:
                return deepcopy(self.state)
            if not self.state['close_requested'] and self.state['put'] and self.state['put']['terminal'] == 'succeeded':
                value = self._inspect()
                if (value and value['rule'] == 'owned' and value.get('complete_list') is True
                        and not self.state['close_requested'] and self._guard_ok()):
                    self._refresh()
                    if not self.state['close_requested']:
                        self._save(status='active', usage_allowed=True, use_lease_from=self.at.isoformat(),
                                   use_lease_until=min(self.at + timedelta(seconds=10), parse(self.state['cleanup_at'])).isoformat())
                else:
                    self._save(close_requested=True, usage_allowed=False)
                return deepcopy(self.state)
            self._save(usage_allowed=False, close_requested=True, status='cleanup_pending')
            if not self._resolve('delete') or self.state['blocked']:
                return deepcopy(self.state)
            value = self._inspect()
            if value is None:
                return deepcopy(self.state)
            put, delete = self.state['put'], self.state['delete']
            if value['rule'] == 'owned' and (put is None or put.get('sent') is False):
                self._save(blocked='rule_appeared_without_our_send', attention='manual_ownership_review_required')
                return deepcopy(self.state)
            put_proven = put is None or put['terminal'] is not None
            deletion_proven = (put is None or put['terminal'] != 'succeeded') if delete is None else delete['terminal'] == 'succeeded'
            if (put_proven and deletion_proven and value['rule'] == 'absent'
                    and value.get('exact_http') == 404 and value.get('complete_list') is True
                    and value.get('listed_absent') is True):
                self._save(status='closed', usage_allowed=False, rule_absent=True,
                           closed_at=self.at.isoformat(), closure_evidence=deepcopy(value), cleanup_responsibility_retained=False)
                return deepcopy(self.state)
            if value['rule'] != 'owned' or not value.get('server_ready') or value.get('complete_list') is not True:
                return deepcopy(self.state)
            if delete is None:
                if put is not None:
                    self._send('delete')
            elif delete['terminal'] == 'failed' and delete.get('error_code') == 'ServerIsBusy':
                if self.state['delete_attempts'] >= 8:
                    self._save(blocked='confirmed_busy_retry_limit', attention='manual_cleanup_required')
                elif self.at >= parse(delete['retry_after']):
                    self._send('delete')
            elif delete['terminal'] in ('failed', 'canceled'):
                self._save(blocked='delete_terminal_failure', attention='manual_cleanup_required')
            return deepcopy(self.state)


class Supervisor:
    """One nonblocking supervisor step; no attempt count abandons ownership.

    A validated external launcher must schedule these steps. It must remain alive
    independently of the interactive executor and never infer success from the
    number of attempts, a timeout, or loss of the controller process.
    """
    def __init__(self, controller, controller_alive, report):
        self.controller = controller
        self.controller_alive = controller_alive
        self.report = report

    def _report(self, value):
        try:
            self.report(value)
            return True
        except Exception:
            # Reporting is secondary to cleanup; failure must not kill the loop.
            return False

    def step(self):
        try:
            try:
                alive = self.controller_alive() is True
            except Exception:
                alive = False
            if not alive:
                self.controller.request_close()
            state = self.controller.tick()
            closed = state['status'] == 'closed'
            reported = self._report({'status': state['status'], 'closed': closed,
                         'cleanupResponsibilityRetained': not closed,
                         'attention': state.get('attention'), 'blocked': state.get('blocked')})
            return {'continue': not closed or not reported,
                    'delay_seconds': 5 if state.get('close_requested') or not reported else 2,
                    'reporting_failed': not reported}
        except Exception as error:
            reported = self._report({'status': 'supervisor_retry_pending', 'closed': False,
                         'cleanupResponsibilityRetained': True, 'errorClass': type(error).__name__})
            return {'continue': True, 'delay_seconds': 5, 'reporting_failed': not reported}
