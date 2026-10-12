"""Pure V3 closure and the explicitly approved 31-request V4 amendment.

The original counter binding and every historical debit remain unchanged.
This verifier neither issues approval nor creates an execution window.
"""
from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath
from types import SimpleNamespace
from scripts.trial_guard.adapters import digest
from .succession import need, keys, raw
from .published_succession import _View as PublicationView

CHILD_NAME='trial-provision-successor-v4'
KIND='STOPPED_INPUT_CONTRACT_V3'
PREFIX_ROWS=148
COUNTS={'owner_arm':270,'owner_control_blob':32,'heartbeat_blob':0}


def allocation(previous_plan,used,counts):
    from .attempt import LIMITS,PHASES
    need(counts==COUNTS and all(type(v) is int for v in counts.values())
         and previous_plan['limits']==LIMITS
         and previous_plan['phase_caps']['owner_arm']==dict(zip(PHASES,(24,22,153,42,120)))
         and previous_plan['unallocated']['owner_arm']==0
         and used['owner_arm']==dict(zip(PHASES,(6,15,0,0,10)))
         and all(type(v) is int for phases in used.values() for v in phases.values())
         and all(used[k][p]==0 for k in ('owner_control_blob','heartbeat_blob') for p in PHASES))
    caps=deepcopy(previous_plan['phase_caps']);reserve=deepcopy(previous_plan['unallocated'])
    delta={'schema':1,'kind':'owner_arm','phase_delta':deepcopy(used['owner_arm']),'unallocated_delta':0}
    need(sum(delta['phase_delta'].values())==31)
    return caps,reserve,delta


def validate_transition(value,*,prefix_raw,previous_plan,counts,used,verified=None):
    from . import attempt as a
    keys(value,('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
        'prefix_tail','counts','authority_sha256','proof_sha256','plan','phase_reallocation','limit_amendment'))
    need(type(value['schema']) is int and value['schema']==3 and value['kind']==KIND
         and type(value['prefix_rows']) is int and value['prefix_rows']==PREFIX_ROWS
         and len(prefix_raw.splitlines())==PREFIX_ROWS and a._sha(prefix_raw)==a._hex(value['prefix_sha256'])
         and a._json(prefix_raw.splitlines()[-1])['hash']==a._hex(value['prefix_tail']))
    need(previous_plan is not None and value['previous_attempt']==previous_plan['attempt']
         and value['previous_plan_sha256']==digest(previous_plan) and value['counts']==counts)
    a._hex(value['authority_sha256']);a._hex(value['proof_sha256'])
    caps,reserve,delta=allocation(previous_plan,used,counts)
    limits=a._authority_limits({'schema':4,'limit_amendment':value['limit_amendment']})
    plan=value['plan'];need(type(plan) is dict and plan.get('counts_before')==counts
        and plan.get('attempt')!=previous_plan['attempt'] and plan.get('unallocated')==reserve
        and plan.get('phase_caps')==caps and plan.get('limits')==limits and value['phase_reallocation']==delta)
    need(type(value['phase_reallocation']['schema']) is int and type(value['phase_reallocation']['unallocated_delta']) is int
         and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    if verified is not None:need(value==transition_value(verified))
    return deepcopy(plan)


def transition_value(verified):
    from .attempt import _proof,phase_plan
    p=_proof(verified);s=p['succession'];need(p['authority']['schema']==4)
    return {'schema':3,'kind':KIND,'previous_attempt':s['previous_attempt'],
        'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
        'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
        'counts':deepcopy(s['counts']),'authority_sha256':p['authority_sha256'],
        'proof_sha256':s['proof_sha256'],'plan':phase_plan(verified),
        'phase_reallocation':deepcopy(s['phase_reallocation']),
        'limit_amendment':deepcopy(p['authority']['limit_amendment'])}


class _View(PublicationView):
    def receipts(self):return {v['operation_id']:v for v in self.values('progress')}


def _bridge(publication,provision,inputs,view,binding,manifest):
    from .publication_bridge import compose_configuration,_core_plan,_prepared_record
    from .operations import create_resolver
    from .registry_publish import registry_cleanup_bundle
    from .registry_cli import _prepare
    from . import attempt as a
    need(compose_configuration(publication,view,inputs,verify_local_node=False)==provision)
    bridge=view.values('provision_bridge_intent');need(len(bridge)==1);bridge=bridge[0]
    keys(bridge,('schema','publication_config_sha256','checked_at','input_sha256','code_sha','run_binding_digest',
                 'image_receipt_digests','output'))
    need(type(bridge['schema']) is int and bridge['schema']==1
         and bridge['publication_config_sha256']==publication['config_sha256']
         and bridge['code_sha']==publication['frozen_head'] and bridge['run_binding_digest']==digest(binding)
         and bridge['image_receipt_digests']=={s:digest(view.latest(s+'ImagePush')) for s in ('guardian','runtime')})
    allocations=view.values('allocation');lookup={v['slot']:v['id'] for v in allocations}
    need(len(lookup)==len(allocations)==17);seen=set()
    def allocate(slot):need(slot in lookup and slot not in seen);seen.add(slot);return lookup[slot]
    core=_core_plan(publication,provision,bridge['checked_at'],allocate)
    need(view.values('core_plan')==[core])
    for intent in view.values('intent'):
        slot='request_'+intent['operation_id'];need(lookup.get(slot)==intent['request_id']);seen.add(slot)
    need(seen==set(lookup))
    resolver=create_resolver(core,manifest,publication['authority_bundle'],provision['resource_bindings'])
    need(view.values('plan')==[resolver.initial_plan] and view.values('provision_bridge_output')==[bridge]
         and view.values('provision_bridge_prepared')==[_prepared_record(view,bridge)])
    bundle=registry_cleanup_bundle(manifest,view,resolver)
    owner=SimpleNamespace(mode='owner',principal=manifest['owner']['principal_id'],tenant=manifest['owner']['tenant_id'])
    registry,op=_prepare(bundle,manifest,provision['resource_bindings'],view,resolver,owner,publication['verified_attempt'])
    need(view.values('registry_cleanup_binding')==[{'bundle_digest':digest(bundle),'operation':op}])
    return registry,op,bundle['push_receipt'],bridge


def validate_proof(authority,ready,config,manifest,*,parent_journal_raw,parent_final_raw,now):
    from . import attempt as a
    from .journal import replay_control_budget
    from .registry import BoundedRegistryProvider
    from .registry_publish import verified_publication_images
    from .configuration import SOURCE_FILES
    rule=authority['succession']
    keys(rule,('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema']==3 and rule['kind']==KIND and rule['child_name']==CHILD_NAME)
    proof=ready.get('succession_proof')
    keys(proof,('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw','previous_provision_raw',
        'previous_bridge_input_raw','previous_source_raw','previous_child_raw','counter_prefix_raw','previous_artifacts','approval_raw'))
    need(type(proof['schema']) is int and proof['schema']==3 and digest(proof)==a._hex(rule['proof_sha256']))
    approval=a._json(raw(proof['approval_raw']))
    need(a._sha(raw(proof['approval_raw']))==authority['limit_amendment']['approval_sha256'])
    keys(approval,('schema','decision','kind','previous','current','delta','counts_before','phase_caps','additional_cap_yen',
        'global_cap_yen','initial_reservation_yen','formal_reservation_yen','unsettled_reservation_yen','new_start_time','recorded_at','answer'))
    need(approval['schema']==1 and type(approval['schema']) is int and approval['decision']=='APPROVED'
         and approval['kind']==KIND and approval['answer']=='631件への変更を承認して続行'
         and all(type(approval[k]) is int for k in ('previous','current','delta','additional_cap_yen','global_cap_yen',
             'initial_reservation_yen','formal_reservation_yen','unsettled_reservation_yen'))
         and (approval['previous'],approval['current'],approval['delta'])==(600,631,31)
         and (approval['additional_cap_yen'],approval['global_cap_yen'],approval['initial_reservation_yen'],
             approval['formal_reservation_yen'],approval['unsettled_reservation_yen'])==(15000,53331,5000,10000,11527)
         and approval['counts_before']==COUNTS and approval['phase_caps']==dict(zip(a.PHASES,(24,22,153,42,120)))
         and approval['new_start_time'] is None and a._time(approval['recorded_at'])<=a._time(authority['approved_at']))
    old_raw=raw(proof['previous_authority_raw']);old=a._json(old_raw)
    need(type(old.get('schema')) is int and old['schema']==3 and old.get('approval')=='ISSUE148_LINKED_ATTEMPT_V3')
    public_raw=raw(proof['previous_publication_raw']);old_config=a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['sources']==config['sources']
         and old_config['control_budget']==config['control_budget'] and old_config['recovery']==config['recovery'])
    keys(proof['previous_source_raw'],SOURCE_FILES)
    bundle={k:raw(v) for k,v in proof['previous_source_raw'].items()}
    need(all(a._sha(v)==config['sources'][k]['sha256'] for k,v in bundle.items()) and a._json(bundle['manifest'])==manifest)
    old_config['authority_bundle']=bundle
    keys(proof['previous_artifacts'],a.ARTIFACTS);artifacts={k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous=a.verify_attempt(old_config,manifest,authority_raw=old_raw,activation_raw=raw(proof['previous_activation_raw']),
        parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,artifacts=artifacts,
        trusted_authority_sha256=a._sha(old_raw),now=now)
    for name in ('manifest_sha256','owner_id','task_id','budget_binding_sha256','parent','retained_runtime',
                 'guardian_prior_digest','catalog_options'):need(authority[name]==old[name])
    # The new image must be measured anew; its conservative forecast can rise
    # within the existing start gate. This does not change any cost allowance:
    # the separately approved money allocation remains an issuer prerequisite.
    need(type(authority['initial_forecast_yen']) is int and old['initial_forecast_yen']<=authority['initial_forecast_yen']<=4500)
    need(authority['head']!=old['head'] and authority['attempt_id']!=old['attempt_id']
         and a._time(authority['publish_from'])>a._time(old['publish_from']))
    child_name,binding=a.journal_descriptor(old_config,previous);need(child_name=='trial-provision-successor-v3')
    child_raw=raw(proof['previous_child_raw']);records,tail=a._journal(child_raw,binding);view=_View(records)
    allowed={'binding','publication_preparation','clock_observation','allocation','intent','progress','runtime_image_retention',
        'core_plan','plan','publication_import','provision_bridge_intent','provision_bridge_output','provision_bridge_prepared',
        'registry_cleanup_binding','registry_reference_observation'}
    allowed.update(slot+suffix for slot in ('guardian','runtime') for suffix in
        ('_docker_directory','_docker_config','_docker_config_absent','_docker_probe_directory','_docker_probe_config',
         '_docker_probe_config_absent','_docker_probe_result','_image_namespace','_image_measurement'))
    need(len(records)==79 and all(r['event'] in allowed for r in records))
    intents=view.values('intent');need(len(intents)==3 and {v['operation_id'] for v in intents}=={'guardianImagePush','runtimeImagePush','guardianImageCleanup'})
    progress=view.values('progress');need(len(progress)==8 and all(v.get('operation_id') in {i['operation_id'] for i in intents} for v in progress))
    old_config.update(manifest=manifest,config_sha256=a._sha(public_raw),verified_attempt=previous,
        build_receipts={slot:a._json(artifacts[slot+'_build']) for slot in ('guardian','runtime')})
    images=verified_publication_images(view,verified_attempt=previous)
    provision_raw=raw(proof['previous_provision_raw']);provision=a._json(provision_raw)
    input_raw=raw(proof['previous_bridge_input_raw']);inputs=a._json(input_raw)
    registry,operation,push,bridge=_bridge(old_config,provision,inputs,view,binding,manifest)
    directory=config['control_budget']['directory'];path_type=PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    need(bridge['input_sha256']==a._sha(input_raw) and bridge['output']=={
        'path':str(path_type(directory)/'provision-successor-v3-config.json'),'sha256':a._sha(provision_raw)})
    ident='guardianImageCleanup';intent=next(v for v in intents if v['operation_id']==ident)
    receipts=[v for v in progress if v['operation_id']==ident];need(len(receipts)==2);ack,final=receipts
    at=a._time(final['observed_at']);need(at<=a._time(approval['recorded_at']))
    need(intent['request_digest']==digest(operation) and intent['method']=='DELETE' and intent['url']==operation['url']
        and intent['deadline']==operation['deadline'])
    # An acknowledged owned manifest can be removed before its removal_due;
    # this aborted attempt performed no foundation writes.
    need(a._time(bridge['checked_at'])<=a._time(intent['at'])<=at)
    for receipt in receipts:
        need(receipt.get('request_digest')==digest(operation) and receipt.get('object_id')==operation['url']
            and receipt.get('created_by_run') is True and receipt.get('delete_acknowledged') is True
            and type(receipt.get('delete_status')) is int and receipt['delete_status']==202
            and receipt.get('ack_digest')==digest({'request_digest':digest(operation),'http':202}))
    need(ack['state']=='pending' and ack['http']==202 and ack['terminal'] is False and ack.get('write_terminal') is False
        and ack.get('readback_verified') is False and final['state']=='succeeded' and final['http']==404
        and all(final.get(k) is True for k in ('terminal','write_terminal','readback_verified'))
        and a._time(intent['at'])<=a._time(ack['observed_at'])<=at)
    observations=view.values('registry_reference_observation');need(len(observations)==1);observation=observations[0]
    need(observation['proof_digest']==ack['properties'].get('zero_reference_evidence_digest') and observation['request_digest']==digest(operation))
    def index(event,value):
        found=[i for i,r in enumerate(records) if r['event']==event and r['value']==value];need(len(found)==1);return found[0]
    ordered=[('provision_bridge_intent',bridge),('core_plan',view.values('core_plan')[0]),('provision_bridge_output',bridge),
        ('plan',view.values('plan')[0]),('publication_import',view.values('publication_import')[0]),
        ('provision_bridge_prepared',view.values('provision_bridge_prepared')[0]),('registry_reference_observation',observation),
        ('intent',intent),('progress',ack),('progress',final)]
    positions=[index(e,v) for e,v in ordered];need(positions==sorted(set(positions)))
    need(all(index('progress',view.latest(s+'ImagePush'))<positions[0] for s in ('guardian','runtime')))
    clocks=[a._time(v['at']) for v in view.values('clock_observation')]
    need(clocks==sorted(clocks) and all(t<=at for t in clocks) and all(a._time(v['observed_at'])<=at for v in progress))
    clock=SimpleNamespace(utc=lambda:a._time(intent['at']),monotonic=lambda:0)
    def forbidden(*_):need(False)
    provider=BoundedRegistryProvider(SimpleNamespace(mode='owner'),forbidden,clock,binding=registry,before_send=forbidden,checkpoint=forbidden)
    need(provider.validate_zero_references(operation,push,observation['proof'])==observation['proof_digest'])
    paths=[]
    for slot in ('guardian','runtime'):
        for probe in (False,True):
            path=str(path_type(directory)/('trial-'+slot+('-docker-probe-' if probe else '-docker-')+digest(binding)[:16]));paths.append(path)
            need(view.values(slot+('_docker_probe' if probe else '_docker')+'_config_absent')==[{'absent':True,'path_digest':digest(path)}])
    counter_raw=raw(proof['counter_prefix_raw'])
    state=replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory,verified=previous)
    need(state['rows']==PREFIX_ROWS and len(state['transitions'])==2 and state['plan']==a.phase_plan(previous) and state['counts']==authority['counts_before'])
    caps,reserve,delta=allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps']==caps and authority['unallocated']==reserve and rule['phase_reallocation']==delta)
    return {'proof_sha256':rule['proof_sha256'],'previous_attempt':previous.binding_digest,'previous_plan':a.phase_plan(previous),
        'previous_transitions':state['transitions'],'previous_authority_sha256':a._sha(old_raw),'child_name':child_name,'child_binding':binding,
        'child_sha256':a._sha(child_raw),'child_tail':tail,'docker_paths':paths,'counter_prefix_sha256':a._sha(counter_raw),
        'counter_tail':state['tail'],'counter_rows':state['rows'],'counts':state['counts'],'phase_reallocation':delta,
        'retained_published_runtime':images['runtime_image']}
