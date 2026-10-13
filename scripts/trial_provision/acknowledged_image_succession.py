"""V6 proof for a stopped first-Identity write and unchanged published images.

Pure validation only. A human's later deletion observation is neither the old
PUT acknowledgement nor a new authenticated absence check. The new controller
must still observe absence before its separately authorized creation.
"""
from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath
import re

from scripts.trial_guard.adapters import digest, encoded
from .succession import need, keys, raw

CHILD_NAME = 'trial-provision-successor-v6'
KIND = 'STOPPED_UNKNOWN_IDENTITY_V5'
PREFIX_ROWS = 182
COUNTS = {'owner_arm':302, 'owner_control_blob':32, 'heartbeat_blob':0}
EVENTS = (
    'binding','publication_preparation','guardian_docker_probe_directory','guardian_docker_probe_config',
    'guardian_docker_probe_config_absent','guardian_docker_probe_result','clock_observation','clock_observation',
    'guardian_docker_directory','guardian_docker_config','clock_observation','guardian_image_namespace',
    'allocation','intent','progress','progress','clock_observation','clock_observation','guardian_image_measurement',
    'progress','guardian_docker_config_absent','runtime_docker_probe_directory','runtime_docker_probe_config',
    'runtime_docker_probe_config_absent','runtime_docker_probe_result','clock_observation','clock_observation',
    'runtime_docker_directory','runtime_docker_config','clock_observation','clock_observation','clock_observation',
    'clock_observation','runtime_image_namespace','allocation','intent','progress','progress','clock_observation',
    'clock_observation','runtime_image_measurement','clock_observation','clock_observation','runtime_image_retention',
    'progress','runtime_docker_config_absent','provision_bridge_intent',
    *('allocation',)*14,'core_plan','provision_bridge_output','plan','publication_import',
    'provision_bridge_prepared','clock_observation','allocation','intent','progress')


def allocation(previous_plan, used, counts):
    from .attempt import LIMITS, PHASES
    need(counts == COUNTS and all(type(v) is int for v in counts.values())
        and previous_plan['limits'] == {**LIMITS,'owner_arm':631}
        and previous_plan['phase_caps']['owner_arm'] == dict(zip(PHASES,(24,19,147,42,120)))
        and previous_plan['unallocated']['owner_arm'] == 0
        and used['owner_arm'] == dict(zip(PHASES,(6,15,2,0,0)))
        and all(type(v) is int for phases in used.values() for v in phases.values())
        and all(used[k][p] == 0 for k in ('owner_control_blob','heartbeat_blob') for p in PHASES))
    caps = {k:{p:previous_plan['phase_caps'][k][p]-used[k][p] for p in PHASES} for k in LIMITS}
    before = deepcopy(caps['owner_arm'])
    caps['owner_arm'] = dict(zip(PHASES,(24,8,145,32,120)))
    delta = {'schema':1,'kind':'owner_arm','phase_delta':{p:caps['owner_arm'][p]-before[p] for p in PHASES},
             'unallocated_delta':0}
    need(sum(delta['phase_delta'].values()) == 0 and sum(caps['owner_arm'].values()) == 329)
    return caps, deepcopy(previous_plan['unallocated']), delta


def previous_verified_attempt(verified):
    from . import attempt as a
    p = a._proof(verified)
    need(p['authority']['schema'] == 6)
    previous = p['succession']['previous_verified_proof']
    need(previous['authority']['schema'] == 5)
    return a.VerifiedAttempt(previous,a._SEAL)


def transition_value(verified):
    from . import attempt as a
    p = a._proof(verified); s = p['succession']; need(p['authority']['schema'] == 6)
    return {'schema':5,'kind':KIND,'previous_attempt':s['previous_attempt'],
        'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
        'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
        'counts':deepcopy(s['counts']),'authority_sha256':p['authority_sha256'],
        'proof_sha256':s['proof_sha256'],'plan':a.phase_plan(verified),
        'phase_reallocation':deepcopy(s['phase_reallocation']),
        'limit_amendment':deepcopy(p['authority']['limit_amendment'])}


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from . import attempt as a
    keys(value, ('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
        'prefix_tail','counts','authority_sha256','proof_sha256','plan','phase_reallocation','limit_amendment'))
    need(type(value['schema']) is int and value['schema'] == 5 and value['kind'] == KIND
        and type(value['prefix_rows']) is int and value['prefix_rows'] == PREFIX_ROWS
        and len(prefix_raw.splitlines()) == PREFIX_ROWS and a._sha(prefix_raw) == a._hex(value['prefix_sha256'])
        and a._json(prefix_raw.splitlines()[-1])['hash'] == a._hex(value['prefix_tail'])
        and previous_plan is not None and value['previous_attempt'] == previous_plan['attempt']
        and value['previous_plan_sha256'] == digest(previous_plan) and value['counts'] == counts)
    a._hex(value['authority_sha256']); a._hex(value['proof_sha256'])
    caps, reserve, delta = allocation(previous_plan,used,counts)
    need(value['phase_reallocation'] == delta
        and type(value['phase_reallocation']['schema']) is int
        and type(value['phase_reallocation']['unallocated_delta']) is int
        and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    rows = [a._json(line) for line in prefix_raw.splitlines()]
    need(rows[148]['event'] == 'attempt_transition'
        and rows[148]['value']['limit_amendment'] == value['limit_amendment'])
    limits = a._authority_limits({'schema':6,'limit_amendment':value['limit_amendment']})
    plan = value['plan']
    need(type(plan) is dict and plan.get('counts_before') == counts and plan.get('attempt') != previous_plan['attempt']
        and plan.get('phase_caps') == caps and plan.get('unallocated') == reserve and plan.get('limits') == limits
        and plan.get('purpose_caps') == a.REUSED_IMAGE_PURPOSE_CAPS)
    if verified is not None:need(value == transition_value(verified))
    return deepcopy(plan)


def _child(previous, config, manifest, public_raw, child_raw, owner_raw, approved_at):
    from . import attempt as a
    from .registry_publish import prepare_publication, verified_publication_images
    from .resources import _operation, canonical_region, RETENTION_END
    name,binding = a.journal_descriptor(config,previous)
    need(name == 'trial-provision-successor-v5')
    records,tail = a._journal(child_raw,binding)
    need(tuple(r['event'] for r in records) == EVENTS)
    view = a._ParentView(records)
    prep = prepare_publication({**config,'verified_attempt':previous},manifest,a._sha(public_raw),view)
    images = verified_publication_images(view,verified_attempt=previous)
    need([v['operation_id'] for v in view.values('intent')] == ['guardianImagePush','runtimeImagePush','webIdentity'])
    need(all(v['operation_id'] in ('guardianImagePush','runtimeImagePush','webIdentity') for v in view.values('progress')))
    rid = manifest['ids']['webIdentity']
    op = _operation('webIdentity','Microsoft.ManagedIdentity','userAssignedIdentities',rid,'2023-01-31',
        {'location':canonical_region(manifest['region'])},previous.activation['windows']['owner_input']['end'],[],
        {'location':canonical_region(manifest['region'])},receipt_properties=['principalId','tenantId','clientId'])
    op['cleanup']['deadline'] = RETENTION_END
    intent = view.values('intent')[-1]; receipt = view.latest('webIdentity')
    keys(intent, ('operation_id','request_digest','request_id','method','url','deadline','at'))
    need(intent['operation_id'] == 'webIdentity' and intent['request_digest'] == digest(op)
        and intent['method'] == 'PUT' and intent['url'] == op['url'] and intent['deadline'] == op['deadline'])
    keys(receipt, ('operation_id','request_digest','object_id','state','terminal','write_terminal','created_by_run',
        'readback_verified','observed_at','properties','http','initial_ack_digest'))
    need(receipt == {'operation_id':'webIdentity','request_digest':digest(op),'object_id':rid,'state':'unknown',
        'terminal':False,'write_terminal':False,'created_by_run':True,'readback_verified':False,
        'observed_at':receipt['observed_at'],'properties':{},'http':201,'initial_ack_digest':a._hex(receipt['initial_ack_digest'])}
        and type(receipt['http']) is int and all(receipt[k] is False for k in ('terminal','write_terminal','readback_verified'))
        and receipt['created_by_run'] is True)
    need(a._time(previous.activation['windows']['guardian']['start']) <= a._time(intent['at'])
        <= a._time(receipt['observed_at']) < a._time(intent['deadline']))
    plan = view.values('plan')[0]; core = view.values('core_plan')[0]
    need(plan['operations']['webIdentity'] == op and plan['resource_bindings']['code_sha'] == previous.authority['head']
        and all(plan['resource_bindings'][k] == v for k,v in images.items()))
    imported = view.values('publication_import')[0]
    need(imported == {'schema':1,'initial_plan_digest':digest(plan),'publication_preparation_digest':digest(prep),
        'run_binding_digest':digest(binding),'push_receipt_digests':{s:digest(view.latest(s+'ImagePush')) for s in ('guardian','runtime')}})
    bridge = view.values('provision_bridge_intent')[0]
    need(view.values('provision_bridge_output') == [bridge] and bridge['publication_config_sha256'] == a._sha(public_raw)
        and bridge['code_sha'] == previous.authority['head'] and bridge['run_binding_digest'] == digest(binding)
        and bridge['image_receipt_digests'] == imported['push_receipt_digests'])
    need(view.values('provision_bridge_prepared') == [{'binding_digest':digest(bridge),'plan_digest':digest(plan),
        'core_plan_digest':digest(core),'publication_import_digest':digest(imported)}])
    directory = config['control_budget']['directory']
    path_type = PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    paths = []
    for slot in ('guardian','runtime'):
        for event,suffix in (('_docker_probe','-docker-probe-'),('_docker','-docker-')):
            path = str(path_type(directory)/('trial-'+slot+suffix+digest(binding)[:16]));paths.append(path)
            need(view.values(slot+event+'_config_absent') == [{'absent':True,'path_digest':digest(path)}])
            need(view.values(slot+event+'_directory')[0]['path_digest'] == digest(path))
        probe = view.values(slot+'_docker_probe_result')[0]
        need(probe['status'] == 'verified' and probe['temporary_config_absent'] is True
            and probe['publication_preparation_digest'] == digest(prep) and probe['run_binding_digest'] == digest(binding)
            and all(type(probe[k]) is int and probe[k] == 0 for k in ('new_owner_token_calls','new_http_requests')))
    owner = a._json(owner_raw)
    need(type(owner.get('schema')) is int and owner['schema'] == 1
        and owner.get('kind') == 'direct_owner_portal_cleanup_observation' and owner.get('resource_id') == rid
        and owner.get('reported_delete_success_notification') is True and owner.get('reported_absence_after_refresh') is True
        and all(owner.get(k) is False for k in ('machine_delete_ack','machine_authenticated_absence',
            'historical_put_ack_reconstructed','new_trial_or_window_authorized','new_trial_or_window_issued','goal_complete'))
        and owner.get('old_unknown_preserved') is True and owner.get('monetary_reservations_preserved') is True
        and owner.get('known_published_images_retained') is True and owner.get('portal_request_count') is None
        and owner.get('counts') == COUNTS and owner.get('counter_rows') == PREFIX_ROWS
        and owner.get('child_sha256') == a._sha(child_raw)
        and a._time(receipt['observed_at']) <= a._time(owner['recorded_at']) <= a._time(approved_at))
    return {'child_name':name,'child_binding':binding,'child_sha256':a._sha(child_raw),'child_tail':tail,
        'docker_paths':paths,'previous_child_records':records,'publication_preparation':prep,
        'acknowledged_images':images,'unknown_identity_receipt':receipt,'owner_cleanup_sha256':a._sha(owner_raw)}


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    rule = authority['succession']
    keys(rule, ('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema'] == 5 and rule['kind'] == KIND and rule['child_name'] == CHILD_NAME)
    proof = ready.get('succession_proof')
    keys(proof, ('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
        'previous_child_raw','counter_prefix_raw','previous_artifacts','owner_cleanup_raw','image_compatibility'))
    need(type(proof['schema']) is int and proof['schema'] == 5 and digest(proof) == a._hex(rule['proof_sha256']))
    old_raw = raw(proof['previous_authority_raw']); old = a._json(old_raw)
    need(type(old.get('schema')) is int and old['schema'] == 5 and old.get('approval') == 'ISSUE148_LINKED_ATTEMPT_V5')
    public_raw = raw(proof['previous_publication_raw']); old_config = a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['sources'] == config['sources']
        and old_config['control_budget'] == config['control_budget'] and old_config['recovery'] == config['recovery'])
    old_config['authority_bundle'] = config['authority_bundle']
    keys(proof['previous_artifacts'],a.ARTIFACTS)
    artifacts = {k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous = a.verify_attempt(old_config,manifest,authority_raw=old_raw,activation_raw=raw(proof['previous_activation_raw']),
        parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,artifacts=artifacts,
        trusted_authority_sha256=a._sha(old_raw),now=now)
    for name in ('manifest_sha256','owner_id','task_id','budget_binding_sha256','parent','retained_runtime',
                 'guardian_prior_digest','catalog_options','unallocated','limit_amendment'):
        need(authority[name] == old[name])
    need(old['initial_forecast_yen'] <= authority['initial_forecast_yen'] <= 4500
        and authority['head'] != old['head'] and authority['image_build_head'] == old['head']
        and authority['attempt_id'] != old['attempt_id'] and authority['tags'] == old['tags']
        and a._time(authority['publish_from']) > a._time(old['publish_from']))
    for slot in ('guardian','runtime'):
        need(authority['artifact_sha256'][slot+'_build'] == old['artifact_sha256'][slot+'_build'])
    compatibility = proof['image_compatibility']
    keys(compatibility, ('schema','local_head','image_build_head','runtime_tree_sha256','guardian_tree_sha256',
        'runtime_unchanged','guardian_unchanged','review_sha256'))
    need(type(compatibility['schema']) is int and compatibility['schema'] == 1
        and compatibility['local_head'] == authority['head'] and compatibility['image_build_head'] == old['head']
        and compatibility['runtime_unchanged'] is True and compatibility['guardian_unchanged'] is True)
    for key in ('runtime_tree_sha256','guardian_tree_sha256','review_sha256'):a._hex(compatibility[key])
    child_raw = raw(proof['previous_child_raw']); owner_raw = raw(proof['owner_cleanup_raw'])
    result = _child(previous,old_config,manifest,public_raw,child_raw,owner_raw,authority['approved_at'])
    counter_raw = raw(proof['counter_prefix_raw'])
    state = replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,
        directory=config['control_budget']['directory'],verified=previous)
    need(state['rows'] == PREFIX_ROWS and len(state['transitions']) == 4 and state['plan'] == a.phase_plan(previous)
        and state['counts'] == authority['counts_before'] == COUNTS
        and a._json(owner_raw)['counter_sha256'] == a._sha(counter_raw))
    records = a._journal(counter_raw,{'binding':config['control_budget']['binding'],'seed':a.SEED,'limits':a.LIMITS})[0]
    expected = [('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*15+[('provision','http')]*2
    need([(r['value'].get('phase'),r['value'].get('purpose')) for r in records[159:]] == expected
        and all(r['event'] == 'request' and r['value'].get('kind') == 'owner_arm' for r in records[159:]))
    caps,reserve,delta = allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps'] == caps and authority['unallocated'] == reserve and rule['phase_reallocation'] == delta)
    return {**result,'proof_sha256':rule['proof_sha256'],'previous_attempt':previous.binding_digest,'previous_plan':state['plan'],
        'previous_transitions':state['transitions'],'previous_authority_sha256':a._sha(old_raw),
        'previous_verified_proof':a._proof(previous),'previous_publication':a._json(public_raw),
        'previous_build_artifacts':{s:a._json(artifacts[s+'_build']) for s in ('guardian','runtime')},
        'image_build_head':old['head'],'counter_prefix_sha256':a._sha(counter_raw),'counter_tail':state['tail'],
        'counter_rows':state['rows'],'counts':state['counts'],'phase_reallocation':delta,
        'retained_published_runtime':a._proof(previous)['succession']['retained_published_runtime']}
