"""Fictional schema-9 proof; historical verifier seam is explicit and local.

The complete real historical chain is checked separately against read-only
local evidence. These fixtures never contain customer/cloud/account values.
"""
import base64
import zlib
from copy import deepcopy
from pathlib import Path
import unittest
import uuid
from unittest.mock import patch
from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a, unknown_identity_succession as target
from scripts.trial_provision import readback_continuation as prior, publication_bridge as bridge, registry_publish as publication
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.journal import replay_control_budget
from scripts.trial_provision.tests import test_readback_continuation as old_fixture
from scripts.trial_provision.tests.test_attempt import chain, stamp
from scripts.trial_provision.tests.test_attempt_succession import seal
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal


def compress(value):
    return {'encoding': 'zlib-base64-v1', 'raw_bytes': len(value), 'raw_sha256': a._sha(value),
            'data': base64.b64encode(zlib.compress(value)).decode()}


def fixture():
    data = old_fixture.fixture(); old = data['new']; previous = old_fixture.verify(data)
    c = old['config']; directory = Path(c['recovery']['directory'])
    ref = lambda name, value: {'path': str(directory / name), 'sha256': a._sha(value if type(value) is bytes else encoded(value))}
    c.update(schema=1, ci=ref('ci.json', {}), attempt_evidence={
        'authority': ref('old-authority.json', old['authority']), 'parent_final': ref('parent-final.json', old['parent_final']),
        'artifacts': {k: ref('old-'+k+'.json', v) for k, v in old['artifacts'].items()}})
    public_raw = encoded({k: v for k, v in c.items() if k != 'authority_bundle'})
    binding = a.journal_descriptor(c, previous)[1]; journal = MemoryJournal([('binding', binding)])
    pub = {**c, 'verified_attempt': previous, 'manifest': old['manifest'], 'config_sha256': a._sha(public_raw)}
    publication.prepare_publication(pub, old['manifest'], a._sha(public_raw), journal)
    w = previous.activation['windows']
    inputs = {'schema': 1, 'publication_config_sha256': a._sha(public_raw),
        'plan_bindings': {'guardian_window': w['guardian'], 'owner_window': w['owner_input']},
        'deadline': w['owner_input']['end'], 'policy_verifier_node': str(directory/'node.exe'),
        'secret_sources': {f'trial-{slot}-database': ref(slot+'.secret', ('fictional-database-'+slot).encode()) for slot in ('web', 'worker')}}
    provision = bridge.compose_configuration(pub, journal, inputs, verify_local_node=False)
    origin = publication.publication_origin(journal, verified_attempt=previous)
    binding_event = {'schema': 1, 'publication_config_sha256': a._sha(public_raw), 'checked_at': stamp(60000),
        'input_sha256': a._sha(encoded(inputs)), 'code_sha': c['frozen_head'], 'run_binding_digest': digest(binding),
        'image_receipt_digests': {slot: digest(origin.latest(slot+'ImagePush')) for slot in ('guardian', 'runtime')},
        'output': ref('provision-continuation-v7r1-config.json', provision)}
    journal.append('provision_bridge_intent', binding_event)
    def allocate(slot):
        value = str(uuid.uuid5(uuid.NAMESPACE_URL, 'fictional-v8-prior:' + slot))
        journal.append('allocation', {'slot': slot, 'id': value}); return value
    core = bridge._core_plan(pub, provision, stamp(60000), allocate); journal.append('core_plan', core)
    journal.append('provision_bridge_output', binding_event)
    resolver = create_resolver(core, old['manifest'], c['authority_bundle'], provision['resource_bindings'], verified_attempt=previous)
    journal.append('plan', resolver.initial_plan)
    journal.append('publication_import', publication._reused_import(journal, resolver, provision['resource_bindings'], previous))
    journal.append('provision_bridge_prepared', bridge._prepared_record(journal, binding_event))
    journal.append('clock_observation', {'at': stamp(60610)})
    request_id = allocate('request_webIdentity'); op = resolver.resolve('webIdentity', {})
    intent = {'operation_id': op['id'], 'request_digest': digest(op), 'method': op['method'], 'url': op['url'],
              'deadline': op['deadline'], 'at': stamp(60610), 'request_id': request_id}
    receipt = {'operation_id': op['id'], 'request_digest': digest(op), 'state': 'unknown', 'terminal': False,
        'write_terminal': False, 'readback_verified': False, 'created_by_run': True,
        'object_id': op['expected']['resource_id'], 'properties': {}, 'http': 201, 'observed_at': stamp(60611),
        'initial_ack_digest': 'd'*64, 'ack_rejection': 'unsupported_lro_headers', 'ack_header_evidence': {
            'azure_asyncoperation_present': False, 'duplicate_control_headers': False, 'location': 'unsupported', 'operation_location_present': False}}
    journal.append('intent', intent); journal.append('progress', receipt)
    child_raw, tail = chain(journal.rows)
    rows = data['counter_rows'] + [('attempt_transition', prior.transition_value(previous))]
    rows += [('request', {'kind': 'owner_arm', 'attempt': previous.binding_digest, 'phase': 'provision', 'purpose': purpose}) for purpose in ('owner_token', 'http', 'http')]
    counter_raw = chain(rows)[0]
    state = replay_control_budget(counter_raw, binding=c['control_budget']['binding'], seed=a.SEED, directory=str(directory), verified=previous)
    caps, reserve, delta = target.allocation(state['plan'], state['used'], state['counts'])
    stopped = {'status': 'STOPPED_UNKNOWN_MANAGED_IDENTITY_ACK_V7R1', 'head': old['authority']['head'],
        'counts': target.COUNTS, 'counter_rows': 216, 'child_rows': 26, 'child_tail': tail, 'new_write_intents': [intent],
        'unknown_receipt': receipt, 'historical_unknowns_preserved': True, 'new_unknown_preserved': True,
        'unknown_receipt_promoted': False, 'reserves_released': False, 'automatic_retry': False,
        'operator_closed': True, 'owner_token_pool_closed': True, 'remaining_total_owner_arm': 298,
        'total_owner_arm_limit': 631, 'recorded_at': stamp(60700),
        'remaining_owner_arm': dict(zip(a.PHASES, (18, 0, 136, 24, 120))),
        'evidence': {k: {'sha256': a._sha(v)} for k,v in {'counter': counter_raw, 'child': child_raw,
            'authority': encoded(old['authority']), 'activation': encoded(old['activation']),
            'publication': public_raw, 'config': encoded(provision)}.items()}}
    new = deepcopy(old); authority = new['authority']; config = new['config']; head = 'f'*40
    manifest = new['manifest']; manifest['names']['webIdentity'] += '-v8'; manifest['ids']['webIdentity'] += '-v8'
    config['authority_bundle']['manifest'] = encoded(manifest)
    config['sources']['manifest'] = ref('manifest-v8.json', manifest)
    config.update(frozen_head=head, code_sources={'scripts/trial_provision/unknown_identity_succession.py': 'f'*64})
    proof = {'schema': 8, 'previous_authority_raw': encoded(old['authority']).decode(),
        'previous_activation_raw': encoded(old['activation']).decode(), 'previous_publication_raw': public_raw.decode(),
        'previous_manifest_raw': c['authority_bundle']['manifest'].decode(), 'previous_provision_raw': encoded(provision).decode(),
        'previous_bridge_inputs_raw': encoded(inputs).decode(), 'previous_child_raw': child_raw.decode(),
        'previous_artifacts': {k: compress(v) if k == 'local_ready' else v.decode() for k,v in old['artifacts'].items()},
        'stopped_raw': encoded(stopped).decode(), 'counter_prefix_raw': counter_raw.decode(),
        'image_compatibility': {**data['proof']['image_compatibility'], 'local_head': head}}
    authority.update(schema=9, approval='ISSUE148_LINKED_ATTEMPT_V9', head=head, attempt_id='fictional-v8-new-identity',
        manifest_sha256=config['sources']['manifest']['sha256'], code_sources_sha256=digest(config['code_sources']),
        approved_at=stamp(79000), publish_from=stamp(80000), counts_before=target.COUNTS, phase_caps=caps, unallocated=reserve,
        unknown_identity_retention={'kind': 'retain_unknown_replace_web_identity', 'old_resource_id': old['manifest']['ids']['webIdentity'],
            'new_name': manifest['names']['webIdentity'], 'new_resource_id': manifest['ids']['webIdentity'],
            'unknown_receipt_sha256': digest(receipt), 'old_unknown_preserved': True, 'old_mutations_authorized': False, 'reserves_released': False},
        succession={'schema': 8, 'kind': target.KIND, 'proof_sha256': digest(proof), 'child_name': target.CHILD_NAME, 'phase_reallocation': delta})
    new['artifacts']['local_ready'] = encoded({'head': head, 'design_sha256': a.DESIGN_SHA256,
        'code_sources_sha256': authority['code_sources_sha256'], 'succession_proof': proof})
    new['artifacts']['limits'] = encoded({'schema': 1, 'head': head, 'counts_before': target.COUNTS,
        'phase_caps': caps, 'unallocated': reserve, 'purpose_caps': a.purpose_caps(authority),
        'limits': a._authority_limits(authority), 'limit_amendment': authority['limit_amendment']})
    new['activation'].update(attempt_id=authority['attempt_id'], issued_at=stamp(79000),
        windows={k: {'start': stamp(80000+s), 'end': stamp(80000+e)} for k,(s,e) in a.window_offsets(authority).items()})
    config['publication']['publish_until'] = new['activation']['windows']['publication']['end']; seal(new)
    return {'new': new, 'old': previous, 'proof': proof, 'counter_rows': rows, 'counter_raw': counter_raw,
            'child_raw': child_raw, 'images': data['images']}


def verify(data):
    n = data['new']; original = a.verify_attempt
    def historical(*args, **kwargs):
        assert kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return data['old']
    with patch.object(a, 'verify_attempt', side_effect=historical):
        return original(n['config'], n['manifest'], authority_raw=encoded(n['authority']), activation_raw=encoded(n['activation']),
            parent_journal_raw=chain(n['parent_rows'])[0], parent_final_raw=encoded(n['parent_final']), artifacts=n['artifacts'],
            trusted_authority_sha256=a._sha(encoded(n['authority'])), now=stamp(79000))


def reseal(data):
    n = data['new']; ready = a._json(n['artifacts']['local_ready']); ready['succession_proof'] = data['proof']
    n['artifacts']['local_ready'] = encoded(ready); n['authority']['succession']['proof_sha256'] = digest(data['proof']); seal(n)


class UnknownIdentitySuccessionTests(unittest.TestCase):
    def test_chain_budget_and_compact_artifact(self):
        data = fixture(); verified = verify(data); n = data['new']; c = n['config']
        self.assertLess(len(n['artifacts']['local_ready']), a._MAX_JSON)
        self.assertLess(len(verified._raw), a._MAX_JSON)
        self.assertEqual(a.journal_descriptor(c, verified)[0], target.CHILD_NAME)
        rows = data['counter_rows'] + [('attempt_transition', target.transition_value(verified))]
        for phase, http, tokens in (('fresh_read',16,1), ('provision',139,2), ('run',18,2), ('cleanup',119,1)):
            rows += [('request', {'kind':'owner_arm','attempt':verified.binding_digest,'phase':phase,'purpose':purpose})
                     for purpose,count in (('http',http),('owner_token',tokens)) for _ in range(count)]
        replay = lambda r: replay_control_budget(chain(r)[0], binding=c['control_budget']['binding'], seed=a.SEED,
            directory=c['control_budget']['directory'], verified=verified)
        self.assertEqual(replay(rows)['counts']['owner_arm'], 631)
        with self.assertRaises(Denied): replay(rows + [rows[-1]])

    def test_compression_rejects_trailing_truncated_bomb_length_and_digest(self):
        raw = encoded({'fixture': 'x'*10000}); good = compress(raw)
        self.assertEqual(target.decode_ready(good), raw)
        cases = [{**good, 'raw_bytes': True}, {**good, 'raw_bytes': len(raw)-1}, {**good, 'raw_sha256': '0'*64},
            {**good, 'data': base64.b64encode(zlib.compress(raw)+b'extra').decode()},
            {**good, 'data': base64.b64encode(zlib.compress(raw)[:-1]).decode()},
            {**good, 'data': base64.b64encode(zlib.compress(raw)*2).decode()}]
        for value in cases:
            with self.subTest(value=list(value)), self.assertRaises(Denied): target.decode_ready(value)

    def test_unknown_and_reserved_cleanup_cannot_be_reinterpreted(self):
        data = fixture()
        for field,value in (('old_mutations_authorized',True),('old_unknown_preserved',False),('reserves_released',True)):
            changed = deepcopy(data, {id(data['old']): data['old']})
            changed['new']['authority']['unknown_identity_retention'][field] = value; seal(changed['new'])
            with self.subTest(field=field), self.assertRaises(Denied): verify(changed)
        changed = deepcopy(data, {id(data['old']): data['old']})
        changed['new']['authority']['phase_caps']['owner_arm']['cleanup'] -= 1; seal(changed['new'])
        with self.assertRaises(Denied): verify(changed)


if __name__ == '__main__': unittest.main()
