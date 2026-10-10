"""Real adapter contracts with fictional ARM replies; no network or CLI calls.

The sole real child is a temporary Python program that sleeps without reading
stdin. It holds no credentials, database connection, or external capability.
"""
import json
import sys
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from .adapters import Deadline, digest, encoded
from .execution import AzureJobStarter, CountedHttp, NodeWorker
from .lifecycle import Denied
from .test_lifecycle import Clock
from .workflow import Receipt


class ArmFixture:
    def __init__(self):
        self.clock = Clock()
        self.request_id = '11111111-1111-4111-8111-111111111111'
        self.job = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.App/jobs/guard'
        environment = self.job.rsplit('/jobs/', 1)[0] + '/managedEnvironments/fictional'
        image_digest = 'sha256:' + 'a' * 64
        self.template = {'containers': [{'name': 'guard', 'image': 'fictional.azurecr.io/guard@' + image_digest,
            'env': [{'name': 'FICTIONAL_MODE', 'value': 'test'}]}], 'initContainers': []}
        self.identity = {'type': 'UserAssigned', 'userAssignedIdentities': {'fictional-identity': {'principalId': 'fictional-principal'}}}
        self.config = {'live_enabled': True, 'cleanup_strategy': 'single_job',
            'prearm_until': (self.clock.utc() + timedelta(minutes=5)).isoformat(),
            'owner_permissions_until': (self.clock.utc() + timedelta(hours=1)).isoformat(),
            'seed_not_before': (self.clock.utc() - timedelta(seconds=1)).isoformat(),
            'owner_id': 'fictional-owner', 'tenant_id': 'fictional-tenant', 'cloud_guard': {'nonce': 'fictional-nonce'},
            'guardian_job': {'resource_id': self.job, 'environment_id': environment,
                'template': deepcopy(self.template), 'template_digest': digest(self.template),
                'identity_digest': digest(self.identity), 'image_digest': image_digest,
                'principal_id': 'fictional-principal', 'readback_verified': True,
                'execution_schema_verified': True, 'approved': True}}
        self.job_reply = {'id': self.job, 'identity': deepcopy(self.identity), 'properties': {
            'environmentId': environment, 'template': deepcopy(self.template),
            'configuration': {'triggerType': 'Manual', 'replicaTimeout': 1800, 'replicaRetryLimit': 0,
                'manualTriggerConfig': {'parallelism': 1, 'replicaCompletionCount': 1}}}}
        self.execution_id = self.job + '/executions/guard-one'
        execution_template = deepcopy(self.template)
        execution_template['containers'][0]['env'].append({'name': 'TRIAL_GUARD_REQUEST_ID', 'value': self.request_id})
        self.execution_reply = {'id': self.execution_id, 'properties': {'template': execution_template,
            'startTime': self.clock.utc().isoformat(), 'status': 'Running'}}
        self.collection = None
        self.replicas = {'value': [{'name': 'guard-one-replica'}]}
        self.post_error = None
        self.post_reply = {'id': self.execution_id}
        self.calls = []

    def wire(self, method, url, headers, body, deadline):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'management.azure.com' or parsed.query != 'api-version=2025-07-01':
            raise AssertionError('unexpected fictional transport target')
        if not parsed.path.startswith(self.job):
            raise AssertionError('unexpected fictional resource')
        suffix = parsed.path[len(self.job):]
        self.calls.append((method, suffix, None if body is None else json.loads(body)))
        deadline.remaining()
        if method == 'POST' and suffix == '/start':
            if self.post_error:
                raise self.post_error
            return {'status': 202, 'headers': {}, 'body': encoded(self.post_reply)}
        if method != 'GET':
            raise AssertionError('unexpected mutation')
        values = {'': self.job_reply, '/executions': self.collection if self.collection is not None else {'value': [self.execution_reply]},
            '/executions/guard-one': self.execution_reply, '/executions/guard-one/replicas': self.replicas}
        if suffix not in values:
            raise AssertionError('unexpected execution')
        if isinstance(values[suffix], Exception):
            raise values[suffix]
        return {'status': 200, 'headers': {}, 'body': encoded(values[suffix])}

    def starter(self, **kwargs):
        return AzureJobStarter(self.config, self.wire, self.clock, **kwargs)

    def posts(self):
        return [call for call in self.calls if call[0] == 'POST']


class AzureJobExecutionTests(unittest.TestCase):
    def setUp(self):
        self.f = ArmFixture()
        self.credentials = patch(__package__ + '.execution.AzureCredential')
        self.credential_class = self.credentials.start()
        self.credential_class.return_value.token.return_value = 'fictional-token'
        self.addCleanup(self.credentials.stop)

    def test_exact_job_template_identity_and_replica_are_verified_before_runtime_is_returned(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.assertEqual([(method, suffix) for method, suffix, _ in self.f.calls],
            [('GET', ''), ('POST', '/start'), ('GET', '/executions/guard-one'), ('GET', '/executions/guard-one/replicas')])
        self.assertEqual(runtime['execution_id'], self.f.execution_id)
        self.assertEqual(runtime['replica_name'], 'guard-one-replica')
        self.assertEqual(runtime['principal_id'], 'fictional-principal')
        self.assertEqual(runtime['job_deadline'], (self.f.clock.utc() + timedelta(minutes=30)).isoformat())
        sent = self.f.posts()[0][2]
        self.assertEqual(sent, self.f.execution_reply['properties']['template'])
        self.assertEqual(self.f.config['guardian_job']['template'], self.f.template)

    def test_unverified_preflight_never_constructs_credentials_or_calls_wire(self):
        for field in ('approved', 'readback_verified', 'execution_schema_verified'):
            with self.subTest(field=field):
                f = ArmFixture(); f.config['guardian_job'][field] = False
                with self.assertRaisesRegex(Denied, 'guardian_job_preflight'):
                    f.starter()
                self.assertEqual(f.calls, [])
        self.credential_class.assert_not_called()

    def test_changed_job_target_configuration_template_or_identity_never_posts(self):
        alterations = [
            (('id',), 'different'), (('identity',), {'type': 'SystemAssigned'}),
            (('properties', 'environmentId'), 'different'),
            (('properties', 'template', 'containers', 0, 'image'), 'different'),
            (('properties', 'configuration', 'triggerType'), 'Schedule'),
            (('properties', 'configuration', 'replicaTimeout'), 1801),
            (('properties', 'configuration', 'replicaRetryLimit'), 1),
            (('properties', 'configuration', 'manualTriggerConfig', 'parallelism'), 2),
            (('properties', 'configuration', 'manualTriggerConfig', 'replicaCompletionCount'), 2),
        ]
        for path, value in alterations:
            with self.subTest(path=path):
                f = ArmFixture(); item = f.job_reply
                for key in path[:-1]: item = item[key]
                item[path[-1]] = value
                with self.assertRaisesRegex(Denied, 'guardian_job_changed'):
                    f.starter().start(f.request_id)
                self.assertEqual(f.posts(), [])

    def test_unknown_start_is_not_retried_and_can_only_be_reconciled_by_matching_gets(self):
        starter = self.f.starter(); self.f.post_error = TimeoutError('fictional response loss')
        with self.assertRaises(TimeoutError): starter.start(self.f.request_id)
        self.assertEqual(len(self.f.posts()), 1)
        runtime = starter.recover(self.f.request_id, None)
        self.assertEqual(runtime['execution_id'], self.f.execution_id)
        self.assertEqual(len(self.f.posts()), 1)
        self.assertIn(('GET', '/executions'), [(method, suffix) for method, suffix, _ in self.f.calls])

    def test_start_ack_without_execution_id_remains_unknown_without_a_second_post(self):
        starter = self.f.starter(); self.f.post_reply = {}
        with self.assertRaisesRegex(Denied, 'start_outcome_unknown'): starter.start(self.f.request_id)
        starter.recover(self.f.request_id, None)
        self.assertEqual(len(self.f.posts()), 1)

    def test_recovery_rejects_empty_duplicate_partial_and_foreign_request_collections(self):
        foreign = deepcopy(self.f.execution_reply)
        foreign['properties']['template']['containers'][0]['env'][-1]['value'] = 'different-request'
        for collection in ({'value': []}, {'value': [self.f.execution_reply, self.f.execution_reply]},
            {'value': [self.f.execution_reply], 'nextLink': 'fictional-next'}, {'value': [foreign]},
            {'value': [self.f.execution_reply] * 51}):
            with self.subTest(collection_kind=list(collection)):
                f = ArmFixture(); f.collection = deepcopy(collection)
                with self.assertRaises(Denied): f.starter().recover(f.request_id, None)
                self.assertEqual(f.posts(), [])

    def test_exact_execution_and_replica_binding_reject_substitution_or_partial_results(self):
        with self.assertRaisesRegex(Denied, 'execution_target'):
            self.f.starter().recover(self.f.request_id, self.f.job + '/executions/foreign-one')
        self.assertEqual(self.f.calls, [])
        for replicas in ({'value': []}, {'value': [{'name': 'foreign-one'}]},
            {'value': [{'name': 'guard-one-a'}, {'name': 'guard-one-b'}]},
            {'value': [{'name': 'guard-one-a'}], 'nextLink': 'fictional-next'}):
            with self.subTest(replicas=replicas):
                f = ArmFixture(); f.replicas = replicas
                with self.assertRaisesRegex(Denied, 'replica_unconfirmed'):
                    f.starter().recover(f.request_id, f.execution_id)
                self.assertEqual(f.posts(), [])
        f = ArmFixture(); f.execution_reply['properties']['template']['containers'][0]['env'][-1]['value'] = 'different-request'
        with self.assertRaisesRegex(Denied, 'execution_binding'):
            f.starter().recover(f.request_id, f.execution_id)

    def test_expired_prearm_blocks_new_start_but_terminal_recovery_uses_recorded_replica(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(1900)
        with self.assertRaisesRegex(Denied, 'prearm_window'): self.f.starter()
        for status in ('Succeeded', 'Failed', 'Stopped'):
            with self.subTest(status=status):
                self.f.execution_reply['properties']['status'] = status
                self.f.replicas = AssertionError('terminal recovery must use verified historical replica')
                self.f.calls.clear()
                starter = self.f.starter(recovery_only=True, recorded_runtime=runtime)
                with self.assertRaisesRegex(Denied, 'recovery_only'): starter.start(self.f.request_id)
                self.assertEqual(starter.recover(self.f.request_id, self.f.execution_id), runtime)
                self.assertEqual(starter.status, status)
                self.assertEqual([(method, suffix) for method, suffix, _ in self.f.calls], [('GET', '/executions/guard-one')])

    def test_running_recovery_still_checks_current_replica_and_does_not_assert_historical_liveness(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(310); self.f.calls.clear(); self.f.replicas = {'value': []}
        with self.assertRaisesRegex(Denied, 'replica_unconfirmed'):
            self.f.starter(recovery_only=True, recorded_runtime=runtime).recover(self.f.request_id, self.f.execution_id)
        self.assertEqual(self.f.posts(), [])

    def test_terminal_recovery_rejects_changed_recorded_runtime(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(1900); self.f.execution_reply['properties']['status'] = 'Succeeded'
        for field in ('execution_id', 'job_started_at', 'image_digest', 'principal_id', 'nonce', 'replica_name'):
            with self.subTest(field=field):
                changed = {**runtime, field: 'different'}; self.f.calls.clear()
                with self.assertRaises(Denied):
                    self.f.starter(recovery_only=True, recorded_runtime=changed).recover(self.f.request_id, self.f.execution_id)
                self.assertEqual(self.f.posts(), [])

    def test_final_permission_fence_blocks_recovery_after_owner_access_expiry(self):
        self.f.clock.advance(3600)
        with self.assertRaisesRegex(Denied, 'receiver_permission_expired'):
            self.f.starter(recovery_only=True).recover(self.f.request_id, self.f.execution_id)
        self.assertEqual(self.f.calls, [])

    def test_failed_request_count_is_preserved_when_the_private_receipt_is_reopened(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory).resolve()); proof = digest(path)
            first = Receipt(path, proof, 'fictional-configuration')
            wire = Mock(side_effect=TimeoutError('fictional response loss'))
            try:
                with self.assertRaises(TimeoutError):
                    CountedHttp(wire, first)('GET', 'https://management.azure.com/fictional', {}, None, Deadline(1))
            finally: first.close()
            second = Receipt(path, proof, 'fictional-configuration')
            try:
                self.assertEqual(second.count('owner_arm'), 1)
                with self.assertRaisesRegex(Denied, 'request_budget'): second.consume('owner_arm', 1)
                self.assertEqual(second.count('owner_arm'), 1)
            finally: second.close()
            wire.assert_called_once()


class NodeWorkerPipeTests(unittest.TestCase):
    def test_full_stdin_pipe_and_nonreading_child_cannot_block_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            # Python accepts a script with this suffix; NodeWorker still uses
            # its exact production argv shape, shell=False and direct-child kill.
            script = Path(directory) / 'trial-session.js'
            script.write_text('import time\ntime.sleep(60)\n', encoding='utf-8')
            worker = NodeWorker(str(Path(sys.executable).resolve()), str(script.resolve()), {'requests': [], 'fixture': 'x' * (1024 * 1024)})
            stopped = threading.Event(); outcome = []
            try:
                with self.assertRaisesRegex(Denied, 'worker_pipe_unconfirmed'):
                    worker.start({'useUntil': 'fictional'}, {'type': 'permit'})
                self.assertIsNone(worker.child.poll())
                def stop():
                    try: outcome.append(worker.stop())
                    except Exception: outcome.append(False)
                    finally: stopped.set()
                threading.Thread(target=stop, daemon=True).start()
                self.assertTrue(stopped.wait(6), 'stop waited on a blocked stdin flush/lock')
                self.assertEqual(outcome, [True])
                self.assertIsNotNone(worker.child.poll())
                self.assertTrue(worker.stop())
            finally:
                if worker.child is not None:
                    if worker.child.poll() is None: worker.child.kill()
                    worker.child.wait(timeout=3)
                    # Once the reader is dead, a blocked writer gets BrokenPipe;
                    # do not make test cleanup itself an unbounded pipe close.
                    def close_pipes():
                        for stream in (worker.child.stdin, worker.child.stdout):
                            try: stream.close()
                            except (BrokenPipeError, OSError): pass
                    cleanup = threading.Thread(target=close_pipes, daemon=True)
                    cleanup.start(); cleanup.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
