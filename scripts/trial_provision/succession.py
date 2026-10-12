"""One approved successor of the stopped, pre-push attempt; pure proof helpers.

No authority issuance, clocks, files, credentials, refunds or recursive restart.
Only ControlBudget.begin_attempt may append the derived transition, under locks.
"""
from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied

CHILD_NAME = 'trial-provision-successor'
PREFIX_ROWS = 71
COUNTS = {'owner_arm':195, 'owner_control_blob':32, 'heartbeat_blob':0}
EVENTS = ('binding','publication_preparation','clock_observation','clock_observation',
          'guardian_docker_directory','guardian_docker_config','guardian_docker_config_absent')


def need(value, reason='attempt_succession'):
    if not value: raise Denied(reason)


def keys(value, names):
    need(type(value) is dict and set(value) == set(names))


def raw(value):
    need(type(value) is str and 0 < len(value.encode('utf-8')) <= 4*1024*1024)
    return value.encode('utf-8')


def _reallocation(source):
    if 'phase_reallocation' not in source:return None
    value=source['phase_reallocation']
    keys(value, ('schema','kind','from_phase','to_phase','requests'))
    need(type(value['schema']) is int and type(value['requests']) is int and value=={
        'schema':1,'kind':'owner_arm','from_phase':'provision','to_phase':'fresh_read','requests':6})
    return deepcopy(value)


def _remaining(plan,used,reallocation):
    from .attempt import LIMITS, PHASES
    remaining={kind:{phase:plan['phase_caps'][kind][phase]-used[kind][phase]
        for phase in PHASES} for kind in LIMITS}
    if reallocation is not None:
        need(remaining['owner_arm']['provision']>=6)
        remaining['owner_arm']['provision']-=6;remaining['owner_arm']['fresh_read']+=6
    return remaining


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    rule=authority['succession']
    keys(rule, ('schema','kind','proof_sha256','child_name')+(('phase_reallocation',) if 'phase_reallocation' in rule else ()))
    reallocation=_reallocation(rule)
    need(type(rule['schema']) is int and rule['schema']==1 and rule['kind']=='STOPPED_BEFORE_PUSH_V1'
         and rule['child_name']==CHILD_NAME)
    proof=ready.get('succession_proof')
    keys(proof, ('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
                 'previous_child_raw','counter_prefix_raw','previous_artifacts'))
    need(type(proof['schema']) is int and proof['schema']==1 and digest(proof)==a._hex(rule['proof_sha256']))
    old_authority_raw=raw(proof['previous_authority_raw']); old_authority=a._json(old_authority_raw)
    # A second V2 predecessor can never recurse or regenerate the allowance.
    need(old_authority.get('schema')==1 and type(old_authority.get('schema')) is int
         and old_authority.get('approval')=='ISSUE148_LINKED_ATTEMPT_V1')
    old_activation_raw=raw(proof['previous_activation_raw'])
    old_publication_raw=raw(proof['previous_publication_raw']); old_config=a._json(old_publication_raw)
    need('authority_bundle' not in old_config and old_config['sources']==config['sources']
         and old_config['control_budget']==config['control_budget'] and old_config['recovery']==config['recovery'])
    old_config['authority_bundle']=config['authority_bundle']
    keys(proof['previous_artifacts'], a.ARTIFACTS)
    old_artifacts={k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous=a.verify_attempt(old_config,manifest,authority_raw=old_authority_raw,activation_raw=old_activation_raw,
        parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,artifacts=old_artifacts,
        trusted_authority_sha256=a._sha(old_authority_raw),now=now)
    for name in ('manifest_sha256','owner_id','task_id','budget_binding_sha256','parent','retained_runtime',
                 'guardian_prior_digest','catalog_options','initial_forecast_yen','unallocated'):
        need(authority[name]==old_authority[name])
    need(authority['attempt_id']!=old_authority['attempt_id'] and authority['head']!=old_authority['head']
         and authority['publish_from']!=old_authority['publish_from'])
    child_name,child_binding=a.journal_descriptor(old_config,previous)
    need(child_name==a.CHILD_JOURNAL)
    child_raw=raw(proof['previous_child_raw']); child,child_tail=a._journal(child_raw,child_binding)
    need(tuple(r['event'] for r in child)==EVENTS)
    prep=child[1]['value']
    keys(prep, ('schema','code_sha','configuration_sha256','login_server','manifest_sha256','owner_id',
                'publish_until','registry_id','run_binding_digest','slots','source_sha256','tenant_id'))
    need(type(prep['schema']) is int and prep['schema']==1 and prep['code_sha']==old_authority['head']
         and prep['configuration_sha256']==a._sha(old_publication_raw)
         and prep['manifest_sha256']==old_authority['manifest_sha256'] and prep['owner_id']==old_authority['owner_id']
         and prep['tenant_id']==manifest['owner']['tenant_id'] and prep['registry_id']==manifest['existing']['registry']
         and prep['login_server']==manifest['registry']['loginServer'] and prep['run_binding_digest']==digest(child_binding)
         and prep['publish_until']==previous.activation['windows']['publication']['end']
         and prep['source_sha256']=={k:v['sha256'] for k,v in config['sources'].items()})
    keys(prep['slots'], ('guardian','runtime'))
    for slot in ('guardian','runtime'):
        value=prep['slots'][slot]; source=old_config['publication']['slots'][slot]
        keys(value, ('repository','tag','local_image_id','docker_sha256','docker_path_sha256','docker_host','build_receipt_sha256'))
        expected=a._slot(manifest,old_authority['head'],slot)
        need(value['repository']==expected['repository'] and value['tag']==expected['tag']
             and value['local_image_id']==source['local_image_id'] and value['docker_sha256']==source['docker_sha256']
             and value['docker_host']==source['docker_host'] and value['docker_path_sha256']==a._sha(source['docker_path'].encode())
             and value['build_receipt_sha256']==source['build_receipt']['sha256'])
    clocks=[]
    for row in child[2:4]:
        keys(row['value'], ('at',)); clocks.append(a._time(row['value']['at']))
    need(a._time(old_authority['publish_from'])<=clocks[0]<=clocks[1]
         <a._time(prep['publish_until']) and clocks[1]<=a._time(authority['approved_at']))
    directory=config['control_budget']['directory']
    path_type=PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    config_path=str(path_type(directory)/('trial-guardian-docker-'+digest(child_binding)[:16]))
    for index in (4,5):
        value=child[index]['value'];keys(value, ('identity','path_digest') if index==4 else ('identity',))
        need(type(value['identity']) is list and len(value['identity'])==2
             and all(type(x) is int and x>=0 for x in value['identity']))
    keys(child[6]['value'], ('absent','path_digest'))
    need(child[4]['value']['path_digest']==child[6]['value']['path_digest']==digest(config_path)
         and child[6]['value']['absent'] is True)
    counter_raw=raw(proof['counter_prefix_raw'])
    counter=a._journal(counter_raw,{'binding':config['control_budget']['binding'],'seed':a.SEED,'limits':a.LIMITS})[0]
    need(len(counter)==PREFIX_ROWS and counter[62]['event']=='phase_plan' and counter[62]['value']==a.phase_plan(previous))
    need(all(r['event'] not in ('attempt_transition',) for r in counter))
    state=replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory)
    expected_requests=[('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*2
    need([(r['value'].get('phase'),r['value'].get('purpose')) for r in counter[63:]]==expected_requests
         and all(r['event']=='request' and r['value'].get('kind')=='owner_arm' for r in counter[63:]))
    need(state['counts']==COUNTS and authority['counts_before']==COUNTS and state['plan']==a.phase_plan(previous))
    remaining=_remaining(state['plan'],state['used'],reallocation)
    need(authority['phase_caps']==remaining)
    result={'proof_sha256':rule['proof_sha256'],'previous_attempt':previous.binding_digest,
            'previous_authority_sha256':a._sha(old_authority_raw),'previous_activation_sha256':a._sha(old_activation_raw),
            'previous_plan':a.phase_plan(previous),'child_binding':child_binding,'child_sha256':a._sha(child_raw),
            'child_tail':child_tail,'docker_path':config_path,'counter_prefix_sha256':a._sha(counter_raw),
            'counter_tail':a._journal(counter_raw,{'binding':config['control_budget']['binding'],'seed':a.SEED,'limits':a.LIMITS})[1],
            'counter_rows':PREFIX_ROWS,'counts':deepcopy(COUNTS)}
    if reallocation is not None:result['phase_reallocation']=reallocation
    return result


def transition_value(verified):
    from .attempt import _proof, phase_plan
    proof=_proof(verified); s=proof.get('succession');need(type(s) is dict)
    result={'schema':1,'kind':'STOPPED_BEFORE_PUSH_V1','previous_attempt':s['previous_attempt'],
            'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
            'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
            'counts':deepcopy(s['counts']),'authority_sha256':proof['authority_sha256'],
            'proof_sha256':s['proof_sha256'],'plan':phase_plan(verified)}
    if 'phase_reallocation' in s:result['phase_reallocation']=deepcopy(s['phase_reallocation'])
    return result


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from .attempt import _sha, _hex, _json
    keys(value, ('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
                 'prefix_tail','counts','authority_sha256','proof_sha256','plan')+(('phase_reallocation',) if 'phase_reallocation' in value else ()))
    reallocation=_reallocation(value)
    need(type(value['schema']) is int and value['schema']==1 and value['kind']=='STOPPED_BEFORE_PUSH_V1')
    need(type(value['prefix_rows']) is int and value['prefix_rows']==PREFIX_ROWS
         and len(prefix_raw.splitlines())==PREFIX_ROWS and _sha(prefix_raw)==_hex(value['prefix_sha256'])
         and _json(prefix_raw.splitlines()[-1])['hash']==_hex(value['prefix_tail']))
    need(previous_plan is not None and value['previous_attempt']==previous_plan['attempt']
         and value['previous_plan_sha256']==digest(previous_plan) and value['counts']==counts==COUNTS)
    _hex(value['authority_sha256']);_hex(value['proof_sha256'])
    plan=value['plan'];need(type(plan) is dict and plan.get('counts_before')==counts
        and plan.get('attempt')!=previous_plan['attempt'] and plan.get('unallocated')==previous_plan['unallocated'])
    remaining=_remaining(previous_plan,used,reallocation)
    need(plan.get('phase_caps')==remaining)
    if verified is not None:need(value==transition_value(verified))
    return deepcopy(plan)
