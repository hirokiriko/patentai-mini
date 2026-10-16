"""Fictional in-memory ACR receipts; never calls Docker, credentials or Cloud."""
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.attempt import journal_descriptor
from scripts.trial_provision.registry_publish import verified_publication_image, verified_publication_images
from scripts.trial_provision.registry_retention import check_attempt, observe_after, observe_namespace, urls
from scripts.trial_provision.tests.test_attempt import fixture, sha, stamp, verify


class MemoryJournal:
    def __init__(self, rows):
        self.rows = deepcopy(rows)
    def values(self, event):
        return deepcopy([v for e, v in self.rows if e == event])
    def latest(self, ident):
        rows = [v for e, v in self.rows if e == 'progress' and v['operation_id'] == ident]
        return deepcopy(rows[-1]) if rows else None
    def append(self, event, value):
        self.rows.append((event, deepcopy(value)))
    def live(self, event):
        return next(v for e, v in self.rows if e == event)


def publication_fixture(data=None, *, verified=None, offset=0):
    from scripts.trial_provision.tests.test_attempt import stamp as base_stamp
    stamp=lambda seconds=0:base_stamp(seconds+offset)
    data = fixture() if data is None else deepcopy(data)
    old_body = encoded({'schemaVersion': 2, 'fictional': 'retained runtime manifest'})
    old_digest = 'sha256:' + sha(old_body)
    old_placeholder = data['authority']['retained_runtime']['digest']
    def replace(value):
        if isinstance(value, str):
            return value.replace(old_placeholder, old_digest)
        if isinstance(value, dict):
            return {k: replace(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [replace(v) for v in value]
        return value
    data['parent_rows'] = replace(data['parent_rows'])
    data['authority']['retained_runtime']['digest'] = old_digest
    verified = verify(data) if verified is None else verified
    data['config']['attempt']['sha256'] = sha(encoded(verified.activation))
    _, binding = journal_descriptor(data['config'], verified)
    prep = deepcopy(next(v for e, v in data['parent_rows'] if e == 'publication_preparation'))
    prep.update(code_sha=verified.authority['head'], run_binding_digest=digest(binding), publish_until=stamp(1800))
    for slot in prep['slots']:
        prep['slots'][slot]['tag'] = verified.authority['tags'][slot]
    rows = [('binding', binding), ('publication_preparation', prep)]
    for slot in ('guardian', 'runtime'):
        ident = slot + 'ImagePush'
        intent = deepcopy(next(v for e, v in data['parent_rows'] if e == 'intent' and v['operation_id'] == ident))
        receipt = deepcopy(next(v for e, v in data['parent_rows'] if e == 'progress' and v['operation_id'] == ident))
        prefix = 'https://' + prep['login_server'] + '/v2/' + prep['slots'][slot]['repository'] + '/manifests/'
        image = 'sha256:' + ('1' if slot == 'guardian' else '2') * 64
        intent.update(url=prefix + prep['slots'][slot]['tag'] + '?api-version=2021-07-01', at=stamp(100), deadline=prep['publish_until'])
        receipt.update(object_id=prefix + image + '?api-version=2021-07-01', observed_at=stamp(120))
        receipt['properties']['manifest_digest'] = image
        namespace = deepcopy(next(v for e, v in data['parent_rows'] if e == slot + '_image_namespace'))
        namespace.update(publication_preparation_digest=digest(prep), run_binding_digest=digest(binding), observed_at=stamp(99))
        if slot == 'runtime':
            checks = {}
            for key, url in urls(prep, verified).items():
                checks[key] = {'url': url, 'http': 404 if key == 'new_tag' else 200,
                    'response_sha256': old_digest[7:] if key.startswith('retained_') else '3' * 64,
                    'observed_at': stamp(99), 'content_digest': old_digest if key.startswith('retained_') else None,
                    'error_code': 'MANIFEST_UNKNOWN' if key == 'new_tag' else None}
            namespace = {'schema': 1, 'mode': 'retained-runtime', 'attempt_binding_digest': verified.binding_digest,
                'publication_preparation_digest': digest(prep), 'run_binding_digest': digest(binding),
                **{k: prep[k] for k in ('registry_id', 'login_server')}, 'repository': prep['slots']['runtime']['repository'],
                'push_operation_id': ident, 'push_request_digest': receipt['request_digest'],
                'retained_tag': verified.authority['retained_runtime']['tag'], 'retained_digest': old_digest,
                'authenticated': True, 'observed_at': stamp(99), 'checks': checks}
            ack = deepcopy(receipt)
            ack.update(state='pending', terminal=False, readback_verified=False, observed_at=stamp(110))
            after_checks = {k: {**v, 'observed_at': stamp(115)} for k, v in checks.items() if k.startswith('retained_')}
            after = {'schema': 1, 'namespace_sha256': digest(namespace), 'push_request_digest': receipt['request_digest'],
                'manifest_digest': image, 'retained_digest': old_digest, 'push_ack_sha256': digest(ack),
                'checks': after_checks, 'observed_at': stamp(115)}
            rows.extend([('runtime_image_retention', after), ('progress', ack)])
        rows.extend([(slot + '_image_namespace', namespace), ('intent', intent), ('progress', receipt)])
    return MemoryJournal(rows), verified, old_body


class RegistryRetentionTests(unittest.TestCase):
    def setUp(self):
        self.journal, self.verified, self.old_body = publication_fixture()
    def images(self):
        return verified_publication_images(self.journal, verified_attempt=self.verified)
    def publisher(self):
        prep = self.journal.live('publication_preparation')
        clock = Mock()
        clock.utc.return_value = datetime.fromisoformat(stamp(99).replace('Z', '+00:00'))
        old_digest = self.verified.authority['retained_runtime']['digest']
        expected = urls(prep, self.verified)
        def wire(method, url, *, token):
            self.assertEqual(method, 'GET')
            self.assertEqual(token, 'fictional-access')
            if url == expected['repository']:
                return {'status': 200, 'headers': {}, 'body': encoded({'name': prep['slots']['runtime']['repository']})}
            if url == expected['new_tag']:
                return {'status': 404, 'headers': {}, 'body': encoded({'errors': [{'code': 'MANIFEST_UNKNOWN'}]})}
            self.assertIn(url, (expected['retained_tag'], expected['retained_digest']))
            return {'status': 200, 'headers': {'docker-content-digest': old_digest}, 'body': self.old_body}
        return SimpleNamespace(journal=self.journal, verified_attempt=self.verified, clock=clock,
            preparation=digest(prep), run_digest=prep['run_binding_digest'], ident='runtimeImagePush',
            op={'fictional': 'runtimeImagePush'}, access='fictional-access',
            binding={**{k: prep[k] for k in ('registry_id', 'login_server')}, 'repository': prep['slots']['runtime']['repository']},
            image_digest=self.journal.latest('runtimeImagePush')['properties']['manifest_digest'], _wire=Mock(side_effect=wire))

    def test_old_namespace_and_new_fixed_tag_have_independent_proofs(self):
        images = self.images()
        self.assertTrue(images['runtime_image'].endswith('@sha256:' + '2' * 64))
        self.assertNotIn(self.verified.authority['retained_runtime']['digest'], images['runtime_image'])
        self.assertEqual(verified_publication_image(self.journal, 'guardian', verified_attempt=self.verified), images['guardian_image'])

    def test_legacy_parent_requires_no_new_attempt_and_cannot_be_imported_as_child(self):
        old = MemoryJournal(fixture()['parent_rows'])
        self.assertIn('runtime_image', verified_publication_images(old))
        with self.assertRaises(Denied):
            verified_publication_images(old, verified_attempt=self.verified)
        with self.assertRaises(Denied):
            verified_publication_images(self.journal)

    def test_attempt_binding_and_new_head_or_tag_cannot_change(self):
        for mutation in (lambda j: j.live('binding')['attempt'].update(binding_digest='0' * 64),
                lambda j: j.live('publication_preparation').update(code_sha='b' * 40),
                lambda j: j.live('publication_preparation')['slots']['runtime'].update(tag='old-runtime')):
            with self.subTest(mutation=mutation):
                changed = MemoryJournal(self.journal.rows)
                mutation(changed)
                with self.assertRaises(Denied):
                    verified_publication_images(changed, verified_attempt=self.verified)

    def test_every_retained_hash_and_new_tag_absence_is_required(self):
        mutations = [lambda n: n.update(authenticated=False), lambda n: n.update(retained_tag='other-tag'),
            lambda n: n['checks']['new_tag'].update(http=200), lambda n: n['checks']['new_tag'].update(error_code='NAME_UNKNOWN'),
            lambda n: n['checks']['repository'].update(http=404), lambda n: n['checks']['retained_tag'].update(response_sha256='0' * 64),
            lambda n: n['checks']['retained_digest'].update(content_digest='sha256:' + '0' * 64),
            lambda n: n['checks']['retained_tag'].update(url='https://other.azurecr.io/foreign')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                changed = MemoryJournal(self.journal.rows)
                mutation(changed.live('runtime_image_namespace'))
                # Keep the envelope hash coherent to exercise the observation validation itself.
                changed.live('runtime_image_retention')['namespace_sha256'] = digest(changed.live('runtime_image_namespace'))
                with self.assertRaises(Denied):
                    verified_publication_images(changed, verified_attempt=self.verified)

    def test_after_proof_requires_ack_both_old_reads_and_new_digest(self):
        for mutation in (lambda a: a.update(push_ack_sha256='0' * 64),
                lambda a: a['checks'].pop('retained_tag'),
                lambda a: a['checks']['retained_digest'].update(response_sha256='0' * 64),
                lambda a: a.update(manifest_digest=self.verified.authority['retained_runtime']['digest']),
                lambda a: a.update(observed_at=stamp(109)),
                lambda a: a['checks']['retained_tag'].update(observed_at=stamp(109))):
            with self.subTest(mutation=mutation):
                changed = MemoryJournal(self.journal.rows)
                mutation(changed.live('runtime_image_retention'))
                with self.assertRaises(Denied):
                    verified_publication_images(changed, verified_attempt=self.verified)

    def test_stale_preflight_or_missing_postflight_cannot_be_success(self):
        for kind in ('stale', 'missing', 'duplicate'):
            with self.subTest(kind=kind):
                changed = MemoryJournal(self.journal.rows)
                if kind == 'stale':
                    changed.live('runtime_image_namespace')['observed_at'] = stamp(69)
                elif kind == 'missing':
                    changed.rows = [(e, v) for e, v in changed.rows if e != 'runtime_image_retention']
                else:
                    changed.append('runtime_image_retention', changed.live('runtime_image_retention'))
                with self.assertRaises(Denied):
                    verified_publication_images(changed, verified_attempt=self.verified)

    def test_partial_guardian_proof_survives_runtime_failure_without_adopting_runtime(self):
        self.journal.rows = [(e, v) for e, v in self.journal.rows
            if not e.startswith('runtime_image_') and v.get('operation_id') != 'runtimeImagePush']
        image = verified_publication_image(self.journal, 'guardian', verified_attempt=self.verified)
        self.assertTrue(image.endswith('@sha256:' + '1' * 64))
        with self.assertRaises(Denied):
            self.images()
        with self.assertRaises(Denied):
            verified_publication_image(self.journal, 'runtime', verified_attempt=self.verified)
        # A positive process ACK alone still cannot authorize guardian cleanup.
        receipt = next(v for e, v in self.journal.rows if e == 'progress')
        receipt.update(state='pending', terminal=False, readback_verified=False)
        with self.assertRaises(Denied):
            verified_publication_image(self.journal, 'guardian', verified_attempt=self.verified)

    def test_observer_uses_exact_four_gets_and_hashes_actual_old_manifest_body(self):
        publisher = self.publisher()
        record = observe_namespace(publisher)
        expected = urls(self.journal.live('publication_preparation'), self.verified)
        self.assertEqual([c.args[1] for c in publisher._wire.call_args_list], list(expected.values()))
        self.assertEqual(record['checks']['retained_tag']['response_sha256'], sha(self.old_body))
        self.assertEqual(record['retained_digest'], 'sha256:' + sha(self.old_body))

    def test_observer_never_retries_mismatched_retained_body_or_existing_new_tag(self):
        for key in ('retained_tag', 'new_tag'):
            with self.subTest(key=key):
                publisher = self.publisher()
                original = publisher._wire.side_effect
                bad_url = urls(self.journal.live('publication_preparation'), self.verified)[key]
                def changed(method, url, *, token):
                    result = original(method, url, token=token)
                    if url == bad_url:
                        result = {**result, 'body': b'changed old manifest'} if key == 'retained_tag' else {**result, 'status': 200}
                    return result
                publisher._wire.side_effect = changed
                with self.assertRaises(Denied):
                    observe_namespace(publisher)
                self.assertEqual(sum(c.args[1] == bad_url for c in publisher._wire.call_args_list), 1)

    def test_postflight_rereads_both_old_references_without_replacing_prior_receipt(self):
        publisher = self.publisher()
        publisher.clock.utc.return_value = datetime.fromisoformat(stamp(116).replace('Z', '+00:00'))
        ack = next(v for e, v in self.journal.rows if e == 'progress' and v['operation_id'] == 'runtimeImagePush' and not v['terminal'])
        before = deepcopy(self.journal.rows)
        observe_after(publisher, ack)
        self.assertEqual(self.journal.rows, before)
        expected = urls(self.journal.live('publication_preparation'), self.verified)
        self.assertEqual([c.args[1] for c in publisher._wire.call_args_list], [expected['retained_tag'], expected['retained_digest']])
        altered = deepcopy(ack); altered['observed_at'] = stamp(111)
        with self.assertRaises(Denied):
            observe_after(publisher, altered)
        self.assertEqual(self.journal.rows, before)


if __name__ == '__main__':
    unittest.main()
