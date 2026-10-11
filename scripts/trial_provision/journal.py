"""OWNER-private durable intents and one lifetime control-request allowance.

No network, token, credential creation, implicit resume, refund or resend. The
directory must be the previously approved OWNER recovery directory. File names
are fixed; current-user-only ACLs are applied before any bytes are written.
"""
import json
import os
import re
import uuid
from copy import deepcopy
from pathlib import Path

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
        if name not in ('trial-provision', 'trial-control-budget'):
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
            self.lock = lock_path.open('r+b')
            self.lock.seek(0); self.lock.write(b'0'); self.lock.flush(); self.lock.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError: raise Denied('concurrent_writer') from None
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

    def values(self, event): return [deepcopy(r['value']) for r in self.records if r['event']==event]

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


class ControlBudget:
    """One existing OWNER allowance, shared by provisioning and guardian.

    Graph and registry control traffic consumes the same 600 slots formerly
    modelled as OWNER ARM. This adds no allowance. Image layer transfers are
    covered separately by the original image/transfer estimate and admission.
    """
    LIMITS = {'owner_arm':600, 'owner_control_blob':3000, 'heartbeat_blob':5250}

    def __init__(self, directory, directory_digest, binding, *, seed, require_existing=False):
        if (set(seed) != set(self.LIMITS) or any(type(seed[k]) is not int or
            not 0 <= seed[k] <= self.LIMITS[k] for k in seed)):
            raise Denied('budget_seed')
        self.seed = deepcopy(seed)
        self.journal = Journal(directory, directory_digest,
            {'binding':binding, 'limits':self.LIMITS, 'seed':seed}, name='trial-control-budget',require_existing=require_existing)

    def count(self, kind):
        if kind not in self.LIMITS: raise Denied('budget_kind')
        return self.seed[kind]+sum(v['kind']==kind for v in self.journal.values('request'))

    def consume(self, kind, limit):
        if limit != self.LIMITS.get(kind) or self.count(kind)>=limit:
            raise Denied('request_budget')
        self.journal.append('request', {'kind':kind})

    def close(self): self.journal.close()
    def __enter__(self): return self
    def __exit__(self, *_): self.close()


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
