"""Fault-injection tests: memory journal and fake clock/transport only."""
import contextlib
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import threading
import unittest

from .lifecycle import Controller, Conflict, Denied, Supervisor, initial, may_use


class Clock:
    def __init__(self):
        self.wall = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.mono = 0
    def utc(self): return self.wall
    def monotonic(self): return self.mono
    def advance(self, seconds):
        self.wall += timedelta(seconds=seconds)
        self.mono += seconds


class Journal:
    def __init__(self, state):
        self.state = deepcopy(state)
        self.mutex = threading.RLock()
        self.saves = 0
        self.fail_save = None
    @contextlib.contextmanager
    def locked(self):
        with self.mutex: yield
    def load(self): return deepcopy(self.state)
    def save(self, value, expected_version):
        self.saves += 1
        if self.saves == self.fail_save: raise OSError('injected_journal_failure')
        if self.state['version'] != expected_version: raise Conflict('stale_version')
        self.state = deepcopy(value)


class Transport:
    def __init__(self, clock):
        self.clock, self.calls, self.queue = clock, [], {}
        self.rule = 'absent'
        self.inspection = {}
        self.delay = {}
    def enqueue(self, kind, value): self.queue.setdefault(kind, []).append(value)
    def _result(self, kind, operation, rule_id, timeout):
        self.calls.append((kind, operation['method'], operation['request_id'], timeout))
        self.clock.advance(self.delay.get(kind, 0))
        pending = self.queue.get(kind, [])
        value = pending.pop(0) if pending else ({'terminal': 'succeeded', 'proof': 'write_response'} if kind == 'send' else {})
        modifies = not isinstance(value, dict) or value.get('terminal') == 'succeeded'
        if kind == 'send' and modifies:
            self.rule = 'owned' if operation['method'] == 'PUT' else 'absent'
        if isinstance(value, Exception): raise value
        return {'request_id': operation['request_id'], 'method': operation['method'], 'rule_id': rule_id, **value}
    def send(self, **kw): return self._result('send', **kw)
    def poll(self, **kw): return self._result('poll', **kw)
    def recover(self, **kw): return self._result('recover', **kw)
    def inspect(self, *, rule_id, lifecycle_id, timeout):
        self.calls.append(('inspect', 'GET', None, timeout))
        self.clock.advance(self.delay.get('inspect', 0))
        return {'http': 200, 'at': self.clock.utc().isoformat(), 'rule_id': rule_id, 'lifecycle_id': lifecycle_id,
                'rule': self.rule, 'exact_http': 404 if self.rule == 'absent' else 200,
                'complete_list': True, 'listed_absent': self.rule == 'absent',
                'existing_rules_unchanged': True, 'network_unchanged': True, 'server_ready': True,
                **self.inspection}
    def sends(self, method): return sum(c[0] == 'send' and c[1] == method for c in self.calls)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.journal = Journal(initial(at=self.clock.utc().isoformat(), rule_id='/fixture/rule',
                               lifecycle_id='fixture-window', guardian_pid=42, independent_guard_verified=True))
        self.transport = Transport(self.clock)
        self.guard_override = {}
        self.runner = self.new_runner()
    def guardian(self):
        return {'at': self.clock.utc().isoformat(), 'alive': True, 'pid': 42,
                'lifecycle_id': 'fixture-window', 'process_handle_verified': True, **self.guard_override}
    def new_runner(self): return Controller(self.journal, self.transport, self.clock, self.guardian)
    def active(self):
        self.runner.start()
        self.assertTrue(self.runner.tick()['usage_allowed'])
    def closing(self):
        self.active()
        self.runner.request_close()

    def test_intent_save_failure_prevents_write(self):
        self.journal.fail_save = 2
        with self.assertRaises(OSError): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_response_save_failure_does_not_resend_after_restart(self):
        self.journal.fail_save = 3
        with self.assertRaises(OSError): self.runner.start()
        self.journal.fail_save = None
        restarted = self.new_runner()
        self.assertEqual(restarted.tick()['status'], 'recovery_pending')
        with self.assertRaises(Denied): restarted.start()
        self.assertEqual(self.transport.sends('PUT'), 1)

    def test_unknown_put_and_absence_never_close_or_resend(self):
        self.transport.enqueue('send', TimeoutError())
        self.runner.start()
        self.transport.rule = 'absent'
        for _ in range(40):
            self.clock.advance(60)
            state = self.new_runner().tick()
            self.assertNotEqual(state['status'], 'closed')
            self.assertTrue(state['cleanup_responsibility_retained'])
        self.assertEqual(self.transport.sends('PUT'), 1)
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_unknown_put_recovers_only_from_bound_terminal_proof(self):
        self.transport.enqueue('send', TimeoutError())
        self.runner.start()
        self.transport.enqueue('recover', {'terminal': 'succeeded', 'proof': 'verified_activity_event'})
        state = self.runner.tick()
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.assertEqual(self.runner.tick()['status'], 'closed')

    def test_wrong_request_id_terminal_proof_rejected(self):
        self.transport.enqueue('send', TimeoutError())
        self.runner.start()
        self.transport.enqueue('recover', {'terminal': 'succeeded', 'proof': 'operation_status', 'request_id': 'wrong'})
        self.assertEqual(self.runner.tick()['blocked'], 'operation_proof_mismatch')
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_unqualified_get_is_not_terminal_proof(self):
        self.transport.enqueue('send', TimeoutError())
        self.runner.start()
        self.transport.enqueue('recover', {'terminal': 'succeeded', 'proof': 'resource_get'})
        self.assertEqual(self.runner.tick()['blocked'], 'terminal_proof_missing')
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_changed_rule_or_existing_settings_prevents_delete(self):
        for changed in ({'rule': 'foreign'}, {'network_unchanged': False}, {'existing_rules_unchanged': False}):
            with self.subTest(changed=changed):
                self.setUp(); self.closing(); self.transport.inspection = changed
                self.assertEqual(self.runner.tick()['blocked'], 'ownership_or_settings_changed')
                self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_unknown_delete_and_404_require_terminal_proof(self):
        self.closing()
        self.transport.enqueue('send', TimeoutError())
        self.runner.tick()
        self.assertEqual(self.transport.rule, 'absent')
        for _ in range(3): self.assertNotEqual(self.new_runner().tick()['status'], 'closed')
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.transport.enqueue('recover', {'terminal': 'succeeded', 'proof': 'verified_activity_event'})
        self.assertEqual(self.runner.tick()['status'], 'closed')

    def test_busy_retry_is_delayed_requires_ready_and_is_durable(self):
        self.closing()
        self.transport.enqueue('send', {'terminal': 'failed', 'proof': 'write_response', 'http': 409, 'error_code': 'ServerIsBusy'})
        self.runner.tick()
        self.runner.tick()
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.clock.advance(15); self.transport.inspection['server_ready'] = False
        self.new_runner().tick()
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.transport.inspection['server_ready'] = True
        self.new_runner().tick()
        self.assertEqual(self.transport.sends('DELETE'), 2)
        self.assertEqual(self.runner.tick()['status'], 'closed')

    def test_busy_retry_limit_retains_cleanup_responsibility(self):
        self.closing()
        for _ in range(8):
            self.transport.enqueue('send', {'terminal': 'failed', 'proof': 'write_response', 'error_code': 'ServerIsBusy'})
            self.runner.tick(); self.clock.advance(15)
        state = self.runner.tick()
        self.assertEqual(state['blocked'], 'confirmed_busy_retry_limit')
        self.assertTrue(state['cleanup_responsibility_retained'])
        self.assertEqual(self.transport.sends('DELETE'), 8)

    def test_authorization_denial_never_retried(self):
        self.closing(); self.transport.enqueue('send', {'http': 403})
        self.assertEqual(self.runner.tick()['blocked'], 'authorization_denied')
        count = len(self.transport.calls)
        for _ in range(5): self.clock.advance(5000); self.new_runner().tick()
        self.assertEqual(len(self.transport.calls), count)
        self.assertEqual(self.transport.sends('DELETE'), 1)

    def test_other_terminal_failure_never_retried(self):
        self.closing()
        self.transport.enqueue('send', {'terminal': 'failed', 'proof': 'write_response', 'error_code': 'Other'})
        self.runner.tick(); self.runner.tick(); self.runner.tick()
        self.assertEqual(self.transport.sends('DELETE'), 1)

    def test_cleanup_cutoff_stops_use(self):
        self.active(); self.clock.advance(5 * 3600)
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertTrue(state['close_requested'])
        self.assertEqual(self.transport.sends('DELETE'), 1)

    def test_deadline_does_not_extend_on_restart_and_cleanup_continues(self):
        self.active(); original = self.journal.state['deadline']
        self.clock.advance(6 * 3600 + 10)
        state = self.new_runner().tick()
        self.assertFalse(state['usage_allowed'])
        self.assertEqual(state['deadline'], original)
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.assertEqual(self.new_runner().tick()['status'], 'closed')

    def test_pending_unknown_retained_beyond_deadline_and_old_retry_count(self):
        self.transport.enqueue('send', TimeoutError()); self.runner.start()
        self.clock.advance(7 * 3600)
        for _ in range(30):
            state = self.new_runner().tick(); self.clock.advance(60)
            self.assertFalse(state['usage_allowed'])
            self.assertTrue(state['cleanup_responsibility_retained'])
        self.assertEqual(self.transport.sends('PUT'), 1)
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_clock_rollback_stops_use_without_extending_deadline(self):
        self.active(); self.clock.advance(10); self.runner.tick()
        deadline = self.journal.state['deadline']
        self.clock.wall -= timedelta(hours=2)
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertEqual(state['deadline'], deadline)
        self.assertTrue(state['close_requested'])

    def test_invalid_deadline_rejected(self):
        self.journal.state['deadline'] = (self.clock.utc() + timedelta(hours=7)).isoformat()
        with self.assertRaises(ValueError): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_start_at_cleanup_cutoff_denied(self):
        self.clock.advance(5 * 3600)
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_guard_unhealthy_variants_deny_start(self):
        variants = [{'alive': False}, {'pid': 99}, {'lifecycle_id': 'old'}, {'process_handle_verified': False},
                    {'at': 'invalid'}, {'at': (self.clock.utc() - timedelta(seconds=31)).isoformat()},
                    {'at': (self.clock.utc() + timedelta(seconds=1)).isoformat()}]
        for variant in variants:
            with self.subTest(variant=variant):
                self.setUp(); self.guard_override = variant
                with self.assertRaises(Denied): self.runner.start()
                self.assertEqual(self.transport.sends('PUT'), 0)

    def test_unverified_independence_denies_start_even_with_ready_guard(self):
        self.journal.state['independent_guard_verified'] = False
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_guard_death_during_active_use_closes_window(self):
        self.active(); self.guard_override['alive'] = False
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertEqual(self.transport.sends('DELETE'), 1)

    def test_timeout_budget_shared_across_read_and_write(self):
        self.closing(); self.transport.delay['inspect'] = 12
        self.runner.tick()
        deletion = [c for c in self.transport.calls if c[0] == 'send' and c[1] == 'DELETE'][-1]
        self.assertEqual(deletion[3], 8)

    def test_call_near_deadline_has_remaining_absolute_budget(self):
        self.closing(); self.clock.advance(6 * 3600 - 3)
        self.runner.tick()
        self.assertLessEqual(self.transport.calls[-1][3], 3)

    def test_transport_overrun_stops_use_and_blocks_new_write_in_tick(self):
        self.closing(); self.transport.delay['inspect'] = 21
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_cutoff_crossed_during_active_readback_never_reenables_use(self):
        self.active(); self.clock.advance(5 * 3600 - 2); self.transport.delay['inspect'] = 3
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertTrue(state['close_requested'])

    def test_closed_requires_complete_list_and_matching_fresh_evidence(self):
        for mismatch in ({'complete_list': False}, {'listed_absent': False}, {'exact_http': 200},
                         {'lifecycle_id': 'old'}, {'at': '2025-01-01T00:00:00+00:00'}):
            with self.subTest(mismatch=mismatch):
                self.setUp(); self.closing(); self.runner.tick(); self.transport.inspection = mismatch
                self.assertNotEqual(self.runner.tick()['status'], 'closed')
                self.assertTrue(self.journal.state['cleanup_responsibility_retained'])

    def test_two_controllers_serialize_one_delete(self):
        self.closing()
        first, second = self.new_runner(), self.new_runner()
        threads = [threading.Thread(target=r.tick) for r in (first, second)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.assertEqual(self.journal.state['status'], 'closed')

    def test_journal_compare_and_swap_rejects_stale_writer(self):
        snapshot = self.journal.load(); self.runner.start()
        with self.assertRaises(Conflict): self.journal.save(snapshot, expected_version=0)
        self.assertEqual(self.transport.sends('PUT'), 1)

    def test_guard_exception_clears_persistent_use_flag(self):
        self.active()
        def unavailable(): raise OSError('guard_io_unavailable')
        self.runner.guardian = unavailable
        state = self.runner.tick()
        self.assertFalse(state['usage_allowed'])
        self.assertTrue(state['close_requested'])

    def test_unexpected_inspection_exception_cannot_retain_use_flag(self):
        self.active()
        def malformed(**_): raise ValueError('invalid_readback')
        self.transport.inspect = malformed
        with self.assertRaises(ValueError): self.runner.tick()
        self.assertFalse(self.journal.state['usage_allowed'])
        self.assertTrue(self.journal.state['cleanup_responsibility_retained'])

    def test_readback_500_or_unknown_cannot_trigger_delete(self):
        for fields in ({'http': 500}, {'rule': 'unknown'}, {'rule': None}, {'exact_http': 500}):
            with self.subTest(fields=fields):
                self.setUp(); self.closing(); self.transport.inspection = fields
                self.runner.tick()
                self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_short_use_lease_expires_without_controller_or_guard(self):
        self.active(); snapshot = self.journal.load()
        self.assertTrue(may_use(snapshot, at=self.clock.utc().isoformat(), lifecycle_id='fixture-window'))
        self.clock.advance(10)
        self.assertFalse(may_use(snapshot, at=self.clock.utc().isoformat(), lifecycle_id='fixture-window'))
        self.assertFalse(may_use(snapshot, at=snapshot['use_lease_from'], lifecycle_id='different-window'))

    def test_guard_callback_time_is_included_before_start(self):
        original = self.runner.guardian
        def slow_guard():
            value = original(); self.clock.advance(25); return value
        self.runner.guardian = slow_guard
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_journal_delay_before_send_rechecks_cutoff(self):
        self.clock.advance(5 * 3600 - 5)
        original = self.journal.save
        def delayed_save(value, expected_version):
            original(value, expected_version)
            if value.get('put') and value['put']['terminal'] is None:
                self.clock.advance(6)
        self.journal.save = delayed_save
        state = self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)
        self.assertEqual(state['put']['proof'], 'local_not_sent')
        self.assertFalse(state['usage_allowed'])

    def test_existing_rule_prevents_creation(self):
        self.transport.rule = 'owned'
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)

    def test_absence_without_successful_delete_proof_stays_pending(self):
        self.closing(); self.transport.rule = 'absent'
        state = self.runner.tick()
        self.assertNotEqual(state['status'], 'closed')
        self.assertEqual(self.transport.sends('DELETE'), 0)

    def test_guard_ages_past_limit_during_intent_save(self):
        self.guard_override['at'] = (self.clock.utc() - timedelta(seconds=29)).isoformat()
        original = self.journal.save
        def delayed(value, expected_version):
            original(value, expected_version)
            if value.get('put') and value['put']['terminal'] is None: self.clock.advance(2)
        self.journal.save = delayed
        state = self.runner.start()
        self.assertEqual(self.transport.sends('PUT'), 0)
        self.assertEqual(state['put']['proof'], 'local_not_sent')

    def test_supervisor_controller_death_triggers_cleanup(self):
        self.active(); reports = []
        supervisor = Supervisor(self.runner, lambda: False, reports.append)
        self.assertTrue(supervisor.step()['continue'])
        self.assertFalse(supervisor.step()['continue'])
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.assertTrue(reports[-1]['closed'])

    def test_supervisor_does_not_abandon_unknown_after_24_attempts_or_expiry(self):
        self.transport.enqueue('send', TimeoutError()); self.runner.start()
        reports = []; supervisor = Supervisor(self.runner, lambda: False, reports.append)
        self.clock.advance(7 * 3600)
        for _ in range(40):
            value = supervisor.step()
            self.assertTrue(value['continue']); self.assertLessEqual(value['delay_seconds'], 5)
        self.assertTrue(reports[-1]['cleanupResponsibilityRetained'])
        self.assertEqual(self.transport.sends('PUT'), 1)

    def test_supervisor_lock_or_journal_failure_is_pending_not_closed(self):
        self.active(); reports = []
        supervisor = Supervisor(self.runner, lambda: False, reports.append)
        self.journal.fail_save = self.journal.saves + 1
        self.assertTrue(supervisor.step()['continue'])
        self.assertFalse(reports[-1]['closed'])
        self.journal.fail_save = None
        self.assertTrue(supervisor.step()['continue'])
        self.assertFalse(supervisor.step()['continue'])

    def test_supervisor_report_failure_keeps_cleanup_running(self):
        self.active()
        def broken_report(_): raise OSError('report_unavailable')
        supervisor = Supervisor(self.runner, lambda: False, broken_report)
        for _ in range(2):
            result = supervisor.step()
            self.assertTrue(result['continue'])
            self.assertTrue(result['reporting_failed'])
            self.assertEqual(result['delay_seconds'], 5)
        self.assertEqual(self.transport.sends('DELETE'), 1)
        self.assertEqual(self.journal.state['status'], 'closed')
        supervisor.report = lambda _: None
        self.assertFalse(supervisor.step()['continue'])

    def test_supervisor_report_and_journal_failure_do_not_escape(self):
        self.active()
        def broken_report(_): raise OSError('report_unavailable')
        supervisor = Supervisor(self.runner, lambda: False, broken_report)
        self.journal.fail_save = self.journal.saves + 1
        result = supervisor.step()
        self.assertTrue(result['continue'])
        self.assertTrue(result['reporting_failed'])
        self.assertEqual(result['delay_seconds'], 5)

    def test_restart_detects_rollback_from_time_observed_inside_tick(self):
        self.active()
        self.transport.delay['inspect'] = 2
        state = self.runner.tick()
        self.assertEqual(state['last_now'], state['use_lease_from'])
        deadline = state['deadline']
        self.clock.wall -= timedelta(seconds=1)
        self.transport.delay['inspect'] = 0
        state = self.new_runner().tick()
        self.assertFalse(state['usage_allowed'])
        self.assertTrue(state['close_requested'])
        self.assertEqual(state['deadline'], deadline)

    def test_not_sent_intent_never_owns_later_matching_rule(self):
        self.clock.advance(5 * 3600 - 5)
        original = self.journal.save
        def delayed(value, expected_version):
            original(value, expected_version)
            if value.get('put') and value['put']['terminal'] is None: self.clock.advance(6)
        self.journal.save = delayed
        self.runner.start()
        self.transport.rule = 'owned'
        state = self.runner.tick()
        self.assertEqual(state['blocked'], 'rule_appeared_without_our_send')
        self.assertEqual(self.transport.sends('PUT'), 0)
        self.assertEqual(self.transport.sends('DELETE'), 0)


if __name__ == '__main__': unittest.main()
