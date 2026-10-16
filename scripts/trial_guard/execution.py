"""Opt-in real adapters for the offline-tested single Job workflow.

Input is private JSON on stdin. No cloud RBAC, secret, resource or image creation;
the only mutations are one reviewed Job start and OWNER journal/firewall control.
The module is inert on import. Never use its existence as live authorization.
"""
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import threading
from copy import deepcopy
from contextvars import ContextVar
from datetime import timedelta
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from .__main__ import Clock,PermissionHttp,FIXED
from .adapters import AzureCredential,BoundedHttp,Deadline,digest,encoded,json_body
from .lifecycle import Denied,parse
from .owner import OwnerSession
from .workflow import Receipt,Workflow


def validate_launch_preflight(config,clock,*,verified_attempt=None):
    """Require current private readback receipts before even starting the Job.

    This consumes OWNER-reviewed evidence; it does not generate that evidence or
    grant authority. The offline final record intentionally cannot satisfy it.
    """
    f=config.get('preflight') or {}
    try:
        p=json.loads(config['worker']['payload']['environment']['TRIAL_POLICY_JSON'])
        sha=p['codeSha'];at=parse(f['checked_at'])
        from scripts.trial_provision.attempt import effective_image_head
        local_head=f['ci_head']
        image_head=effective_image_head(verified_attempt,local_head)
        staged=config['worker'].get('mode')=='catalog_then_bootstrap_v1'
        evidence=('network_approval','current_ip','platform_isolation' if staged else 'isolation','current_ledger','current_prices','effective_permissions','additional_authority')
        audit_ready=(f.get('schema')==2 and type(f.get('schema')) is int and f.get('catalog_acl')=='pending_catalog' and
            f.get('launch_checks_verified') is True and 'external_business_acl_verified' not in f and 'all_evidence_verified' not in f) if staged else (
            f.get('external_business_acl_verified') is True and f.get('all_evidence_verified') is True)
        if (not re.fullmatch('[a-f0-9]{40}',sha) or sha!=image_head or f['reviewed_head']!=local_head or
            not at<=clock.utc()<at+timedelta(minutes=10) or
            f['ipv4']!=config['binding']['ipv4'] or f['server_id']!=config['binding']['server_id'] or f['rule_id']!=config['binding']['rule_id'] or
            type(f['initial_forecast_yen']) is not int or f['initial_forecast_yen']>4500 or f['initial_forecast_yen']<0 or f['initial_cap_yen']!=5000 or
            f['all_unsettled_retained'] is not True or not audit_ready or
            f['no_production_change'] is not True or
            any(not re.fullmatch('[a-f0-9]{64}',f['evidence_sha256'][k]) for k in evidence)):
            raise Denied('launch_preflight_unconfirmed')
    except (KeyError,TypeError,ValueError):raise Denied('launch_preflight_unconfirmed') from None


class CountedHttp:
    def __init__(self,wire,receipt,shared_budget=None,*,accounting_lock=None):
        # The per-session receipt is audit detail, not another allowance. New
        # live execute paths must also use the one pre-existing lifetime budget.
        self.wire,self.receipt=wire,receipt
        self.shared_budget=shared_budget
        self.accounting_lock=accounting_lock or threading.RLock()
    def for_purpose(self,purpose):
        if purpose not in ('owner_control_blob','heartbeat_blob'):raise Denied('owner_http_purpose')
        def send(method,url,headers,body,deadline):
            return self._send(purpose,method,url,headers,body,deadline)
        return send
    def __call__(self,method,url,headers,body,deadline):
        return self._send('owner_control_blob',method,url,headers,body,deadline)
    def _send(self,purpose,method,url,headers,body,deadline):
        u=urlsplit(url);host=u.hostname
        if u.scheme!='https' or u.username or u.password or u.port not in (None,443) or u.fragment:
            raise Denied('owner_http_host')
        if host=='management.azure.com':kind,limit='owner_arm',600
        elif host and host.endswith('.blob.core.windows.net'):
            kind,limit=('heartbeat_blob',5250) if purpose=='heartbeat_blob' else ('owner_control_blob',3000)
        else:raise Denied('owner_http_host')
        # Fsync lifetime debit first. A later audit/deadline/HTTP failure keeps
        # that reservation; never refund, fall back or debit the lifetime twice.
        with self.accounting_lock:
            if self.shared_budget is not None:self.shared_budget.consume(kind,limit)
            self.receipt.consume(kind,limit)
        deadline.remaining()
        return self.wire(method,url,headers,body,deadline)


def open_control_budget(config):
    """Reopen the provisioning lifetime ledger; never initialize one here.

    Its binding survives head/window changes. Provisioning establishes the
    reviewed seed and source manifest before any request; guardian execution and
    OWNER recovery must present the exact same metadata and physical directory.
    """
    from scripts.trial_provision.journal import ControlBudget
    try:
        value=config['control_budget']
        if not isinstance(value,dict) or set(value)!={'directory','directory_digest','binding','seed'}:
            raise ValueError()
        binding=value['binding']
        if not isinstance(binding,dict) or set(binding)!={'manifest_sha256','owner_id','task_id','source_sha256'}:
            raise ValueError()
        if (binding['owner_id']!=config['owner_id'] or not isinstance(binding['task_id'],str) or
            not re.fullmatch('[A-Za-z0-9_-]{1,128}',binding['task_id']) or
            any(not isinstance(binding[k],str) or not re.fullmatch('[a-f0-9]{64}',binding[k])
                for k in ('manifest_sha256','source_sha256')) or
            value['seed']!={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}):
            raise ValueError()
        # A new window/recovery process cannot silently create an empty budget.
        path=Path(value['directory'])/'trial-control-budget.jsonl'
        if not path.is_file() or path.is_symlink() or path.stat().st_size==0:
            raise ValueError()
        return ControlBudget(value['directory'],value['directory_digest'],binding,
            seed=value['seed'],require_existing=True)
    except (KeyError,TypeError,ValueError,OSError):
        raise Denied('shared_control_budget_unconfirmed') from None


class CountedSession(OwnerSession):
    def __init__(self,config,wire,clock,recovery_only=False,credential_factory=None):
        self._purpose=ContextVar('owner_action_purpose',default='owner_control_blob')
        routes={p:wire.for_purpose(p) for p in ('owner_control_blob','heartbeat_blob')}
        def scoped(method,url,headers,body,deadline):
            return routes[self._purpose.get()](method,url,headers,body,deadline)
        kwargs={} if credential_factory is None else {'credential_factory':credential_factory}
        super().__init__(config,http=scoped,clock=clock,require_fresh=not recovery_only,recovery_only=recovery_only,**kwargs)
    def action(self,action):
        token=self._purpose.set('heartbeat_blob' if action=='heartbeat' else 'owner_control_blob')
        try:return super().action(action)
        finally:self._purpose.reset(token)


class AzureJobStarter:
    """Fixed reviewed manual Job, unique request marker, zero POST retries.

    Unknown start searches only that Job's bounded execution collection. Empty,
    multiple or paginated results remain unknown; no second Job is launched.
    Replica response schema must be read-verified before live_enabled is allowed.
    """
    def __init__(self,config,wire,clock,recovery_only=False,recorded_runtime=None,credential_factory=None):
        self.c,self.clock=config,clock
        self.guardian=guardian_configuration(config) if config.get('guardian_config') is not None else None
        j=config['guardian_job'];self.job=j['resource_id'];self.template=j['template']
        if (config.get('live_enabled') is not True or j.get('readback_verified') is not True or
            j.get('execution_schema_verified') is not True or j.get('approved') is not True or
            not re.fullmatch(r'/subscriptions/[a-fA-F0-9-]+/resourceGroups/[^/]+/providers/Microsoft.App/jobs/[a-z0-9-]+',self.job) or
            digest(self.template)!=j['template_digest'] or config['cleanup_strategy']!='single_job'):
            raise Denied('guardian_job_preflight')
        self.until=parse(config['prearm_until'])
        self.recovery_only=recovery_only
        self.recorded_runtime=recorded_runtime
        if not recovery_only and not self.clock.utc()<self.until<=self.clock.utc()+timedelta(minutes=5):raise Denied('prearm_window')
        self.http=PermissionHttp(wire,clock,config['owner_permissions_until'])
        self.credential=AzureCredential('owner',config['owner_id'],config['tenant_id'],self.http)
        if credential_factory is not None:self.credential=credential_factory(self.credential)

    def request(self,suffix,method='GET',body=None,before=None):
        if suffix not in ('','/start','/executions') and not re.fullmatch('/executions/[a-z0-9-]{1,100}(?:/replicas)?',suffix):raise Denied('job_suffix')
        if (method=='POST')!=(suffix=='/start'):raise Denied('job_method')
        seconds=10 if before is None else min(10,(before-self.clock.utc()).total_seconds())
        d=Deadline(seconds,self.clock.monotonic)
        token=self.credential.token('https://management.azure.com/',d)
        if before is not None and self.clock.utc()>=before:raise Denied('job_send_expired')
        r=self.http(method,'https://management.azure.com'+self.job+suffix+'?api-version=2025-07-01',
            {'Authorization':'Bearer '+token,'Content-Type':'application/json'},None if body is None else encoded(body),d)
        return r,json_body(r)

    def _template(self,request_id):
        value=deepcopy(self.template)
        if len(value.get('containers',[]))!=1 or value.get('initContainers',[])!=[]:raise Denied('job_template')
        c=value['containers'][0]
        if not c['image'].endswith(self.c['guardian_job']['image_digest']) or any(e['name']=='TRIAL_GUARD_REQUEST_ID' for e in c.get('env',[])):raise Denied('job_template')
        if self.guardian is not None:
            if (c.get('command')!=['python','-m','trial_guard'] or c.get('args',[])!=[] or c.get('env',[])!=[] or
                c.get('resources')!={'cpu':0.25,'memory':'0.5Gi'}):raise Denied('job_template')
            c['env']=[{'name':'TRIAL_GUARD_CONFIG_JSON','value':encoded(self.guardian).decode()}]
        c.setdefault('env',[]).append({'name':'TRIAL_GUARD_REQUEST_ID','value':request_id})
        return value

    def start(self,request_id):
        if self.recovery_only:raise Denied('recovery_only')
        r,job=self.request('',before=self.until)
        p=job.get('properties',{});c=p.get('configuration',{});j=self.c['guardian_job']
        if (r['status']!=200 or job.get('id','').lower()!=self.job.lower() or p.get('environmentId','').lower()!=j['environment_id'].lower() or
            c.get('triggerType')!='Manual' or c.get('replicaTimeout')!=1800 or c.get('replicaRetryLimit')!=0 or
            c.get('manualTriggerConfig',{}).get('parallelism')!=1 or c.get('manualTriggerConfig',{}).get('replicaCompletionCount')!=1 or
            digest(p.get('template'))!=j['template_digest'] or digest(job.get('identity'))!=j['identity_digest']):raise Denied('guardian_job_changed')
        r,value=self.request('/start','POST',self._template(request_id),before=self.until)
        execution=value.get('id','')
        if r['status'] not in (200,202) or not self._execution(execution):raise Denied('start_outcome_unknown')
        return self.recover(request_id,execution)

    def _execution(self,value):
        return isinstance(value,str) and value.startswith(self.job+'/executions/'+self.job.split('/')[-1]+'-') and bool(re.fullmatch('[a-z0-9-]{1,100}',value.split('/')[-1]))

    def _match(self,value,request_id):
        return (self._execution(value.get('id')) and digest(value.get('properties',{}).get('template'))==digest(self._template(request_id)))

    def recover(self,request_id,execution_id):
        if execution_id is None:
            r,collection=self.request('/executions')
            if r['status']!=200 or collection.get('nextLink') or not isinstance(collection.get('value'),list) or len(collection['value'])>50:raise Denied('start_reconciliation_incomplete')
            matches=[v for v in collection['value'] if self._match(v,request_id)]
            if len(matches)!=1:raise Denied('start_reconciliation_unknown')
            execution_id=matches[0]['id']
        if not self._execution(execution_id):raise Denied('execution_target')
        name=execution_id.split('/')[-1]
        r,value=self.request('/executions/'+name)
        if r['status']!=200 or value.get('id')!=execution_id or not self._match(value,request_id):raise Denied('execution_binding')
        p=value['properties'];start=parse(p['startTime'])
        self.status=p.get('status')
        if self.status not in (('Running','Succeeded','Failed','Stopped') if self.recovery_only else ('Running',)) or not parse(self.c['seed_not_before'])<=start<=self.clock.utc():raise Denied('execution_not_running')
        if not self.recovery_only and self.clock.utc()>=start+timedelta(minutes=30):raise Denied('execution_not_running')
        prior=self.recorded_runtime
        if prior and prior.get('execution_id')!=execution_id:raise Denied('recorded_runtime_changed')
        if self.recovery_only and prior and prior.get('execution_id')==execution_id and self.status!='Running':
            if any(prior.get(k)!=v for k,v in {'job_started_at':start.isoformat(),'image_digest':self.c['guardian_job']['image_digest'],
                    'principal_id':self.c['guardian_job']['principal_id'],'nonce':self.c['cloud_guard']['nonce']}.items()):raise Denied('recorded_runtime_changed')
            replica=prior['replica_name']  # Historical verified replica, never a fresh liveness assertion.
        else:
            r,replicas=self.request('/executions/'+name+'/replicas')
            rows=replicas.get('value',[])
            if r['status']!=200 or replicas.get('nextLink') or len(rows)!=1:raise Denied('replica_unconfirmed')
            replica=rows[0].get('name','')
        if not re.fullmatch('[a-z0-9-]{1,150}',replica) or not replica.startswith(name+'-'):raise Denied('replica_unconfirmed')
        return {'execution_id':execution_id,'replica_name':replica,'image_digest':self.c['guardian_job']['image_digest'],
            'principal_id':self.c['guardian_job']['principal_id'],'nonce':self.c['cloud_guard']['nonce'],
            'job_started_at':start.isoformat(),'job_deadline':(start+timedelta(minutes=30)).isoformat()}


def guardian_configuration(config):
    """Supply the main guardian's fixed config through execution override only.

    Platform identity/time placeholders are resolved by the existing guardian,
    never synthesized locally. The persisted Job template remains unchanged.
    """
    try:
        g=config['guardian_config'];b=config['binding'];j=config['guardian_job'];job=j['resource_id']
        fields={'live_enabled','mode','job_name','tenant_id','journal_url','prearm_until','seed_not_before','binding','immutable'}
        if (not isinstance(g,dict) or set(g)!=fields or g['live_enabled'] is not True or g['mode']!='main' or
            g['job_name']!=job.rsplit('/',1)[1] or b['mode']!='guardian' or g['binding']!=b or
            any(g[k]!=config[k] for k in ('tenant_id','journal_url','prearm_until','seed_not_before'))):raise ValueError()
        f=g['immutable']
        if (set(f)!=FIXED or f['cleanup_strategy']!='single_job' or f['lifecycle_id']!=b['lifecycle_id'] or
            f['rule_id']!=b['rule_id'] or f['owner_access']!=config['owner_access'] or
            f['cleanup_targets_digest']!=config['cleanup_targets_digest'] or
            any(f[k]!='$CURRENT' for k in ('prepared_at','cleanup_at','deadline','ready_until')) or
            any(f[k] is not None for k in ('successor_id','successor_nonce','successor_runtime'))):raise ValueError()
        guard=f['cloud_guard']
        if (set(guard)!={'execution_id','replica_name','image_digest','principal_id','nonce','job_started_at','job_deadline'} or
            guard!=config['cloud_guard'] or guard['execution_id']!=job+'/executions/$CURRENT' or
            any(guard[k]!='$CURRENT' for k in ('replica_name','job_started_at','job_deadline')) or
            guard['principal_id']!=j['principal_id'] or guard['image_digest']!=j['image_digest'] or
            not isinstance(guard['nonce'],str) or not 16<=len(guard['nonce'])<=128 or
            len(encoded(g))>65536):raise ValueError()
        return deepcopy(g)
    except (KeyError,TypeError,ValueError):raise Denied('guardian_configuration') from None


def execution_binding(config):
    """One shared non-secret binding for execution, cleanup and local proof import."""
    value={k:config[k] for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
    payload=config['worker']['payload']
    value['worker_request_digest']=digest(payload['requests'])
    value['worker_azure_cli_python']=payload.get('azureCliPython')
    value['worker_artifact_pin_digest']=digest(config['worker'].get('artifact_pin'))
    value['network_source_binding_digest']=digest(config.get('network_source_binding'))
    value['guardian_config_digest']=digest(config.get('guardian_config'))
    value['worker_target_digest']=digest({k:payload.get(k) for k in ('environment','access','recoveryDirectory')} |
        {'bootstrap':{k:payload.get('bootstrap',{}).get(k) for k in ('manifest','mode')}})
    value['preflight']=config.get('preflight')
    value['control_budget']=deepcopy(config.get('control_budget'))
    if config['worker'].get('mode') is not None:
        from .catalog_execution import MODE,catalog_digest,validate_catalog_payload
        if config['worker']['mode']!=MODE:raise Denied('worker_mode')
        validate_catalog_payload(payload)
        value['worker_mode']=MODE
        value['catalog_plan_digest']=catalog_digest(payload['catalogPlan'])
        attempt_binding=config.get('attempt_binding_digest')
        if not isinstance(attempt_binding,str) or re.fullmatch('[a-f0-9]{64}',attempt_binding) is None:raise Denied('attempt_binding')
        value['attempt_binding_digest']=attempt_binding
    return value


def validate_worker_python(payload):
    # Use the exact normal OWNER CLI runtime already running this launcher.
    # Never resolve az.cmd, shell aliases, another cache or a fallback chain.
    if payload.get('azureCliPython')!=str(Path(sys.executable).resolve()):
        raise Denied('worker_credential_runtime')


def validate_worker_directories(config):
    """Check both existing private roots before any journal creation or child."""
    from scripts.trial_provision.private_io import verify_owner_directory, verify_owner_file
    try:
        recovery=Path(config['recovery_directory'])
        worker=Path(config['worker']['payload']['recoveryDirectory'])
        for path in (recovery,worker):
            if not path.is_absolute() or path.resolve()!=path:raise ValueError()
            verify_owner_directory(path)
        for name in ('trial-session.jsonl','trial-session.lock'):
            path=recovery/name
            if path.exists():verify_owner_file(path)
    except (KeyError,TypeError,ValueError,OSError):
        raise Denied('worker_private_directory') from None


COMPILED_ROOT=Path(__file__).resolve().parents[2]/'.koho-ops'/'managed'


def validate_worker_artifact(node,script,pin,*,verify_files=False):
    """Bind already-compiled files; the offline launcher proves source/CI emit.

    Shape-only validation does no I/O during cleanup-only resume. Every fresh
    launch and every actual child start re-hashes all files without following
    links. This does not compile, rebuild, download or obtain credentials.
    """
    try:
        if (not isinstance(pin,dict) or set(pin)!={'schema','head','node_sha256','compiled_root','entry','files','source_digest'} or
            type(pin['schema']) is not int or pin['schema']!=1 or
            not isinstance(pin['head'],str) or not re.fullmatch('[a-f0-9]{40}',pin['head']) or
            any(not isinstance(pin[k],str) or not re.fullmatch('[a-f0-9]{64}',pin[k]) for k in ('node_sha256','source_digest')) or
            pin['entry']!='scripts/trial-session.js'):
            raise ValueError()
        root=Path(pin['compiled_root']);binary=Path(node);entry=Path(script)
        if (not root.is_absolute() or root!=COMPILED_ROOT or not binary.is_absolute() or not entry.is_absolute() or
            entry!=root/'scripts'/'trial-session.js'):
            raise ValueError()
        files=pin['files']
        if not isinstance(files,dict) or not 1<=len(files)<=4096 or pin['entry'] not in files:raise ValueError()
        names=set()
        for name,checksum in files.items():
            if (not isinstance(name,str) or not name or len(name)>512 or '\\' in name or ':' in name or
                any(ord(c)<32 for c in name) or PurePosixPath(name).is_absolute() or
                PurePosixPath(name).as_posix()!=name or any(p in ('.','..') for p in name.split('/')) or
                name.casefold() in names or not isinstance(checksum,str) or not re.fullmatch('[a-f0-9]{64}',checksum)):
                raise ValueError()
            names.add(name.casefold())
        if not verify_files:return
        if any(os.environ.get(k) for k in ('NODE_OPTIONS','NODE_PATH')):raise ValueError()
        def plain(path):
            for part in (path,*path.parents):
                stat=part.lstat()
                if part.is_symlink() or getattr(stat,'st_file_attributes',0)&1024:raise ValueError()
            if path.resolve()!=path:raise ValueError()
        def checksum(path,limit):
            plain(path);before=path.stat()
            if not path.is_file() or not 0<=before.st_size<=limit:raise ValueError()
            size=0;value=hashlib.sha256()
            with path.open('rb') as stream:
                while chunk:=stream.read(min(1024**2,limit-size+1)):
                    size+=len(chunk)
                    if size>limit:raise ValueError()
                    value.update(chunk)
            after=path.stat()
            if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or size!=after.st_size:raise ValueError()
            return value.hexdigest(),size
        if checksum(binary,128*1024**2)[0]!=pin['node_sha256']:raise ValueError()
        plain(root)
        if not root.is_dir():raise ValueError()
        found={};total=0;directories=0
        def walk_error(_):raise ValueError()
        for base,dirs,children in os.walk(root,followlinks=False,onerror=walk_error):
            directories+=1
            if directories>4096:raise ValueError()
            for child in dirs:plain(Path(base)/child)
            for child in children:
                path=Path(base)/child;name=path.relative_to(root).as_posix()
                if name not in files or len(found)>=4096:raise ValueError()
                value,size=checksum(path,128*1024**2-total);total+=size
                if value!=files[name]:raise ValueError()
                found[name]=value
        if found!=files:raise ValueError()
    except (KeyError,TypeError,ValueError,OSError):
        raise Denied('worker_artifact_unconfirmed') from None


class NodeWorker:
    """One direct child. EOF and short permit expiry are enforced inside Node.

    No shell, detached service, general process discovery or Windows Job policy
    changes. Credentials travel only in the private stdin pipe. CLI credential
    subprocesses have their own bounded timeout and never hold DB sessions.
    """
    def __init__(self,node,script,payload,receipt=None,artifact_pin=None):
        if artifact_pin is None:
            for value in (node,script):
                p=Path(value)
                if not p.is_absolute() or not p.is_file() or p.is_symlink():raise Denied('worker_path')
        else:validate_worker_artifact(node,script,artifact_pin)
        if Path(script).name!='trial-session.js':raise Denied('worker_script')
        if not isinstance(payload.get('requests'),list) or len(payload['requests'])>16:raise Denied('worker_requests')
        self.expected_requests=len(payload['requests'])
        self.receipt=receipt;self.window=None
        self.expected_bootstrap=deepcopy(payload.get('bootstrap',{}))
        self.artifact_pin=deepcopy(artifact_pin)
        self.node,self.script,self.payload=node,script,deepcopy(payload);self.child=None;self.output=None
    def _send(self,value):
        if self.child is None or self.child.poll() is not None:raise Denied('worker_not_running')
        raw=encoded(value)+b'\n'
        if len(raw)>2*1024*1024:raise Denied('worker_input_limit')
        done=threading.Event();error=[]
        def send():
            try:self.child.stdin.write(raw);self.child.stdin.flush()
            except Exception:error.append(True)
            finally:done.set()
        threading.Thread(target=send,daemon=True).start()
        if not done.wait(2) or error:raise Denied('worker_pipe_unconfirmed')
    def start(self,window,permit):
        if self.child is not None:raise Denied('worker_already_started')
        if any(os.environ.get(k) for k in ('NODE_OPTIONS','NODE_PATH')):raise Denied('worker_node_environment')
        if self.artifact_pin is not None:validate_worker_artifact(self.node,self.script,self.artifact_pin,verify_files=True)
        self.child=subprocess.Popen([self.node,self.script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            shell=False,creationflags=0x08000000 if os.name=='nt' else 0)
        self.window=deepcopy(window)
        payload={**self.payload,'databaseWindow':window};self.payload={}
        self._send(payload);self._send(permit)
    def permit(self,value):self._send(value)
    def poll(self):
        if self.child is None:return False
        status=self.child.poll()
        if status is None:return None
        # Result is strictly tiny. stdout pipe cannot be used for data delivery.
        raw=self.child.stdout.read(4097)
        if len(raw)>4096:return False
        try:value=json.loads(raw)
        except Exception:return False
        valid=status==0 and value.get('status')=='completed' and type(value.get('completedRequests')) is int and value['completedRequests']==self.expected_requests
        if not valid:return False
        if self.receipt is not None:
            try:
                b=value['bootstrap']
                fields={'schema','status','databaseBaselineBytes','cases','automaticResend','finalRuntimePolicySha256',
                    'databaseWindowDigest','receiptSetSha256','receiptCount','proofSha256'}
                if (set(value)!={'status','completedRequests','bootstrap'} or set(b)!=fields or type(b['schema']) is not int or b['schema']!=1 or
                    b['status']!=('bootstrapped' if self.expected_bootstrap['mode']=='apply' else 'reconciled') or
                    type(b['databaseBaselineBytes']) is not int or not 0<=b['databaseBaselineBytes']<=64*1024**2 or
                    type(b['cases']) is not int or b['cases']!=len(self.expected_bootstrap['manifest']['cases']) or b['automaticResend'] is not False or
                    type(b['receiptCount']) is not int or not 1<=b['receiptCount']<=1000 or b['databaseWindowDigest']!=digest(self.window) or
                    any(not isinstance(b[k],str) or not re.fullmatch('[a-f0-9]{64}',b[k]) for k in
                        ('finalRuntimePolicySha256','databaseWindowDigest','receiptSetSha256','proofSha256'))):return False
                if self.output is None:
                    self.receipt.append('worker_result',{'output':value,'database_window':self.window})
                    self.output=deepcopy(value)
                elif self.output!=value:return False
            except (KeyError,TypeError,ValueError):return False
        return True
    def stop(self):
        if self.child is None:return True
        if self.child.poll() is None:
            # Terminate before close: a blocked buffered writer can hold the
            # pipe lock; flushing/closing it first could block this supervisor.
            self.child.terminate()
            try:self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill();self.child.wait(timeout=2)
        return self.child.poll() is not None


def execute(config,*,clock=None,http=None,verified_attempt=None,owner_token_pool=None):
    clock=clock or Clock()
    if config.get('live_enabled') is not True:raise Denied('live_not_enabled')
    # Cleanup resumption must remain possible after initial evidence expires.
    # Receipt ownership/immutability below controls resume, not a caller flag.
    # No passwords/keys included in persistent receipts or stdout. Fixed request
    # and policy digests cover reviewed targets; bootstrap journals cover DDL.
    validate_worker_python(config['worker']['payload'])
    validate_worker_directories(config)
    binding=execution_binding(config)
    w=config['worker'];pin=w.get('artifact_pin')
    staged=w.get('mode')=='catalog_then_bootstrap_v1'
    if staged:
        from scripts.trial_provision.attempt import _proof,check_window,effective_image_head
        from scripts.trial_provision.journal import scope_for_dispatch
        a=_proof(verified_attempt)['authority']
        policy=json.loads(w['payload']['environment']['TRIAL_POLICY_JSON'])
        image_head=effective_image_head(verified_attempt,config['preflight']['ci_head'])
        if (owner_token_pool is None or config.get('attempt_binding_digest')!=verified_attempt.binding_digest or
            digest(config['control_budget']['binding'])!=a['budget_binding_sha256'] or policy['codeSha']!=image_head or
            config['owner_id']!=a['owner_id']):raise Denied('execution_attempt_binding')
        plan=w['payload']['catalogPlan'];options=a['catalog_options']
        expected_set={'schema':1,'kind':'temporary-owner-set-v1','authoritySha256':_proof(verified_attempt)['authority_sha256']} if options['temporary_owner_set'] else None
        if plan['excludedDatabases']!=options['excluded_databases'] or plan.get('bootstrapOwnerSet')!=expected_set:raise Denied('execution_catalog_authority')
        windows=verified_attempt.activation['windows']
        if ({'start':policy['startsAt'],'end':policy['endsAt']}!=windows['initial'] or
            {k:w['payload']['access'][field] for k,field in (('start','startsAt'),('end','endsAt'))}!=windows['owner_input']):raise Denied('execution_attempt_window')
    elif verified_attempt is not None:raise Denied('execution_legacy_attempt')
    budget=open_control_budget(config)
    receipt=None;worker=None
    try:
        receipt=Receipt(config['recovery_directory'],config['recovery_directory_digest'],digest(binding),require_existing=not staged)
        resume=bool(receipt.find('start_intent'))
        if not resume:
            validate_launch_preflight(config,clock,verified_attempt=verified_attempt)
            if not staged:raise Denied('catalog_stage_required')
        scoped=budget;credential_factory=None
        if staged:
            if not resume:check_window(verified_attempt,'initial',clock.utc(),600)
            scoped=scope_for_dispatch(budget,verified_attempt,entry_point='owner-cleanup' if resume else 'owner-run',action='recover' if resume else 'execute')
            credential_factory=lambda credential:owner_token_pool.bind(credential,scoped,verified_attempt)
        wire=CountedHttp(http or BoundedHttp(),receipt,shared_budget=scoped,accounting_lock=receipt.mutex)
        validate_worker_artifact(w.get('node'),w.get('script'),pin,verify_files=not resume)
        if not resume and pin['head']!=image_head:raise Denied('worker_artifact_head')
        guardian_configuration(config)
        saved=receipt.find('start_ack')
        credential_kwargs={} if credential_factory is None else {'credential_factory':credential_factory}
        starter=AzureJobStarter(config,wire,clock,recovery_only=bool(receipt.find('start_intent')),recorded_runtime=saved[-1].get('runtime') if saved else None,**credential_kwargs)
        if staged:
            from .catalog_execution import CatalogNodeWorker,FixedPermitReader
            worker=CatalogNodeWorker(w['node'],w['script'],w['payload'],receipt=receipt,artifact_pin=pin,clock=clock)
        else:worker=NodeWorker(w['node'],w['script'],w['payload'],receipt=receipt,artifact_pin=pin)
        def session_factory(runtime,recovery_only):
            c={**config,'cloud_guard':runtime,'runtime_readback':{**runtime,'status':starter.status,'at':clock.utc().isoformat()}}
            session=CountedSession(c,wire,clock,recovery_only=recovery_only,**credential_kwargs)
            if staged and not recovery_only:
                credential=credential_factory(AzureCredential('owner',config['owner_id'],config['tenant_id'],wire))
                worker.install_permit_reader(FixedPermitReader(c,session.initial,wire,clock,credential=credential))
            return session
        workflow=Workflow(receipt,starter,session_factory,worker,clock,time.sleep)
        previous={}
        for sig in (signal.SIGINT,signal.SIGTERM):
            previous[sig]=signal.signal(sig,lambda *_:workflow.interrupt())
        try:return workflow.run()
        finally:
            for sig,handler in previous.items():signal.signal(sig,handler)
    finally:
        if worker is not None and not worker.stop():raise Denied('worker_stop_unconfirmed')
        try:
            if receipt is not None:receipt.close()
        finally:budget.close()


def main():
    try:
        raw=sys.stdin.buffer.read(2*1024*1024+1)
        if len(raw)>2*1024*1024:raise Denied('input_limit')
        result=execute(json.loads(raw))
    except BaseException:result={'status':'reconciliation_required','cleanupConfirmed':False,'workComplete':False}
    print(json.dumps(result),flush=True)
    return 0 if result['status']=='completed' else 1

if __name__=='__main__':sys.exit(main())
