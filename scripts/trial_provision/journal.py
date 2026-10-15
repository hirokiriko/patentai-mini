"""OWNER-private durable intents and one lifetime control-request allowance.

No network, token, credential creation, implicit resume, refund or resend. The
directory must be the previously approved OWNER recovery directory. File names
are fixed; current-user-only ACLs are applied before any bytes are written.
"""
import json
import os
import re
import uuid
import threading
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from .private_io import create_owner_file, verify_owner_file


FORBIDDEN_KEYS = frozenset(('secrettext', 'accesstoken', 'refreshtoken',
    'password', 'clientsecret', 'authorization', 'connectionstring', 'privatekey'))


def no_secret(value):
    if isinstance(value, dict):
        if any(str(k).lower().replace('_', '') in FORBIDDEN_KEYS for k in value):
            raise Denied('secret_in_receipt')
        for v in value.values(): no_secret(v)
    elif isinstance(value, (list, tuple)):
        for v in value: no_secret(v)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise Denied('receipt_json_type')


class Journal:
    """Hash chain and OS writer lock; a partial/changed chain cannot be reset."""
    def __init__(self, directory, directory_digest, binding, *, name='trial-provision', require_existing=False):
        self.mutex = threading.RLock()
        if name not in ('trial-provision', 'trial-control-budget','trial-provision-next','trial-provision-successor','trial-provision-successor-v3','trial-provision-successor-v4','trial-provision-successor-v5','trial-provision-successor-v6'):
            raise Denied('journal_name')
        directory = Path(directory)
        if (not directory.is_absolute() or not directory.is_dir() or directory.is_symlink()
            or str(directory.resolve()) != str(directory) or digest(str(directory)) != directory_digest):
            raise Denied('journal_directory')
        self.path = directory/(name+'.jsonl')
        lock_path = directory/(name+'.lock')
        if self.path.is_symlink() or lock_path.is_symlink(): raise Denied('journal_symlink')
        self.lock = self.stream = None
        try:
            for path in (lock_path, self.path):
                if not path.exists():
                    if require_existing: raise Denied('journal_missing')
                    try:
                        fd = create_owner_file(path)
                        os.close(fd)
                    except FileExistsError: pass
                verify_owner_file(path)
            self.lock = lock_path.open('r+b', buffering=0)
            self.lock.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError: raise Denied('concurrent_writer') from None
            self.lock.write(b'0'); self.lock.flush(); self.lock.seek(0)
            if self.path.stat().st_size > 16*1024*1024: raise Denied('journal_limit')
            raw = self.path.read_bytes()
            if require_existing and not raw: raise Denied('journal_empty')
            if raw and not raw.endswith(b'\n'): raise Denied('journal_partial')
            self.records, self.previous = [], '0'*64
            for line in raw.splitlines():
                row = json.loads(line); proof = row.pop('hash', None)
                if (row.get('sequence') != len(self.records) or row.get('previous') != self.previous
                    or digest(row) != proof): raise Denied('journal_chain')
                no_secret(row)
                self.records.append(row); self.previous = proof
            if self.records and (self.records[0]['event'] != 'binding' or self.records[0]['value'] != binding):
                raise Denied('journal_binding_changed')
            self.stream = self.path.open('r+b', buffering=0)
            self.stream.seek(0, os.SEEK_END)
            if not self.records: self.append('binding', binding)
        except BaseException:
            self.close(); raise

    def append(self, event, value):
        with self.mutex:
            if not re.fullmatch('[a-z_]{1,40}', event) or len(self.records) >= 15000:
                raise Denied('journal_limit')
            no_secret(value)
            row = {'sequence':len(self.records), 'previous':self.previous,
                   'event':event, 'value':deepcopy(value)}
            proof = digest(row); raw = encoded({**row, 'hash':proof})+b'\n'
            if self.path.stat().st_size+len(raw) > 16*1024*1024: raise Denied('journal_limit')
            if self.stream.write(raw) != len(raw): raise Denied('journal_short_write')
            os.fsync(self.stream.fileno())
            self.records.append(row); self.previous = proof

    def values(self, event):
        with self.mutex:return [deepcopy(r['value']) for r in self.records if r['event']==event]

    def allocate_id(self, slot):
        if not re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,63}', slot): raise Denied('allocation_slot')
        old = [v for v in self.values('allocation') if v['slot']==slot]
        if old: return old[0]['id']
        if len(self.values('allocation')) >= 128: raise Denied('allocation_limit')
        value = str(uuid.uuid4())
        self.append('allocation', {'slot':slot, 'id':value})
        return value

    def fix_plan(self, plan):
        no_secret(plan)
        old = self.values('plan')
        if old:
            if old[0] != plan: raise Denied('plan_changed')
        else: self.append('plan', plan)

    def intent(self, op, at):
        if any(v['operation_id']==op['id'] for v in self.values('intent')):
            raise Denied('operation_already_attempted')
        value = {'operation_id':op['id'], 'request_digest':digest(op),
                 'method':op['method'], 'url':op['url'], 'deadline':op['deadline'],
                 'at':at, 'request_id':self.allocate_id('request_'+op['id'])}
        self.append('intent', value)
        return value

    def latest(self, operation_id):
        values = [v for v in self.values('progress') if v['operation_id']==operation_id]
        return values[-1] if values else None

    def checkpoint(self, op, receipt):
        no_secret(receipt)
        expected = digest(op)
        if (receipt.get('operation_id') != op['id'] or receipt.get('request_digest') != expected
            or receipt.get('state') not in ('pending', 'succeeded', 'failed', 'unknown')
            or not any(v['operation_id']==op['id'] and v['request_digest']==expected for v in self.values('intent'))):
            raise Denied('receipt_binding')
        old = self.latest(op['id'])
        if old:
            for key in ('operation_id', 'request_digest', 'object_id'):
                if old.get(key) is not None and receipt.get(key) != old[key]: raise Denied('receipt_identity_changed')
            if old.get('terminal') is True and old != receipt: raise Denied('terminal_receipt_changed')
            if old == receipt: return
        if receipt.get('state')=='succeeded' and (receipt.get('terminal') is not True
            or receipt.get('readback_verified') is not True): raise Denied('unverified_success')
        self.append('progress', receipt)

    def receipts(self):
        # An fsynced intent is an attempted write even when the process died
        # before receiving or checkpointing its acknowledgement. Resolvers must
        # see it so cleanup cannot fall back to stale pre-update properties.
        result = {v['operation_id']:{'operation_id':v['operation_id'],
            'request_digest':v['request_digest'],'state':'unknown','terminal':False,
            'write_terminal':False,'readback_verified':False,'created_by_run':False}
            for v in self.values('intent')}
        for value in self.values('progress'): result[value['operation_id']] = value
        return result

    def close(self):
        if self.stream is not None: self.stream.close(); self.stream = None
        if self.lock is not None: self.lock.close(); self.lock = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()


_PHASES=('fresh_read','publication','provision','run','cleanup')
_PURPOSES=('http','owner_token')
_PURPOSE_CAPS={'provision':{'http':170,'owner_token':10}}
_OWNER_PHASE_MAX=dict(zip(_PHASES,(24,24,180,42,120)))
_ORIGINAL_SEED={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}
_SCOPE_KEY=object()
def _budget_need(ok,reason):
    if not ok:raise Denied(reason)
def _nonnegative_int(value):return type(value) is int and value>=0

_HISTORY_SOURCE_SHA256='b02afe5570cc0999c243050378831b6665f5bc9ffc1a2d4a9bb633e5de21a13b'
_HISTORY_SOURCES=(('preflight.local.json','92a0d1d45bef5d58cd5b23cd51f2361321ddb0bc71ddedcc04e7f0c9136e32c9'),
    ('network-summary.local.json','7c6fdbac1c5e88195586ff84a82202b3b41482b30afd97b303d91ff983e87645'))

def validated_history_marker_indexes(records,*,binding,seed,directory):
    """Validate the one historical three-request debit without charging it again.

    The original producer stored intent, three ordinary requests, then complete
    at positions 1..5. Their source hashes are historical provenance; the source
    files may since have changed. This function performs no filesystem access.
    """
    starts=[i for i,r in enumerate(records) if r['event']=='history_debit_intent']
    ends=[i for i,r in enumerate(records) if r['event']=='history_debit_complete']
    _budget_need(all(not r['event'].startswith('history_') or r['event'] in
        ('history_debit_intent','history_debit_complete') for r in records),'budget_history_event')
    if not starts and not ends:return frozenset()
    _budget_need(starts==[1] and ends==[5],'budget_history_pair')
    _budget_need(seed==_ORIGINAL_SEED and all(type(v) is int for v in seed.values())
        and binding.get('source_sha256')==_HISTORY_SOURCE_SHA256,'budget_history_binding')
    start,end=records[1]['value'],records[5]['value']
    common={'source_sha256','subsequent_sources','kind','requests'}
    _budget_need(type(start) is dict and type(end) is dict and set(start)==common|{'start_count'}
        and set(end)==common|{'end_count'},'budget_history_schema')
    _budget_need(start['source_sha256']==_HISTORY_SOURCE_SHA256 and start['kind']=='owner_arm'
        and type(start['requests']) is int and start['requests']==3 and type(start['start_count']) is int and start['start_count']==128
        and type(end['requests']) is int and type(end['end_count']) is int and end['end_count']==131
        and {k:end[k] for k in common}=={k:start[k] for k in common},'budget_history_values')
    sources=start['subsequent_sources'];root=Path(directory)
    _budget_need(root.is_absolute() and type(sources) is list and len(sources)==2,'budget_history_sources')
    for item,(name,checksum) in zip(sources,_HISTORY_SOURCES):
        _budget_need(type(item) is dict and set(item)=={'path','sha256'} and type(item['path']) is str
            and item['sha256']==checksum,'budget_history_sources')
        path=Path(item['path'])
        _budget_need(path.is_absolute() and path.parent==root and path.name==name and '..' not in path.parts,'budget_history_sources')
    _budget_need(all(r['event']=='request' and r['value']=={'kind':'owner_arm'} for r in records[2:5]),'budget_history_requests')
    return frozenset((1,5))

class ControlBudget:
    """Original lifetime ledger with one append-only verified attempt plan."""
    LIMITS={'owner_arm':600,'owner_control_blob':3000,'heartbeat_blob':5250}
    def __init__(self,directory,directory_digest,binding,*,seed,require_existing=False):
        self.mutex=threading.RLock()
        _budget_need(isinstance(seed,dict) and set(seed)==set(self.LIMITS) and all(type(seed[k]) is int and 0<=seed[k]<=self.LIMITS[k] for k in seed),'budget_seed')
        self.seed=deepcopy(seed);self.binding=deepcopy(binding);self._seed_digest=digest(seed);self._binding_digest=digest(binding);self._verified=None;self._poisoned=False;self._closed=False
        self.journal=Journal(directory,directory_digest,{'binding':binding,'limits':self.LIMITS,'seed':seed},name='trial-control-budget',require_existing=require_existing)
        try:self._replay()
        except BaseException:self.close();raise
    def _assert_open(self):_budget_need(not self._closed and not self._poisoned,'budget_unavailable')
    def _validate_plan(self,plan,*,published_successor=False,amended=False,reused_images=False):
        from .attempt import REUSED_IMAGE_PURPOSE_CAPS
        purpose_caps=REUSED_IMAGE_PURPOSE_CAPS if reused_images else _PURPOSE_CAPS
        limits={**self.LIMITS,'owner_arm':631} if amended else self.LIMITS
        _budget_need(isinstance(plan,dict) and set(plan)=={'schema','attempt','limits','counts_before','phase_caps','unallocated','purpose_caps','budget_binding_sha256'}
            and type(plan['schema']) is int and plan['schema']==1 and isinstance(plan['attempt'],str) and re.fullmatch('[a-f0-9]{64}',plan['attempt']) is not None
            and plan['limits']==limits and plan['purpose_caps']==purpose_caps and plan['budget_binding_sha256']==digest(self.binding) and self.seed==_ORIGINAL_SEED,'budget_phase_plan')
        for field in ('counts_before','phase_caps','unallocated'):_budget_need(isinstance(plan[field],dict) and set(plan[field])==set(self.LIMITS),'budget_phase_plan')
        for kind,limit in limits.items():
            before,reserve,caps=plan['counts_before'][kind],plan['unallocated'][kind],plan['phase_caps'][kind]
            _budget_need(type(before) is int and self.seed[kind]<=before<=limit and _nonnegative_int(reserve) and isinstance(caps,dict) and set(caps)==set(_PHASES)
                and all(_nonnegative_int(v) for v in caps.values()) and sum(caps.values())+reserve<=limit-before,'budget_phase_allocation')
        owner_caps=plan['phase_caps']['owner_arm']
        _budget_need(all(owner_caps[phase]<=cap for phase,cap in _OWNER_PHASE_MAX.items()) and owner_caps['cleanup']==120
            and (plan['unallocated']['owner_arm']==0 if published_successor else plan['unallocated']['owner_arm']>=23),'budget_owner_reservation')
    def _blank_usage(self):return {kind:{phase:0 for phase in _PHASES} for kind in self.LIMITS}
    def _blank_purposes(self):return {kind:{phase:{purpose:0 for purpose in _PURPOSES} for phase in _PHASES} for kind in self.LIMITS}
    def _admit(self,kind,phase,purpose,*,verified=None):
        plan=self._plan
        _budget_need(plan is not None and kind in self.LIMITS and phase in _PHASES and purpose in _PURPOSES and (purpose!='owner_token' or kind=='owner_arm'),'budget_scope')
        limit=plan['limits'][kind]
        count=self._counts[kind];_budget_need(count<limit,'request_budget');_budget_need(count<limit-plan['unallocated'][kind],'budget_unallocated_reserved')
        _budget_need(self._used[kind][phase]<plan['phase_caps'][kind][phase],'budget_phase_exhausted')
        if kind=='owner_arm' and phase!='cleanup':_budget_need(count<(limit-120 if self._published_plan else 457),'budget_cleanup_reserved')
        if kind=='owner_arm' and phase in plan['purpose_caps']:
            _budget_need(self._purpose_used[kind][phase][purpose]<plan['purpose_caps'][phase][purpose],'budget_purpose_exhausted')
        if verified is not None:
            from .attempt import check_phase_send
            check_phase_send(verified,kind,phase,deepcopy(self._counts),self._used[kind][phase])
    def _add_request(self,row):
        kind=row['kind'];self._counts[kind]+=1
        if self._plan is not None:
            phase,purpose=row['phase'],row['purpose'];self._used[kind][phase]+=1;self._purpose_used[kind][phase][purpose]+=1
    def _replay(self,verified=None,*,raw=None):
        from .attempt import _journal
        self._plan=None;self._transition=None;self._transitions=[];self._published_plan=False
        self._counts=deepcopy(self.seed);self._used=self._blank_usage();self._purpose_used=self._blank_purposes()
        with self.journal.mutex:
            records=deepcopy(self.journal.records)
            if raw is None:raw=self.journal.path.read_bytes()
        parsed,tail=_journal(raw,{'binding':self.binding,'seed':self.seed,'limits':self.LIMITS})
        _budget_need(parsed==records,'budget_outside_writer')
        for row in parsed:no_secret(row)
        markers=validated_history_marker_indexes(records,binding=self.binding,seed=self.seed,directory=self.journal.path.parent)
        for index,record in enumerate(records[1:],1):
            if index in markers:continue
            event,value=record['event'],record['value']
            if event=='phase_plan':
                _budget_need(self._plan is None,'budget_plan_repeated');self._validate_plan(value);_budget_need(value['counts_before']==self._counts,'budget_plan_snapshot');self._plan=deepcopy(value);continue
            if event=='attempt_transition':
                from .attempt import _proof
                _budget_need(len(self._transitions)<5,'budget_transition_repeated')
                active=verified if verified is not None and value.get('plan',{}).get('attempt')==verified.binding_digest else None
                ordinal=len(self._transitions)
                amended=ordinal in (2,3,4)
                published=ordinal in (1,2,3,4)
                if verified is not None and _proof(verified)['authority']['schema'] in (4,5,6):
                    schema=_proof(verified)['authority']['schema']
                    _budget_need(ordinal<schema-1,'budget_transition_repeated')
                    if ordinal<schema-2:
                        _budget_need(value==_proof(verified)['succession']['previous_transitions'][ordinal],'budget_previous_transition_changed')
                if ordinal==4:
                    from .acknowledged_image_succession import validate_transition, PREFIX_ROWS, KIND
                    _budget_need(index==PREFIX_ROWS and value.get('kind')==KIND,'budget_transition_repeated')
                elif ordinal==3:
                    from .unknown_publication_succession import validate_transition, PREFIX_ROWS, KIND
                    _budget_need(index==PREFIX_ROWS and value.get('kind')==KIND,'budget_transition_repeated')
                elif ordinal==2:
                    from .input_succession import validate_transition, PREFIX_ROWS, KIND
                    _budget_need(index==PREFIX_ROWS and value.get('kind')==KIND,'budget_transition_repeated')
                elif published:
                    from .published_succession import validate_transition
                    _budget_need(index>71 and value.get('kind')=='STOPPED_AFTER_PUBLICATION_V2','budget_transition_repeated')
                else:
                    from .succession import validate_transition, PREFIX_ROWS
                    _budget_need(not self._transitions and index==PREFIX_ROWS,'budget_transition_repeated')
                    if verified is not None and _proof(verified)['authority']['schema']==3:
                        _budget_need(value==_proof(verified)['succession']['previous_transition'],'budget_previous_transition_changed')
                _budget_need(len(self._transitions)<5,'budget_transition_repeated')
                plan=validate_transition(value,prefix_raw=b''.join(raw.splitlines(keepends=True)[:index]),
                    previous_plan=self._plan,counts=self._counts,used=self._used,verified=active)
                self._validate_plan(plan,published_successor=published,amended=amended,reused_images=ordinal==4);self._plan=plan;self._transition=deepcopy(value)
                self._transitions.append(deepcopy(value));self._published_plan=published
                self._used=self._blank_usage();self._purpose_used=self._blank_purposes();continue
            _budget_need(event=='request' and isinstance(value,dict),'budget_event');kind=value.get('kind');_budget_need(kind in self.LIMITS,'budget_kind')
            if self._plan is None:_budget_need(set(value)=={'kind'} and self._counts[kind]<self.LIMITS[kind],'budget_legacy_request')
            else:
                _budget_need(set(value)=={'kind','attempt','phase','purpose'} and value['attempt']==self._plan['attempt'],'budget_scoped_request')
                # The previous approved phase begins at 187. Its historical
                # requests must not be re-authorized against the successor's
                # 195 snapshot. Structural caps still validate every request.
                active=verified if verified is not None and self._plan['attempt']==verified.binding_digest else None
                self._admit(kind,value['phase'],value['purpose'],verified=active)
            self._add_request(value)
        self._record_count=len(records);self._tail=tail
    def _unchanged(self):
        _budget_need(len(self.journal.records)==self._record_count,'budget_outside_writer')
        _budget_need(digest(self.seed)==self._seed_digest and digest(self.binding)==self._binding_digest,'budget_binding_changed')
    def _append(self,event,value):
        try:self.journal.append(event,value)
        except BaseException:self._poisoned=True;raise
        self._record_count=len(self.journal.records)
    def counts(self):
        with self.mutex:self._assert_open();self._unchanged();return deepcopy(self._counts)
    def count(self,kind):
        with self.mutex:self._assert_open();self._unchanged();_budget_need(kind in self.LIMITS,'budget_kind');return self._counts[kind]
    def begin_attempt(self,verified,*,initialize=False):
        from .attempt import phase_plan,check_budget_snapshot,_proof
        expected=phase_plan(verified)
        with self.mutex:
            schema=_proof(verified)['authority']['schema']
            self._assert_open();self._unchanged();self._validate_plan(expected,published_successor=schema in (3,4,5,6),amended=schema in (4,5,6),reused_images=schema==6)
            if self._plan is None:
                _budget_need('succession' not in _proof(verified),'budget_succession_prefix_required')
                _budget_need(initialize is True,'budget_plan_not_prepared')
                _budget_need(expected['counts_before']==self._counts,'budget_plan_snapshot');check_budget_snapshot(verified,deepcopy(self._counts),initializing=True)
                self._append('phase_plan',expected);self._plan=deepcopy(expected)
            elif self._plan!=expected:
                expected_transitions={2:0,3:1,4:2,5:3,6:4}.get(schema,-1)
                _budget_need(initialize is True and len(self._transitions)==expected_transitions and 'succession' in _proof(verified),'budget_phase_plan_changed')
                self._begin_successor(verified)
            self._replay(verified);check_budget_snapshot(verified,deepcopy(self._counts),initializing=False);self._verified=verified
    def _begin_successor(self,verified):
        """One append while both counter and previous-child OS locks are held."""
        from .attempt import _proof,_sha,CHILD_JOURNAL
        if _proof(verified)['authority']['schema']==6:
            from .acknowledged_image_succession import transition_value,validate_transition
        elif _proof(verified)['authority']['schema']==5:
            from .unknown_publication_succession import transition_value,validate_transition
        elif _proof(verified)['authority']['schema']==4:
            from .input_succession import transition_value,validate_transition
        elif _proof(verified)['authority']['schema']==3:
            from .published_succession import transition_value,validate_transition
        else:from .succession import transition_value,validate_transition
        proof=_proof(verified)['succession'];value=transition_value(verified)
        raw=self.journal.path.read_bytes()
        validate_transition(value,prefix_raw=raw,previous_plan=self._plan,
            counts=self._counts,used=self._used,verified=verified)
        directory=self.journal.path.parent
        with Journal(directory,digest(str(directory)),proof['child_binding'],name=proof.get('child_name',CHILD_JOURNAL),require_existing=True) as prior:
            _budget_need(_sha(prior.path.read_bytes())==proof['child_sha256'] and prior.previous==proof['child_tail'],'budget_succession_child_changed')
            paths=proof['docker_paths'] if 'docker_paths' in proof else [proof['docker_path']]
            for value_path in paths:
                config_path=Path(value_path)
                _budget_need(config_path.parent==directory and not os.path.lexists(config_path),'budget_succession_config_present')
            # Refuse a changed prefix under the same OS counter lock. A failed
            # append poisons this object; it never retries or alters old rows.
            _budget_need(self.journal.path.read_bytes()==raw,'budget_outside_writer')
            self._append('attempt_transition',value)
    def consume(self,kind,limit):
        with self.mutex:
            self._assert_open();self._unchanged();_budget_need(self._plan is None,'budget_scope_required')
            _budget_need(type(limit) is int and kind in self.LIMITS and limit==self.LIMITS[kind] and self._counts[kind]<limit,'request_budget')
            row={'kind':kind};self._append('request',row);self._add_request(row)
    def _new_scope(self,phase,key):
        with self.mutex:
            self._assert_open();self._unchanged();_budget_need(key is _SCOPE_KEY and self._verified is not None and self._plan is not None and phase in _PHASES,'budget_dispatcher_required')
            return _BudgetScope(self,phase,self._plan['attempt'],_SCOPE_KEY)
    def _consume_scoped(self,scope,kind,limit,purpose):
        # The legacy nominal argument identifies the original request class.
        # Admission uses only the authenticated active plan's effective limit;
        # passing 631 here cannot grant or enlarge an allowance.
        with self.mutex:
            self._assert_open();self._unchanged();_budget_need(isinstance(scope,_BudgetScope) and scope._matches(self,self._plan) and self._verified is not None
                and type(limit) is int and limit==self.LIMITS.get(kind),'budget_scope')
            phase=scope.phase;self._admit(kind,phase,purpose,verified=self._verified)
            row={'kind':kind,'attempt':self._plan['attempt'],'phase':phase,'purpose':purpose};self._append('request',row);self._add_request(row)
    def begin_unknown_observation(self,grant,*,guard):
        """Separate read-only grant; expired trial windows grant no capability."""
        from .unknown_observation import ObservationGrant,validate_counter,MARKER
        with self.mutex:
            self._assert_open();self._unchanged()
            _budget_need(type(grant) is ObservationGrant and not hasattr(self,'_observation'),'unknown_observation_scope')
            proof=grant.proof
            _budget_need(self.binding==proof['counter_binding'] and self.seed==proof['seed']
                and str(self.journal.path.parent)==proof['directory'] and self._plan['attempt']==proof['attempt']
                and self._counts==proof['counts'],'unknown_observation_scope')
            marker=self.journal.path.parent/MARKER;verify_owner_file(marker)
            value=json.loads(marker.read_bytes())
            _budget_need(value['grant_sha256']==grant.checksum and value['old_attempt']==proof['attempt']
                and value['target_digest']==digest(proof['target']),'unknown_observation_scope')
            validate_counter(grant,self.journal.path.read_bytes(),consumed=[]);guard()
            self._observation=(grant,guard,[])
            return _ObservationScope(self,grant)
    def _consume_observation(self,grant,purpose):
        from .unknown_observation import validate_counter
        with self.mutex:
            self._assert_open();self._unchanged()
            active,guard,consumed=self._observation
            _budget_need(grant is active and consumed in ([],['owner_token'])
                and purpose==('owner_token' if not consumed else 'http'),'unknown_observation_exhausted')
            guard();validate_counter(grant,self.journal.path.read_bytes(),consumed=consumed)
            _budget_need(self._counts['owner_arm']==316+len(consumed),'unknown_observation_counter_changed')
            self._admit('owner_arm','provision',purpose)
            row={'kind':'owner_arm','attempt':self._plan['attempt'],'phase':'provision','purpose':purpose}
            self._append('request',row);self._add_request(row);consumed.append(purpose)
            guard()
    def close(self):
        with self.mutex:self._closed=True;self._verified=None;self.journal.close()
    def __enter__(self):return self
    def __exit__(self,*_):self.close()


def replay_control_budget(raw,*,binding,seed,directory,verified=None):
    """Pure strict readback for an already read immutable counter snapshot.

    No Journal, lock, file read, authority issuance or send capability is made.
    A successor verified argument additionally binds any persisted transition.
    """
    from .attempt import _journal
    _budget_need(type(seed) is dict and set(seed)==set(ControlBudget.LIMITS)
        and all(type(seed[k]) is int and 0<=seed[k]<=ControlBudget.LIMITS[k] for k in seed),'budget_seed')
    records,_=_journal(raw,{'binding':binding,'seed':seed,'limits':ControlBudget.LIMITS})
    state=object.__new__(ControlBudget)
    state.seed=deepcopy(seed);state.binding=deepcopy(binding)
    state.journal=SimpleNamespace(mutex=threading.RLock(),records=records,path=Path(directory)/'trial-control-budget.jsonl')
    state._replay(verified,raw=raw)
    return {'counts':deepcopy(state._counts),'plan':deepcopy(state._plan),'used':deepcopy(state._used),
        'purpose_used':deepcopy(state._purpose_used),'transition':deepcopy(state._transition),
        'transitions':deepcopy(state._transitions),
        'rows':state._record_count,'tail':state._tail}

class _BudgetScope:
    __slots__=('__budget','__phase','__attempt')
    LIMITS=ControlBudget.LIMITS
    def __init__(self,budget,phase,attempt,key):
        _budget_need(key is _SCOPE_KEY,'budget_dispatcher_required')
        object.__setattr__(self,'_BudgetScope__budget',budget);object.__setattr__(self,'_BudgetScope__phase',phase);object.__setattr__(self,'_BudgetScope__attempt',attempt)
    def __setattr__(self,*_):raise Denied('budget_scope_immutable')
    @property
    def phase(self):return self.__phase
    def _matches(self,budget,plan):return self.__budget is budget and plan is not None and self.__attempt==plan['attempt'] and self.__phase in _PHASES
    def consume(self,kind,limit):self.__budget._consume_scoped(self,kind,limit,'http')
    def consume_owner_token(self):self.__budget._consume_scoped(self,'owner_arm',600,'owner_token')
    def count(self,kind):return self.__budget.count(kind)
    def counts(self):return self.__budget.counts()

class _ObservationScope:
    __slots__=('__budget','__grant')
    def __init__(self,budget,grant):self.__budget,self.__grant=budget,grant
    def consume_owner_token(self):self.__budget._consume_observation(self.__grant,'owner_token')
    def consume(self,kind,limit):
        _budget_need(kind=='owner_arm' and type(limit) is int and limit==600,'unknown_observation_scope')
        self.__budget._consume_observation(self.__grant,'http')

_PROVISION_IDS=frozenset(('webIdentity','workerIdentity','originals','artifacts','budget','journal','guard','job','app','O1','O2','E1','E2','E3','E4',
    'guardMainConfiguration','jobRuntime','appRuntime','auth-platform-secret','auth-config','auth-ingress')+tuple('C'+str(i) for i in range(1,8))+
    tuple('G'+str(i) for i in range(1,7))+tuple('R'+str(i) for i in range(1,11)))
def scope_for_dispatch(budget,verified,*,entry_point,action,operation=None):
    """Fixed source dispatchers classify a validated operation, never JSON phase."""
    if entry_point=='provision':
        _budget_need(isinstance(operation,dict) and isinstance(operation.get('kind'),str) and isinstance(operation.get('expected'),dict),'budget_resolved_operation')
        cleanup=operation.get('method')=='DELETE' or operation['kind'].startswith('cleanup:') or str(operation['expected'].get('auth_action','')).startswith('cleanup:')
        if cleanup:_budget_need(action in ('cleanup','reconcile'),'budget_dispatch_action');phase='cleanup'
        else:_budget_need(operation.get('id') in _PROVISION_IDS and action in ('create','update','reconcile'),'budget_dispatch_action');phase='provision'
    elif entry_point=='publication':
        from .attempt import _proof
        schema=_proof(verified)['authority']['schema']
        _budget_need(action==('verify-reused-images' if schema==6 else 'publish'),'budget_dispatch_action');phase='publication'
    elif entry_point=='registry-cleanup':_budget_need(action=='cleanup','budget_dispatch_action');phase='cleanup'
    elif entry_point=='rehearsal':_budget_need(action in ('start','poll','seed','verify'),'budget_dispatch_action');phase='run'
    elif entry_point=='owner-run':_budget_need(action=='execute','budget_dispatch_action');phase='run'
    elif entry_point=='owner-cleanup':_budget_need(action=='recover','budget_dispatch_action');phase='cleanup'
    elif entry_point=='fresh-read':_budget_need(action=='read','budget_dispatch_action');phase='fresh_read'
    else:raise Denied('budget_dispatch_entry')
    budget.begin_attempt(verified);return budget._new_scope(phase,_SCOPE_KEY)


class CountedControlHttp:
    """Counter injection for provider-validated URLs; no broad credential host."""
    def __init__(self, wire, budget, *, registry_host=None):
        if registry_host is not None and not re.fullmatch(r'[a-z0-9]{5,50}\.azurecr\.io', registry_host):
            raise Denied('registry_host')
        self.wire, self.budget, self.registry = wire, budget, registry_host

    def __call__(self, method, url, headers, body, deadline):
        return self.send_guarded(method, url, headers, body, deadline)

    def send_guarded(self, method, url, headers, body, deadline, *, before_send=None):
        from urllib.parse import urlsplit
        u = urlsplit(url)
        if (u.scheme!='https' or not u.hostname or u.hostname not in ('management.azure.com','graph.microsoft.com',self.registry)
            or u.username or u.password or u.port not in (None,443) or u.fragment):
            raise Denied('control_http_target')
        if body is not None and len(body)>2*1024*1024: raise Denied('control_body_limit')
        self.budget.consume('owner_arm',600)
        # fsync may consume time; the caller's evidence/deadline must still
        # permit this exact send after durable accounting has completed.
        if before_send is not None:
            before_send()
        deadline.remaining()
        return self.wire(method,url,headers,body,deadline)
