"""Only fictional counters in temporary OWNER-private files; no live ledger."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import ControlBudget, CountedControlHttp, scope_for_dispatch
from scripts.trial_provision.tests.test_attempt import SEED, fixture, verify


def budget_fixture(test):
    temp = tempfile.TemporaryDirectory()
    test.addCleanup(temp.cleanup)
    directory = Path(temp.name).resolve()
    data = fixture()
    binding = data['config']['control_budget']['binding']
    args = (directory, digest(str(directory)), binding)
    budget = ControlBudget(*args, seed=SEED)
    test.addCleanup(budget.close)
    for _ in range(59):
        budget.consume('owner_arm', 600)
    return budget, verify(data), args


def scope(budget, verified, phase):
    entries = {'fresh_read': ('fresh-read', 'read'), 'publication': ('publication', 'publish'),
        'run': ('owner-run', 'execute'), 'cleanup': ('owner-cleanup', 'recover')}
    if phase == 'provision':
        return scope_for_dispatch(budget, verified, entry_point='provision', action='create',
            operation={'id': 'webIdentity', 'kind': 'managedIdentity', 'method': 'PUT', 'expected': {}})
    entry, action = entries[phase]
    return scope_for_dispatch(budget, verified, entry_point=entry, action=action)


class AttemptAccountingTests(unittest.TestCase):
    def test_prepare_is_explicit_and_reopen_preserves_exact_legacy_prefix(self):
        budget, verified, args = budget_fixture(self)
        prefix = budget.journal.path.read_bytes()
        with self.assertRaisesRegex(Denied, 'budget_plan_not_prepared'):
            scope(budget, verified, 'publication')
        self.assertEqual(budget.journal.path.read_bytes(), prefix)
        budget.close()
        budget = ControlBudget(*args, seed=SEED, require_existing=True)
        self.addCleanup(budget.close)
        with self.assertRaisesRegex(Denied, 'budget_plan_not_prepared'):
            budget.begin_attempt(verified)
        self.assertEqual(budget.journal.path.read_bytes(), prefix)
        budget.begin_attempt(verified, initialize=True)
        budget.begin_attempt(verified, initialize=True)
        scope(budget, verified, 'publication').consume('owner_arm', 600)
        appended = budget.journal.path.read_bytes()
        self.assertTrue(appended.startswith(prefix))
        self.assertEqual(len(budget.journal.values('phase_plan')), 1)
        self.assertEqual(budget.journal.values('binding')[0],
            {'binding': args[2], 'seed': SEED, 'limits': ControlBudget.LIMITS})
        budget.close()
        reopened = ControlBudget(*args, seed=SEED, require_existing=True)
        self.addCleanup(reopened.close)
        reopened.begin_attempt(verified)
        self.assertEqual(reopened.counts(), {'owner_arm': 188, 'owner_control_blob': 32, 'heartbeat_blob': 0})
        self.assertEqual(reopened.journal.path.read_bytes(), appended)
        with self.assertRaisesRegex(Denied, 'budget_scope_required'):
            reopened.consume('owner_arm', 600)

    def test_provision_http_and_owner_token_caps_are_separate_single_debits(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        provision = scope(budget, verified, 'provision')
        for _ in range(170):
            provision.consume('owner_arm', 600)
        with self.assertRaisesRegex(Denied, 'budget_purpose_exhausted'):
            provision.consume('owner_arm', 600)
        self.assertEqual(budget.count('owner_arm'), 357)
        for _ in range(10):
            provision.consume_owner_token()
        before = budget.journal.path.read_bytes()
        for send in (lambda: provision.consume('owner_arm', 600), provision.consume_owner_token):
            with self.assertRaises(Denied):
                send()
        self.assertEqual(budget.count('owner_arm'), 367)
        self.assertEqual(budget.journal.path.read_bytes(), before)
        rows = budget.journal.values('request')[59:]
        self.assertEqual(len(rows), 180)
        self.assertEqual(sum(r['purpose'] == 'owner_token' for r in rows), 10)
        self.assertTrue(all(r['attempt'] == verified.binding_digest and r['phase'] == 'provision' for r in rows))

    def test_457_stops_noncleanup_and_120_cleanup_plus_23_unallocated_survive(self):
        budget, verified, args = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        for phase, cap in (('fresh_read', 24), ('publication', 24), ('provision', 170), ('run', 42)):
            scoped = scope(budget, verified, phase)
            for _ in range(cap):
                scoped.consume('owner_arm', 600)
        provision = scope(budget, verified, 'provision')
        for _ in range(10):
            provision.consume_owner_token()
        self.assertEqual(budget.count('owner_arm'), 457)
        for phase in ('fresh_read', 'publication', 'provision', 'run'):
            with self.subTest(phase=phase), self.assertRaises(Denied):
                scope(budget, verified, phase).consume('owner_arm', 600)
        budget.close()
        reopened = ControlBudget(*args, seed=SEED, require_existing=True)
        self.addCleanup(reopened.close)
        cleanup = scope(reopened, verified, 'cleanup')
        for _ in range(120):
            cleanup.consume('owner_arm', 600)
        self.assertEqual(reopened.count('owner_arm'), 577)
        with self.assertRaises(Denied):
            cleanup.consume_owner_token()
        self.assertEqual(600 - reopened.count('owner_arm'), 23)

    def test_cleanup_first_still_blocks_normal_send_at_457(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        cleanup = scope(budget, verified, 'cleanup')
        for _ in range(120):
            cleanup.consume('owner_arm', 600)
        provision = scope(budget, verified, 'provision')
        for _ in range(150):
            provision.consume('owner_arm', 600)
        self.assertEqual(budget.count('owner_arm'), 457)
        with self.assertRaisesRegex(Denied, 'budget_cleanup_reserved'):
            provision.consume('owner_arm', 600)

    def test_failed_wire_and_failed_guard_are_counted_once_without_retry(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        wire = Mock(side_effect=OSError('fictional unknown outcome'))
        http = CountedControlHttp(wire, scope(budget, verified, 'provision'))
        with self.assertRaises(OSError):
            http('GET', 'https://management.azure.com/fixed', {}, None, Mock())
        with self.assertRaises(TimeoutError):
            http.send_guarded('GET', 'https://management.azure.com/fixed', {}, None, Mock(),
                before_send=Mock(side_effect=TimeoutError('expired after fsync')))
        self.assertEqual(wire.call_count, 1)
        self.assertEqual(budget.count('owner_arm'), 189)

    def test_failed_fsync_poison_prevents_current_or_subsequent_wire(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        wire = Mock()
        http = CountedControlHttp(wire, scope(budget, verified, 'provision'))
        with patch('scripts.trial_provision.journal.os.fsync', side_effect=OSError('fictional fsync')):
            with self.assertRaises(OSError):
                http('GET', 'https://management.azure.com/fixed', {}, None, Mock())
        with self.assertRaisesRegex(Denied, 'budget_unavailable'):
            http('GET', 'https://management.azure.com/fixed', {}, None, Mock())
        wire.assert_not_called()

    def test_concurrent_last_http_slot_cannot_overrun(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        scoped = scope(budget, verified, 'provision')
        for _ in range(169):
            scoped.consume('owner_arm', 600)
        def send(_):
            try:
                scoped.consume('owner_arm', 600)
                return True
            except Denied:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(send, range(2))), [False, True])
        self.assertEqual(budget.count('owner_arm'), 357)

    def test_reopen_denies_legacy_row_or_repeated_plan_after_activation(self):
        for event in ('request', 'phase_plan'):
            with self.subTest(event=event):
                budget, verified, args = budget_fixture(self)
                budget.begin_attempt(verified, initialize=True)
                value = {'kind': 'owner_arm'} if event == 'request' else budget.journal.values('phase_plan')[0]
                budget.journal.append(event, value)
                with self.assertRaisesRegex(Denied, 'budget_outside_writer'):
                    budget.counts()
                budget.close()
                with self.assertRaises(Denied):
                    ControlBudget(*args, seed=SEED, require_existing=True)

    def test_wrong_snapshot_or_binding_cannot_initialize(self):
        budget, verified, args = budget_fixture(self)
        budget.consume('owner_arm', 600)
        before = budget.journal.path.read_bytes()
        with self.assertRaisesRegex(Denied, 'budget_plan_snapshot'):
            budget.begin_attempt(verified, initialize=True)
        self.assertEqual(budget.journal.path.read_bytes(), before)
        budget.close()
        changed = deepcopy(args[2]); changed['task_id'] = 'another-fictional-task'
        with self.assertRaises(Denied):
            ControlBudget(args[0], args[1], changed, seed=SEED, require_existing=True)

    def test_dispatcher_scope_cannot_be_set_by_json_phase_or_mutated(self):
        budget, verified, _ = budget_fixture(self)
        budget.begin_attempt(verified, initialize=True)
        scoped = scope(budget, verified, 'provision')
        with self.assertRaises(Denied):
            scoped.phase = 'cleanup'
        operation = {'id': 'webIdentity', 'kind': 'identity', 'method': 'PUT', 'expected': {}, 'phase': 'cleanup'}
        classified = scope_for_dispatch(budget, verified, entry_point='provision', action='create', operation=operation)
        self.assertEqual(classified.phase, 'provision')
        for operation in ({**operation, 'method': 'DELETE'}, {**operation, 'kind': 'cleanup:identity'},
                {**operation, 'expected': {'auth_action': 'cleanup:auth'}}):
            self.assertEqual(scope_for_dispatch(budget, verified, entry_point='provision', action='reconcile', operation=operation).phase, 'cleanup')
        with self.assertRaises(Denied):
            scope_for_dispatch(budget, verified, entry_point='user-phase', action='cleanup')


if __name__ == '__main__':
    unittest.main()
