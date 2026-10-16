"""One finite V7 continuation after a local bridge failed before any write.

Successful metadata and digest observations remain historical evidence. They
do not authorize another observation or replace later live preflight checks.
The immutable prefix and every remaining phase/purpose limit are inherited.
"""
from copy import deepcopy
from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import parse
from .succession import need, keys, raw

CHILD_NAME = 'trial-provision-continuation-v7r1'
KIND = 'STOPPED_V7_BRIDGE_AFTER_READBACK'
PREFIX_ROWS = 212
COUNTS = {'owner_arm': 330, 'owner_control_blob': 32, 'heartbeat_blob': 0}
EVENTS = ('binding', 'image_reuse_preparation', 'image_reuse_readback_intent',
          *('clock_observation',) * 6, 'image_reuse_readback')


def allocation(previous_plan, used, counts):
    from . import attempt as a
    need(counts == COUNTS and all(type(v) is int for v in counts.values())
         and previous_plan['limits'] == {**a.LIMITS, 'owner_arm': 631}
         and previous_plan['phase_caps']['owner_arm'] == dict(zip(a.PHASES, (24, 6, 139, 24, 120)))
         and previous_plan['purpose_caps'] == a.OBSERVED_IDENTITY_PURPOSE_CAPS
         and previous_plan['unallocated']['owner_arm'] == 0
         and used['owner_arm'] == dict(zip(a.PHASES, (6, 6, 0, 0, 0)))
         and all(type(v) is int for phases in used.values() for v in phases.values())
         and all(used[k][p] == 0 for k in ('owner_control_blob', 'heartbeat_blob') for p in a.PHASES))
    caps = {k: {p: previous_plan['phase_caps'][k][p] - used[k][p] for p in a.PHASES} for k in a.LIMITS}
    need(caps['owner_arm'] == dict(zip(a.PHASES, (18, 0, 139, 24, 120))))
    delta = {'schema': 1, 'kind': 'owner_arm', 'phase_delta': {p: 0 for p in a.PHASES}, 'unallocated_delta': 0}
    return caps, deepcopy(previous_plan['unallocated']), delta


def transition_value(verified):
    from . import attempt as a
    p = a._proof(verified); s = p['succession']; need(p['authority']['schema'] == 8)
    return {'schema': 7, 'kind': KIND, 'previous_attempt': s['previous_attempt'],
        'previous_plan_sha256': digest(s['previous_plan']), 'prefix_rows': s['counter_rows'],
        'prefix_sha256': s['counter_prefix_sha256'], 'prefix_tail': s['counter_tail'],
        'counts': deepcopy(s['counts']), 'authority_sha256': p['authority_sha256'],
        'proof_sha256': s['proof_sha256'], 'plan': a.phase_plan(verified),
        'phase_reallocation': deepcopy(s['phase_reallocation']),
        'limit_amendment': deepcopy(p['authority']['limit_amendment'])}


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from . import attempt as a
    keys(value, ('schema', 'kind', 'previous_attempt', 'previous_plan_sha256', 'prefix_rows', 'prefix_sha256',
        'prefix_tail', 'counts', 'authority_sha256', 'proof_sha256', 'plan', 'phase_reallocation', 'limit_amendment'))
    need(type(value['schema']) is int and value['schema'] == 7 and value['kind'] == KIND
         and type(value['prefix_rows']) is int and value['prefix_rows'] == PREFIX_ROWS
         and len(prefix_raw.splitlines()) == PREFIX_ROWS and a._sha(prefix_raw) == a._hex(value['prefix_sha256'])
         and a._json(prefix_raw.splitlines()[-1])['hash'] == a._hex(value['prefix_tail'])
         and previous_plan is not None and value['previous_attempt'] == previous_plan['attempt']
         and value['previous_plan_sha256'] == digest(previous_plan) and value['counts'] == counts)
    a._hex(value['authority_sha256']); a._hex(value['proof_sha256'])
    caps, reserve, delta = allocation(previous_plan, used, counts)
    need(value['phase_reallocation'] == delta and type(value['phase_reallocation']['schema']) is int
         and type(value['phase_reallocation']['unallocated_delta']) is int
         and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    rows = [a._json(line) for line in prefix_raw.splitlines()]
    need(rows[199]['event'] == 'attempt_transition'
         and rows[199]['value']['limit_amendment'] == value['limit_amendment'])
    expected = [('fresh_read', 'owner_token')] + [('fresh_read', 'http')] * 5 + [('publication', 'http')] * 6
    need([(r['value'].get('phase'), r['value'].get('purpose')) for r in rows[200:]] == expected
         and all(r['event'] == 'request' and r['value'].get('kind') == 'owner_arm'
                 and r['value'].get('attempt') == previous_plan['attempt'] for r in rows[200:]))
    plan = value['plan']
    need(type(plan) is dict and plan.get('counts_before') == counts and plan.get('attempt') != previous_plan['attempt']
         and plan.get('phase_caps') == caps and plan.get('unallocated') == reserve
         and plan.get('limits') == a._authority_limits({'schema': 8, 'limit_amendment': value['limit_amendment']})
         and plan.get('purpose_caps') == a.READBACK_CONTINUATION_PURPOSE_CAPS)
    if verified is not None: need(value == transition_value(verified))
    return deepcopy(plan)


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    from .registry_publish import prepare_publication, verified_publication_images
    rule = authority['succession']
    keys(rule, ('schema', 'kind', 'proof_sha256', 'child_name', 'phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema'] == 7 and rule['kind'] == KIND and rule['child_name'] == CHILD_NAME)
    proof = ready.get('succession_proof')
    keys(proof, ('schema', 'previous_authority_raw', 'previous_activation_raw', 'previous_publication_raw',
        'previous_child_raw', 'previous_artifacts', 'stopped_raw', 'counter_prefix_raw', 'fresh_intent_raw', 'fresh_result_raw', 'image_compatibility'))
    need(type(proof['schema']) is int and proof['schema'] == 7 and digest(proof) == a._hex(rule['proof_sha256']))
    old_raw = raw(proof['previous_authority_raw']); old = a._json(old_raw)
    need(old.get('schema') == 7 and old.get('approval') == 'ISSUE148_LINKED_ATTEMPT_V7')
    public_raw = raw(proof['previous_publication_raw']); old_config = a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['control_budget'] == config['control_budget']
         and old_config['recovery'] == config['recovery']
         and {k:v['sha256'] for k,v in old_config['sources'].items()} == {k:v['sha256'] for k,v in config['sources'].items()})
    old_config['authority_bundle'] = config['authority_bundle']
    keys(proof['previous_artifacts'], a.ARTIFACTS)
    previous = a.verify_attempt(old_config, manifest, authority_raw=old_raw,
        activation_raw=raw(proof['previous_activation_raw']), parent_journal_raw=parent_journal_raw,
        parent_final_raw=parent_final_raw, artifacts={k:raw(v) for k,v in proof['previous_artifacts'].items()},
        trusted_authority_sha256=a._sha(old_raw), now=now)
    for name in ('owner_id', 'task_id', 'budget_binding_sha256', 'parent', 'retained_runtime', 'guardian_prior_digest',
                 'catalog_options', 'unallocated', 'limit_amendment', 'image_build_head', 'tags',
                 'manifest_sha256', 'origin_manifest_sha256', 'identity_disposition'):
        need(authority[name] == old[name])
    need(old['initial_forecast_yen'] <= authority['initial_forecast_yen'] <= 4500
         and authority['head'] != old['head'] and authority['attempt_id'] != old['attempt_id']
         and a._time(authority['publish_from']) > a._time(old['publish_from']))
    for slot in ('guardian', 'runtime'):
        need(authority['artifact_sha256'][slot+'_build'] == old['artifact_sha256'][slot+'_build'])
    compatibility = proof['image_compatibility']
    keys(compatibility, ('schema', 'local_head', 'image_build_head', 'runtime_tree_sha256', 'guardian_tree_sha256',
        'runtime_unchanged', 'guardian_unchanged', 'review_sha256'))
    need(type(compatibility['schema']) is int and compatibility['schema'] == 1
         and compatibility['local_head'] == authority['head'] and compatibility['image_build_head'] == old['image_build_head']
         and compatibility['runtime_unchanged'] is True and compatibility['guardian_unchanged'] is True)
    for key in ('runtime_tree_sha256', 'guardian_tree_sha256', 'review_sha256'): a._hex(compatibility[key])
    child_raw = raw(proof['previous_child_raw']); name, binding = a.journal_descriptor(old_config, previous)
    need(name == 'trial-provision-successor-v7')
    records, tail = a._journal(child_raw, binding); need(tuple(r['event'] for r in records) == EVENTS)
    view = a._ParentView(records)
    prepare_publication({**old_config, 'verified_attempt': previous}, manifest, a._sha(public_raw), view)
    images = verified_publication_images(view, verified_attempt=previous)
    counter_raw = raw(proof['counter_prefix_raw'])
    state = replay_control_budget(counter_raw, binding=config['control_budget']['binding'], seed=a.SEED,
        directory=config['control_budget']['directory'], verified=previous)
    need(state['rows'] == PREFIX_ROWS and len(state['transitions']) == 6 and state['plan'] == a.phase_plan(previous)
         and state['counts'] == authority['counts_before'] == COUNTS)
    fresh_raw = raw(proof['fresh_result_raw']); fresh = a._json(fresh_raw)
    fresh_intent = a._json(raw(proof['fresh_intent_raw']))
    need(all(fresh_intent[k] == fresh[k] for k in
             ('schema', 'head', 'attempt_binding_digest', 'started_at', 'counts_before', 'cloud_mutations', 'automatic_retry'))
         and fresh_intent['status'] == 'unconfirmed' and fresh_intent['maximum_owner_arm_debits'] == 6
         and fresh_intent['requests'] == [] and fresh_intent['metadata'] == {} and fresh_intent['ip_checked'] is False
         and fresh_intent['metadata_basis'] == a._json(raw(proof['previous_artifacts']['local_ready']))['metadata_basis'])
    need(fresh['schema'] == 1 and fresh['head'] == old['head'] and fresh['attempt_binding_digest'] == previous.binding_digest
         and fresh['status'] == 'fixed_metadata_verified' and fresh['cloud_mutations'] == 0
         and fresh['automatic_retry'] is False and fresh['ip_checked'] is True and len(fresh['ip_sources']) == 2
         and fresh['counts_before'] == old['counts_before']
         and fresh['counts_after'] == {**COUNTS, 'owner_arm': 324}
         and [r['alias'] for r in fresh['requests']] == ['registry', 'environment', 'ai', 'normal', 'fast']
         and all(type(r['http']) is int and r['http'] == 200 for r in fresh['requests'])
         and a._time(previous.activation['windows']['publication']['start']) <= parse(fresh['started_at'])
         <= parse(fresh['completed_at']) < a._time(previous.activation['windows']['publication']['end']))
    from datetime import timedelta
    observed = [parse(r['value']['at']) for r in records if r['event'] == 'clock_observation']
    checks = view.values('image_reuse_readback')[0]['checks']
    guardian_at, runtime_at = (parse(checks[slot]['observed_at']) for slot in ('guardian', 'runtime'))
    need(observed == sorted(observed) and observed[2] <= guardian_at <= observed[3] and observed[5] <= runtime_at)
    observed += [guardian_at, runtime_at]
    need(all(parse(fresh['completed_at']) <= at <= parse(fresh['completed_at']) + timedelta(minutes=15)
             and at < a._time(previous.activation['windows']['publication']['end']) for at in observed))
    stopped = a._json(raw(proof['stopped_raw']))
    need(stopped['status'] == 'STOPPED_V7_LOCAL_BRIDGE_BEFORE_RESOURCE_WRITES'
         and stopped['head'] == old['head'] and stopped['counts'] == COUNTS
         and stopped['counter_rows'] == PREFIX_ROWS and stopped['child_rows'] == len(EVENTS)
         and stopped['child_tail'] == tail and stopped['new_resource_write_intents'] == 0
         and stopped['bridge_intent_created'] is False and stopped['core_plan_created'] is False
         and stopped['old_unknown_preserved'] is True and stopped['reserves_released'] is False
         and stopped['automatic_retry'] is False and stopped['operator_closed'] is True
         and stopped['owner_token_pool_closed'] is True
         and all(stopped['evidence'][k]['sha256'] == checksum for k, checksum in
                 {'counter': a._sha(counter_raw), 'child': a._sha(child_raw), 'authority': a._sha(old_raw),
                  'fresh_result': a._sha(fresh_raw)}.items())
         and max(observed) <= parse(stopped['recorded_at']) <= a._time(authority['approved_at']))
    caps, reserve, delta = allocation(state['plan'], state['used'], state['counts'])
    need(authority['phase_caps'] == caps and authority['unallocated'] == reserve and rule['phase_reallocation'] == delta
         and stopped['remaining_owner_arm'] == caps['owner_arm'])
    old_proof = a._proof(previous); source = old_proof['succession']
    return {'child_name': name, 'child_binding': binding, 'child_sha256': a._sha(child_raw), 'child_tail': tail,
        'docker_paths': source['docker_paths'], 'previous_child_records': records,
        'previous_attempt': previous.binding_digest, 'previous_plan': state['plan'], 'previous_transitions': state['transitions'],
        'previous_verified_proof': old_proof, 'previous_publication': a._json(public_raw),
        'previous_authority_sha256': a._sha(old_raw), 'counter_prefix_sha256': a._sha(counter_raw),
        'counter_tail': state['tail'], 'counter_rows': state['rows'], 'counts': state['counts'],
        'phase_reallocation': delta, 'proof_sha256': rule['proof_sha256'], 'acknowledged_images': images,
        'image_build_head': old['image_build_head'], 'origin_manifest': source['origin_manifest'],
        'origin_sources': source['origin_sources'], 'new_sources': source['new_sources'],
        'unknown_identity_receipt': source['unknown_identity_receipt'],
        'retained_published_runtime': source['retained_published_runtime'],
        'inherited_readback_sha256': digest(view.values('image_reuse_readback')[0]),
        'inherited_fresh_sha256': a._sha(fresh_raw)}
