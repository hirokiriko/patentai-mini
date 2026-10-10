"""Explicit OWNER-side initialization/control; no resource creation or live defaults.

The same private configuration comes from the reviewed actual ARM readback.
The caller owns the local durable operation receipt before invoking initialize
or open. No polling tick runs with OWNER authority; only the guardian resolves
operations. Invoke heartbeat at most once per 2s while Local DB use is needed.
"""
from copy import deepcopy
from urllib.parse import urlsplit
from .__main__ import FIXED,Clock,PermissionHttp
from .adapters import AzureCredential,ArmTransport,BlobJournal,BoundedHttp,digest,Deadline
from .lifecycle import Controller,Denied,parse,initial

def assemble_owner(config,*,http=None,clock=None,require_fresh=True):
    if config.get('live_enabled') is not True or config.get('cleanup_strategy') not in ('single_job','rehearsal'):
        raise Denied('owner_not_enabled')
    if urlsplit(config['journal_url']).path.split('/')[-1] != ('rehearsal.json' if config['cleanup_strategy']=='rehearsal' else 'state.json'):
        raise Denied('owner_journal_mode_binding')
    clock=clock or Clock()
    end=parse(config['owner_permissions_until'])
    access=config.get('owner_access') or {}
    if (access.get('approved') is not True or access.get('readback_verified') is not True or
            access.get('principal_id')!=config['owner_id'] or access.get('journal_url')!=config['journal_url'] or
            access.get('ends_at')!=config['owner_permissions_until'] or not access.get('assignment_id') or
            not isinstance(access.get('evidence_sha256'),str) or len(access['evidence_sha256'])!=64):
        raise Denied('owner_grant_binding')
    grant_start=parse(access['starts_at'])
    at=parse(config['runtime_readback']['job_started_at'])
    if not grant_start<=at<=clock.utc()<end or not 0<(end-grant_start).total_seconds()<=8*3600:
        raise Denied('owner_time_binding')
    wire=PermissionHttp(http or BoundedHttp(),clock,config['owner_permissions_until'])
    credential=AzureCredential('owner',config['owner_id'],config['tenant_id'],wire)
    credential.token('https://storage.azure.com/',Deadline(10,clock.monotonic))
    runtime=deepcopy(config['cloud_guard']);e=config['runtime_readback']
    if (e.get('status')!='Running' or not at<=parse(e['at'])<=clock.utc() or
            (require_fresh and (clock.utc()-parse(e['at'])).total_seconds()>60) or
            any(e.get(k)!=runtime[k] for k in ('execution_id','replica_name','image_digest','principal_id','job_started_at'))):
        raise Denied('owner_runtime_readback')
    if config['cleanup_strategy']=='single_job':
        approval=config['binding'].get('lro_authorization') or {}
        if (approval.get('approved') is not True or approval.get('readback_verified') is not True or
                approval.get('principal_id')!=runtime['principal_id'] or
                approval.get('scope')!='/subscriptions/'+config['binding']['server_id'].split('/')[2] or
                sorted(approval.get('actions',[]))!=sorted(ArmTransport.lro_actions) or
                not approval.get('assignment_id') or not isinstance(approval.get('evidence_sha256'),str) or
                len(approval['evidence_sha256'])!=64 or not approval.get('ends_at') or
                parse(approval['ends_at'])<parse(runtime['job_deadline'])):
            raise Denied('guardian_lro_preflight_missing')
    s=initial(at=at.isoformat(),rule_id=config['binding']['rule_id'],lifecycle_id=config['binding']['lifecycle_id'],
        guardian_pid=None,independent_guard_verified=True,cleanup_seconds=600 if config['cleanup_strategy']=='single_job' else None,
        cloud_guard=runtime,cleanup_strategy=config['cleanup_strategy'])
    s.update(successor_id=None,successor_nonce=None,successor_runtime=None,cleanup_targets_digest=config['cleanup_targets_digest'],owner_access=deepcopy(access))
    fixed={k:deepcopy(s[k]) for k in FIXED}
    # Journal uses the guardian binding on both sides; OWNER mode differs only
    # in its transient transport, never in the immutable journal digest.
    if config['binding']['mode']!='guardian':raise Denied('owner_journal_binding')
    s.update(binding_digest=digest({'binding':config['binding'],'immutable':fixed}),runtime_readback=deepcopy(e),
        owner_heartbeat={'at':clock.utc().isoformat(),'lifecycle_id':s['lifecycle_id'],'nonce':runtime['nonce']})
    journal=BlobJournal(config['journal_url'],s['binding_digest'],credential,wire,clock,immutable=fixed)
    transport=ArmTransport({**config['binding'],'mode':'owner'},credential,wire,clock,journal.assert_send_lease)
    def proof():
        ready=(journal.state or {}).get('guardian_ready') or {}
        return {**runtime,'kind':'azure_job','lifecycle_id':s['lifecycle_id'],'runtime_verified':True,
            'alive':bool(ready),'at':ready.get('at',s['prepared_at'])}
    return journal,Controller(journal,transport,clock,proof),s,clock

def owner_action(config,action,*,http=None,clock=None):
    if action not in ('initialize','heartbeat','open','close','status'):raise Denied('owner_action')
    if config.get('cleanup_strategy')=='rehearsal' and action not in ('initialize','status'):raise Denied('rehearsal_read_only')
    journal,controller,initial_state,clock=assemble_owner(config,http=http,clock=clock,require_fresh=action in ('initialize','open'))
    if action=='initialize':
        journal.initialize(initial_state);return {'status':'initialized'}
    if action=='open':
        return {'status':controller.start()['status']}  # durable intent prevents resend
    if action=='close':controller.request_close()
    with journal.locked():
        state=journal.load()
        if action=='heartbeat':
            if state['close_requested'] or clock.utc()>=parse(state['cleanup_at']):raise Denied('owner_use_ended')
            previous=(state.get('owner_heartbeat') or {}).get('at',state['prepared_at'])
            if (clock.utc()-parse(previous)).total_seconds()<2:raise Denied('heartbeat_cadence')
            state.update(version=state['version']+1,owner_heartbeat={'at':clock.utc().isoformat(),
                'lifecycle_id':state['lifecycle_id'],'nonce':state['cloud_guard']['nonce']})
            journal.save(state,expected_version=state['version']-1)
        return {'status':state['status'],'closed':state['status']=='closed','obligation':state['cleanup_responsibility_retained']}
