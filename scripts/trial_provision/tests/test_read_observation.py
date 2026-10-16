"""Fail-closed read observations, with fictional data and no cloud access."""
import json
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from scripts.trial_guard.adapters import Deadline, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.read_observation import count_collection, job_absence, summary, COLLECTIONS
from scripts.trial_provision.read_http import ReadHttp, ReadFailure, _read_child
from scripts.trial_provision.providers import BoundedArmProvider
from .test_providers import Clock, Credential, Http, operation, resource, SUB, UUID


def response(status=200, value=None, headers=None):
    return {'status': status, 'headers': headers or {}, 'body': encoded(value if value is not None else {'value': []})}


class ReadObservationTests(unittest.TestCase):
    def setUp(self):
        self.op = operation('jobs')
        self.rid = self.op['expected']['resource_id']
        self.role = SUB + '/providers/Microsoft.Authorization/roleDefinitions/' + UUID
        self.initial = 'https://management.azure.com' + SUB + '/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01'

    def test_only_scoped_json_resource_not_found_proves_job_absence(self):
        good = response(404, {'error': {'code': 'ResourceNotFound', 'target': self.rid, 'message': 'canary-secret'}})
        self.assertTrue(job_absence(good, self.rid))
        bad = [response(404, {'error': {'code': code}}) for code in ('NotFound', 'ResourceGroupNotFound', 'ParentResourceNotFound', 'AuthorizationFailed')]
        bad += [response(403, {'error': {'code': 'ResourceNotFound'}}),
                response(404, {'error': {'code': 'ResourceNotFound', 'target': 'other'}}),
                response(404, {'error': {'code': 'ResourceNotFound', 'details': [{'code': 'other'}]}}),
                response(404, {'error': {'code': 'ResourceNotFound'}, 'value': []}),
                response(404, {'error': {'code': 'ResourceNotFound'}}, {'Location': 'canary-secret'})]
        for raw in (b'', b'<html>404</html>', b'{"error":{"code":"ResourceNotFound","code":"ResourceNotFound"}}', b'\xff'):
            bad.append({'status': 404, 'headers': {}, 'body': raw})
        for item in bad:
            with self.subTest(item=item): self.assertFalse(job_absence(item, self.rid))
        self.assertNotIn('canary-secret', json.dumps(summary(good)))

    def test_http_status_survives_malformed_body_and_no_unknown_is_promoted(self):
        clock, wire = Clock(), Http()
        provider = BoundedArmProvider(Credential(clock), wire, clock)
        for status, raw in ((200, b'{"error":{"message":"canary-secret"}}'), (404, b'<html/>'), (403, b'')):
            wire.responses.append({'status': status, 'headers': {}, 'body': raw})
            item = provider.readback(self.op)
            self.assertEqual('unknown', item['state'])
            self.assertEqual(status, item['http'])
            self.assertFalse(item['write_terminal']); self.assertFalse(item['readback_verified'])
            self.assertNotIn('canary-secret', json.dumps(item))
        wire.add(200, resource(self.op))
        unknown = provider._base(self.op, 'unknown')
        observed = provider.readback(self.op, unknown)
        self.assertEqual('unknown', observed['state'])
        self.assertFalse(observed['terminal'])

    def test_large_job_response_preserves_status_and_pending_ack_keeps_observation(self):
        clock, wire = Clock(), Http()
        provider = BoundedArmProvider(Credential(clock), wire, clock)
        wire.responses.append({'status': 200, 'headers': {}, 'body': b'x' * 1048577})
        result = provider.readback(self.op)
        self.assertEqual(200, result['http'])
        self.assertEqual('response_limit', result['observation']['transport_stage'])
        pending = provider._base(self.op, 'pending', 201)
        pending.update(write_terminal=True, initial_ack_digest='a'*64)
        wire.add(403, {'error': {'code': 'AuthorizationFailed', 'message': 'canary-secret'}})
        result = provider.readback(self.op, pending)
        self.assertEqual('pending', result['state']);self.assertTrue(result['write_terminal'])
        self.assertFalse(result['readback_verified']);self.assertFalse(result['terminal'])
        self.assertEqual('a'*64, result['initial_ack_digest'])
        self.assertEqual(403, result['readback_observation']['http'])
        self.assertNotIn('canary-secret', json.dumps(result))

    def test_cli_job_get_uses_new_wire_but_lro_and_mutation_keep_existing_boundary(self):
        from scripts.trial_provision.cli import _arm_http
        with patch('scripts.trial_provision.read_http.ReadHttp') as reads, patch('scripts.trial_provision.read_http.BoundedHttp.__call__') as old:
            wire=_arm_http(self.op); deadline=Deadline(20)
            wire('GET',self.op['url'],{},None,deadline)
            reads.return_value.assert_called_once();old.assert_not_called()
            wire('PUT',self.op['url'],{},b'{}',deadline)
            poll=self.op['url'].split('?')[0]+'/operationResults/'+UUID+'?api-version=2025-07-01'
            wire('GET',poll,{},None,deadline)
            self.assertEqual(2,old.call_count);self.assertEqual(1,reads.return_value.call_count)

    def test_list_errors_are_not_zero_and_every_failure_is_observed(self):
        invalid = [response(200, {'value': [], 'error': {}}), response(403), response(429), response(503),
                   response(200, {'value': [{'properties': {'roleDefinitionId': 'invalid'}}]}),
                   response(200, {'value': []}, {'operation-location': 'canary-secret'})]
        for raw in (b'{"value":[],"value":[]}', b'{"value":[],"bad":NaN}', b'\xff'):
            invalid.append({'status': 200, 'headers': {}, 'body': raw})
        for item in invalid:
            seen = []
            with self.assertRaises(Denied):
                count_collection(lambda _: item, self.initial, self.role, observe=seen.append)
            self.assertEqual(1, len(seen))
            self.assertNotIn('canary-secret', json.dumps(seen))
            self.assertNotEqual('page_valid', seen[0]['validation'])

    def test_pim_failed_or_expired_entries_still_count_as_references(self):
        for collection, version in COLLECTIONS:
            initial = self.initial.replace('roleAssignments?api-version=2022-04-01', collection + '?api-version=' + version)
            value = {'value': [{'properties': {'roleDefinitionId': self.role, 'status': 'Failed', 'endDateTime': '2000-01-01T00:00:00Z'}}]}
            total, proof = count_collection(lambda _: response(value=value), initial, self.role)
            self.assertEqual(1, total); self.assertEqual(1, len(proof))

    def test_complete_pages_only_and_no_implicit_retries(self):
        second = self.initial + '&$skiptoken=two'
        replies = [response(value={'value': [], 'nextLink': second}), response()]
        seen, calls = [], []
        def fetch(url): calls.append(url); return replies.pop(0)
        total, proof = count_collection(fetch, self.initial, self.role, observe=seen.append)
        self.assertEqual(0, total); self.assertEqual(2, len(proof)); self.assertEqual([self.initial, second], calls)
        replies[:] = [response(value={'value': [], 'nextLink': second}), response(403)]
        seen.clear(); calls.clear()
        with self.assertRaises(Denied): count_collection(fetch, self.initial, self.role, observe=seen.append)
        self.assertEqual(2, len(calls)); self.assertEqual(403, seen[1]['http'])

    def test_bad_pagination_never_produces_a_partial_zero_proof(self):
        for following in (self.initial, self.initial.replace(UUID, 'ffffffff-ffff-ffff-ffff-ffffffffffff').replace(SUB, '/subscriptions/ffffffff-ffff-ffff-ffff-ffffffffffff'),
                          self.initial.replace('management.azure.com', 'evil.invalid'), self.initial + '&$filter=atScope()', self.initial + '&api-version=other', 1):
            calls = []
            def fetch(url): calls.append(url); return response(value={'value': [], 'nextLink': following})
            with self.assertRaises(Denied): count_collection(fetch, self.initial, self.role)
            self.assertEqual(1, len(calls))
        pages = iter(('one', 'two', 'three'))
        calls = []
        def fetch(url): calls.append(url); return response(value={'value': [], 'nextLink': self.initial + '&$skiptoken=' + next(pages)})
        with self.assertRaises(Denied): count_collection(fetch, self.initial, self.role)
        self.assertEqual(3, len(calls))

    def test_transport_failure_is_observed_without_exception_text(self):
        seen = []
        def fetch(_): raise ReadFailure('response_body', 200)
        with self.assertRaises(Denied): count_collection(fetch, self.initial, self.role, observe=seen.append)
        self.assertEqual('response_body', seen[0]['transport_stage'])
        self.assertEqual(200, seen[0]['http'])

    def test_wire_has_one_request_and_retains_only_safe_failure_stage(self):
        pipe, conn, reply = MagicMock(), MagicMock(), MagicMock()
        reply.status = 403; reply.getheaders.return_value = []
        reply.read.side_effect = OSError('canary-secret')
        conn.getresponse.return_value = reply
        with patch('scripts.trial_provision.read_http.http.client.HTTPSConnection', return_value=conn):
            _read_child(pipe, (self.op['url'], {}, 20))
        self.assertEqual((False, 403, 'response_body', None), pipe.send.call_args.args[0])
        conn.request.assert_called_once(); conn.close.assert_called_once(); pipe.close.assert_called_once()

    def test_partial_pipe_frame_cannot_outlive_deadline(self):
        with patch('scripts.trial_provision.read_http.multiprocessing.get_context') as context:
            ctx = context.return_value
            parent, child, process = MagicMock(), MagicMock(), ctx.Process.return_value
            ctx.Pipe.return_value = parent, child
            process.pid = 123; process.is_alive.side_effect = [True, False]
            release = threading.Event()
            parent.recv.side_effect = lambda: release.wait(2)
            parent.close.side_effect = release.set
            started = time.monotonic()
            with self.assertRaises(ReadFailure): ReadHttp()('GET', self.op['url'], {}, None, Deadline(.02))
            self.assertLess(time.monotonic() - started, 1)
            parent.poll.assert_not_called(); process.start.assert_called_once(); process.terminate.assert_called_once()
            process.join.assert_called_once_with(timeout=1)

    def test_targets_and_methods_rejected_before_any_process(self):
        with patch('scripts.trial_provision.read_http.multiprocessing.get_context') as context:
            for method, url, body in (('POST', self.op['url'], None), ('GET', self.op['url'], b'x'),
                                      ('GET', self.op['url'] + '&extra=1', None), ('GET', self.op['url'].replace('https:', 'http:'), None)):
                with self.assertRaises(Denied): ReadHttp()(method, url, {}, body, Deadline(20))
            context.assert_not_called()


if __name__ == '__main__': unittest.main()
