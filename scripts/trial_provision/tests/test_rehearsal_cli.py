"""Offline CLI orchestration with the real adapter and Journal state checks."""
from copy import deepcopy
from datetime import timedelta
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import Journal, no_secret
from scripts.trial_provision.rehearsal_cli import run_rehearsal
from scripts.trial_provision.tests import test_rehearsal as fixture
from scripts.trial_provision.tests import test_operations as operations_fixture


class MemoryJournal(Journal):
    # Exercise production intent/allocation/checkpoint validation without files.
    def __init__(self):
        import threading
        self.records = []
        self.mutex = threading.RLock()
    def append(self, event, value):
        no_secret(value)
        self.records.append({'event': event, 'value': deepcopy(value)})


class Budget:
    def __init__(self): self.calls = []; self.counts = {'owner_arm': 128, 'owner_control_blob': 32, 'heartbeat_blob': 0}
    def consume(self, kind, limit):
        if self.counts[kind] >= limit: raise Denied('budget_exhausted')
        self.counts[kind] += 1; self.calls.append((kind, limit))


class Resolver:
    plan_digest = 'a' * 64
    def __init__(self, op): self.op, self.events = op, []
    def resolve(self, ident, receipts):
        if ident != 'guard': raise Denied('not_resolver_operation')
        return deepcopy(self.op)
    def bind_rehearsal(self, event, receipts):
        if (set(event) != {'initial_plan_digest', 'operation', 'receipt'}
            or event['initial_plan_digest'] != self.plan_digest
            or receipts.get('guardRehearsal') != event['receipt']
            or event['receipt']['request_digest'] != digest(event['operation'])
            or any(receipts[k]['terminal'] is not True for k in ('guard', 'guardRehearsalStart', 'guardRehearsalSeed', 'guardRehearsal'))):
            raise Denied('invalid_binding_event')
        self.events.append(deepcopy(event))


class RehearsalCliTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.RehearsalTests()
        self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.bundle = {'owner': deepcopy(self.f.owner), 'guardian': deepcopy(self.f.guardian)}
        self.journal = MemoryJournal()
        self.journal.intent(self.f.create, self.f.clock.iso())
        self.journal.checkpoint(self.f.create, self.f.created)
        self.resolver, self.budget = Resolver(self.f.create), Budget()
    def run_phase(self, action, **changes):
        return run_rehearsal(action, changes.get('bundle', self.bundle), self.journal,
            self.resolver, self.f.credential, self.f.wire, self.budget, self.f.clock)
    def seed(self):
        self.run_phase('start')
        self.run_phase('seed')
    def complete(self):
        self.seed(); self.f.wire.finish()
        return self.run_phase('verify')
    def test_phases_persist_binding_and_normalized_receipt(self):
        result = self.complete()
        self.assertEqual('succeeded', result['status']); self.assertTrue(result['rehearsal_verified'])
        self.assertFalse(result['live_delete_verified'])
        self.assertEqual([digest(self.bundle)], self.journal.values('rehearsal_config_binding'))
        self.assertEqual(1, len(self.journal.values('rehearsal_binding')))
        self.assertEqual(1, len(self.resolver.events))
        self.assertNotIn('object_id', result); self.assertNotIn(fixture.EXECUTION, str(result))
    def test_existing_success_replays_binding_without_any_cloud_call(self):
        self.complete(); count = len(self.f.wire.calls)
        self.resolver = Resolver(self.f.create)
        self.assertTrue(self.run_phase('verify')['rehearsal_verified'])
        self.assertEqual(count, len(self.f.wire.calls)); self.assertEqual(1, len(self.resolver.events))
    def test_changed_private_bundle_rejected_before_credentials(self):
        self.run_phase('start'); calls = len(self.f.credential.calls)
        changed = deepcopy(self.bundle); changed['owner']['prearm_until'] = '2026-10-11T00:06:00Z'
        with self.assertRaises(Denied): self.run_phase('seed', bundle=changed)
        self.assertEqual(calls, len(self.f.credential.calls))
    def test_arbitrary_operation_or_extra_config_key_not_accepted(self):
        with self.assertRaises(Denied): self.run_phase('start', bundle={**self.bundle, 'operation': {}})
        with self.assertRaises(Denied): self.run_phase('delete')
        self.assertFalse(self.f.wire.calls)
    def test_unknown_start_reopen_returns_unknown_without_another_post(self):
        self.f.wire.start_response = TimeoutError('private marker')
        first = self.run_phase('start'); count = len(self.f.wire.calls)
        second = self.run_phase('start')
        self.assertEqual('unknown', first['status']); self.assertEqual('unknown', second['status'])
        self.assertEqual(count, len(self.f.wire.calls))
        with self.assertRaises(Denied): self.run_phase('seed')
        self.assertEqual(1, sum(c[0] == 'POST' for c in self.f.wire.calls))
    def test_missing_start_checkpoint_is_unknown_not_resent(self):
        self.run_phase('start')
        self.journal.records = [r for r in self.journal.records if not (r['event'] == 'progress' and r['value']['operation_id'] == 'guardRehearsalStart')]
        count = len(self.f.wire.calls)
        self.assertEqual('unknown', self.run_phase('start')['status'])
        self.assertEqual(count, len(self.f.wire.calls))
    def test_unknown_seed_never_resent(self):
        self.run_phase('start')
        self.f.wire.modify = lambda m,u,h,b: TimeoutError() if m == 'PUT' and u == fixture.BLOB else None
        first = self.run_phase('seed'); count = len(self.f.wire.calls)
        second = self.run_phase('seed')
        self.assertEqual('unknown', first['status']); self.assertEqual('unknown', second['status'])
        self.assertEqual(count, len(self.f.wire.calls))
    def test_prior_unresolved_intent_blocks_new_rehearsal(self):
        other = deepcopy(self.f.create); other['id'] = 'other'
        self.journal.intent(other, self.f.clock.iso())
        result = self.run_phase('start')
        self.assertEqual('unknown', result['status'])
        self.assertFalse(any(c[0] == 'POST' for c in self.f.wire.calls))
        self.assertFalse(any(v['operation_id'] == 'guardRehearsalStart' for v in self.journal.values('intent')))
    def test_budget_counts_both_arm_and_blob_without_new_allowance(self):
        self.complete()
        self.assertEqual(len(self.f.wire.calls), len(self.budget.calls))
        self.assertEqual(len(self.f.wire.calls), len(self.journal.values('rehearsal_request')))
        self.assertEqual({'owner_arm', 'owner_control_blob'}, {k for k, _ in self.budget.calls})
        self.assertGreater(self.budget.counts['owner_arm'], 128)
        self.assertGreater(self.budget.counts['owner_control_blob'], 32)
    def test_exhausted_lifetime_budget_sends_nothing(self):
        self.budget.counts['owner_arm'] = 600
        with self.assertRaises(Denied): self.run_phase('start')
        self.assertFalse(self.f.wire.calls)
        self.assertEqual(600, self.budget.counts['owner_arm'])
    def test_failed_audit_after_debit_is_not_refunded(self):
        original = self.journal.append
        def append(event, value):
            if event == 'rehearsal_request': raise OSError('private audit path')
            original(event, value)
        self.journal.append = append
        with self.assertRaises(OSError): self.run_phase('start')
        self.assertEqual(129, self.budget.counts['owner_arm']); self.assertFalse(self.f.wire.calls)
    def test_restart_clock_rollback_revokes_new_writes_persistently(self):
        self.journal.append('clock_observation', {'at': self.f.clock.iso(60)})
        with self.assertRaises(Denied): self.run_phase('start')
        self.assertTrue(self.journal.values('clock_revoked')); self.assertFalse(self.f.wire.calls)
    def test_failed_verification_records_observation_without_binding(self):
        self.seed(); self.f.wire.finish(); self.f.wire.state.pop('rehearsal')
        result = self.run_phase('verify')
        self.assertFalse(result['rehearsal_verified'])
        self.assertFalse(self.journal.values('rehearsal_binding'))
        self.assertEqual(1, len(self.journal.values('rehearsal_observation')))
    def test_local_observation_intent_without_checkpoint_can_recover_by_reads(self):
        self.complete()
        # Simulate interruption after the local GET observation intent, before
        # its checkpoint and binding event. Start/seed ACKs remain untouched.
        self.journal.records = [r for r in self.journal.records if r['event'] != 'rehearsal_binding'
            and not (r['event'] == 'progress' and r['value']['operation_id'] == 'guardRehearsal')]
        self.assertTrue(self.run_phase('verify')['rehearsal_verified'])
        self.assertEqual(1, sum(c[0] == 'POST' for c in self.f.wire.calls))
        self.assertEqual(1, sum(c[0] == 'PUT' and c[1] == fixture.BLOB for c in self.f.wire.calls))
    def test_real_resolver_accepts_wrapper_binding_and_main_after_restart(self):
        args = operations_fixture.fixture()
        self.resolver = operations_fixture.create_resolver(*args)
        manifest = args[1]
        create = self.resolver.resolve('guard', {})
        job = create['expected']['resource_id']
        execution = job + '/executions/' + job.rsplit('/', 1)[1] + '-one'
        blob = ('https://' + manifest['existing']['storage'].rsplit('/', 1)[1]
            + '.blob.core.windows.net/' + manifest['names']['journal'] + '/rehearsal.json')
        principal = operations_fixture.guid(2500)
        tenant, owner = manifest['owner']['tenant_id'], manifest['owner']['principal_id']
        image = create['body']['properties']['template']['containers'][0]['image'].split('@', 1)[1]
        self.f.clock.at += timedelta(hours=1)
        self.f.credential.principal, self.f.credential.tenant = owner, tenant
        self.f.create = create
        self.f.created = operations_fixture.receipt(create, {'principalId': principal, 'tenantId': tenant})
        self.f.owner.update(owner_id=owner, tenant_id=tenant, journal_url=blob,
            owner_permissions_until=self.f.clock.iso(28800), prearm_until=self.f.clock.iso(300), seed_not_before=self.f.clock.iso())
        self.f.owner['owner_access'].update(principal_id=owner, journal_url=blob,
            starts_at=self.f.clock.iso(), ends_at=self.f.clock.iso(28800))
        self.f.guardian.update(tenant_id=tenant, journal_url=blob, job_name=job.rsplit('/', 1)[1],
            prearm_until=self.f.clock.iso(300), seed_not_before=self.f.clock.iso())
        self.f.guardian['immutable']['owner_access'] = deepcopy(self.f.owner['owner_access'])
        self.f.guardian['immutable']['cloud_guard'].update(execution_id=job + '/executions/$CURRENT',
            principal_id=principal, image_digest=image)
        self.bundle = {'owner': deepcopy(self.f.owner), 'guardian': deepcopy(self.f.guardian)}
        self.journal = MemoryJournal()
        self.journal.intent(create, self.f.clock.iso())
        self.journal.checkpoint(create, self.f.created)
        with patch.multiple(fixture, JOB=job, EXECUTION=execution, BLOB=blob, PRINCIPAL=principal, TENANT=tenant):
            self.f.wire = fixture.Wire(self.f.clock, create)
            self.f.wire.replica_rows = [{'name': execution.rsplit('/', 1)[1] + '-replica'}]
            result = self.complete()
            self.assertTrue(result['rehearsal_verified'])
            event = self.journal.values('rehearsal_binding')[0]
            self.resolver = operations_fixture.create_resolver(*args)
            self.resolver.bind_rehearsal(event, self.journal.receipts())
            main = self.resolver.resolve('guardMainConfiguration', self.journal.receipts())
            self.assertEqual(1800, main['body']['properties']['configuration']['replicaTimeout'])
            self.assertEqual(create['cleanup']['deadline'], main['deadline'])
            count = len(self.f.wire.calls)
            self.assertTrue(self.run_phase('verify')['rehearsal_verified'])
            self.assertEqual(count, len(self.f.wire.calls))


if __name__ == '__main__': unittest.main()
