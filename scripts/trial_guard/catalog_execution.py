"""Staged Local DB worker. Inert on import; no authority or network defaults."""
import hashlib
import base64
import json
import math
import os
import re
import subprocess
import threading
import time
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .__main__ import Clock, FIXED, PermissionHttp
from .adapters import AzureCredential, Deadline, digest, encoded
from .lifecycle import Denied, may_use, parse
from scripts.trial_provision.private_io import verify_owner_directory, verify_owner_file

MODE = 'catalog_then_bootstrap_v1'
HEX = r'[a-f0-9]{64}'
WINDOW_KEYS = {'lifecycleId','bindingDigest','guardianNonce','ruleId','journalUrl','jobStartedAt','useUntil'}
PLAN_KEYS = {'schema','server','adminUser','targetDatabase','roles','excludedDatabases',
    'maximumAuditConnections','builtinManifestSha256','querySetSha256','limits'}
LIMITS = {'rowsPerQuery':16384,'bytesPerQuery':8388608,'bytesPerSnapshot':16777216}
PASS_KEYS = {'schema','pass','codeSha','auditPlanDigest','querySetDigest','builtinManifestSha256',
    'databaseWindowDigest','lifecycleId','guardianNonce','targetInventoryDigest','catalogDigest',
    'startedAt','checkedAt','auditConnectionAttempts','counts','status','automaticResend'}
PASS_HASHES = {'auditPlanDigest','querySetDigest','builtinManifestSha256',
    'databaseWindowDigest','targetInventoryDigest','catalogDigest'}
BOOTSTRAP_KEYS = {'schema','status','databaseBaselineBytes','cases','automaticResend',
    'finalRuntimePolicySha256','databaseWindowDigest','receiptSetSha256','receiptCount','proofSha256'}
CATALOG_RESULT_KEYS = {'schema','pass1Sha256','pass2Sha256','pass3Sha256',
    'auditPlanDigest','auditConnectionAttempts'}
MAX_FRAME = 2*1024**2
MAX_STREAM = 8*1024**2

def need(value, code='catalog_protocol_unconfirmed'):
    if not value: raise Denied(code)

def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value: raise ValueError('duplicate_json_key')
        value[key] = item
    return value

def _constant(_):
    raise ValueError('nonfinite_json_number')

def strict_json(raw):
    if isinstance(raw, bytes): raw = raw.decode('utf-8', 'strict')
    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant)

def canonical(value):
    # New protocol only. Never change legacy adapters.encoded/digest.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
        allow_nan=False).encode('utf-8')

def catalog_digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def _sha(value):
    return isinstance(value, str) and re.fullmatch(HEX, value) is not None

def _integer(value, low, high):
    return type(value) is int and low <= value <= high

def _target(url):
    need(isinstance(url, str) and 0 < len(url) <= 8192)
    u = urlsplit(url)
    need(u.scheme == 'postgresql' and u.hostname and u.username and u.password and
        u.port in (None, 5432) and not u.query and not u.fragment and u.path.startswith('/'))
    for value in (u.username, u.path[1:]):
        need(not re.search(r'%(?![0-9a-fA-F]{2})', value))
    return {'host':u.hostname, 'database':unquote(u.path[1:], errors='strict'),
        'user':unquote(u.username, errors='strict')}

def validate_catalog_payload(payload):
    """No time or credential access; also safe for cleanup-only construction."""
    try:
        fields = {'azureCliPython','environment','access','signingPrivateKey','databaseWindow',
            'bootstrap','operatorDatabaseUrl','recoveryDirectory','requests','catalogPlan'}
        need(isinstance(payload, dict) and set(payload) == fields)
        policy = strict_json(payload['environment']['TRIAL_POLICY_JSON'])
        need(isinstance(policy, dict) and isinstance(policy['codeSha'], str) and
            re.fullmatch('[a-f0-9]{40}', policy['codeSha']))
        p = payload['catalogPlan']; db = policy['database']; boot = payload['bootstrap']
        need(isinstance(p, dict) and set(p) in (PLAN_KEYS, PLAN_KEYS|{'bootstrapOwnerSet'}) and type(p['schema']) is int and p['schema'] == 1)
        if 'bootstrapOwnerSet' in p:
            authority=p['bootstrapOwnerSet']
            need(isinstance(authority,dict) and set(authority)=={'schema','kind','authoritySha256'} and
                type(authority['schema']) is int and authority['schema']==1 and
                authority['kind']=='temporary-owner-set-v1' and _sha(authority['authoritySha256']))
        need(policy.get('localOperator',{}).get('catalogPlanDigest') == catalog_digest(p))
        need(p['maximumAuditConnections'] == 6 and type(p['maximumAuditConnections']) is int)
        need(p['limits'] == LIMITS and all(type(v) is int for v in p['limits'].values()))
        need(_sha(p['builtinManifestSha256']) and _sha(p['querySetSha256']))
        roles = {'owner':db['ownerRole'],'migrator':db['migratorUser'],'web':db['webUser'],'worker':db['workerUser']}
        need(p['server'] == db['host'] and p['targetDatabase'] == db['database'] and p['roles'] == roles)
        need(isinstance(boot, dict) and set(boot) == {'manifest','credentials','mode'} and boot['mode'] == 'apply')
        m = boot['manifest']
        need(m['adminCatalog'] == 'postgres' and p['adminUser'] == m['adminUser'])
        need(len(set(roles.values())) == 4 and p['adminUser'] not in roles.values())
        excluded = p['excludedDatabases']; need(isinstance(excluded, list) and len(excluded) <= 16)
        names = set()
        for item in excluded:
            need(isinstance(item, dict) and set(item) == {'name','template','allowConnect'})
            name = item['name']
            need(isinstance(name, str) and 0 < len(name.encode('utf-8')) <= 63 and not re.search(r'[\x00-\x1f\x7f]',name) and
                name not in names and name not in ('postgres', p['targetDatabase']) and
                type(item['template']) is bool and item['allowConnect'] is False)
            names.add(name)
        need(_target(boot['credentials']['adminUrl']) == {'host':p['server'],'database':'postgres','user':p['adminUser']})
        need(_target(payload['operatorDatabaseUrl']) == {'host':db['host'],'database':db['database'],'user':db['migratorUser']})
        cases = m['cases']; need(isinstance(cases, list) and len(cases) == 4)
        ids = [c['id'] for c in cases]
        need(all(_integer(i, 1, 2147483646) for i in ids) and len(set(ids)) == 4)
        requests = payload['requests']; need(isinstance(requests, list) and len(requests) == 10)
        need(requests[0]['command'] == 'initialize-ledger' and requests[1]['command'] == 'package-import')
        for i, case_id in enumerate(ids):
            at = 2+2*i; sample, setting = requests[at], requests[at+1]
            need(sample['command'] == 'sample-save' and sample['caseId'] == case_id and
                setting['command'] == 'setting-save' and setting['setting']['caseId'] == case_id)
            for field in ('base','source'):
                need(setting['setting'][field] == {'$sessionResult':{'requestIndex':at,'field':field}})
        return deepcopy(policy)
    except (KeyError, TypeError, ValueError, UnicodeError, AttributeError):
        raise Denied('catalog_payload_unconfirmed') from None

def bootstrap_binding(payload, window):
    value = {k:deepcopy(payload[k]) for k in ('environment','access','azureCliPython','recoveryDirectory')}
    value.update(databaseWindow=deepcopy(window), manifest=deepcopy(payload['bootstrap']['manifest']),
        mode=payload['bootstrap']['mode'], requests=deepcopy(payload['requests']),
        operatorTarget=_target(payload['operatorDatabaseUrl']))
    return catalog_digest(value)

def _private_bytes(path, maximum):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path)
    verify_owner_directory(path.parent); verify_owner_file(path)
    before = path.stat(); need(0 < before.st_size <= maximum)
    with path.open('rb') as stream: raw = stream.read(maximum+1)
    after = path.stat(); verify_owner_file(path)
    need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) ==
        (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and len(raw) == after.st_size)
    return raw

def verify_catalog_receipt(value, pass_no, policy, plan, window, *, prior=None, observed_at=None):
    """Receipt shape/binding only. Historical import can omit observed_at."""
    try:
        need(isinstance(value, dict) and set(value) == PASS_KEYS)
        need(type(value['schema']) is int and value['schema'] == 1 and type(value['pass']) is int and value['pass'] == pass_no)
        need(value['status'] == 'verified' and value['automaticResend'] is False)
        need(isinstance(value['codeSha'], str) and re.fullmatch('[a-f0-9]{40}', value['codeSha']) and value['codeSha'] == policy['codeSha'])
        need(all(_sha(value[k]) for k in PASS_HASHES))
        need(value['auditPlanDigest'] == catalog_digest(plan) and value['querySetDigest'] == plan['querySetSha256'] and
            value['builtinManifestSha256'] == plan['builtinManifestSha256'] and value['databaseWindowDigest'] == catalog_digest(window))
        need(value['lifecycleId'] == window['lifecycleId'] and value['guardianNonce'] == window['guardianNonce'])
        start, checked = parse(value['startedAt']), parse(value['checkedAt'])
        need(parse(window['jobStartedAt']) <= start <= checked < parse(window['useUntil']))
        if observed_at is not None: need(checked <= observed_at < parse(window['useUntil']))
        n = value['auditConnectionAttempts']; need(_integer(n, 1, 6))
        counts = value['counts']; need(isinstance(counts, dict) and set(counts) == {'databases','queries','rows','bytes'})
        need(type(counts['databases']) is int and counts['databases'] == n)
        need(type(counts['queries']) is int and counts['queries'] == 19*n)
        need(_integer(counts['rows'], 0, n*17*plan['limits']['rowsPerQuery']))
        need(_integer(counts['bytes'], 1, n*plan['limits']['bytesPerSnapshot']))
        if prior is not None:
            need(parse(prior['checkedAt']) <= start and all(value[k] == prior[k] for k in
                ('targetInventoryDigest','catalogDigest','auditConnectionAttempts')))
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, UnicodeError, AttributeError):
        raise Denied('catalog_receipt_unconfirmed') from None

def read_catalog_receipt(directory, pass_no, file_sha, policy, plan, window, *, prior=None, observed_at=None):
    need(_integer(pass_no, 1, 3) and _sha(file_sha))
    raw = _private_bytes(Path(directory)/('trial-catalog-pass-%d.json' % pass_no), 16384)
    need(raw.endswith(b'\n') and hashlib.sha256(raw).hexdigest() == file_sha)
    value = strict_json(raw)
    need(raw == canonical(value)+b'\n')
    return verify_catalog_receipt(value, pass_no, policy, plan, window, prior=prior, observed_at=observed_at)

class ClockFence:
    def __init__(self, clock):
        self.clock = clock; self.lock = threading.RLock(); self.failed = False
        self.raw = self.wall = clock.utc(); self.mono = clock.monotonic()
    def now(self):
        with self.lock:
            raw, mono = self.clock.utc(), self.clock.monotonic()
            if not math.isfinite(mono) or raw < self.raw or mono < self.mono: self.failed = True
            self.wall = max(self.wall, raw, self.wall+timedelta(seconds=max(0,mono-self.mono)))
            self.raw, self.mono = raw, mono
            need(not self.failed, 'catalog_clock_revoked')
            return self.wall
    def observe(self, at):
        with self.lock:
            self.wall = max(self.now(), at)
            return self.wall

class FixedPermitReader:
    """One fixed authenticated GET. No Blob lease or shared mutable OwnerSession."""
    def __init__(self, config, initial, wire, clock, *, credential=None):
        self.clock = clock; self.fence = ClockFence(clock); self.cancelled = threading.Event()
        self.lock = threading.Lock(); self.failed = False
        self.fixed = {k:deepcopy(initial[k]) for k in FIXED}
        self.binding = initial['binding_digest']; self.url = config['journal_url']
        self.until = parse(initial['cleanup_at']); self.version = -1; self.high = parse(initial['last_now'])
        u = urlsplit(self.url)
        need(u.scheme == 'https' and u.hostname and u.hostname.endswith('.blob.core.windows.net') and
            u.username is None and u.password is None and u.port in (None,443) and not u.query and not u.fragment and
            re.fullmatch(r'/[a-z0-9-]+/state\.json',u.path), 'catalog_permit_target')
        need(self.fixed['cleanup_strategy'] == 'single_job' and
            self.until-parse(self.fixed['cloud_guard']['job_started_at']) == timedelta(seconds=600))
        self.http = PermissionHttp(wire.for_purpose('owner_control_blob'), clock, config['owner_permissions_until'])
        self.credential = credential or AzureCredential('owner', config['owner_id'], config['tenant_id'], self.http)
        self.owner,self.tenant=config['owner_id'],config['tenant_id']
    def owner_token(self,audience):
        need(audience in ('https://storage.azure.com/','https://management.azure.com/'),'catalog_token_audience')
        need(not self.cancelled.is_set() and not self.failed and (self.until-self.fence.now()).total_seconds()>5,'catalog_permit_revoked')
        token=self.credential.token(audience,Deadline(5,self.clock.monotonic))
        need(not self.cancelled.is_set() and not self.failed and self.fence.now()<self.until,'catalog_permit_revoked')
        try:
            need(isinstance(token,str) and 0<len(token)<=32768)
            claims=strict_json(base64.urlsafe_b64decode(token.split('.')[1]+'==='))
            need(claims['oid'].lower()==self.owner.lower() and claims['tid'].lower()==self.tenant.lower())
            expiry=claims['exp'];need(type(expiry) in (int,float) and math.isfinite(expiry) and expiry>self.clock.utc().timestamp()+60)
            return {'accessToken':token,'tenant':self.tenant,'expires_on':expiry}
        except (ValueError,TypeError,KeyError,IndexError):raise Denied('catalog_token_binding') from None
    def cancel(self):self.cancelled.set()
    def matches(self, window):
        return (set(window) == WINDOW_KEYS and window['journalUrl'] == self.url and
            window['bindingDigest'] == self.binding and window['lifecycleId'] == self.fixed['lifecycle_id'] and
            window['ruleId'] == self.fixed['rule_id'] and window['guardianNonce'] == self.fixed['cloud_guard']['nonce'] and
            parse(window['jobStartedAt']) == parse(self.fixed['cloud_guard']['job_started_at']) and
            parse(window['useUntil']) == self.until)
    def read(self):
        need(self.lock.acquire(blocking=False), 'catalog_permit_concurrent')
        try:
            need(not self.cancelled.is_set() and not self.failed, 'catalog_permit_revoked')
            at = self.fence.now(); need((self.until-at).total_seconds() > 5)
            deadline = Deadline(5, self.clock.monotonic)
            token = self.credential.token('https://storage.azure.com/', deadline)
            at = self.fence.now()
            need(not self.cancelled.is_set() and (self.until-at).total_seconds() > deadline.remaining())
            response = self.http('GET', self.url, {'Authorization':'Bearer '+token,'x-ms-version':'2023-11-03'}, None, deadline)
            deadline.remaining(); need(not self.cancelled.is_set())
            need(response['status'] == 200 and response['headers'].get('etag') and len(response['body']) <= 65536)
            state = strict_json(response['body'])
            need(isinstance(state, dict) and state.get('binding_digest') == self.binding and
                all(state.get(k) == v for k,v in self.fixed.items()))
            need(type(state['version']) is int and state['version'] >= self.version and parse(state['last_now']) >= self.high)
            at = self.fence.observe(parse(state['last_now']))
            need(state['status'] == 'active' and may_use(state,at=at.isoformat(),lifecycle_id=self.fixed['lifecycle_id']))
            end, begin = parse(state['use_lease_until']), parse(state['use_lease_from'])
            need(end-begin <= timedelta(seconds=10) and end <= self.until and end-at >= timedelta(seconds=3))
            self.version, self.high = state['version'], parse(state['last_now'])
            return deepcopy(state)
        except BaseException:
            self.failed = True
            raise Denied('catalog_permit_unavailable') from None
        finally:self.lock.release()

class CatalogNodeWorker:
    """One child/stdout reader and at most one counted fixed-GET request."""
    def __init__(self, node, script, payload, receipt=None, artifact_pin=None, *, clock=None, mode=MODE):
        from .execution import validate_worker_artifact
        need(mode == MODE and receipt is not None, 'catalog_worker_mode')
        if artifact_pin is None:
            for item in (node, script):
                path = Path(item)
                need(path.is_absolute() and path.is_file() and not path.is_symlink(), 'worker_path')
        else: validate_worker_artifact(node, script, artifact_pin)
        need(Path(script).name == 'trial-session.js', 'worker_script')
        self.policy = validate_catalog_payload(payload)
        if artifact_pin is not None: need(artifact_pin['head'] == self.policy['codeSha'], 'worker_artifact_head')
        self.node, self.script = node, script
        self.payload = deepcopy(payload); self.plan = deepcopy(payload['catalogPlan'])
        self.directory = Path(payload['recoveryDirectory'])
        self.expected_bootstrap = {k:deepcopy(payload['bootstrap'][k]) for k in ('manifest','mode')}
        self.receipt = receipt; self.artifact_pin = deepcopy(artifact_pin)
        self.clock = clock or Clock(); self.fence = ClockFence(self.clock)
        self.child = None; self.window = None; self.binding = None; self.output = None
        self.passes = []; self.pass_hashes = []; self._result = None
        self._state_lock = threading.RLock(); self._send_lock = threading.Lock(); self._request_lock = threading.Lock()
        self._stopping = threading.Event(); self._fault = threading.Event(); self._eof = threading.Event()
        self._reader = None; self._broker = None; self._writers = set(); self._permit_reader = None
        self._last_request = 0; self._waiting_request = None
        self._last_token=0;self._waiting_token=None;self._token_broker=None
        self._started = False; self._bootstrap_sent = False; self._input_bytes = 0; self._input_frames = 0
        self._exit_seen = None; self._pipes_closed = False

    def install_permit_reader(self, reader):
        need(not self._started and self.child is None and self._permit_reader is None, 'catalog_reader_binding')
        self._permit_reader = reader

    def _latch_fault(self):
        self._fault.set(); self._stopping.set()
        if self._permit_reader is not None: self._permit_reader.cancel()
        child = self.child
        if child is not None:
            try:
                if child.poll() is None: child.terminate()
            except Exception: pass

    def _send(self, value, *, allow_finished=False):
        raw = encoded(value)+b'\n'
        need(len(raw) <= MAX_FRAME, 'worker_input_limit')
        end = time.monotonic()+2
        if not self._send_lock.acquire(timeout=2):
            self._latch_fault(); raise Denied('worker_pipe_unconfirmed')
        try:
            with self._state_lock:
                # A periodic permit may wait behind the final bootstrap
                # write. A clean child exit in that interval is drained by
                # poll(), which still requires all three proofs and result.
                if allow_finished and self.child is not None and self.child.poll()==0 and not self._fault.is_set():return
                need(not self._stopping.is_set() and not self._fault.is_set() and
                    self.child is not None and self.child.poll() is None, 'worker_not_running')
                need(self._input_bytes+len(raw) <= MAX_STREAM and self._input_frames < 4096, 'worker_input_limit')
                self._input_bytes += len(raw); self._input_frames += 1
                done = threading.Event(); failed = []
                def write():
                    try:
                        if self._stopping.is_set(): raise Denied('worker_stopped')
                        self.child.stdin.write(raw); self.child.stdin.flush()
                    except BaseException: failed.append(True)
                    finally:
                        done.set()
                        with self._state_lock: self._writers.discard(threading.current_thread())
                thread = threading.Thread(target=write, daemon=True)
                self._writers.add(thread); thread.start()
            if not done.wait(max(0, end-time.monotonic())) or failed:
                self._latch_fault(); raise Denied('worker_pipe_unconfirmed')
        except BaseException:
            self._latch_fault(); raise
        finally:self._send_lock.release()

    def start(self, window, permit):
        from .execution import validate_worker_artifact
        need(not self._started and self.child is None, 'worker_already_started')
        self._started = True
        need(not any(os.environ.get(k) for k in ('NODE_OPTIONS','NODE_PATH')), 'worker_node_environment')
        need(self._permit_reader is not None and self._permit_reader.matches(window), 'catalog_reader_window')
        at = self.fence.now()
        need(parse(window['jobStartedAt']) <= at < parse(window['useUntil']) and
            parse(window['useUntil'])-parse(window['jobStartedAt']) == timedelta(seconds=600), 'catalog_window')
        need(parse(self.policy['startsAt']) <= parse(window['jobStartedAt']) and
            parse(window['useUntil']) <= parse(self.policy['endsAt']), 'catalog_policy_window')
        need(self.directory.is_absolute() and self.directory.resolve() == self.directory, 'catalog_private_directory')
        verify_owner_directory(self.directory)
        for i in (1,2,3):
            path = self.directory/('trial-catalog-pass-%d.json' % i)
            need(not path.exists() and not path.is_symlink(), 'catalog_prior_receipt')
        if self.artifact_pin is not None:validate_worker_artifact(self.node, self.script, self.artifact_pin, verify_files=True)
        self.window = deepcopy(window); self.binding = bootstrap_binding(self.payload, window)
        first = {k:deepcopy(self.payload[k]) for k in ('environment','access','azureCliPython','recoveryDirectory','catalogPlan')}
        first.update(type='catalog_start',schema=1,databaseWindow=deepcopy(window),bootstrapBinding=self.binding,
            admin={'adminUrl':self.payload['bootstrap']['credentials']['adminUrl'],'adminUser':self.expected_bootstrap['manifest']['adminUser']})
        self.child = subprocess.Popen([self.node,self.script], stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,shell=False,creationflags=0x08000000 if os.name == 'nt' else 0)
        self._send(first); self._send(permit)
        self._reader = threading.Thread(target=self._receive_stdout, daemon=True);self._reader.start()

    def permit(self, value):
        need(not self._fault.is_set(), 'catalog_worker_unconfirmed')
        if self.child is not None and self.child.poll() is not None:return
        at = self.fence.now()
        need(self.window is not None and at < parse(self.window['useUntil']), 'catalog_window_expired')
        self._send(value,allow_finished=True)

    def _accept_catalog(self, event):
        need(set(event) == {'type','schema','pass','sha256'} and type(event['schema']) is int and
            event['schema'] == 1 and _integer(event['pass'],1,3) and _sha(event['sha256']))
        pass_no = event['pass']
        need(pass_no == len(self.passes)+1 and (pass_no == 1 or self._bootstrap_sent), 'catalog_pass_order')
        value = read_catalog_receipt(self.directory, pass_no, event['sha256'], self.policy, self.plan,
            self.window, prior=self.passes[-1] if self.passes else None, observed_at=self.fence.now())
        need(not self._stopping.is_set() and not self._fault.is_set(), 'catalog_worker_stopped')
        self.receipt.append('catalog_verified', {'pass':pass_no,'sha256':event['sha256'],
            'receipt_digest':catalog_digest(value),'bootstrap_binding':self.binding})
        self.passes.append(value); self.pass_hashes.append(event['sha256'])
        if pass_no == 1:
            need(not self._bootstrap_sent and self.payload, 'catalog_bootstrap_replay')
            payload = {k:deepcopy(v) for k,v in self.payload.items() if k != 'catalogPlan'}
            payload['databaseWindow'] = deepcopy(self.window)
            need(bootstrap_binding(payload, self.window) == self.binding, 'catalog_bootstrap_binding')
            self.receipt.append('bootstrap_frame_intent', {'pass1_sha256':event['sha256'],'bootstrap_binding':self.binding})
            self._send({'type':'bootstrap','schema':1,'catalogPass1Sha256':event['sha256'],'payload':payload})
            self._bootstrap_sent = True; self.payload = {}
            self.receipt.append('bootstrap_frame_sent', {'pass1_sha256':event['sha256'],'bootstrap_binding':self.binding})

    def _accept_result(self, value):
        need(isinstance(value,dict) and set(value) == {'status','completedRequests','bootstrap','catalog'})
        need(value['status'] == 'completed' and type(value['completedRequests']) is int and value['completedRequests'] == 10)
        need(self._bootstrap_sent and len(self.passes) == 3, 'catalog_incomplete')
        b = value['bootstrap']; need(isinstance(b,dict) and set(b) == BOOTSTRAP_KEYS)
        need(type(b['schema']) is int and b['schema'] == 1 and b['status'] == 'bootstrapped' and
            b['automaticResend'] is False and _integer(b['databaseBaselineBytes'],0,64*1024**2) and
            type(b['cases']) is int and b['cases'] == 4 and _integer(b['receiptCount'],1,512))
        need(all(_sha(b[k]) for k in ('finalRuntimePolicySha256','databaseWindowDigest','receiptSetSha256','proofSha256')))
        need(b['databaseWindowDigest'] == catalog_digest(self.window), 'bootstrap_window_binding')
        c = value['catalog']; need(isinstance(c,dict) and set(c) == CATALOG_RESULT_KEYS)
        need(type(c['schema']) is int and c['schema'] == 1 and c['auditPlanDigest'] == catalog_digest(self.plan) and
            type(c['auditConnectionAttempts']) is int and c['auditConnectionAttempts'] == self.passes[0]['auditConnectionAttempts'])
        need([c['pass%dSha256' % i] for i in (1,2,3)] == self.pass_hashes)
        with self._request_lock:
            need(self._waiting_request is None and self._waiting_token is None, 'catalog_permit_incomplete')
            with self._state_lock:
                need(self._result is None and not self._fault.is_set(), 'worker_duplicate_result');self._result = deepcopy(value)

    def _receive_stdout(self):
        frames = 0; total = 0
        try:
            while not self._stopping.is_set():
                raw = self.child.stdout.readline(4097)
                if not raw:
                    with self._state_lock:
                        need(self._result is not None and not self._fault.is_set(), 'worker_incomplete_eof')
                    return
                frames += 1; total += len(raw)
                need(len(raw) <= 4096 and raw.endswith(b'\n') and frames <= 3020 and total <= 4*1024**2, 'worker_output_limit')
                value = strict_json(raw); need(isinstance(value,dict))
                with self._state_lock: need(self._result is None and not self._fault.is_set(), 'worker_output_after_result')
                if value.get('type') == 'permit_request':
                    need(set(value) == {'type','schema','id'} and type(value['schema']) is int and
                        value['schema'] == 1 and _integer(value['id'],1,3000), 'worker_permit_request')
                    with self._request_lock:
                        need(not self._stopping.is_set() and self._waiting_request is None and
                            value['id'] == self._last_request+1, 'worker_permit_request')
                        self._last_request = value['id']; self._waiting_request = value['id']
                        self._broker = threading.Thread(target=self._serve_permit,args=(value['id'],),daemon=True);self._broker.start()
                elif value.get('type')=='owner_token_request':
                    need(set(value)=={'type','schema','id','audience'} and type(value['schema']) is int and value['schema']==1
                        and _integer(value['id'],1,16) and value['audience'] in ('https://storage.azure.com/','https://management.azure.com/'),'worker_token_request')
                    with self._request_lock:
                        need(self._bootstrap_sent and not self._stopping.is_set() and self._waiting_token is None and value['id']==self._last_token+1,'worker_token_request')
                        self._last_token=value['id'];self._waiting_token=value['id']
                        self._token_broker=threading.Thread(target=self._serve_token,args=(value['id'],value['audience']),daemon=True);self._token_broker.start()
                elif value.get('type') == 'catalog_pass': self._accept_catalog(value)
                else: self._accept_result(value)
        except BaseException:self._latch_fault()
        finally:self._eof.set()

    def _serve_permit(self, request_id):
        try:
            if self._stopping.is_set():return
            state = self._permit_reader.read()
            projection = {k:deepcopy(state[k]) for k in ('binding_digest','lifecycle_id','rule_id','cleanup_strategy',
                'status','usage_allowed','close_requested','blocked','cleanup_at','use_lease_from','use_lease_until','last_now','version')}
            projection['cloud_guard'] = {k:state['cloud_guard'][k] for k in ('nonce','job_started_at')}
            with self._request_lock:
                if self._stopping.is_set() or self._fault.is_set():return
                need(self._waiting_request == request_id, 'worker_permit_request')
                self._send({'type':'permit_snapshot','schema':1,'id':request_id,'snapshot':projection});self._waiting_request = None
        except BaseException:self._latch_fault()

    def _serve_token(self,request_id,audience):
        try:
            credential=self._permit_reader.owner_token(audience)
            with self._request_lock:
                need(not self._stopping.is_set() and not self._fault.is_set() and self._waiting_token==request_id,'worker_token_request')
                self._send({'type':'owner_token','schema':1,'id':request_id,'credential':credential});self._waiting_token=None
            credential=None
        except BaseException:self._latch_fault()

    def poll(self):
        if self.child is None:return False
        status = self.child.poll()
        if status is None:
            need(not self._fault.is_set(), 'catalog_worker_unconfirmed')
            need(self.fence.now() < parse(self.window['useUntil']), 'catalog_window_expired');return None
        if not self._eof.is_set() and not self._fault.is_set():
            if self._exit_seen is None:self._exit_seen = time.monotonic()
            if time.monotonic()-self._exit_seen < 2:return None
            self._latch_fault()
        need(self.stop(), 'worker_stop_unconfirmed')
        if status != 0 or self._fault.is_set() or self._result is None:return False
        if self.output is None:
            self.receipt.append('worker_result', {'output':self._result,'database_window':self.window});self.output = deepcopy(self._result)
        else:need(self.output == self._result, 'worker_result_changed')
        return True

    def stop(self):
        self._stopping.set()
        if self._permit_reader is not None:self._permit_reader.cancel()
        end = time.monotonic()+8;child = self.child
        if child is not None and child.poll() is None:
            try:
                child.terminate()
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:child.kill(); child.wait(timeout=2)
            except Exception:return False
        reader = self._reader
        if reader is not None and reader is not threading.current_thread():reader.join(max(0,end-time.monotonic()))
        if reader is not None and reader.is_alive():return False
        broker = self._broker
        if broker is not None and broker is not threading.current_thread():broker.join(max(0,end-time.monotonic()))
        if broker is not None and broker.is_alive():return False
        token_broker=self._token_broker
        if token_broker is not None and token_broker is not threading.current_thread():token_broker.join(max(0,end-time.monotonic()))
        if token_broker is not None and token_broker.is_alive():return False
        with self._state_lock:writers = list(self._writers)
        for writer in writers:
            if writer is not threading.current_thread():writer.join(max(0,end-time.monotonic()))
        if any(writer.is_alive() for writer in writers):return False
        if child is not None:
            if child.poll() is None:return False
            if not self._pipes_closed:
                for stream in (child.stdin,child.stdout):
                    try:stream.close()
                    except Exception:pass
                self._pipes_closed = True
        self.payload = {};return True
