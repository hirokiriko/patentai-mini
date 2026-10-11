"""Real journals/controller/adapters with fictional, in-memory HTTP only."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.auth import (
    GraphAdapter, EasyAuthAdapter, build_auth_operations, build_auth_cleanup,
    completed, progress, auth_configuration,
)
from scripts.trial_provision.controller import Controller
from scripts.trial_provision.journal import Journal, ControlBudget, CountedControlHttp
from scripts.trial_provision.providers import BoundedArmProvider
from .test_auth import (
    Clock, Credential, Wire, response, operations, operation, all_receipts,
    binding, easy_binding, app_value, APP, KEY, OTHER, SECRET, RUNTIME_SECRET,
    AUTH_SECRET, TARGET, ARM, API_VERSION, END, CLIENT,
)


class ControllerAuthIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve()
        self.path_digest = digest(str(self.path))
        self.binding = {'trial': 'fictional-auth-integration'}
        self.seed = {'owner_arm': 128, 'owner_control_blob': 32, 'heartbeat_blob': 0}
        self.clock, self.wire, self.credential = Clock(), Wire(), Credential()
        self.ops = {op['id']: op for op in operations()}
        self.ops['trial-app'] = operation('containerApps', {}, ARM + TARGET + '?api-version=' + API_VERSION, 'trial-app')
        self.ops.update({op['id']: op for op in build_auth_operations(easy_binding(), all_receipts(), END, 'trial-app')})
        self.journal = self.budget = None
        self.reopen()
        self.addCleanup(self.close)
        # These are simulated prior terminal operations, durably bound through
        # the same real Journal, not cloud discovery or an authority shortcut.
        for key, receipt in all_receipts().items():
            if key == 'addPassword':
                continue
            self.journal.intent(self.ops[key], self.clock.utc().isoformat())
            self.journal.checkpoint(self.ops[key], receipt)

    def close(self):
        if self.journal:
            self.journal.close(); self.journal = None
        if self.budget:
            self.budget.close(); self.budget = None

    def reopen(self):
        self.close()
        self.journal = Journal(self.path, self.path_digest, self.binding)
        self.budget = ControlBudget(self.path, self.path_digest, self.binding, seed=self.seed)
        counted = CountedControlHttp(self.wire, self.budget)
        self.graph = GraphAdapter(binding(), self.credential, counted, self.clock)
        self.arm = BoundedArmProvider(self.credential, counted, self.clock)
        self.easy = EasyAuthAdapter(easy_binding(), self.credential, counted,
            lambda: {RUNTIME_SECRET: 'fictional-db-value'}, self.clock, arm_provider=self.arm)

    def controller(self):
        return Controller(self.journal, self.clock,
            lambda key, receipts: deepcopy(self.ops[key]), list(self.ops),
            {'Microsoft.Graph': self.graph, 'Microsoft.App': self.arm}, easy_auth=self.easy)

    def queue_password(self):
        password = operations()[3]['body']['passwordCredential']
        self.wire.responses.extend([
            response(200, dict(password, keyId=KEY, secretText=SECRET)),
            response(200, {'id': APP, 'passwordCredentials': [dict(password, keyId=KEY)]}),
        ])

    def queue_delivery(self, final=None):
        before = app_value()
        after = app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.wire.responses.extend([response(200, before), response(200, before)])
        if final is None:
            self.wire.responses.extend([response(200, after), response(200, after)])
        else:
            self.wire.responses.append(final)

    def test_e4_e5_atomic_handoff_durable_order_and_one_common_budget(self):
        self.queue_password(); self.queue_delivery()
        result = self.controller().create('addPassword')
        self.assertTrue(result['terminal'])
        delivery = self.journal.latest('auth-platform-secret')
        self.assertTrue(delivery['readback_verified'])
        records = self.journal.records
        e4_ready = next(i for i, r in enumerate(records) if r['event'] == 'progress'
            and r['value'].get('operation_id') == 'addPassword' and r['value'].get('terminal'))
        e5_intent = next(i for i, r in enumerate(records) if r['event'] == 'intent'
            and r['value']['operation_id'] == 'auth-platform-secret')
        e5_preimage = next(i for i, r in enumerate(records) if r['event'] == 'progress'
            and r['value']['operation_id'] == 'auth-platform-secret')
        self.assertLess(e4_ready, e5_intent)
        self.assertLess(e5_intent, e5_preimage)
        self.assertEqual(self.budget.count('owner_arm'), 128 + len(self.wire.calls))
        data = (self.path / 'trial-provision.jsonl').read_text()
        self.assertNotIn(SECRET, data)
        self.assertNotIn('fictional-db-value', data)
        self.assertNotIn('offline-fixture-token', data)

    def test_known_platform_lro_survives_restart_without_secret_or_write_retry(self):
        self.queue_password()
        url = ARM + '/subscriptions/' + OTHER + '/providers/Microsoft.App/containerApps/fictional-trial/operationResults/' + KEY + '?api-version=' + API_VERSION
        self.queue_delivery(response(202, headers={'location': url}))
        self.controller().create('addPassword')
        self.assertEqual(self.journal.latest('auth-platform-secret')['operation_url'], url)
        before_count = self.budget.count('owner_arm')
        self.reopen()
        self.clock.value += 2; self.clock.mono += 2
        self.wire.responses.extend([response(200, {'status': 'Succeeded'}), response(200, app_value([RUNTIME_SECRET, AUTH_SECRET]))])
        result = self.controller().reconcile('auth-platform-secret')
        self.assertTrue(result['readback_verified'])
        self.assertEqual(self.budget.count('owner_arm'), before_count + 2)
        self.assertEqual(sum(r[0] == 'POST' for r in self.wire.calls), 1)
        self.assertEqual(sum(r[0] == 'PATCH' for r in self.wire.calls), 1)
        with self.assertRaises(Denied):
            self.controller().create('addPassword')

    def test_unknown_platform_delivery_retains_key_and_never_recreates(self):
        self.queue_password(); self.queue_delivery(TimeoutError(SECRET))
        result = self.controller().create('addPassword')
        self.assertTrue(result['terminal'])
        self.assertEqual(result['properties']['keyId'], KEY)
        self.assertFalse(self.journal.latest('auth-platform-secret')['write_terminal'])
        self.reopen()
        count = len(self.wire.calls)
        self.assertFalse(self.controller().reconcile('auth-platform-secret')['terminal'])
        self.assertEqual(len(self.wire.calls), count)
        with self.assertRaises(Denied):
            self.controller().create('addPassword')
        with self.assertRaises(Denied):
            self.controller().create('auth-platform-secret')

    def test_known_password_missing_secret_after_restart_gets_no_redelivery(self):
        password = operations()[3]['body']['passwordCredential']
        self.wire.responses = [response(200, dict(password, keyId=KEY, secretText=SECRET)), TimeoutError('readback')]
        first = self.controller().create('addPassword')
        self.assertTrue(first['write_terminal'])
        self.assertFalse(first['terminal'])
        self.reopen()
        self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': [dict(password, keyId=KEY)]})]
        result = self.controller().reconcile('addPassword')
        self.assertTrue(result['terminal'])
        self.assertIsNone(self.journal.latest('auth-platform-secret'))
        with self.assertRaises(Denied):
            self.controller().create('addPassword')
        self.assertEqual(sum(r[0] == 'POST' for r in self.wire.calls), 1)
        self.assertEqual(sum(r[0] == 'PATCH' for r in self.wire.calls), 0)

    def test_cleanup_password_post_dispatch_terminal_and_explicit_empty_collection(self):
        self.queue_password(); self.queue_delivery()
        self.controller().create('addPassword')
        create = self.ops['addPassword']
        creation = self.journal.latest('addPassword')
        proof = {'complete': True, 'creation_request_digest': digest(create),
            'creation_receipt_digest': digest(creation), 'object_id': KEY, 'depends_on': []}
        op = build_auth_cleanup(create, creation, easy_binding(), END, proof)
        self.ops[op['id']] = op
        password = create['body']['passwordCredential']
        self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': [dict(password, keyId=KEY)]}),
            response(204), response(200, {'id': APP})]
        first = self.controller().cleanup(op['id'], 'addPassword')
        self.assertTrue(first['write_terminal'])
        self.assertFalse(first['terminal'])
        self.reopen()
        self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': []})]
        self.assertTrue(self.controller().cleanup(op['id'], 'addPassword')['absent'])
        self.assertEqual(sum(r[0] == 'POST' and r[1].endswith('/removePassword') for r in self.wire.calls), 1)

    def test_cleanup_password_continues_after_deadline_without_expiry_change(self):
        self.queue_password(); self.queue_delivery()
        self.controller().create('addPassword')
        create = self.ops['addPassword']; creation = self.journal.latest('addPassword')
        proof = {'complete': True, 'creation_request_digest': digest(create),
            'creation_receipt_digest': digest(creation), 'object_id': KEY, 'depends_on': []}
        op = build_auth_cleanup(create, creation, easy_binding(), END, proof)
        self.ops[op['id']] = op
        self.clock.value += 120; self.clock.mono += 120
        password = create['body']['passwordCredential']
        self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': [dict(password, keyId=KEY)]}),
            response(204), response(200, {'id': APP, 'passwordCredentials': []})]
        result = self.controller().cleanup(op['id'], 'addPassword')
        self.assertTrue(result['absent'])
        self.assertEqual(self.ops[op['id']]['deadline'], END)
        self.assertEqual(self.journal.latest('addPassword')['properties']['endDateTime'], creation['properties']['endDateTime'])

    def seed_open_ingress(self):
        for ident, properties, object_id in (
            ('addPassword', {'kind': 'addPassword', 'keyId': KEY}, KEY),
            ('auth-platform-secret', {'kind': 'authPlatformSecret'}, TARGET),
            ('auth-config', {'kind': 'authConfigs', 'appId': CLIENT}, TARGET + '/authConfigs/current')):
            op = self.ops[ident]
            self.journal.intent(op, self.clock.utc().isoformat())
            self.journal.checkpoint(op, completed(progress(op, object_id, properties, True)))
        app = app_value([RUNTIME_SECRET, AUTH_SECRET], external=True)
        create = self.ops['auth-ingress']
        known = completed(progress(create, TARGET, {'kind': 'authIngress',
            'retainedConfigurationDigest': digest(app['properties']['configuration']),
            'retainedTemplateDigest': digest(app['properties']['template'])}, True))
        self.journal.intent(create, self.clock.utc().isoformat())
        self.journal.checkpoint(create, known)
        proof = {'complete': True, 'creation_request_digest': digest(create),
            'creation_receipt_digest': digest(known), 'object_id': TARGET, 'depends_on': ['auth-ingress']}
        op = build_auth_cleanup(create, known, easy_binding(), END, proof)
        self.ops[op['id']] = op
        return op, app

    def test_close_ingress_real_provider_known_202_resumes_after_deadline(self):
        op, opened = self.seed_open_ingress()
        self.clock.value += 120; self.clock.mono += 120
        url = ARM + '/subscriptions/' + OTHER + '/providers/Microsoft.App/containerApps/fictional-trial/operationResults/' + KEY + '?api-version=' + API_VERSION
        self.wire.responses = [response(200, opened), response(200, opened), response(202, headers={'location': url})]
        pending = self.controller().cleanup(op['id'], 'auth-ingress')
        self.assertEqual(pending['operation_url'], url)
        self.assertFalse(pending['terminal'])
        self.reopen()
        self.clock.value += 2; self.clock.mono += 2
        self.wire.responses = [response(200, {'status': 'Succeeded'}), response(200, app_value([RUNTIME_SECRET, AUTH_SECRET]))]
        result = self.controller().cleanup(op['id'], 'auth-ingress')
        self.assertTrue(result['terminal'])
        self.assertTrue(result['absent'])
        self.assertEqual(op['deadline'], END)
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET', 'PATCH', 'GET', 'GET'])
        self.assertEqual(self.budget.count('owner_arm'), 128 + 5)

    def test_close_ingress_unknown_after_restart_never_resends(self):
        op, opened = self.seed_open_ingress()
        self.wire.responses = [response(200, opened), response(200, opened), TimeoutError('fixture')]
        self.assertFalse(self.controller().cleanup(op['id'], 'auth-ingress')['write_terminal'])
        self.reopen()
        self.assertFalse(self.controller().cleanup(op['id'], 'auth-ingress')['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET', 'PATCH'])


if __name__ == '__main__':
    unittest.main()
