"""New diagnostic authority over the exact stopped V8 fake-I/O pipeline."""
from copy import deepcopy
from datetime import timedelta
import json
import os
import unittest
from unittest.mock import Mock

from scripts.trial_guard.adapters import encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import pim_diagnosis as target
from scripts.trial_provision import stopped_reads as prior


def response(status=400, code='AadPremiumLicenseRequired', message='fictional-private-message'):
    return {'status': status, 'headers': {}, 'body': encoded({'error': {'code': code, 'message': message}})}


class ClassifierTests(unittest.TestCase):
    def test_known_code_and_unknown_code_never_expose_message(self):
        value = target.classify(response())
        self.assertEqual('license_requirement', value['cause'])
        self.assertNotIn('fictional-private-message', json.dumps(value))
        value = target.classify(response(code='canary-secret-code', message='canary-private-message'))
        self.assertEqual('unclassified', value['cause'])
        self.assertNotIn('canary-', json.dumps(value))

    def test_error_bearing_json_and_message_pattern_are_bounded(self):
        owner = '11111111-1111-4111-8111-111111111111'
        value = target.classify(response(code='unlisted', message='The requestor '+owner+' does not have permissions for this request. '
            'Please use $filter=asTarget() to filter on the requestor\'s assignments.'), owner)
        self.assertEqual('permission_denied', value['cause'])
        self.assertNotIn(owner, json.dumps(value))
        value = target.classify(response(code='unlisted', message='A premium license is not required.'))
        self.assertEqual('unclassified', value['cause'])
        value = target.classify({'status': 400, 'headers': {}, 'body': b'{"error":{"code":"InvalidFilter","code":"BadRequest"}}'})
        self.assertEqual('unclassified', value['cause'])

    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI boundary')
    def test_current_user_dpapi_roundtrip(self):
        raw = b'fictional-private-diagnostic-body'
        cipher = target.protect_failure_body(raw)
        self.assertNotIn(raw, cipher)
        self.assertEqual(raw, target.protect_failure_body(cipher, decrypt=True))


class PimDiagnosisTests(unittest.TestCase):
    def setUp(self):
        from scripts.trial_provision.tests.test_stopped_reads import StoppedReadsTests
        old = self.old = StoppedReadsTests('runTest'); old.setUp(); self.addCleanup(old.doCleanups)
        old.wire.side_effect = [
            {'status': 404, 'headers': {}, 'body': encoded({'error': {'code': 'ResourceNotFound'}})},
            {'status': 200, 'headers': {}, 'body': encoded({'value': []})}, response(), response()]
        self.previous = old.run_reads(); h = self.h = old.h
        e = {k: old.evidence[k] for k in ('child', 'authority', 'manifest', 'stop_guard', 'stop_cleanup')}
        e.update(counter=(h.root/'trial-control-budget.jsonl').read_bytes(), prior_grant=encoded(old.g),
                 prior_request=old.evidence['direct_request'], prior_result=(h.root/prior.RESULT).read_bytes(),
                 prior_marker=(h.root/prior.MARKER).read_bytes(), direct_request=b'new explicit fictional diagnosis request')
        self.evidence = e; self.sources = {'new-fixture.py': 'c'*64}
        g = deepcopy(old.g)
        g.update(kind=target.KIND, phase=target.PHASE, targets=g['targets'][2:], source_digests=self.sources,
                 counter_rows=266, counts=self.previous['counts'], maximum={'http': 2, 'owner_token': 1},
                 direct_request_sha256=target.sha(e['direct_request']), evidence_sha256={k: target.sha(v) for k, v in e.items()})
        self.g = g
        self.credential = Mock(mode='owner', principal=g['owner']['principal_id'].lower(), tenant=g['owner']['tenant_id'].lower())
        self.credential.token.return_value = 'fictional-memory-token'
        self.wire = Mock(return_value=response())
        self.protector = Mock(return_value=b'fictional-ciphertext-only')

    def verify(self):
        raw = encoded(self.g)
        return target.verify_grant(raw, trusted_sha256=target.sha(raw), evidence=self.evidence,
                                   source_digests=self.sources, now=self.h.clock.utc())

    def run_reads(self):
        return target.observe_once(self.verify(), clock=self.h.clock, credential=self.credential, wire=self.wire,
                                   current_sources=lambda: self.sources, protector=self.protector)

    def test_first_error_stops_with_two_fresh_debits_and_preserves_every_old_byte(self):
        result = self.run_reads()
        self.assertEqual((384, 268, 2), (result['counts']['owner_arm'], result['counter_rows'], result['requests']))
        self.assertEqual('license_requirement', result['observations'][0]['cause'])
        self.assertEqual(1, self.wire.call_count)
        counter = (self.h.root/'trial-control-budget.jsonl').read_bytes()
        self.assertTrue(counter.startswith(self.evidence['counter']))
        suffix = [json.loads(x) for x in counter.splitlines()[-2:]]
        self.assertEqual(['owner_token', 'http'], [r['value']['purpose'] for r in suffix])
        self.assertTrue(all(r['value']['phase'] == 'fresh_read' for r in suffix))
        self.assertEqual(self.evidence['child'], (self.h.root/(target.CHILD+'.jsonl')).read_bytes())
        self.assertEqual(self.evidence['prior_result'], (self.h.root/prior.RESULT).read_bytes())
        self.assertNotIn('fictional-private-message', (self.h.root/'trial-v8-pim-failure-0.dpapi.json').read_text())
        self.assertNotIn('fictional-memory-token', json.dumps(result))
        with self.assertRaises(Denied): self.run_reads()
        self.assertEqual(counter, (self.h.root/'trial-control-budget.jsonl').read_bytes())

    def test_two_successful_fixed_gets_are_still_not_cleanup_proof(self):
        self.wire.return_value = {'status': 200, 'headers': {}, 'body': encoded({'value': []})}
        counts = []
        def read(*args):
            counts.append(len((self.h.root/'trial-control-budget.jsonl').read_bytes().splitlines()))
            self.assertEqual('GET', args[0]); self.assertIsNone(args[3])
            return self.wire.return_value
        self.wire.side_effect = read
        result = self.run_reads()
        self.assertEqual([268, 269], counts)
        self.assertEqual(385, result['counts']['owner_arm'])
        self.assertFalse(result['deletion_authorized']); self.assertFalse(result['restart_authorized'])
        self.protector.assert_not_called()

    def test_changed_evidence_target_or_phase_is_rejected_before_auth(self):
        original = deepcopy(self.g)
        for alter in (lambda: self.g.update(phase='provision'),
                      lambda: self.g['targets'][0].update(url=self.g['targets'][0]['url']+'&$filter=asTarget()'),
                      lambda: self.g.update(counter_rows=267)):
            self.g = deepcopy(original); alter()
            with self.assertRaises(Denied): self.verify()
        self.g = original; self.evidence['prior_result'] += b' '
        with self.assertRaises(Denied): self.verify()
        self.credential.token.assert_not_called(); self.wire.assert_not_called()

    def test_expiry_during_token_stops_before_any_get(self):
        self.g['end'] = (self.h.clock.utc()+timedelta(seconds=2)).isoformat()
        def token(_, deadline):
            self.assertLessEqual(deadline.remaining(), 2)
            self.h.clock.advance(3); deadline.remaining()
        self.credential.token.side_effect = token
        result = self.run_reads()
        self.assertEqual((383, 1), (result['counts']['owner_arm'], result['requests']))
        self.wire.assert_not_called()


if __name__ == '__main__': unittest.main()
