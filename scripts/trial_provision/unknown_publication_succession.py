"""One explicit V5 successor; the stopped V4 push remains UNKNOWN forever.

Pure immutable proof validation only. No Portal observation is an ACK, no old
intent is retried, and no debit, reservation or lifetime limit is reset.
"""
from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath
import re

from scripts.trial_guard.adapters import digest, encoded
from .succession import need, keys, raw, _reallocation

CHILD_NAME = 'trial-provision-successor-v5'
KIND = 'STOPPED_UNKNOWN_PUBLICATION_V4'
PREFIX_ROWS = 158
COUNTS = {'owner_arm':279, 'owner_control_blob':32, 'heartbeat_blob':0}
EVENTS = ('binding','publication_preparation','guardian_docker_probe_directory',
    'guardian_docker_probe_config','guardian_docker_probe_config_absent','guardian_docker_probe_result',
    'clock_observation','clock_observation','guardian_docker_directory','guardian_docker_config',
    'clock_observation','guardian_image_namespace','allocation','intent','progress','guardian_docker_config_absent')
REALLOCATION = {'schema':1,'kind':'owner_arm','from_phase':'provision','to_phase':'fresh_read','requests':6}


def allocation(previous_plan, used, counts):
    from .attempt import LIMITS, PHASES
    need(counts == COUNTS and all(type(v) is int for v in counts.values())
        and previous_plan['limits'] == {**LIMITS,'owner_arm':631}
        and previous_plan['phase_caps']['owner_arm'] == dict(zip(PHASES,(24,22,153,42,120)))
        and previous_plan['unallocated']['owner_arm'] == 0
        and used['owner_arm'] == dict(zip(PHASES,(6,3,0,0,0)))
        and all(type(v) is int for phases in used.values() for v in phases.values())
        and all(used[k][p] == 0 for k in ('owner_control_blob','heartbeat_blob') for p in PHASES))
    caps = {k:{p:previous_plan['phase_caps'][k][p]-used[k][p] for p in PHASES} for k in LIMITS}
    caps['owner_arm']['provision'] -= 6
    caps['owner_arm']['fresh_read'] += 6
    need(caps['owner_arm'] == dict(zip(PHASES,(24,19,147,42,120))) and sum(caps['owner_arm'].values()) == 352)
    return caps, deepcopy(previous_plan['unallocated'])


def transition_value(verified):
    from .attempt import _proof, phase_plan
    p = _proof(verified); s = p['succession']; need(p['authority']['schema'] == 5)
    return {'schema':4,'kind':KIND,'previous_attempt':s['previous_attempt'],
        'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
        'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
        'counts':deepcopy(s['counts']),'authority_sha256':p['authority_sha256'],
        'proof_sha256':s['proof_sha256'],'plan':phase_plan(verified),
        'phase_reallocation':deepcopy(s['phase_reallocation']),
        'limit_amendment':deepcopy(p['authority']['limit_amendment'])}


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from . import attempt as a
    keys(value, ('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
        'prefix_tail','counts','authority_sha256','proof_sha256','plan','phase_reallocation','limit_amendment'))
    need(type(value['schema']) is int and value['schema'] == 4 and value['kind'] == KIND
        and type(value['prefix_rows']) is int and value['prefix_rows'] == PREFIX_ROWS
        and len(prefix_raw.splitlines()) == PREFIX_ROWS and a._sha(prefix_raw) == a._hex(value['prefix_sha256'])
        and a._json(prefix_raw.splitlines()[-1])['hash'] == a._hex(value['prefix_tail']))
    need(previous_plan is not None and value['previous_attempt'] == previous_plan['attempt']
        and value['previous_plan_sha256'] == digest(previous_plan) and value['counts'] == counts)
    a._hex(value['authority_sha256']); a._hex(value['proof_sha256'])
    need(_reallocation(value) == REALLOCATION)
    caps, reserve = allocation(previous_plan, used, counts)
    limits = a._authority_limits({'schema':5,'limit_amendment':value['limit_amendment']})
    # Retain the exact original amendment receipt, including its approval SHA.
    rows = [a._json(line) for line in prefix_raw.splitlines()]
    need(rows[148]['event'] == 'attempt_transition'
        and rows[148]['value']['limit_amendment'] == value['limit_amendment'])
    plan = value['plan']
    need(type(plan) is dict and plan.get('counts_before') == counts and plan.get('attempt') != previous_plan['attempt']
        and plan.get('phase_caps') == caps and plan.get('unallocated') == reserve and plan.get('limits') == limits)
    if verified is not None: need(value == transition_value(verified))
    return deepcopy(plan)


def _child(previous, config, manifest, public_raw, child_raw, approved_at):
    """Validate the exact stopped publisher state without executing its code."""
    from . import attempt as a
    from .registry_publish import prepare_publication
    name, binding = a.journal_descriptor(config, previous)
    need(name == 'trial-provision-successor-v4')
    records, tail = a._journal(child_raw, binding)
    need(tuple(r['event'] for r in records) == EVENTS)
    view = a._ParentView(records)
    # Existing preparation must match; this view has no append method, so a
    # missing preparation cannot silently create a journal or repair evidence.
    config = {**config,'verified_attempt':previous}
    prep = prepare_publication(config, manifest, a._sha(public_raw), view)
    fixed = prep['slots']['guardian']; ident = 'guardianImagePush'
    host = prep['login_server']; repo = fixed['repository']; tag = host+'/'+repo+':'+fixed['tag']
    op = {'id':ident,'provider':'AzureContainerRegistry','kind':'dockerImagePush','method':'PUT',
        'url':'https://'+host+'/v2/'+repo+'/manifests/'+fixed['tag']+'?api-version=2021-07-01',
        'body':{'fixed_tag':tag,'local_image_id':fixed['local_image_id']},'deadline':prep['publish_until'],'depends_on':[],
        'expected':{'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),
            'docker_sha256':fixed['docker_sha256'],'docker_host':fixed['docker_host']},
        'cleanup':{'created_only':True,'purpose':'guardian','retained':False}}
    rd = digest(op)
    directory = config['control_budget']['directory']
    path_type = PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    paths = []
    for start, end, suffix in ((2,4,'-docker-probe-'),(8,15,'-docker-')):
        path = str(path_type(directory)/('trial-guardian'+suffix+digest(binding)[:16])); paths.append(path)
        for index in (start,start+1):
            v = records[index]['value']; keys(v, ('identity','path_digest') if index == start else ('identity',))
            need(type(v['identity']) is list and len(v['identity']) == 2 and all(type(n) is int and n >= 0 for n in v['identity']))
        keys(records[end]['value'], ('absent','path_digest'))
        need(records[end]['value'] == {'absent':True,'path_digest':digest(path)} and records[end]['value']['absent'] is True
            and records[start]['value']['path_digest'] == digest(path))
    probe = records[5]['value']
    keys(probe, ('schema','publication_preparation_digest','run_binding_digest','docker_sha256','docker_host',
        'tag_sha256','local_image_id','empty_config_sha256','checked_at','status','temporary_config_absent',
        'new_owner_token_calls','new_http_requests','automatic_retry'))
    need(type(probe['schema']) is int and probe['schema'] == 1
        and all(probe[k] == fixed[k] for k in ('docker_sha256','docker_host','local_image_id'))
        and probe['publication_preparation_digest'] == digest(prep) and probe['run_binding_digest'] == digest(binding)
        and probe['tag_sha256'] == a._sha(tag.encode()) and probe['empty_config_sha256'] == a._sha(encoded({'auths':{}}))
        and probe['status'] == 'verified' and probe['temporary_config_absent'] is True and probe['automatic_retry'] is False
        and all(type(probe[k]) is int and probe[k] == 0 for k in ('new_owner_token_calls','new_http_requests')))
    clocks = []
    for index in (6,7,10):
        keys(records[index]['value'], ('at',)); clocks.append(a._time(records[index]['value']['at']))
    namespace, allocation_row, intent, receipt = (records[i]['value'] for i in (11,12,13,14))
    keys(namespace, ('publication_preparation_digest','run_binding_digest','registry_id','login_server','repository',
        'authenticated','method','url','http','error_code','response_sha256','observed_at','push_operation_id','push_request_digest'))
    need(namespace == {'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),
        'registry_id':prep['registry_id'],'login_server':host,'repository':repo,'authenticated':True,'method':'GET',
        'url':'https://'+host+'/acr/v1/'+repo+'?api-version=2021-07-01','http':404,'error_code':'NAME_UNKNOWN',
        'response_sha256':a._hex(namespace['response_sha256']),'observed_at':namespace['observed_at'],
        'push_operation_id':ident,'push_request_digest':rd} and type(namespace['http']) is int and namespace['authenticated'] is True)
    keys(allocation_row, ('slot','id'))
    need(allocation_row['slot'] == 'request_'+ident and type(allocation_row['id']) is str
        and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',allocation_row['id']))
    keys(intent, ('operation_id','request_digest','request_id','method','url','deadline','at'))
    need(intent == {'operation_id':ident,'request_digest':rd,'request_id':allocation_row['id'],
        'method':'PUT','url':op['url'],'deadline':op['deadline'],'at':intent['at']})
    keys(receipt, ('operation_id','request_digest','object_id','state','terminal','write_terminal','created_by_run',
        'readback_verified','observed_at','properties'))
    need(receipt == {'operation_id':ident,'request_digest':rd,'object_id':None,'state':'unknown','terminal':False,
        'write_terminal':False,'created_by_run':True,'readback_verified':False,'observed_at':receipt['observed_at'],'properties':{}}
        and all(receipt[k] is False for k in ('terminal','write_terminal','readback_verified')) and receipt['created_by_run'] is True)
    times = [a._time(probe['checked_at']), *clocks, a._time(namespace['observed_at']), a._time(intent['at']), a._time(receipt['observed_at'])]
    need(times == sorted(times) and a._time(previous.authority['publish_from']) <= times[0]
        and times[-1] < a._time(prep['publish_until']) <= a._time(approved_at)
        and 0 <= (a._time(intent['at'])-a._time(namespace['observed_at'])).total_seconds() <= 30)
    return name, binding, tail, paths, rd


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    rule = authority['succession']
    keys(rule, ('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema'] == 4 and rule['kind'] == KIND and rule['child_name'] == CHILD_NAME
        and _reallocation(rule) == REALLOCATION)
    proof = ready.get('succession_proof')
    keys(proof, ('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
        'previous_child_raw','counter_prefix_raw','previous_artifacts'))
    need(type(proof['schema']) is int and proof['schema'] == 4 and digest(proof) == a._hex(rule['proof_sha256']))
    old_raw = raw(proof['previous_authority_raw']); old = a._json(old_raw)
    need(type(old.get('schema')) is int and old['schema'] == 4 and old.get('approval') == 'ISSUE148_LINKED_ATTEMPT_V4')
    public_raw = raw(proof['previous_publication_raw']); old_config = a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['sources'] == config['sources']
        and old_config['control_budget'] == config['control_budget'] and old_config['recovery'] == config['recovery'])
    old_config['authority_bundle'] = config['authority_bundle']
    keys(proof['previous_artifacts'], a.ARTIFACTS)
    artifacts = {k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous = a.verify_attempt(old_config, manifest, authority_raw=old_raw, activation_raw=raw(proof['previous_activation_raw']),
        parent_journal_raw=parent_journal_raw, parent_final_raw=parent_final_raw, artifacts=artifacts,
        trusted_authority_sha256=a._sha(old_raw), now=now)
    for name in ('manifest_sha256','owner_id','task_id','budget_binding_sha256','parent','retained_runtime',
        'guardian_prior_digest','catalog_options','unallocated','limit_amendment'):
        need(authority[name] == old[name])
    need(type(authority['initial_forecast_yen']) is int and old['initial_forecast_yen'] <= authority['initial_forecast_yen'] <= 4500
        and authority['head'] != old['head'] and authority['attempt_id'] != old['attempt_id']
        and a._time(authority['publish_from']) > a._time(old['publish_from']))
    for slot in ('guardian','runtime'):
        need(a._slot(manifest,authority['head'],slot)['tag'] != a._slot(manifest,old['head'],slot)['tag'])
    child_raw = raw(proof['previous_child_raw'])
    name, binding, tail, paths, rd = _child(previous,old_config,manifest,public_raw,child_raw,authority['approved_at'])
    counter_raw = raw(proof['counter_prefix_raw']); directory = config['control_budget']['directory']
    state = replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory,verified=previous)
    need(state['rows'] == PREFIX_ROWS and len(state['transitions']) == 3 and state['plan'] == a.phase_plan(previous)
        and state['counts'] == authority['counts_before'] == COUNTS)
    records = a._journal(counter_raw,{'binding':config['control_budget']['binding'],'seed':a.SEED,'limits':a.LIMITS})[0]
    expected = [('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*3
    need([(r['value'].get('phase'),r['value'].get('purpose')) for r in records[149:]] == expected
        and all(r['event'] == 'request' and r['value'].get('kind') == 'owner_arm' for r in records[149:]))
    caps, reserve = allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps'] == caps and authority['unallocated'] == reserve)
    return {'proof_sha256':rule['proof_sha256'],'previous_attempt':previous.binding_digest,'previous_plan':state['plan'],
        'previous_transitions':state['transitions'],'previous_authority_sha256':a._sha(old_raw),
        'child_name':name,'child_binding':binding,'child_sha256':a._sha(child_raw),'child_tail':tail,'docker_paths':paths,
        'counter_prefix_sha256':a._sha(counter_raw),'counter_tail':state['tail'],'counter_rows':state['rows'],
        'counts':state['counts'],'phase_reallocation':deepcopy(REALLOCATION),'unknown_push_request_digest':rd,
        'retained_published_runtime':a._proof(previous)['succession']['retained_published_runtime']}
