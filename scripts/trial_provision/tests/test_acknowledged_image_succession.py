"""Fictional V5 publication/UNKNOWN history and canonical V6 validation.

No file, clock issuance, credentials or Cloud I/O. The historical V5 verifier
alone is a seam in verify(); outer V6 artifacts, exact child chain, counter
replay, allocation and human-observation boundaries use production consumers.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a
from scripts.trial_provision import acknowledged_image_succession as target
from scripts.trial_provision import unknown_publication_succession as prior
from scripts.trial_provision.journal import ControlBudget, _SCOPE_KEY, replay_control_budget
from scripts.trial_provision.registry_publish import prepare_publication, verified_publication_images
from scripts.trial_provision.resources import RETENTION_END, _operation, canonical_region
from scripts.trial_provision.tests import test_unknown_publication_succession as prior_fixture
from scripts.trial_provision.tests import test_attempt_succession as first_fixture
from scripts.trial_provision.tests.test_attempt import chain, stamp
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal, publication_fixture


def _identity_seed(base):
    """Extend the fictional manifest before the existing first seal/prefix."""
    base = deepcopy(base); manifest = base['manifest']
    manifest['region'] = 'fictional'
    group = manifest['existing']['registry'].split('/providers/')[0]
    manifest['ids']['webIdentity'] = group + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trial-web'
    raw = encoded(manifest); mh = a._sha(raw)
    base['config']['authority_bundle']['manifest'] = raw
    base['config']['sources']['manifest']['sha256'] = mh
    base['config']['control_budget']['binding']['manifest_sha256'] = mh
    base['authority']['manifest_sha256'] = mh
    binding = base['parent_rows'][0][1]; binding['manifest_sha256'] = mh
    prep = next(v for e, v in base['parent_rows'] if e == 'publication_preparation')
    prep.update(manifest_sha256=mh, run_binding_digest=digest(binding))
    for event, value in base['parent_rows']:
        if event.endswith('_image_namespace'):
            value.update(publication_preparation_digest=digest(prep), run_binding_digest=digest(binding))
    for slot in ('guardian', 'runtime'):
        build = a._json(base['artifacts'][slot+'_build']); build['manifest_sha256'] = mh
        base['artifacts'][slot+'_build'] = encoded(build)
        base['config']['publication']['slots'][slot]['build_receipt']['sha256'] = a._sha(encoded(build))
    return base


def fixture():
    original = first_fixture.proof_fixture
    def seeded(directory, *, base=None):
        assert base is not None
        return original(directory, base=_identity_seed(base))
    with patch.object(first_fixture, 'proof_fixture', side_effect=seeded):
        old_data = prior_fixture.fixture()
    previous = prior_fixture.verify(old_data)
    old = old_data['new']; config = deepcopy(old['config']); manifest = deepcopy(old['manifest'])
    directory = Path(config['control_budget']['directory'])
    public_raw = encoded({k: v for k, v in config.items() if k != 'authority_bundle'})
    _, binding = a.journal_descriptor(config, previous)
    memory, _, _ = publication_fixture(old, verified=previous, offset=14000)
    journal = MemoryJournal([('binding', binding)])
    prep = prepare_publication({**config, 'verified_attempt': previous}, manifest, a._sha(public_raw), journal)
    published = deepcopy(memory.rows[2:])
    for event, value in published:
        if event.endswith('_image_namespace'): value['publication_preparation_digest'] = digest(prep)
    namespace = next(v for e, v in published if e == 'runtime_image_namespace')
    next(v for e, v in published if e == 'runtime_image_retention')['namespace_sha256'] = digest(namespace)
    journal.rows.extend(published)
    images = verified_publication_images(journal, verified_attempt=previous)
    rid = manifest['ids']['webIdentity']
    op = _operation('webIdentity', 'Microsoft.ManagedIdentity', 'userAssignedIdentities', rid, '2023-01-31',
        {'location': canonical_region(manifest['region'])}, previous.activation['windows']['owner_input']['end'], [],
        {'location': canonical_region(manifest['region'])}, receipt_properties=['principalId', 'tenantId', 'clientId'])
    op['cleanup']['deadline'] = RETENTION_END
    unknown = {'operation_id': 'webIdentity', 'request_digest': digest(op), 'object_id': rid,
        'state': 'unknown', 'terminal': False, 'write_terminal': False, 'created_by_run': True,
        'readback_verified': False, 'observed_at': stamp(16102), 'properties': {}, 'http': 201,
        'initial_ack_digest': 'b'*64}
    identity_intent = {'operation_id': 'webIdentity', 'request_digest': digest(op),
        'request_id': '12345678-1234-4234-8234-123456789abc', 'method': 'PUT',
        'url': op['url'], 'deadline': op['deadline'], 'at': stamp(16101)}
    plan = {'operations': {'webIdentity': op}, 'resource_bindings': {'code_sha': previous.authority['head'], **images}}
    core = {'schema': 1, 'fixture': 'stopped-before-other-provision-writes'}
    imported = {'schema': 1, 'initial_plan_digest': digest(plan), 'publication_preparation_digest': digest(prep),
        'run_binding_digest': digest(binding),
        'push_receipt_digests': {s: digest(journal.latest(s+'ImagePush')) for s in ('guardian', 'runtime')}}
    bridge = {'publication_config_sha256': a._sha(public_raw), 'code_sha': previous.authority['head'],
        'run_binding_digest': digest(binding), 'image_receipt_digests': imported['push_receipt_digests']}
    progress = {}
    for slot in ('guardian', 'runtime'):
        final = journal.latest(slot+'ImagePush')
        pending = next((deepcopy(v) for e, v in published if e == 'progress' and v['operation_id'] == slot+'ImagePush'
                        and not v['terminal']), deepcopy(final))
        pending.update(state='pending', terminal=False, readback_verified=False, observed_at=stamp(14110))
        first = deepcopy(pending); first.update(state='unknown', write_terminal=False, object_id=None, properties={}, observed_at=stamp(14100))
        first.pop('ack_kind', None)
        progress[slot] = iter((first, pending, final))
    rows = []; slot = 'guardian'; allocations = 0
    for event in target.EVENTS:
        if event.startswith('runtime_'): slot = 'runtime'
        if event == 'binding': value = binding
        elif event == 'publication_preparation': value = prep
        elif event == 'clock_observation': value = {'at': stamp(14100 if len(rows) < 46 else 16100)}
        elif event == 'allocation':
            allocations += 1; value = {'slot': 'fictional-allocation-'+str(allocations), 'id': '00000000-0000-4000-8000-'+str(allocations).zfill(12)}
        elif event == 'intent':
            value = identity_intent if len(rows) > 60 else next(v for e, v in published if e == 'intent' and v['operation_id'] == slot+'ImagePush')
        elif event == 'progress': value = unknown if len(rows) > 60 else next(progress[slot])
        elif event.endswith('_image_namespace') or event == 'runtime_image_retention':
            value = next(v for e, v in published if e == event)
        elif event.endswith('_docker_probe_result'):
            value = {'schema': 1, 'status': 'verified', 'temporary_config_absent': True,
                'publication_preparation_digest': digest(prep), 'run_binding_digest': digest(binding),
                'new_owner_token_calls': 0, 'new_http_requests': 0, 'automatic_retry': False}
        elif event.endswith('_directory') or event.endswith('_config_absent'):
            probe = '_docker_probe_' in event
            path = str(directory / ('trial-'+slot+('-docker-probe-' if probe else '-docker-')+digest(binding)[:16]))
            value = {'path_digest': digest(path), **({'absent': True} if event.endswith('_config_absent') else {'identity': [1, len(rows)+1]})}
        elif event.endswith('_docker_config') or event.endswith('_docker_probe_config'): value = {'identity': [1, len(rows)+1]}
        elif event.endswith('_image_measurement'): value = {'schema': 1, 'fixture': 'image-measurement'}
        elif event in ('provision_bridge_intent', 'provision_bridge_output'): value = bridge
        elif event == 'core_plan': value = core
        elif event == 'plan': value = plan
        elif event == 'publication_import': value = imported
        elif event == 'provision_bridge_prepared': value = {'binding_digest': digest(bridge), 'plan_digest': digest(plan),
            'core_plan_digest': digest(core), 'publication_import_digest': digest(imported)}
        else: raise AssertionError(event)
        rows.append((event, deepcopy(value)))
    child_raw, _ = chain(rows)
    counter_rows = deepcopy(old_data['counter_rows']) + [('attempt_transition', prior.transition_value(previous))]
    requests = [('fresh_read', 'owner_token')]+[('fresh_read', 'http')]*5+[('publication', 'http')]*15+[('provision', 'http')]*2
    counter_rows += [('request', {'kind': 'owner_arm', 'attempt': previous.binding_digest, 'phase': p, 'purpose': q}) for p, q in requests]
    counter_raw, _ = chain(counter_rows)
    state = replay_control_budget(counter_raw, binding=config['control_budget']['binding'], seed=a.SEED, directory=directory, verified=previous)
    owner = {'schema': 1, 'kind': 'direct_owner_portal_cleanup_observation', 'resource_id': rid,
        'reported_delete_success_notification': True, 'reported_absence_after_refresh': True,
        **{key: False for key in ('machine_delete_ack', 'machine_authenticated_absence', 'historical_put_ack_reconstructed',
            'new_trial_or_window_authorized', 'new_trial_or_window_issued', 'goal_complete')},
        'old_unknown_preserved': True, 'monetary_reservations_preserved': True, 'known_published_images_retained': True,
        'portal_request_count': None, 'counts': deepcopy(target.COUNTS), 'counter_rows': 182,
        'child_sha256': a._sha(child_raw), 'counter_sha256': a._sha(counter_raw), 'recorded_at': stamp(22000)}
    head = '9'*40
    proof = {'schema': 5, 'previous_authority_raw': encoded(previous.authority).decode(),
        'previous_activation_raw': encoded(previous.activation).decode(), 'previous_publication_raw': public_raw.decode(),
        'previous_child_raw': child_raw.decode(), 'counter_prefix_raw': counter_raw.decode(),
        'previous_artifacts': {k: v.decode() for k, v in old['artifacts'].items()}, 'owner_cleanup_raw': encoded(owner).decode(),
        'image_compatibility': {'schema': 1, 'local_head': head, 'image_build_head': previous.authority['head'],
            'runtime_tree_sha256': 'c'*64, 'guardian_tree_sha256': 'd'*64, 'review_sha256': 'e'*64,
            'runtime_unchanged': True, 'guardian_unchanged': True}}
    new = deepcopy(old); authority = new['authority']; new_config = new['config']
    caps, reserve, delta = target.allocation(state['plan'], state['used'], state['counts'])
    new_config['frozen_head'] = head; new_config['code_sources'] = {'scripts/trial_provision/acknowledged_image_succession.py': '9'*64}
    authority.update(schema=6, approval='ISSUE148_LINKED_ATTEMPT_V6', head=head, image_build_head=previous.authority['head'],
        attempt_id='fictional-known-images-successor', code_sources_sha256=digest(new_config['code_sources']),
        approved_at=stamp(24000), publish_from=stamp(25000), counts_before=deepcopy(target.COUNTS), phase_caps=caps, unallocated=reserve,
        succession={'schema': 5, 'kind': target.KIND, 'proof_sha256': digest(proof), 'child_name': target.CHILD_NAME, 'phase_reallocation': delta})
    new['artifacts']['local_ready'] = encoded({'head': head, 'design_sha256': a.DESIGN_SHA256,
        'code_sources_sha256': authority['code_sources_sha256'], 'succession_proof': proof})
    new['artifacts']['limits'] = encoded({'schema': 1, 'head': head, 'counts_before': target.COUNTS,
        'phase_caps': caps, 'unallocated': reserve, 'purpose_caps': a.REUSED_IMAGE_PURPOSE_CAPS,
        'limits': a._authority_limits(authority), 'limit_amendment': authority['limit_amendment']})
    new['activation'].update(attempt_id=authority['attempt_id'], issued_at=stamp(24000),
        windows={k: {'start': stamp(25000+s), 'end': stamp(25000+e)} for k, (s, e) in a.window_offsets(authority).items()})
    new_config['publication']['publish_until'] = new['activation']['windows']['publication']['end']; first_fixture.seal(new)
    return {'new': new, 'old': previous, 'old_data': old_data, 'old_config': config, 'proof': proof,
        'child_rows': rows, 'child_raw': child_raw, 'counter_rows': counter_rows, 'counter_raw': counter_raw,
        'state': state, 'owner': owner, 'images': images, 'prep': prep, 'identity_operation': op}


def verify(data, *, now=None):
    new = data['new']; parent, _ = chain(new['parent_rows']); original = a.verify_attempt
    with patch.object(a, 'verify_attempt', return_value=data['old']) as historical:
        result = original(new['config'], new['manifest'], authority_raw=encoded(new['authority']),
            activation_raw=encoded(new['activation']), parent_journal_raw=parent,
            parent_final_raw=encoded(new['parent_final']), artifacts=new['artifacts'],
            trusted_authority_sha256=a._sha(encoded(new['authority'])), now=now or stamp(24000))
        historical.assert_called_once()
        assert historical.call_args.kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return result


def reseal(data):
    ready = a._json(data['new']['artifacts']['local_ready']); ready['succession_proof'] = data['proof']
    data['new']['artifacts']['local_ready'] = encoded(ready)
    data['new']['authority']['succession']['proof_sha256'] = digest(data['proof']); first_fixture.seal(data['new'])


class AcknowledgedImageSuccessionTests(unittest.TestCase):
    def setUp(self): self.data = fixture()

    def clone(self):
        sealed = (self.data['old'], self.data['old_data']['old'])
        return deepcopy(self.data, {id(value): value for value in sealed})

    def replay(self, raw, verified=None):
        config = self.data['old_config']
        return replay_control_budget(raw, binding=config['control_budget']['binding'], seed=a.SEED,
            directory=config['control_budget']['directory'], verified=verified)

    def changed_child(self, data, rows):
        child_raw = chain(rows)[0]
        data['proof']['previous_child_raw'] = child_raw.decode()
        owner = a._json(data['proof']['owner_cleanup_raw'].encode()); owner['child_sha256'] = a._sha(child_raw)
        data['proof']['owner_cleanup_raw'] = encoded(owner).decode(); reseal(data)

    def test_real_v6_verifier_preserves_302_and_unknown_and_both_images(self):
        data = self.data; before = data['counter_raw'], data['child_raw']
        with (patch('builtins.open', side_effect=AssertionError('file')), patch('subprocess.run', side_effect=AssertionError('process')),
              patch('socket.create_connection', side_effect=AssertionError('network'))):
            verified = verify(data)
        self.assertEqual(len(data['child_rows']), 70); self.assertEqual(len(data['counter_rows']), 182)
        self.assertEqual(verified.authority['phase_caps']['owner_arm'], dict(zip(a.PHASES, (24, 8, 145, 32, 120))))
        self.assertEqual(verified.authority['counts_before'], target.COUNTS)
        self.assertEqual(a._proof(verified)['succession']['acknowledged_images'], data['images'])
        self.assertEqual(a._proof(verified)['succession']['unknown_identity_receipt']['state'], 'unknown')
        self.assertEqual(a.effective_image_head(verified, verified.authority['head']), data['old'].authority['head'])
        raw, _ = chain(data['counter_rows']+[('attempt_transition', target.transition_value(verified))])
        config = data['old_config']; state = replay_control_budget(raw, binding=config['control_budget']['binding'], seed=a.SEED,
            directory=config['control_budget']['directory'], verified=verified)
        self.assertEqual(state['counts'], target.COUNTS); self.assertEqual(len(state['transitions']), 5)
        self.assertTrue(raw.startswith(before[0])); self.assertEqual(before, (data['counter_raw'], data['child_raw']))

    def test_shorter_reused_image_windows_require_reuse_schema_with_fixed_lead(self):
        self.assertEqual(a.window_offsets({'schema': 6}), {'publication': (0, 600), 'guardian': (600, 29400),
            'owner_input': (3300, 6900), 'initial': (4200, 6000)})
        for schema in (1, 2, 3, 4, 5): self.assertEqual(a.window_offsets({'schema': schema}), a.WINDOW_OFFSETS)
        for schema in (7,8,9):self.assertEqual(a.window_offsets({'schema':schema}),a.REUSED_IMAGE_WINDOW_OFFSETS)
        for bad in ({}, {'schema': True}, {'schema': 10}, {'schema': '6'}):
            with self.subTest(bad=bad), self.assertRaises(Denied): a.window_offsets(bad)
        copy = a.window_offsets({'schema': 6}); copy['publication'] = (0, 1800)
        self.assertEqual(a.window_offsets({'schema': 6})['publication'], (0, 600))
        for name in a.WINDOW_OFFSETS:
            data = self.clone(); start, end = a.WINDOW_OFFSETS[name]
            data['new']['activation']['windows'][name] = {'start': stamp(25000+start), 'end': stamp(25000+end)}
            first_fixture.seal(data['new'])
            with self.subTest(window=name), self.assertRaises(Denied): verify(data)
        data = self.clone(); data['new']['activation']['issued_at'] = stamp(24700); first_fixture.seal(data['new'])
        verify(data, now=stamp(24700))
        data['new']['activation']['issued_at'] = stamp(24701); first_fixture.seal(data['new'])
        with self.assertRaises(Denied): verify(data, now=stamp(24701))

    def test_unknown_identity_cannot_be_reinterpreted_as_ack_or_absence(self):
        for key, value in (('state', 'succeeded'), ('terminal', True), ('write_terminal', True),
                ('readback_verified', True), ('created_by_run', False), ('http', 200),
                ('properties', {'principalId': '00000000-0000-4000-8000-000000000001'}),
                ('operation_url', 'https://management.azure.com/fictional-operation'),
                ('initial_ack_digest', 'not-a-digest')):
            data = self.clone(); rows = deepcopy(data['child_rows']); rows[-1][1][key] = value
            self.changed_child(data, rows)
            with self.subTest(key=key), self.assertRaises(Denied): verify(data)
        for event in ('progress', 'portal_absence', 'clock_revoked'):
            data = self.clone(); rows = deepcopy(data['child_rows']); rows.append((event, {}))
            self.changed_child(data, rows)
            with self.subTest(event=event), self.assertRaises(Denied): verify(data)

    def test_portal_observation_does_not_authorize_ack_absence_or_new_trial(self):
        changes = [(key, True) for key in ('machine_delete_ack', 'machine_authenticated_absence',
            'historical_put_ack_reconstructed', 'new_trial_or_window_authorized', 'new_trial_or_window_issued', 'goal_complete')]
        changes += [('reported_delete_success_notification', False), ('reported_absence_after_refresh', False),
            ('old_unknown_preserved', False), ('monetary_reservations_preserved', False),
            ('known_published_images_retained', False), ('portal_request_count', 0),
            ('resource_id', self.data['old_config']['control_budget']['directory']), ('counter_rows', 181),
            ('counter_sha256', '0'*64), ('recorded_at', stamp(24001))]
        for key, value in changes:
            data = self.clone(); owner = deepcopy(data['owner']); owner[key] = value
            data['proof']['owner_cleanup_raw'] = encoded(owner).decode(); reseal(data)
            with self.subTest(key=key), self.assertRaises(Denied): verify(data)

    def test_ack_images_probe_absence_and_bridge_digests_are_required(self):
        mutations = [
            ('guardian_image_namespace', 'authenticated', False),
            ('runtime_image_retention', 'namespace_sha256', '0'*64),
            ('guardian_docker_probe_result', 'new_http_requests', 1),
            ('runtime_docker_probe_result', 'temporary_config_absent', False),
            ('guardian_docker_config_absent', 'absent', False),
            ('runtime_docker_probe_config_absent', 'path_digest', '0'*64),
            ('provision_bridge_output', 'code_sha', '0'*40),
            ('publication_import', 'initial_plan_digest', '0'*64),
            ('provision_bridge_prepared', 'core_plan_digest', '0'*64),
        ]
        for event, key, value in mutations:
            data = self.clone(); rows = deepcopy(data['child_rows'])
            next(v for e, v in rows if e == event)[key] = value; self.changed_child(data, rows)
            with self.subTest(event=event, key=key), self.assertRaises(Denied): verify(data)
        for slot in ('guardian', 'runtime'):
            data = self.clone(); rows = deepcopy(data['child_rows'])
            final = [v for e, v in rows if e == 'progress' and v['operation_id'] == slot+'ImagePush'][-1]
            final['terminal'] = False; self.changed_child(data, rows)
            with self.subTest(slot=slot), self.assertRaises(Denied): verify(data)

    def test_new_head_old_image_tags_compatibility_and_fixed_reallocation(self):
        for mutate in ('pending', 'old-head', 'image-head', 'tag', 'cleanup', 'run', 'delta',
                'amendment', 'runtime-changed', 'guardian-int', 'compatibility-head', 'review-missing'):
            data = self.clone(); authority = data['new']['authority']; compatibility = data['proof']['image_compatibility']
            if mutate == 'pending': authority['decision'] = 'PENDING'
            elif mutate == 'old-head': authority['head'] = data['old'].authority['head']
            elif mutate == 'image-head': authority['image_build_head'] = authority['head']
            elif mutate == 'tag': authority['tags']['guardian'] += '-new'
            elif mutate == 'cleanup': authority['phase_caps']['owner_arm'].update(cleanup=119, provision=146)
            elif mutate == 'run': authority['phase_caps']['owner_arm'].update(run=33, publication=7)
            elif mutate == 'delta': authority['succession']['phase_reallocation']['phase_delta']['run'] = -9
            elif mutate == 'amendment': authority['limit_amendment']['approval_sha256'] = '0'*64
            elif mutate == 'runtime-changed': compatibility['runtime_unchanged'] = False
            elif mutate == 'guardian-int': compatibility['guardian_unchanged'] = 1
            elif mutate == 'compatibility-head': compatibility['local_head'] = data['old'].authority['head']
            else: compatibility['review_sha256'] = ''
            reseal(data)
            with self.subTest(mutate=mutate), self.assertRaises(Denied): verify(data)

    def test_prior_debits_transitions_scope_and_prefix_cannot_be_rewritten(self):
        current = verify(self.data); transition = target.transition_value(current)
        for mutate in ('spent', 'fresh-token', 'first', 'second', 'third', 'fourth', 'fifth',
                'repeat', 'prefix', 'delta', 'old-scope'):
            rows = deepcopy(self.data['counter_rows'])+[('attempt_transition', deepcopy(transition))]
            if mutate == 'spent': rows.pop(181)
            elif mutate == 'fresh-token': rows[159][1]['purpose'] = 'http'
            elif mutate in ('first', 'second', 'third', 'fourth', 'fifth'):
                index = {'first': 71, 'second': 116, 'third': 148, 'fourth': 158, 'fifth': 182}[mutate]
                rows[index][1]['proof_sha256'] = '0'*64
            elif mutate == 'repeat': rows.append(deepcopy(rows[-1]))
            elif mutate == 'prefix': rows[-1][1]['prefix_rows'] = 181
            elif mutate == 'delta': rows[-1][1]['phase_reallocation']['phase_delta']['cleanup'] = -1
            else: rows.append(('request', {'kind': 'owner_arm', 'attempt': self.data['old'].binding_digest,
                'phase': 'publication', 'purpose': 'http'}))
            with self.subTest(mutate=mutate), self.assertRaises(Denied): self.replay(chain(rows)[0], current)

    def test_entire_remaining_329_caps_and_new_purpose_caps_are_enforced(self):
        current = verify(self.data)
        prefix = deepcopy(self.data['counter_rows'])+[('attempt_transition', target.transition_value(current))]
        rows = deepcopy(prefix)
        for phase, http_count, token_count in (('fresh_read', 24, 0), ('publication', 6, 2),
                ('provision', 135, 10), ('run', 24, 8), ('cleanup', 120, 0)):
            for purpose, count in (('http', http_count), ('owner_token', token_count)):
                rows += [('request', {'kind': 'owner_arm', 'attempt': current.binding_digest,
                    'phase': phase, 'purpose': purpose}) for _ in range(count)]
        state = self.replay(chain(rows)[0], current)
        self.assertEqual(state['counts']['owner_arm'], 631)
        self.assertEqual(state['used']['owner_arm']['cleanup'], 120)
        for phase, purpose, count in (('publication', 'http', 7), ('publication', 'owner_token', 3),
                ('run', 'http', 25), ('run', 'owner_token', 9), ('cleanup', 'http', 121)):
            extra = [('request', {'kind': 'owner_arm', 'attempt': current.binding_digest,
                'phase': phase, 'purpose': purpose}) for _ in range(count)]
            with self.subTest(phase=phase, purpose=purpose), self.assertRaises(Denied):
                self.replay(chain(prefix+extra)[0], current)
        rows.append(('request', {'kind': 'owner_arm', 'attempt': current.binding_digest, 'phase': 'fresh_read', 'purpose': 'http'}))
        with self.assertRaises(Denied): self.replay(chain(rows)[0], current)

    def test_successor_needs_explicit_initialize_and_prior_child_lock_once(self):
        current = verify(self.data); config = self.data['old_config']
        store = {'raw': self.data['counter_raw'], 'locked': False, 'appends': 0}
        counter_binding = {'binding': config['control_budget']['binding'], 'limits': a.LIMITS, 'seed': a.SEED}
        records, _ = a._journal(store['raw'], counter_binding)
        budget = object.__new__(ControlBudget); budget.mutex = threading.RLock(); budget.seed = deepcopy(a.SEED)
        budget.binding = deepcopy(config['control_budget']['binding']); budget._binding_digest = digest(budget.binding)
        budget._seed_digest = digest(budget.seed); budget._closed = budget._poisoned = False; budget._verified = self.data['old']
        def append(event, value):
            self.assertTrue(store['locked']); self.assertEqual(event, 'attempt_transition'); store['appends'] += 1
            rows = [(r['event'], r['value']) for r in budget.journal.records]+[(event, value)]
            store['raw'] = chain(rows)[0]; budget.journal.records = a._journal(store['raw'], counter_binding)[0]
        path = SimpleNamespace(parent=Path(config['control_budget']['directory']), read_bytes=lambda: store['raw'])
        budget.journal = SimpleNamespace(path=path, mutex=threading.RLock(), records=records, append=append)
        budget._replay(self.data['old']); old_scope = budget._new_scope('publication', _SCOPE_KEY)
        with self.assertRaises(Denied): budget.begin_attempt(current)
        self.assertEqual(store['appends'], 0)
        class PriorLock:
            def __init__(inner, *args, **kwargs):
                self.assertEqual(kwargs['name'], 'trial-provision-successor-v5'); self.assertIs(kwargs['require_existing'], True)
                self.assertEqual(args[2], a._proof(current)['succession']['child_binding'])
                inner.path = SimpleNamespace(read_bytes=lambda: self.data['child_raw'])
                inner.previous = a._proof(current)['succession']['child_tail']
            def __enter__(inner): store['locked'] = True; return inner
            def __exit__(inner, *_): store['locked'] = False
        with patch('scripts.trial_provision.journal.Journal', PriorLock), patch('os.path.lexists', return_value=True):
            with self.assertRaises(Denied): budget.begin_attempt(current, initialize=True)
        self.assertEqual(store['appends'], 0); self.assertEqual(store['raw'], self.data['counter_raw'])
        with patch('scripts.trial_provision.journal.Journal', PriorLock), patch('os.path.lexists', return_value=False):
            budget.begin_attempt(current, initialize=True); once = store['raw']; budget.begin_attempt(current, initialize=True)
        self.assertEqual(store['appends'], 1); self.assertEqual(store['raw'], once); self.assertFalse(store['locked'])
        self.assertTrue(once.startswith(self.data['counter_raw'])); self.assertEqual(budget.counts(), target.COUNTS)
        with self.assertRaises(Denied): old_scope.consume('owner_arm', 600)
        with self.assertRaises(Denied): budget.begin_attempt(self.data['old'], initialize=True)
        self.assertEqual(store['raw'], once)


if __name__ == '__main__': unittest.main()
