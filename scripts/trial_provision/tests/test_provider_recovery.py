"""Offline provider recovery contracts; no real credentials, files or network.

The fixture imports use only invented targets and injected transport/clock.
"""
from copy import deepcopy
import json
import unittest

from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.providers import BoundedArmProvider
from scripts.trial_provision.tests import test_providers as fixtures
from scripts.trial_provision.tests.test_providers import (
    Credential, deletion, operation, resource,
)


class ProviderRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.h = fixtures.ProvidersTests()
        self.h.setUp()

    def initial_ack(self):
        h = self.h
        op = operation('jobs')
        absent = h.absent(op)
        h.http.add(201, resource(op))
        return op, h.provider.send(op, absent)

    def test_known_create_ack_recovers_after_deadline_then_scoped_cleanup_closes(self):
        h = self.h
        op, ack = self.initial_ack()
        h.clock.advance(601)
        # A fresh adapter represents process restart; the saved receipt alone
        # supplies the same bound ACK, never a new create or observed adoption.
        h.provider = BoundedArmProvider(Credential(h.clock), h.http, h.clock)
        count = len(h.http.calls)
        h.http.add(500)
        pending = h.provider.readback(op, ack)
        self.assertEqual(ack['initial_ack_digest'], pending['initial_ack_digest'])
        self.assertEqual(ack['request_digest'], pending['request_digest'])
        self.assertEqual('pending', pending['state'])
        h.http.add(200, resource(op))
        created = h.provider.readback(op, pending)
        self.assertEqual('succeeded', created['state'])
        self.assertTrue(created['readback_verified'])
        delete = deletion(op)
        h.http.add(200, resource(op))
        current = h.provider.inspect_cleanup(op, created, delete)
        h.http.add(204)
        delete_ack = h.provider.cleanup(delete, op, created, current)
        h.http.add(404)
        final = h.provider.readback(delete, delete_ack)
        self.assertEqual('succeeded', final['state'])
        self.assertTrue(final['terminal'])
        self.assertEqual(['GET', 'GET', 'GET', 'DELETE', 'GET'],
                         [call[0] for call in h.http.calls[count:]])

    def test_known_lro_after_deadline_then_resource_readback_is_get_only(self):
        h = self.h
        op, pending = h.lro('jobs')
        h.clock.advance(601)
        count = len(h.http.calls)
        h.http.add(200, {'status': 'Succeeded'})
        ack = h.provider.poll(op, pending)
        self.assertTrue(ack['write_terminal'])
        self.assertEqual(pending['initial_ack_digest'], ack['initial_ack_digest'])
        self.assertEqual(pending['operation_url_digest'], ack['operation_url_digest'])
        h.http.add(200, resource(op))
        final = h.provider.readback(op, ack)
        self.assertEqual('succeeded', final['state'])
        self.assertEqual(['GET', 'GET'], [call[0] for call in h.http.calls[count:]])

    def test_unknown_or_missing_ack_gets_no_expired_read_authority_or_adoption(self):
        h = self.h
        op, ack = self.initial_ack()
        h.clock.advance(601)
        missing = deepcopy(ack)
        missing.pop('initial_ack_digest')
        unknown = h.provider._base(op, 'unknown')
        count = len(h.http.calls)
        for receipt in (None, missing, unknown):
            result = h.provider.readback(op, receipt)
            self.assertNotEqual('succeeded', result['state'])
            self.assertFalse(result['terminal'])
        self.assertEqual(count, len(h.http.calls))
        foreign = deepcopy(ack)
        foreign['request_digest'] = 'f' * 64
        with self.assertRaises(Denied):
            h.provider.readback(op, foreign)
        self.assertEqual(count, len(h.http.calls))

    def test_recovery_flag_cannot_send_writes_or_get_body(self):
        h = self.h
        op, _ = self.initial_ack()
        h.clock.advance(601)
        calls, tokens = len(h.http.calls), h.credential.calls
        for method, body in (('PUT', {}), ('PATCH', {}), ('POST', None),
                             ('DELETE', None), ('GET', {})):
            with self.subTest(method=method, body_present=body is not None):
                with self.assertRaises(Denied):
                    h.provider._request(op, method, op['url'], body, recovery=True)
        self.assertEqual(calls, len(h.http.calls))
        self.assertEqual(tokens, h.credential.calls)
        # Ordinary create retains its original deadline too.
        result = h.provider.send(op, h.provider._base(op, 'absent', 404))
        self.assertFalse(result['write_terminal'])
        self.assertEqual(calls, len(h.http.calls))

    def test_recovery_has_one_30_second_budget_including_credentials(self):
        h = self.h
        op, ack = self.initial_ack()
        h.clock.advance(601)
        h.credential.delay = 31
        calls = len(h.http.calls)
        result = h.provider.readback(op, ack)
        self.assertEqual(calls, len(h.http.calls))
        self.assertEqual('pending', result['state'])
        self.assertEqual(ack['initial_ack_digest'], result['initial_ack_digest'])
        self.assertFalse(result['terminal'])

    def test_slow_recovery_response_keeps_ack_for_fresh_bounded_retry(self):
        h = self.h
        op, ack = self.initial_ack()
        h.clock.advance(601)
        observed = []
        def slow_wire(method, url, headers, body, deadline):
            observed.append((method, deadline.remaining()))
            h.clock.advance(31)
            return {'status': 200, 'headers': {},
                    'body': json.dumps(resource(op)).encode()}
        h.provider.http = slow_wire
        pending = h.provider.readback(op, ack)
        self.assertEqual([('GET', 30)], observed)
        self.assertEqual('pending', pending['state'])
        self.assertEqual(ack['initial_ack_digest'], pending['initial_ack_digest'])
        self.assertFalse(pending['terminal'])
        h.provider.http = h.http
        h.http.add(200, resource(op))
        self.assertEqual('succeeded', h.provider.readback(op, pending)['state'])


if __name__ == '__main__':
    unittest.main()
