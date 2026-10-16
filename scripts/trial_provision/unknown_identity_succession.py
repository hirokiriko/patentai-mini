"""Finite V8 succession: preserve an unproven MI ACK and all charged history.

Pure validation only. Internal authority schema 9 does not retry schema 8 or
infer ownership from existence. Only the new manifest identity may be sent.
"""
import base64
import binascii
import zlib
from copy import deepcopy
from pathlib import PureWindowsPath, PurePosixPath
from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import parse
from .succession import need, keys, raw

CHILD_NAME = 'trial-provision-successor-v8'
KIND = 'STOPPED_V7R1_UNKNOWN_IDENTITY'
PREFIX_ROWS = 216
COUNTS = {'owner_arm': 333, 'owner_control_blob': 32, 'heartbeat_blob': 0}
EVENTS = ('binding', 'image_reuse_preparation', 'provision_bridge_intent',
          *('allocation',) * 14, 'core_plan', 'provision_bridge_output', 'plan',
          'publication_import', 'provision_bridge_prepared', 'clock_observation',
          'allocation', 'intent', 'progress')


def decode_ready(value):
    """Bound output before decompressing; reject alternate/trailing streams."""
    from . import attempt as a
    keys(value, ('encoding', 'raw_bytes', 'raw_sha256', 'data'))
    need(value['encoding'] == 'zlib-base64-v1' and type(value['raw_bytes']) is int
         and 0 < value['raw_bytes'] <= a._MAX_JSON and type(value['data']) is str
         and 0 < len(value['data']) <= a._MAX_JSON)
    try:
        packed = base64.b64decode(value['data'], validate=True)
        need(base64.b64encode(packed).decode('ascii') == value['data'])
        decoder = zlib.decompressobj()
        result = decoder.decompress(packed, value['raw_bytes'] + 1)
        need(len(result) == value['raw_bytes'] and decoder.eof
             and not decoder.unused_data and not decoder.unconsumed_tail
             and a._sha(result) == a._hex(value['raw_sha256']))
        a._json(result)
        return result
    except (ValueError, binascii.Error, zlib.error):
        need(False)


def allocation(previous_plan, used, counts):
    from . import attempt as a
    need(counts == COUNTS and all(type(v) is int for v in counts.values())
         and previous_plan['limits'] == {**a.LIMITS, 'owner_arm': 631}
         and previous_plan['phase_caps']['owner_arm'] == dict(zip(a.PHASES, (18, 0, 139, 24, 120)))
         and previous_plan['purpose_caps'] == a.READBACK_CONTINUATION_PURPOSE_CAPS
         and previous_plan['unallocated']['owner_arm'] == 0
         and used['owner_arm'] == dict(zip(a.PHASES, (0, 0, 3, 0, 0)))
         and all(type(v) is int for phases in used.values() for v in phases.values())
         and all(used[k][p] == 0 for k in ('owner_control_blob', 'heartbeat_blob') for p in a.PHASES))
    caps = {k: {p: previous_plan['phase_caps'][k][p] - used[k][p] for p in a.PHASES} for k in a.LIMITS}
    delta = {'schema': 1, 'kind': 'owner_arm', 'phase_delta': dict(zip(a.PHASES, (-1, 0, 5, -4, 0))), 'unallocated_delta': 0}
    for p in a.PHASES: caps['owner_arm'][p] += delta['phase_delta'][p]
    need(caps['owner_arm'] == dict(zip(a.PHASES, (17, 0, 141, 20, 120))))
    return caps, deepcopy(previous_plan['unallocated']), delta


def transition_value(verified):
    from . import attempt as a
    p = a._proof(verified); s = p['succession']; need(p['authority']['schema'] == 9)
    return {'schema': 8, 'kind': KIND, 'previous_attempt': s['previous_attempt'],
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
    need(type(value['schema']) is int and value['schema'] == 8 and value['kind'] == KIND
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
    need(rows[212]['event'] == 'attempt_transition'
         and rows[212]['value']['limit_amendment'] == value['limit_amendment'])
    need([r['value'].get('purpose') for r in rows[213:]] == ['owner_token', 'http', 'http']
         and all(r['event'] == 'request' and r['value'].get('kind') == 'owner_arm'
                 and r['value'].get('phase') == 'provision'
                 and r['value'].get('attempt') == previous_plan['attempt'] for r in rows[213:]))
    plan = value['plan']
    need(type(plan) is dict and plan.get('counts_before') == counts and plan.get('attempt') != previous_plan['attempt']
         and plan.get('phase_caps') == caps and plan.get('unallocated') == reserve
         and plan.get('limits') == a._authority_limits({'schema': 9, 'limit_amendment': value['limit_amendment']})
         and plan.get('purpose_caps') == a.V8_PURPOSE_CAPS)
    if verified is not None: need(value == transition_value(verified))
    return deepcopy(plan)


def _previous_bridge(old_config, manifest, previous, public_raw, provision_raw, inputs_raw, binding, records):
    from . import attempt as a
    from .publication_bridge import compose_configuration, _core_plan, _prepared_record
    from .operations import create_resolver
    from .plan import _guid
    from .registry_publish import prepare_publication, verified_publication_images, publication_origin, verify_reused_import
    publication = {**old_config, 'manifest': manifest, 'verified_attempt': previous, 'config_sha256': a._sha(public_raw)}
    view = a._ParentView(records)
    prepare_publication(publication, manifest, publication['config_sha256'], view)
    images = verified_publication_images(view, verified_attempt=previous)
    bridge = view.values('provision_bridge_intent')[0]
    keys(bridge, ('schema', 'publication_config_sha256', 'checked_at', 'input_sha256', 'code_sha',
                  'run_binding_digest', 'image_receipt_digests', 'output'))
    a._ref(bridge['output'])
    directory = old_config['recovery']['directory']
    path_type = PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    origin = publication_origin(view, verified_attempt=previous)
    need(type(bridge['schema']) is int and bridge['schema'] == 1
         and bridge['publication_config_sha256'] == publication['config_sha256']
         and bridge['code_sha'] == old_config['frozen_head'] and bridge['run_binding_digest'] == digest(binding)
         and bridge['input_sha256'] == a._sha(inputs_raw)
         and bridge['output'] == {'path': str(path_type(directory) / 'provision-continuation-v7r1-config.json'), 'sha256': a._sha(provision_raw)}
         and bridge['image_receipt_digests'] == {slot: digest(origin.latest(slot + 'ImagePush')) for slot in ('guardian', 'runtime')})
    provision = a._json(provision_raw)
    need(compose_configuration(publication, view, a._json(inputs_raw), verify_local_node=False) == provision)
    allocations = view.values('allocation'); need(len(allocations) == 15); lookup = {}
    for item in allocations:
        keys(item, ('slot', 'id'))
        need(type(item['slot']) is str and item['slot'] not in lookup and _guid(item['id']) == item['id'])
        lookup[item['slot']] = item['id']
    need(len(set(lookup.values())) == 15); seen = set()
    def allocate(slot):
        need(slot in lookup and slot not in seen); seen.add(slot); return lookup[slot]
    core = _core_plan(publication, provision, bridge['checked_at'], allocate)
    need(len(seen) == 14 and view.values('core_plan') == [core])
    resolver = create_resolver(core, manifest, old_config['authority_bundle'], provision['resource_bindings'], verified_attempt=previous)
    need(view.values('plan') == [resolver.initial_plan])
    verify_reused_import(view, resolver, provision['resource_bindings'], previous)
    need(view.values('provision_bridge_output') == [bridge]
         and view.values('provision_bridge_prepared') == [_prepared_record(view, bridge)])
    intent, receipt = view.values('intent')[0], view.values('progress')[0]
    keys(intent, ('operation_id', 'request_digest', 'method', 'url', 'deadline', 'at', 'request_id'))
    operation = resolver.resolve('webIdentity', {})
    need(intent['operation_id'] == receipt['operation_id'] == 'webIdentity'
         and intent['request_digest'] == receipt['request_digest'] == digest(operation)
         and intent['method'] == operation['method'] == 'PUT' and intent['url'] == operation['url']
         and intent['deadline'] == operation['deadline'] and receipt['object_id'] == operation['expected']['resource_id']
         and intent['request_id'] == lookup.get('request_webIdentity') and 'request_webIdentity' not in seen)
    seen.add('request_webIdentity'); need(seen == set(lookup))
    return bridge, intent, receipt, images


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    rule = authority['succession']
    keys(rule, ('schema', 'kind', 'proof_sha256', 'child_name', 'phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema'] == 8 and rule['kind'] == KIND and rule['child_name'] == CHILD_NAME)
    proof = ready.get('succession_proof')
    keys(proof, ('schema', 'previous_authority_raw', 'previous_activation_raw', 'previous_publication_raw',
        'previous_manifest_raw', 'previous_provision_raw', 'previous_bridge_inputs_raw', 'previous_child_raw',
        'previous_artifacts', 'stopped_raw', 'counter_prefix_raw', 'image_compatibility'))
    need(type(proof['schema']) is int and proof['schema'] == 8 and digest(proof) == a._hex(rule['proof_sha256']))
    old_raw = raw(proof['previous_authority_raw']); old = a._json(old_raw)
    need(old.get('schema') == 8 and old.get('approval') == 'ISSUE148_LINKED_ATTEMPT_V8')
    old_manifest_raw = raw(proof['previous_manifest_raw']); old_manifest = a._json(old_manifest_raw)
    need(a._sha(old_manifest_raw) == old['manifest_sha256'])
    public_raw = raw(proof['previous_publication_raw']); old_config = a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['control_budget'] == config['control_budget']
         and old_config['recovery'] == config['recovery'] and set(old_config['sources']) == set(config['sources']))
    need(all(old_config['sources'][k]['sha256'] == config['sources'][k]['sha256'] for k in old_config['sources'] if k != 'manifest'))
    old_config['authority_bundle'] = {**config['authority_bundle'], 'manifest': old_manifest_raw}
    keys(proof['previous_artifacts'], a.ARTIFACTS)
    artifacts = {k: decode_ready(v) if k == 'local_ready' else raw(v) for k, v in proof['previous_artifacts'].items()}
    previous = a.verify_attempt(old_config, old_manifest, authority_raw=old_raw,
        activation_raw=raw(proof['previous_activation_raw']), parent_journal_raw=parent_journal_raw,
        parent_final_raw=parent_final_raw, artifacts=artifacts, trusted_authority_sha256=a._sha(old_raw), now=now)
    for name in ('owner_id', 'task_id', 'budget_binding_sha256', 'parent', 'retained_runtime', 'guardian_prior_digest',
                 'catalog_options', 'unallocated', 'limit_amendment', 'image_build_head', 'tags', 'origin_manifest_sha256', 'identity_disposition'):
        need(authority[name] == old[name])
    need(old['initial_forecast_yen'] <= authority['initial_forecast_yen'] <= 4500
         and authority['head'] != old['head'] and authority['attempt_id'] != old['attempt_id']
         and a._time(authority['publish_from']) > a._time(old['publish_from']))
    for slot in ('guardian', 'runtime'): need(authority['artifact_sha256'][slot + '_build'] == old['artifact_sha256'][slot + '_build'])
    compatibility = proof['image_compatibility']
    keys(compatibility, ('schema', 'local_head', 'image_build_head', 'runtime_tree_sha256', 'guardian_tree_sha256',
        'runtime_unchanged', 'guardian_unchanged', 'review_sha256'))
    need(type(compatibility['schema']) is int and compatibility['schema'] == 1
         and compatibility['local_head'] == authority['head'] and compatibility['image_build_head'] == old['image_build_head']
         and compatibility['runtime_unchanged'] is True and compatibility['guardian_unchanged'] is True)
    for key in ('runtime_tree_sha256', 'guardian_tree_sha256', 'review_sha256'): a._hex(compatibility[key])
    child_raw = raw(proof['previous_child_raw']); name, binding = a.journal_descriptor(old_config, previous)
    need(name == 'trial-provision-continuation-v7r1')
    records, tail = a._journal(child_raw, binding); need(tuple(r['event'] for r in records) == EVENTS)
    provision_raw = raw(proof['previous_provision_raw'])
    bridge, intent, receipt, images = _previous_bridge(old_config, old_manifest, previous, public_raw,
        provision_raw, raw(proof['previous_bridge_inputs_raw']), binding, records)
    keys(receipt, ('operation_id', 'request_digest', 'state', 'terminal', 'write_terminal', 'readback_verified',
        'created_by_run', 'object_id', 'properties', 'http', 'observed_at', 'initial_ack_digest', 'ack_rejection', 'ack_header_evidence'))
    need(receipt['state'] == 'unknown' and receipt['properties'] == {} and type(receipt['http']) is int and receipt['http'] == 201
         and receipt['created_by_run'] is True and all(receipt[k] is False for k in ('terminal', 'write_terminal', 'readback_verified'))
         and receipt['ack_rejection'] == 'unsupported_lro_headers'
         and receipt['ack_header_evidence'] == {'azure_asyncoperation_present': False, 'duplicate_control_headers': False,
                                               'location': 'unsupported', 'operation_location_present': False})
    a._hex(receipt['initial_ack_digest'])
    disposition = authority['unknown_identity_retention']
    keys(disposition, ('kind', 'old_resource_id', 'new_name', 'new_resource_id', 'unknown_receipt_sha256',
                       'old_unknown_preserved', 'old_mutations_authorized', 'reserves_released'))
    need(disposition['kind'] == 'retain_unknown_replace_web_identity' and disposition['old_unknown_preserved'] is True
         and disposition['old_mutations_authorized'] is False and disposition['reserves_released'] is False
         and disposition['old_resource_id'] == old_manifest['ids']['webIdentity'] == receipt['object_id']
         and disposition['unknown_receipt_sha256'] == digest(receipt))
    expected = deepcopy(old_manifest)
    expected['names']['webIdentity'], expected['ids']['webIdentity'] = disposition['new_name'], disposition['new_resource_id']
    need(manifest == expected and disposition['new_name'].endswith('-v8')
         and disposition['new_resource_id'].lower() not in {old_manifest['ids']['webIdentity'].lower(), old['identity_disposition']['old_resource_id'].lower()})
    from .resources import _manifest
    _manifest(manifest, {'manifest': encoded(manifest)})
    counter_raw = raw(proof['counter_prefix_raw'])
    state = replay_control_budget(counter_raw, binding=config['control_budget']['binding'], seed=a.SEED,
        directory=config['control_budget']['directory'], verified=previous)
    need(state['rows'] == PREFIX_ROWS and len(state['transitions']) == 7 and state['plan'] == a.phase_plan(previous)
         and state['counts'] == authority['counts_before'] == COUNTS)
    stopped = a._json(raw(proof['stopped_raw']))
    need(stopped['status'] == 'STOPPED_UNKNOWN_MANAGED_IDENTITY_ACK_V7R1'
         and stopped['head'] == old['head'] and stopped['counts'] == COUNTS and stopped['counter_rows'] == PREFIX_ROWS
         and stopped['child_rows'] == len(EVENTS) and stopped['child_tail'] == tail
         and stopped['new_write_intents'] == [intent] and stopped['unknown_receipt'] == receipt
         and stopped['historical_unknowns_preserved'] is True and stopped['new_unknown_preserved'] is True
         and stopped['unknown_receipt_promoted'] is False and stopped['reserves_released'] is False
         and stopped['automatic_retry'] is False and stopped['operator_closed'] is True and stopped['owner_token_pool_closed'] is True
         and stopped['remaining_total_owner_arm'] == 298 and stopped['total_owner_arm_limit'] == 631)
    for key, checksum in {'counter': a._sha(counter_raw), 'child': a._sha(child_raw), 'authority': a._sha(old_raw),
                         'activation': a._sha(raw(proof['previous_activation_raw'])), 'publication': a._sha(public_raw),
                         'config': a._sha(provision_raw)}.items(): need(stopped['evidence'][key]['sha256'] == checksum)
    clocks = a._ParentView(records).values('clock_observation'); need(len(clocks) == 1 and clocks[0]['at'] == intent['at'])
    need(parse(previous.activation['issued_at']) <= parse(bridge['checked_at']) <= parse(intent['at'])
         <= parse(receipt['observed_at']) <= parse(stopped['recorded_at']) <= parse(authority['approved_at'])
         and parse(previous.activation['windows']['guardian']['start']) <= parse(intent['at'])
         < parse(previous.activation['windows']['owner_input']['start']))
    caps, reserve, delta = allocation(state['plan'], state['used'], state['counts'])
    need(authority['phase_caps'] == caps and authority['unallocated'] == reserve and rule['phase_reallocation'] == delta
         and stopped['remaining_owner_arm'] == dict(zip(a.PHASES, (18, 0, 136, 24, 120))))
    old_proof = a._proof(previous); source = old_proof['succession']
    return {**{k: deepcopy(source[k]) for k in ('docker_paths', 'origin_manifest', 'origin_sources',
        'unknown_identity_receipt', 'retained_published_runtime', 'inherited_readback_sha256', 'inherited_fresh_sha256')},
        'child_name': name, 'child_binding': binding, 'child_sha256': a._sha(child_raw), 'child_tail': tail,
        'previous_child_records': records, 'previous_attempt': previous.binding_digest, 'previous_plan': state['plan'],
        'previous_transitions': state['transitions'], 'previous_verified_proof': old_proof,
        'previous_publication': a._json(public_raw), 'previous_authority_sha256': a._sha(old_raw),
        'counter_prefix_sha256': a._sha(counter_raw), 'counter_tail': state['tail'], 'counter_rows': state['rows'], 'counts': state['counts'],
        'phase_reallocation': delta, 'proof_sha256': rule['proof_sha256'], 'acknowledged_images': images,
        'image_build_head': old['image_build_head'], 'new_sources': {k: v['sha256'] for k, v in config['sources'].items()},
        'retained_unknown_identity_receipt': receipt}
