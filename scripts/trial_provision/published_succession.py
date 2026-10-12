"""One V2-to-V3 continuation after acknowledged publication-only cleanup.

Pure validation, not an approval issuer. Every old debit is retained. A new
independently trusted authority must approve the exact balanced allocation.
"""
from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath
from types import SimpleNamespace
from scripts.trial_guard.adapters import digest
from .succession import need, keys, raw

CHILD_NAME='trial-provision-successor-v3'
KIND='STOPPED_AFTER_PUBLICATION_V2'


def allocation(previous_plan, used, counts):
    from .attempt import LIMITS, PHASES
    n=counts['owner_arm']
    need(type(n) is int and 218<=n<=247)
    need(counts['owner_control_blob']==32 and type(counts['owner_control_blob']) is int
         and counts['heartbeat_blob']==0 and type(counts['heartbeat_blob']) is int
         and all(used[k][p]==0 for k in ('owner_control_blob','heartbeat_blob') for p in PHASES))
    caps={k:{p:previous_plan['phase_caps'][k][p]-used[k][p] for p in PHASES} for k in LIMITS}
    need(previous_plan['unallocated']['owner_arm']==23
         and previous_plan['phase_caps']['owner_arm']==dict(zip(PHASES,(24,22,174,42,120)))
         and used['owner_arm']==dict(zip(PHASES,(6,15,0,0,n-216))))
    reserve=deepcopy(previous_plan['unallocated'])
    before=deepcopy(caps['owner_arm'])
    caps['owner_arm']=dict(zip(PHASES,(24,22,392-n,42,120)));reserve['owner_arm']=0
    delta={'schema':1,'kind':'owner_arm','phase_delta':{p:caps['owner_arm'][p]-before[p] for p in PHASES},
           'unallocated_delta':-23}
    need(sum(delta['phase_delta'].values())+delta['unallocated_delta']==0)
    return caps,reserve,delta


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from . import attempt as a
    keys(value,('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
                'prefix_tail','counts','authority_sha256','proof_sha256','plan','phase_reallocation'))
    need(type(value['schema']) is int and value['schema']==2 and value['kind']==KIND)
    need(type(value['prefix_rows']) is int and 71<value['prefix_rows']<=124
         and len(prefix_raw.splitlines())==value['prefix_rows'] and a._sha(prefix_raw)==a._hex(value['prefix_sha256'])
         and a._json(prefix_raw.splitlines()[-1])['hash']==a._hex(value['prefix_tail']))
    need(previous_plan is not None and value['previous_attempt']==previous_plan['attempt']
         and value['previous_plan_sha256']==digest(previous_plan) and value['counts']==counts)
    a._hex(value['authority_sha256']);a._hex(value['proof_sha256'])
    caps,reserve,delta=allocation(previous_plan,used,counts)
    plan=value['plan'];need(type(plan) is dict and plan.get('counts_before')==counts
        and plan.get('attempt')!=previous_plan['attempt'] and plan.get('unallocated')==reserve
        and plan.get('phase_caps')==caps and value['phase_reallocation']==delta)
    # Reject bool/int equivalence in the signed transfer as well.
    need(type(value['phase_reallocation']['schema']) is int
         and type(value['phase_reallocation']['unallocated_delta']) is int
         and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    if verified is not None:need(value==transition_value(verified))
    return deepcopy(plan)


def transition_value(verified):
    from .attempt import _proof,phase_plan
    p=_proof(verified);s=p['succession'];need(p['authority']['schema']==3)
    return {'schema':2,'kind':KIND,'previous_attempt':s['previous_attempt'],
        'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
        'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
        'counts':deepcopy(s['counts']),'authority_sha256':p['authority_sha256'],
        'proof_sha256':s['proof_sha256'],'plan':phase_plan(verified),
        'phase_reallocation':deepcopy(s['phase_reallocation'])}


class _View:
    def __init__(self,records):self.records=records
    def values(self,event):return [deepcopy(r['value']) for r in self.records if r['event']==event]
    def latest(self,ident):
        rows=[v for v in self.values('progress') if v.get('operation_id')==ident]
        return rows[-1] if rows else None
    def append(self,*_):need(False)


def validate_proof(authority,ready,config,manifest,*,parent_journal_raw,parent_final_raw,now):
    from . import attempt as a
    from .journal import replay_control_budget
    from .publication_only_cleanup import prepare,IDENT
    from .registry import BoundedRegistryProvider
    from .registry_publish import verified_publication_images
    rule=authority['succession']
    keys(rule,('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema']==2 and rule['kind']==KIND and rule['child_name']==CHILD_NAME)
    proof=ready.get('succession_proof')
    keys(proof,('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
                'previous_child_raw','counter_prefix_raw','previous_artifacts'))
    need(type(proof['schema']) is int and proof['schema']==2 and digest(proof)==a._hex(rule['proof_sha256']))
    old_raw=raw(proof['previous_authority_raw']);old=a._json(old_raw)
    need(type(old.get('schema')) is int and old['schema']==2 and old.get('approval')=='ISSUE148_LINKED_ATTEMPT_V2')
    old_config=a._json(raw(proof['previous_publication_raw']))
    need('authority_bundle' not in old_config and old_config['sources']==config['sources']
         and old_config['control_budget']==config['control_budget'] and old_config['recovery']==config['recovery'])
    old_config['authority_bundle']=config['authority_bundle']
    keys(proof['previous_artifacts'],a.ARTIFACTS)
    artifacts={k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous=a.verify_attempt(old_config,manifest,authority_raw=old_raw,activation_raw=raw(proof['previous_activation_raw']),
        parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,artifacts=artifacts,
        trusted_authority_sha256=a._sha(old_raw),now=now)
    for name in ('manifest_sha256','owner_id','task_id','budget_binding_sha256','parent','retained_runtime',
                 'guardian_prior_digest','catalog_options','initial_forecast_yen'):
        need(authority[name]==old[name])
    need(authority['head']!=old['head'] and authority['attempt_id']!=old['attempt_id']
         and a._time(authority['publish_from'])>a._time(old['publish_from']))
    child_name,binding=a.journal_descriptor(old_config,previous)
    from .succession import CHILD_NAME as PREVIOUS_CHILD
    need(child_name==PREVIOUS_CHILD)
    child_raw=raw(proof['previous_child_raw']);records,tail=a._journal(child_raw,binding);view=_View(records)
    need(not any(r['event'] in ('clock_revoked','core_plan','plan','publication_import')
                 or r['event'].startswith('provision_bridge_') for r in records))
    allowed={'binding','publication_preparation','clock_observation','allocation','intent','progress',
             'publication_cleanup_binding','publication_cleanup_observation','runtime_image_retention'}
    allowed.update(slot+suffix for slot in ('guardian','runtime') for suffix in
        ('_docker_directory','_docker_config','_docker_config_absent','_docker_probe_directory',
         '_docker_probe_config','_docker_probe_config_absent','_docker_probe_result','_image_namespace','_image_measurement'))
    need(all(r['event'] in allowed for r in records))
    need(all(v.get('operation_id') in ('guardianImagePush','runtimeImagePush',IDENT) for v in view.values('progress')))
    old_config.update(manifest=manifest,config_sha256=a._sha(raw(proof['previous_publication_raw'])),
        verified_attempt=previous,build_receipts={slot:a._json(artifacts[slot+'_build']) for slot in ('guardian','runtime')})
    images=verified_publication_images(view,verified_attempt=previous)
    final=view.latest(IDENT);need(type(final) is dict)
    at=a._time(final['observed_at']);need(at<=a._time(authority['approved_at']))
    registry,operation,push,scope=prepare(old_config,view,at)
    need(view.values('publication_cleanup_binding')==[{'scope':scope,'operation':operation}])
    intents=[v for v in view.values('intent') if v.get('operation_id')==IDENT]
    need(len(intents)==1);intent=intents[0]
    need(intent['request_digest']==digest(operation) and intent['method']=='DELETE' and intent['url']==operation['url']
         and intent['deadline']==operation['deadline'] and a._time(operation['deadline'])<=a._time(intent['at'])<=at)
    receipts=[v for v in view.values('progress') if v.get('operation_id')==IDENT]
    need(len(receipts)==2 and receipts[-1]==final)
    for receipt in receipts:
        need(receipt.get('request_digest')==digest(operation) and receipt.get('object_id')==operation['url']
             and receipt.get('created_by_run') is True and receipt.get('delete_acknowledged') is True
             and type(receipt.get('delete_status')) is int and receipt['delete_status']==202
             and receipt.get('ack_digest')==digest({'request_digest':digest(operation),'http':202}))
    ack=receipts[0]
    need(ack['state']=='pending' and ack['http']==202 and ack['terminal'] is False
         and ack.get('write_terminal') is False and ack.get('readback_verified') is False
         and final['state']=='succeeded' and final['http']==404
         and all(final.get(k) is True for k in ('terminal','write_terminal','readback_verified'))
         and a._time(intent['at'])<=a._time(ack['observed_at'])<=at)
    observations=view.values('publication_cleanup_observation')
    matched=[v for v in observations if v.get('proof_digest')==ack['properties'].get('zero_reference_evidence_digest')]
    need(len(matched)==1);observation=matched[0]
    need(observation['request_digest']==digest(operation))
    def index(event,value):
        matches=[i for i,r in enumerate(records) if r['event']==event and r['value']==value]
        need(len(matches)==1);return matches[0]
    need(index('publication_cleanup_observation',observation)<index('intent',intent)<index('progress',ack)<index('progress',final))
    need(all(index('progress',view.latest(slot+'ImagePush'))<index('intent',intent) for slot in ('guardian','runtime')))
    clocks=[a._time(v['at']) for v in view.values('clock_observation')]
    need(clocks==sorted(clocks) and all(t<=at for t in clocks))
    need(all(a._time(v['observed_at'])<=at for v in view.values('progress')))
    # Historical evidence is evaluated at the recorded DELETE intent, never
    # made fresh relative to the next execution's clock.
    clock=SimpleNamespace(utc=lambda:a._time(intent['at']),monotonic=lambda:0)
    def forbidden(*_):need(False)
    provider=BoundedRegistryProvider(SimpleNamespace(mode='owner'),forbidden,clock,binding=registry,
                                     before_send=forbidden,checkpoint=forbidden)
    need(provider.validate_zero_references(operation,push,observation['proof'])==observation['proof_digest'])
    directory=config['control_budget']['directory']
    path_type=PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    paths=[]
    for slot in ('guardian','runtime'):
        for probe in (False,True):
            path=str(path_type(directory)/('trial-'+slot+('-docker-probe-' if probe else '-docker-')+digest(binding)[:16]));paths.append(path)
            absent=view.values(slot+('_docker_probe' if probe else '_docker')+'_config_absent')
            need(len(absent)==1 and absent[0]=={'absent':True,'path_digest':digest(path)})
    counter_raw=raw(proof['counter_prefix_raw'])
    state=replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory,verified=previous)
    need(state['plan']==a.phase_plan(previous) and state['transition'] is not None and state['counts']==authority['counts_before'])
    caps,reserve,delta=allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps']==caps and authority['unallocated']==reserve and rule['phase_reallocation']==delta)
    return {'proof_sha256':rule['proof_sha256'],'previous_attempt':previous.binding_digest,
        'previous_authority_sha256':a._sha(old_raw),'previous_activation_sha256':a._sha(raw(proof['previous_activation_raw'])),
        'previous_plan':a.phase_plan(previous),'previous_transition':state['transition'],
        'child_name':child_name,'child_binding':binding,'child_sha256':a._sha(child_raw),'child_tail':tail,
        'docker_paths':paths,'counter_prefix_sha256':a._sha(counter_raw),'counter_tail':state['tail'],
        'counter_rows':state['rows'],'counts':state['counts'],'phase_reallocation':delta,
        'retained_published_runtime':images['runtime_image']}
