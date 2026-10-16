"""Finite V7 succession after the separate single-GET V6 observation.

Retain the old UNKNOWN identity and all reserves. Replace only the Web identity
name/ID after explicit OWNER approval; never adopt, retry or delete the old ID.
Old image publication, manifest and lifetime accounting evidence stay intact.
"""
from copy import deepcopy
from scripts.trial_guard.adapters import digest
from .succession import need, keys, raw

CHILD_NAME = 'trial-provision-successor-v7'
KIND = 'STOPPED_UNKNOWN_IDENTITY_V6_AFTER_READ_ONCE'
PREFIX_ROWS = 199
COUNTS = {'owner_arm':318,'owner_control_blob':32,'heartbeat_blob':0}
EVENTS = ('binding','image_reuse_preparation','image_reuse_readback_intent',
    *('clock_observation',)*6,'image_reuse_readback','provision_bridge_intent',
    *('allocation',)*14,'core_plan','provision_bridge_output','plan','publication_import',
    'provision_bridge_prepared','clock_observation','allocation','intent','progress')


def allocation(previous_plan, used, counts):
    from . import attempt as a
    need(counts == COUNTS and all(type(v) is int for v in counts.values())
        and previous_plan['limits'] == {**a.LIMITS,'owner_arm':631}
        and previous_plan['phase_caps']['owner_arm'] == dict(zip(a.PHASES,(24,8,145,32,120)))
        and previous_plan['unallocated']['owner_arm'] == 0
        and used['owner_arm'] == dict(zip(a.PHASES,(6,6,4,0,0)))
        and all(type(v) is int for phases in used.values() for v in phases.values())
        and all(used[k][p] == 0 for k in ('owner_control_blob','heartbeat_blob') for p in a.PHASES))
    caps = {k:{p:previous_plan['phase_caps'][k][p]-used[k][p] for p in a.PHASES} for k in a.LIMITS}
    before = deepcopy(caps['owner_arm']); caps['owner_arm'] = dict(zip(a.PHASES,(24,6,139,24,120)))
    delta = {'schema':1,'kind':'owner_arm','phase_delta':{p:caps['owner_arm'][p]-before[p] for p in a.PHASES},'unallocated_delta':0}
    need(delta['phase_delta'] == dict(zip(a.PHASES,(6,4,-2,-8,0))) and sum(caps['owner_arm'].values()) == 313)
    return caps,deepcopy(previous_plan['unallocated']),delta


def transition_value(verified):
    from . import attempt as a
    p = a._proof(verified); s = p['succession']; need(p['authority']['schema'] == 7)
    return {'schema':6,'kind':KIND,'previous_attempt':s['previous_attempt'],
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
    need(type(value['schema']) is int and value['schema'] == 6 and value['kind'] == KIND
        and type(value['prefix_rows']) is int and value['prefix_rows'] == PREFIX_ROWS
        and len(prefix_raw.splitlines()) == PREFIX_ROWS and a._sha(prefix_raw) == a._hex(value['prefix_sha256'])
        and a._json(prefix_raw.splitlines()[-1])['hash'] == a._hex(value['prefix_tail'])
        and previous_plan is not None and value['previous_attempt'] == previous_plan['attempt']
        and value['previous_plan_sha256'] == digest(previous_plan) and value['counts'] == counts)
    a._hex(value['authority_sha256']); a._hex(value['proof_sha256'])
    caps,reserve,delta = allocation(previous_plan,used,counts)
    need(value['phase_reallocation'] == delta and type(value['phase_reallocation']['schema']) is int
        and type(value['phase_reallocation']['unallocated_delta']) is int
        and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    rows = [a._json(line) for line in prefix_raw.splitlines()]
    need(rows[148]['event'] == 'attempt_transition' and rows[148]['value']['limit_amendment'] == value['limit_amendment'])
    expected = [('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*6
    expected += [('provision','http')]*2+[('provision','owner_token'),('provision','http')]
    need([(r['value'].get('phase'),r['value'].get('purpose')) for r in rows[183:]] == expected
        and all(r['event'] == 'request' and r['value'].get('kind') == 'owner_arm'
                and r['value'].get('attempt') == previous_plan['attempt'] for r in rows[183:]))
    limits = a._authority_limits({'schema':7,'limit_amendment':value['limit_amendment']})
    plan = value['plan']
    need(type(plan) is dict and plan.get('counts_before') == counts and plan.get('attempt') != previous_plan['attempt']
        and plan.get('phase_caps') == caps and plan.get('unallocated') == reserve and plan.get('limits') == limits
        and plan.get('purpose_caps') == a.OBSERVED_IDENTITY_PURPOSE_CAPS)
    if verified is not None:need(value == transition_value(verified))
    return deepcopy(plan)


def validate_target_amendment(authority, old_manifest, manifest, observation):
    from .resources import _manifest
    amendment = authority['identity_disposition']
    keys(amendment, ('kind','old_resource_id','new_name','new_resource_id','observed_identity_digest',
                     'old_unknown_preserved','old_mutations_authorized','reserves_released'))
    need(amendment['kind'] == 'retain_unknown_replace_web_identity'
        and amendment['old_unknown_preserved'] is True and amendment['old_mutations_authorized'] is False
        and amendment['reserves_released'] is False and observation['status'] == 'current_exists'
        and amendment['observed_identity_digest'] == observation['identity_digest']
        and amendment['old_resource_id'] == old_manifest['ids']['webIdentity'])
    expected = deepcopy(old_manifest)
    expected['names']['webIdentity'] = amendment['new_name']
    expected['ids']['webIdentity'] = amendment['new_resource_id']
    need(manifest == expected and type(amendment['new_resource_id']) is str
        and amendment['new_resource_id'].lower() != amendment['old_resource_id'].lower())
    from scripts.trial_guard.adapters import encoded
    _manifest(manifest, {'manifest':encoded(manifest)})


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a, unknown_observation as observation
    from .journal import replay_control_budget
    from .registry_publish import prepare_publication, verified_publication_images
    rule = authority['succession']
    keys(rule, ('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema'] == 6 and rule['kind'] == KIND and rule['child_name'] == CHILD_NAME)
    proof = ready.get('succession_proof')
    keys(proof, ('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
        'previous_manifest_raw','previous_child_raw','previous_artifacts','stopped_raw','counter_prefix_raw',
        'observation_grant_raw','observation_marker_raw','observation_result_raw','image_compatibility'))
    need(type(proof['schema']) is int and proof['schema'] == 6 and digest(proof) == a._hex(rule['proof_sha256']))
    old_raw = raw(proof['previous_authority_raw']); old = a._json(old_raw)
    need(old.get('schema') == 6 and old.get('approval') == 'ISSUE148_LINKED_ATTEMPT_V6')
    old_manifest_raw = raw(proof['previous_manifest_raw']); old_manifest = a._json(old_manifest_raw)
    need(a._sha(old_manifest_raw) == old['manifest_sha256'] == authority['origin_manifest_sha256'])
    public_raw = raw(proof['previous_publication_raw']); old_config = a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['control_budget'] == config['control_budget']
        and old_config['recovery'] == config['recovery'])
    need(set(old_config['sources']) == set(config['sources']))
    for key in old_config['sources']:
        if key != 'manifest':need(old_config['sources'][key]['sha256'] == config['sources'][key]['sha256'])
    old_config['authority_bundle'] = {**config['authority_bundle'],'manifest':old_manifest_raw}
    keys(proof['previous_artifacts'], a.ARTIFACTS)
    artifacts = {k:raw(v) for k,v in proof['previous_artifacts'].items()}
    previous = a.verify_attempt(old_config,old_manifest,authority_raw=old_raw,
        activation_raw=raw(proof['previous_activation_raw']),parent_journal_raw=parent_journal_raw,
        parent_final_raw=parent_final_raw,artifacts=artifacts,trusted_authority_sha256=a._sha(old_raw),now=now)
    for name in ('owner_id','task_id','budget_binding_sha256','parent','retained_runtime','guardian_prior_digest',
                 'catalog_options','unallocated','limit_amendment','image_build_head','tags'):
        need(authority[name] == old[name])
    need(old['initial_forecast_yen'] <= authority['initial_forecast_yen'] <= 4500
        and authority['head'] != old['head'] and authority['attempt_id'] != old['attempt_id']
        and a._time(authority['publish_from']) > a._time(old['publish_from']))
    for slot in ('guardian','runtime'):
        need(authority['artifact_sha256'][slot+'_build'] == old['artifact_sha256'][slot+'_build'])
    compatibility = proof['image_compatibility']
    keys(compatibility, ('schema','local_head','image_build_head','runtime_tree_sha256','guardian_tree_sha256',
        'runtime_unchanged','guardian_unchanged','review_sha256'))
    need(type(compatibility['schema']) is int and compatibility['schema'] == 1
        and compatibility['local_head'] == authority['head'] and compatibility['image_build_head'] == old['image_build_head']
        and compatibility['runtime_unchanged'] is True and compatibility['guardian_unchanged'] is True)
    for key in ('runtime_tree_sha256','guardian_tree_sha256','review_sha256'):a._hex(compatibility[key])
    child_raw = raw(proof['previous_child_raw']); name,binding = a.journal_descriptor(old_config,previous)
    need(name == 'trial-provision-successor-v6')
    records,tail = a._journal(child_raw,binding); need(tuple(r['event'] for r in records) == EVENTS)
    view = a._ParentView(records)
    prepare_publication({**old_config,'verified_attempt':previous},old_manifest,a._sha(public_raw),view)
    images = verified_publication_images(view,verified_attempt=previous)
    counter_raw = raw(proof['counter_prefix_raw'])
    state = replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,
        directory=config['control_budget']['directory'],verified=previous)
    need(state['rows'] == PREFIX_ROWS and len(state['transitions']) == 5 and state['plan'] == a.phase_plan(previous)
        and state['counts'] == authority['counts_before'] == COUNTS)
    grant_raw = raw(proof['observation_grant_raw']); grant_data = a._json(grant_raw)
    result = a._json(raw(proof['observation_result_raw'])); marker = a._json(raw(proof['observation_marker_raw']))
    evidence = {'counter':b''.join(counter_raw.splitlines(keepends=True)[:197]),'child':child_raw,
                'authority':old_raw,'manifest':old_manifest_raw,'stopped':raw(proof['stopped_raw'])}
    grant = observation.verify_grant(grant_raw,trusted_sha256=a._sha(grant_raw),evidence=evidence,
        source_digests=grant_data['source_digests'],now=a._time(result['observed_at']))
    observation.validate_counter(grant,counter_raw,consumed=['owner_token','http'])
    need(grant_data['attempt'] == previous.binding_digest and grant_data['child_binding'] == binding
        and grant_data['directory'] == config['control_budget']['directory']
        and result['schema'] == 1 and result['kind'] == observation.KIND and result['grant_sha256'] == grant.checksum
        and result['source_digests'] == grant_data['source_digests'] and result['evidence_sha256'] == grant_data['evidence_sha256']
        and result['target_digest'] == digest(grant_data['target']) and result['counter_sha256'] == a._sha(counter_raw)
        and result['counter_rows'] == PREFIX_ROWS and result['counter_tail'] == state['tail']
        and result['counts'] == COUNTS and type(result['requests']) is int and result['requests'] == 2
        and result['automatic_retry'] is False and result['old_unknown_preserved'] is True
        and result['adoption_authorized'] is False and result['deletion_authorized'] is False
        and result['status'] == 'current_exists' and result['http'] == 200
        and result['identity_digest'] == digest(result['identity'])
        and a._time(result['observed_at']) <= a._time(authority['approved_at']))
    need(marker == {'schema':1,'kind':observation.KIND,'grant_sha256':grant.checksum,
        'target_digest':digest(grant_data['target']),'old_attempt':previous.binding_digest,
        'counter_prefix_sha256':grant_data['evidence_sha256']['counter'],'at':marker['at']}
        and a._time(grant_data['start']) <= a._time(marker['at']) <= a._time(result['observed_at']))
    validate_target_amendment(authority,old_manifest,manifest,result)
    caps,reserve,delta = allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps'] == caps and authority['unallocated'] == reserve and rule['phase_reallocation'] == delta)
    old_proof = a._proof(previous)
    return {'child_name':name,'child_binding':binding,'child_sha256':a._sha(child_raw),'child_tail':tail,
        'docker_paths':old_proof['succession']['docker_paths'],'previous_child_records':records,
        'previous_attempt':previous.binding_digest,'previous_plan':state['plan'],'previous_transitions':state['transitions'],
        'previous_verified_proof':old_proof,'previous_publication':a._json(public_raw),
        'previous_authority_sha256':a._sha(old_raw),'counter_prefix_sha256':a._sha(counter_raw),
        'counter_tail':state['tail'],'counter_rows':state['rows'],'counts':state['counts'],
        'phase_reallocation':delta,'proof_sha256':rule['proof_sha256'],'acknowledged_images':images,
        'image_build_head':old['image_build_head'],'origin_manifest':old_manifest,
        'origin_sources':{k:v['sha256'] for k,v in old_config['sources'].items()},
        'new_sources':{k:v['sha256'] for k,v in config['sources'].items()},
        'unknown_identity_receipt':deepcopy(records[-1]['value']),
        'retained_published_runtime':old_proof['succession']['retained_published_runtime']}
