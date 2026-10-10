"""Opt-in real adapters for the offline-tested single Job workflow.

Input is private JSON on stdin. No cloud RBAC, secret, resource or image creation;
the only mutations are one reviewed Job start and OWNER journal/firewall control.
The module is inert on import. Never use its existence as live authorization.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import threading
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit
from .__main__ import Clock,PermissionHttp
from .adapters import AzureCredential,BoundedHttp,Deadline,digest,encoded,json_body
from .lifecycle import Denied,parse
from .owner import OwnerSession
from .workflow import Receipt,Workflow


def validate_launch_preflight(config,clock):
    """Require current private readback receipts before even starting the Job.

    This consumes OWNER-reviewed evidence; it does not generate that evidence or
    grant authority. The offline final record intentionally cannot satisfy it.
    """
    f=config.get('preflight') or {}
    try:
        p=json.loads(config['worker']['payload']['environment']['TRIAL_POLICY_JSON'])
        sha=p['codeSha'];at=parse(f['checked_at'])
        evidence=('network_approval','current_ip','isolation','current_ledger','current_prices','effective_permissions','additional_authority')
        if (not re.fullmatch('[a-f0-9]{40}',sha) or f['ci_head']!=sha or f['reviewed_head']!=sha or
            not at<=clock.utc()<at+timedelta(minutes=10) or
            f['ipv4']!=config['binding']['ipv4'] or f['server_id']!=config['binding']['server_id'] or f['rule_id']!=config['binding']['rule_id'] or
            type(f['initial_forecast_yen']) is not int or f['initial_forecast_yen']>4500 or f['initial_forecast_yen']<0 or f['initial_cap_yen']!=5000 or
            f['all_unsettled_retained'] is not True or f['external_business_acl_verified'] is not True or
            f['no_production_change'] is not True or f['all_evidence_verified'] is not True or
            any(not re.fullmatch('[a-f0-9]{64}',f['evidence_sha256'][k]) for k in evidence)):
            raise Denied('launch_preflight_unconfirmed')
    except (KeyError,TypeError,ValueError):raise Denied('launch_preflight_unconfirmed') from None


class CountedHttp:
    def __init__(self,wire,receipt):self.wire,self.receipt,self.heartbeat=wire,receipt,False
    def __call__(self,method,url,headers,body,deadline):
        host=urlsplit(url).hostname
        if host=='management.azure.com':kind,limit='owner_arm',600
        elif host and host.endswith('.blob.core.windows.net'):
            kind,limit=('heartbeat_blob',5250) if self.heartbeat else ('owner_control_blob',3000)
        else:raise Denied('owner_http_host')
        self.receipt.consume(kind,limit)
        deadline.remaining()
        return self.wire(method,url,headers,body,deadline)


class CountedSession(OwnerSession):
    def __init__(self,config,wire,clock,recovery_only=False):
        self.counted=wire
        super().__init__(config,http=wire,clock=clock,require_fresh=not recovery_only,recovery_only=recovery_only)
    def action(self,action):
        self.counted.heartbeat=action=='heartbeat'
        try:return super().action(action)
        finally:self.counted.heartbeat=False


class AzureJobStarter:
    """Fixed reviewed manual Job, unique request marker, zero POST retries.

    Unknown start searches only that Job's bounded execution collection. Empty,
    multiple or paginated results remain unknown; no second Job is launched.
    Replica response schema must be read-verified before live_enabled is allowed.
    """
    def __init__(self,config,wire,clock,recovery_only=False,recorded_runtime=None):
        self.c,self.clock=config,clock
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
        if r['status']!=200 or not self._match(value,request_id):raise Denied('execution_binding')
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


class NodeWorker:
    """One direct child. EOF and short permit expiry are enforced inside Node.

    No shell, detached service, general process discovery or Windows Job policy
    changes. Credentials travel only in the private stdin pipe. CLI credential
    subprocesses have their own bounded timeout and never hold DB sessions.
    """
    def __init__(self,node,script,payload):
        for value in (node,script):
            p=Path(value)
            if not p.is_absolute() or not p.is_file() or p.is_symlink():raise Denied('worker_path')
        if Path(script).name!='trial-session.js':raise Denied('worker_script')
        if not isinstance(payload.get('requests'),list) or len(payload['requests'])>16:raise Denied('worker_requests')
        self.expected_requests=len(payload['requests'])
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
        self.child=subprocess.Popen([self.node,self.script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            shell=False,creationflags=0x08000000 if os.name=='nt' else 0)
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
        return status==0 and value.get('status')=='completed' and type(value.get('completedRequests')) is int and value['completedRequests']==self.expected_requests
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


def execute(config,*,clock=None,http=None):
    clock=clock or Clock()
    if config.get('live_enabled') is not True:raise Denied('live_not_enabled')
    # Cleanup resumption must remain possible after initial evidence expires.
    # Receipt ownership/immutability below controls resume, not a caller flag.
    # No passwords/keys included in persistent receipts or stdout. Fixed request
    # and policy digests cover reviewed targets; bootstrap journals cover DDL.
    binding={k:config[k] for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
    binding['worker_request_digest']=digest(config['worker']['payload']['requests'])
    binding['preflight']=config.get('preflight')
    receipt=Receipt(config['recovery_directory'],config['recovery_directory_digest'],digest(binding))
    wire=CountedHttp(http or BoundedHttp(),receipt)
    try:
        if not receipt.find('start_intent'):validate_launch_preflight(config,clock)
        saved=receipt.find('start_ack')
        starter=AzureJobStarter(config,wire,clock,recovery_only=bool(receipt.find('start_intent')),recorded_runtime=saved[-1].get('runtime') if saved else None)
        def session_factory(runtime,recovery_only):
            c={**config,'cloud_guard':runtime,'runtime_readback':{**runtime,'status':starter.status,'at':clock.utc().isoformat()}}
            return CountedSession(c,wire,clock,recovery_only=recovery_only)
        worker=NodeWorker(config['worker']['node'],config['worker']['script'],config['worker']['payload'])
        workflow=Workflow(receipt,starter,session_factory,worker,clock,time.sleep)
        previous={}
        for sig in (signal.SIGINT,signal.SIGTERM):
            previous[sig]=signal.signal(sig,lambda *_:workflow.interrupt())
        try:return workflow.run()
        finally:
            for sig,handler in previous.items():signal.signal(sig,handler)
    finally:receipt.close()


def main():
    try:
        raw=sys.stdin.buffer.read(2*1024*1024+1)
        if len(raw)>2*1024*1024:raise Denied('input_limit')
        result=execute(json.loads(raw))
    except BaseException:result={'status':'reconciliation_required','cleanupConfirmed':False,'workComplete':False}
    print(json.dumps(result),flush=True)
    return 0 if result['status']=='completed' else 1

if __name__=='__main__':sys.exit(main())
