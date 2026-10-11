"""Offline integration: real controller, ARM provider and durable journals.

Only fictional requests reach an in-memory HTTP fixture. No token acquisition,
subprocess, credential store, Docker or external network is used.
"""
from copy import deepcopy
from datetime import timedelta
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.controller import Controller
from scripts.trial_provision.journal import Journal, ControlBudget, CountedControlHttp
from scripts.trial_provision.providers import BoundedArmProvider, _validate
from scripts.trial_provision.resources import build_resource_operations, build_runtime_operations
from .test_providers import Clock, Credential, Http, operation, resource, deletion, SUB, UUID
from .test_resources import fixture as resources_fixture, runtime_fixture
from . import test_operations as operation_fixtures
from scripts.trial_provision.operations import create_resolver


class ControllerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve()
        self.directory_digest = digest(str(self.path))
        self.clock, self.http = Clock(), Http()
        self.credential = Credential(self.clock)
        self.provider = BoundedArmProvider(self.credential, self.http, self.clock)
        self.ops = {}
        self.journal = None
        self.reopen()
        self.addCleanup(self.close)

    def close(self):
        if self.journal is not None:
            self.journal.close()
            self.journal = None

    def reopen(self):
        self.close()
        self.journal = Journal(self.path, self.directory_digest, {'trial': 'fictional-fixed'})

    def controller(self):
        return Controller(self.journal, self.clock,
            lambda key, receipts: deepcopy(self.ops[key]), list(self.ops),
            {op['provider']: self.provider for op in self.ops.values()})

    def add(self, op):
        self.ops[op['id']] = op
        return op

    def create_success(self, op):
        self.http.add(404)
        self.http.add(201, resource(op))
        self.http.add(200, resource(op))
        result = self.controller().create(op['id'])
        self.assertEqual('succeeded', result['state'])
        return result

    def update_operation(self, original):
        op = deepcopy(original)
        op.update(id='update-app', method='PATCH')
        op['body']['properties']['template']['containers'][0]['image'] = 'fictional.azurecr.io/trial@sha256:' + 'b' * 64
        op['expected'].update(before_absent=False, body_sha256=digest(op['body']),
            update_from={'operation_id': original['id'], 'request_digest': digest(original)})
        return self.add(op)

    def test_create_requires_ack_readback_and_cannot_repeat_after_restart(self):
        op = self.add(operation())
        self.create_success(op)
        self.reopen()
        with self.assertRaises(Denied): self.controller().create(op['id'])
        self.assertEqual(['GET', 'PUT', 'GET'], [r[0] for r in self.http.calls])
        self.assertEqual(1, len(self.journal.values('intent')))

    def test_unknown_put_stays_unknown_and_blocks_another_create_after_restart(self):
        op = self.add(operation())
        other = self.add(operation('userAssignedIdentities'))
        self.http.add(404)
        self.http.responses.append(TimeoutError('PRIVATE_CANARY'))
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            result = self.controller().create(op['id'])
        self.assertEqual('unknown', result['state'])
        self.assertEqual('', output.getvalue())
        self.assertNotIn('PRIVATE_CANARY', str(result))
        self.reopen()
        self.assertEqual('unknown', self.controller().reconcile(op['id'])['state'])
        with self.assertRaises(Denied): self.controller().create(other['id'])
        self.assertEqual(['GET', 'PUT'], [r[0] for r in self.http.calls])

    def test_known_create_can_cleanup_with_fresh_exact_get_and_ack_404(self):
        op = self.add(operation())
        delete = self.add(deletion(op))
        self.create_success(op)
        self.http.add(200, resource(op))
        self.http.add(204)
        self.http.add(404)
        result = self.controller().cleanup(delete['id'], op['id'])
        self.assertEqual('succeeded', result['state'])
        self.assertTrue(result['readback_verified'])
        self.reopen()
        self.assertEqual('succeeded', self.controller().cleanup(delete['id'], op['id'])['state'])
        self.assertEqual(1, sum(r[0] == 'DELETE' for r in self.http.calls))

    def test_cleanup_after_creation_deadline_keeps_original_creation_binding(self):
        op=self.add(operation())
        delete=deletion(op);delete['deadline']='2026-01-01T01:00:00Z';self.add(delete)
        self.create_success(op)
        original=digest(op)
        self.clock.advance(601)
        self.http.add(200,resource(op));self.http.add(204);self.http.add(404)
        result=self.controller().cleanup(delete['id'],op['id'])
        self.assertEqual('succeeded',result['state'])
        self.assertEqual(original,digest(self.ops[op['id']]))
        self.assertEqual(1,sum(r[0]=='DELETE' for r in self.http.calls))

    def test_clock_revocation_blocks_new_work_but_cleanup_survives_restart(self):
        op=self.add(operation());delete=self.add(deletion(op))
        self.create_success(op)
        controller=self.controller();self.clock.wall-=timedelta(seconds=1)
        controller.now()
        self.assertTrue(self.journal.values('clock_revoked'))
        self.reopen()
        self.http.add(200,resource(op));self.http.add(204);self.http.add(404)
        self.assertEqual('succeeded',self.controller().cleanup(delete['id'],op['id'])['state'])
        self.assertTrue(self.journal.values('clock_revoked'))
        self.assertEqual(1,sum(r[0]=='PUT' for r in self.http.calls))

    def test_summary_counts_crashed_intent_without_progress_as_unresolved(self):
        op=self.add(operation())
        self.journal.intent(op,self.clock.utc().isoformat())
        self.reopen()
        self.assertEqual({'attempts':1,'succeeded':0,'failed':0,'unresolved':1},self.controller().summary())

    def test_intent_only_runtime_patch_blocks_stale_app_cleanup_after_restart(self):
        # Model a process dying after PATCH send, before any response progress.
        # A fresh GET could still show the old App while that PATCH is pending;
        # the resolver must stop before using that GET to authorize deletion.
        prepared=operation_fixtures.OperationsTests()
        prepared.setUp()
        event=prepared.bind_runtime()
        for ident,value in prepared.receipts.items():
            if ident=='trialDatabaseBootstrap':
                # The local observer is deliberately outside Cloud dispatch.
                op={'id':ident,'method':'GET','url':'local://fictional-bootstrap',
                    'deadline':'2026-10-11T02:30:00Z'}
                value['request_digest']=digest(op)
            else:op=prepared.resolver.resolve(ident,prepared.receipts)
            self.journal.intent(op,'2026-10-11T02:00:00Z')
            self.journal.checkpoint(op,value)
        update=prepared.resolver.resolve('appRuntime',prepared.receipts)
        self.journal.intent(update,'2026-10-11T02:00:01Z')
        self.reopen()
        observed=self.journal.receipts()
        self.assertEqual('unknown',observed['appRuntime']['state'])
        self.assertEqual(digest(update),observed['appRuntime']['request_digest'])
        for key in ('terminal','write_terminal','readback_verified','created_by_run'):
            self.assertIs(observed['appRuntime'][key],False)
        restarted=create_resolver(*prepared.args)
        restarted.bind_runtime(event,observed,verify_policy=lambda e:json.loads(e['TRIAL_POLICY_JSON']))
        original=restarted.resolve('app',observed)
        restarted.bind_cleanup('cleanup_app',{'initial_plan_digest':restarted.plan_digest,
            'deadline':original['cleanup']['deadline'],'reference_evidence':{}})
        with self.assertRaises(Denied):restarted.cleanup_creation_id('cleanup_app',observed)
        control=Controller(self.journal,self.clock,restarted.resolve,restarted.allowed_ids,
            {name:self.provider for name in ('Microsoft.App','Microsoft.ManagedIdentity','Microsoft.Authorization','Microsoft.Storage','Microsoft.Graph')})
        with self.assertRaises(Denied):control.cleanup('cleanup_app','app')
        self.assertEqual([],self.http.calls)
        self.assertFalse(any(v['operation_id']=='cleanup_app' for v in self.journal.values('intent')))

    def test_known_create_can_update_via_fresh_exact_get_and_patch_ack(self):
        op = self.add(operation('containerApps'))
        update = self.update_operation(op)
        self.create_success(op)
        self.http.add(200, resource(op))
        self.http.add(200, resource(update))
        self.http.add(200, resource(update))
        result = self.controller().update(update['id'], op['id'])
        self.assertEqual('succeeded', result['state'])
        self.assertEqual(1, sum(r[0] == 'PATCH' for r in self.http.calls))

    def test_known_write_ack_survives_transient_get_failure_and_restart(self):
        op = self.add(operation())
        self.http.add(404)
        self.http.add(201, resource(op))
        self.http.responses.append(TimeoutError('temporary-get'))
        first = self.controller().create(op['id'])
        self.assertNotEqual('succeeded', first['state'])
        self.reopen()
        self.http.add(200, resource(op))
        result = self.controller().reconcile(op['id'])
        self.assertEqual('succeeded', result['state'])
        self.assertEqual(1, sum(r[0] == 'PUT' for r in self.http.calls))

    def lro_start(self):
        op = self.add(operation('jobs'))
        url = 'https://management.azure.com' + SUB + '/providers/Microsoft.App/locations/eastus/containerappsjobOperationStatuses/' + UUID + '?api-version=2025-07-01'
        self.http.add(404)
        self.http.add(201, headers={'azure-asyncoperation': url, 'retry-after': '1'})
        self.assertEqual('pending', self.controller().create(op['id'])['state'])
        return op

    def test_known_lro_ack_can_be_polled_after_transient_failure_and_restart(self):
        op = self.lro_start()
        self.clock.advance(2)
        self.http.responses.append(TimeoutError('temporary-poll'))
        self.controller().reconcile(op['id'])
        self.reopen()
        self.http.add(200, {'status': 'Succeeded'})
        self.http.add(200, resource(op))
        result = self.controller().reconcile(op['id'])
        self.assertEqual('succeeded', result['state'])
        self.assertEqual(1, sum(r[0] == 'PUT' for r in self.http.calls))

    def test_create_200_with_lro_cannot_adopt_an_existing_app(self):
        op = self.add(operation('jobs'))
        url = 'https://management.azure.com' + SUB + '/providers/Microsoft.App/locations/eastus/containerappsjobOperationStatuses/' + UUID + '?api-version=2025-07-01'
        self.http.add(404)
        self.http.add(200, resource(op), {'azure-asyncoperation': url})
        first = self.controller().create(op['id'])
        self.assertEqual('unknown', first['state'])
        self.clock.advance(2)
        self.http.add(200, {'status': 'Succeeded'})
        self.http.add(200, resource(op))
        self.assertNotEqual('succeeded', self.controller().reconcile(op['id'])['state'])
        self.assertEqual(2, len(self.http.calls))

    def test_unresolved_other_attempt_blocks_new_update_intent(self):
        app = self.add(operation('containerApps'))
        update = self.update_operation(app)
        other = self.add(operation())
        self.create_success(app)
        self.http.add(404)
        self.http.responses.append(TimeoutError('unknown-put'))
        self.controller().create(other['id'])
        self.http.add(200, resource(app))
        self.http.add(200, resource(update))
        self.http.add(200, resource(update))
        with self.assertRaises(Denied): self.controller().update(update['id'], app['id'])
        self.assertFalse(any(v['operation_id'] == update['id'] for v in self.journal.values('intent')))
        self.assertNotIn('PATCH', [r[0] for r in self.http.calls])

    def test_clock_rollback_revokes_new_writes_even_after_clock_recovers_and_restart(self):
        op = self.add(operation())
        controller = self.controller()
        self.clock.wall -= timedelta(seconds=1)
        self.http.add(404)
        with self.assertRaisesRegex(Denied, 'clock_rollback'): controller.create(op['id'])
        self.clock.wall += timedelta(seconds=2)
        self.reopen()
        self.http.responses = []
        self.http.add(404)
        self.http.add(201, resource(op))
        self.http.add(200, resource(op))
        with self.assertRaises(Denied): self.controller().create(op['id'])
        self.assertNotIn('PUT', [r[0] for r in self.http.calls])

    def test_shared_budget_counts_before_send_and_unknown_never_refunds(self):
        op = self.add(operation())
        seed = {'owner_arm': 598, 'owner_control_blob': 32, 'heartbeat_blob': 0}
        with ControlBudget(self.path, self.directory_digest, {'trial': 'fictional-fixed'}, seed=seed) as budget:
            self.provider.http = CountedControlHttp(self.http, budget)
            self.http.add(404)
            self.http.responses.append(TimeoutError('unknown-put'))
            self.assertEqual('unknown', self.controller().create(op['id'])['state'])
            self.assertEqual(600, budget.count('owner_arm'))
        self.reopen()
        with ControlBudget(self.path, self.directory_digest, {'trial': 'fictional-fixed'}, seed=seed) as budget:
            self.provider.http = CountedControlHttp(self.http, budget)
            with self.assertRaises(Denied): budget.consume('owner_arm', 600)
            self.assertEqual('unknown', self.controller().reconcile(op['id'])['state'])
            self.assertEqual(600, budget.count('owner_arm'))
        self.assertEqual(['GET', 'PUT'], [r[0] for r in self.http.calls])


class ResourceProviderContractTests(unittest.TestCase):
    def test_all_generated_resource_operations_match_real_provider_contract(self):
        for op in build_resource_operations(*resources_fixture()):
            with self.subTest(slot=op['id']):
                self.assertEqual(op, _validate(op))

    def test_generated_app_and_guard_get_accept_service_identity_fields(self):
        clock, http = Clock(), Http()
        provider = BoundedArmProvider(Credential(clock), http, clock)
        ops = {op['id']: op for op in build_resource_operations(*resources_fixture())}
        for slot in ('app', 'guard'):
            op = ops[slot]
            value = resource(op)
            if slot == 'app':
                for fields in value['identity']['userAssignedIdentities'].values():
                    fields.update(principalId=UUID, clientId=UUID)
                value['properties']['configuration']['ingress']['fqdn'] = 'trial-app.fictional.azurecontainerapps.io'
                for secret in value['properties']['configuration']['secrets']:
                    secret.pop('value', None)
            else:
                value['identity'].update(principalId=UUID, tenantId=UUID)
            http.add(200, value)
            with self.subTest(slot=slot):
                result = provider.readback(op)
                self.assertEqual('matching', result['state'])
                self.assertTrue(result['properties'])

    def test_generated_runtime_updates_match_real_provider_contract(self):
        manifest, authority, bindings, receipts, environment, auth = runtime_fixture()
        for op in build_runtime_operations(manifest, authority, bindings, receipts, environment,
                verify_policy=lambda value: json.loads(value['TRIAL_POLICY_JSON']),
                auth_operation=auth, deadline='2026-10-11T02:20:00Z'):
            with self.subTest(slot=op['id']):
                self.assertEqual(op, _validate(op))


if __name__ == '__main__': unittest.main()
