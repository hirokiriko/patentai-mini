"""Exercise the Local wire boundary with fake sockets/processes, no network."""
import unittest
import threading
import time
from unittest.mock import MagicMock, patch

from scripts.trial_guard.adapters import BoundedHttp, Deadline
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.cli import REQUIRED_SOURCES, _arm_http
from scripts.trial_provision.identity_http import IdentityHttp, _identity_http_child
from .test_providers import Clock, operation


class IdentityHttpTests(unittest.TestCase):
    def exchange(self, headers, body=b'{}'):
        pipe, connection, reply = MagicMock(), MagicMock(), MagicMock()
        reply.status = 201
        reply.read.return_value = body
        reply.getheaders.return_value = headers
        connection.getresponse.return_value = reply
        url = operation('userAssignedIdentities')['url']
        with patch('scripts.trial_provision.identity_http.http.client.HTTPSConnection', return_value=connection):
            _identity_http_child(pipe, ('PUT', url, {}, b'{}', 20))
        connection.request.assert_called_once()
        connection.close.assert_called_once()
        pipe.close.assert_called_once()
        pipe.send.assert_called_once()
        return pipe.send.call_args.args[0]

    def test_duplicate_control_headers_cannot_be_lost_before_ack_validation(self):
        for key in ('Location', 'Azure-AsyncOperation', 'Operation-Location'):
            for second in (key, key.lower()):
                with self.subTest(key=key, second=second):
                    self.assertIsNone(self.exchange([(key, 'canary-secret'), (second, 'fixed-resource')]))

    def test_single_control_header_reaches_provider_without_url_normalization(self):
        url = operation('userAssignedIdentities')['url']
        status, headers, body = self.exchange([('Location', url), ('X-Fixture', 'one'), ('X-Fixture', 'two')])
        self.assertEqual(201, status)
        self.assertEqual(b'{}', body)
        self.assertEqual({'location': url, 'x-fixture': 'two'}, headers)

    def test_response_limit_stops_as_unknown(self):
        self.assertIsNone(self.exchange([], b'x' * 1048577))

    def test_only_identity_uses_new_local_transport_and_it_is_source_bound(self):
        self.assertIsInstance(_arm_http(operation('userAssignedIdentities')), IdentityHttp)
        for op in (None, operation(), operation('containerApps'), operation('jobs'), operation('roleAssignments')):
            self.assertIsInstance(_arm_http(op), BoundedHttp)
        self.assertIn('scripts/trial_provision/identity_http.py', REQUIRED_SOURCES)

    def test_target_validation_happens_before_process_creation(self):
        url = operation('userAssignedIdentities')['url']
        invalid = [url.replace('management.azure.com', 'evil.invalid'),
                   url.replace('https:', 'http:'), url + '#fragment', url + '&other=1',
                   url.replace('2023-01-31', '2024-01-31'), '\n' + url, url + '\t',
                   url.replace('management.azure.com', 'management.azure.com:443'),
                   url.replace('management.azure.com', 'user@management.azure.com'),
                   url.replace('/trial-worker', '/trial%2dworker'), operation()['url']]
        with patch('scripts.trial_provision.identity_http.multiprocessing.get_context') as ctx:
            for target in invalid:
                with self.subTest(target=target), self.assertRaises(Denied):
                    IdentityHttp()('GET', target, {}, None, Deadline(20))
            with self.assertRaises(Denied):
                IdentityHttp()('POST', url, {}, None, Deadline(20))
            ctx.assert_not_called()

    def test_one_child_no_retry_and_bounded_termination_on_unknown_or_timeout(self):
        url = operation('userAssignedIdentities')['url']
        for mode in ('success', 'unknown', 'timeout', 'expired'):
            with self.subTest(mode=mode), patch('scripts.trial_provision.identity_http.multiprocessing.get_context') as context:
                ctx = context.return_value
                parent, child, process = MagicMock(), MagicMock(), ctx.Process.return_value
                ctx.Pipe.return_value = parent, child
                process.pid = 123
                process.is_alive.side_effect = [True, False]
                parent.recv.return_value = None if mode == 'unknown' else (201, {}, b'{}')
                clock = Clock()
                if mode == 'expired':
                    def receive():
                        clock.advance(21)
                        return 201, {}, b'{}'
                    parent.recv.side_effect = receive
                deadline = Deadline(20, clock.monotonic)
                if mode == 'timeout':
                    stalled_frame = threading.Event()
                    parent.recv.side_effect = lambda: stalled_frame.wait(2)
                    parent.close.side_effect = stalled_frame.set
                    deadline = Deadline(0.02)
                started = time.monotonic()
                if mode == 'success':
                    self.assertEqual(201, IdentityHttp()('PUT', url, {}, b'{}', deadline)['status'])
                else:
                    with self.assertRaises((OSError, TimeoutError)):
                        IdentityHttp()('PUT', url, {}, b'{}', deadline)
                self.assertLess(time.monotonic() - started, 1)
                parent.poll.assert_not_called()
                context.assert_called_once_with('spawn')
                ctx.Process.assert_called_once()
                process.start.assert_called_once()
                process.terminate.assert_called_once()
                process.join.assert_called_once_with(timeout=1)
                process.kill.assert_not_called()
                parent.close.assert_called_once()
                self.assertGreaterEqual(child.close.call_count, 1)

    def test_expired_deadline_does_not_create_a_child_or_pipes(self):
        clock = Clock()
        deadline = Deadline(20, clock.monotonic)
        clock.advance(21)
        with patch('scripts.trial_provision.identity_http.multiprocessing.get_context') as context:
            with self.assertRaises(TimeoutError):
                IdentityHttp()('GET', operation('userAssignedIdentities')['url'], {}, None, deadline)
            context.assert_not_called()

    def test_process_start_failure_closes_both_pipe_ends_without_retry(self):
        with patch('scripts.trial_provision.identity_http.multiprocessing.get_context') as context:
            ctx = context.return_value
            parent, child, process = MagicMock(), MagicMock(), ctx.Process.return_value
            ctx.Pipe.return_value = parent, child
            process.pid = None
            process.start.side_effect = OSError('fixture-start-failure')
            with self.assertRaises(OSError):
                IdentityHttp()('GET', operation('userAssignedIdentities')['url'], {}, None, Deadline(20))
            process.start.assert_called_once()
            process.terminate.assert_not_called()
            parent.close.assert_called_once()
            child.close.assert_called_once()

