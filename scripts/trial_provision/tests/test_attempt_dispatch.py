"""Dispatcher regression tests with sealed fictional authority and fake adapters."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision.attempt_dispatch import ApprovedAttemptSession, FOUNDATION, GROUPS
from scripts.trial_provision.tests.test_attempt import fixture, stamp, verify
from scripts.trial_provision.tests.test_rehearsal_cli import MemoryJournal


class Clock:
    def __init__(self, seconds=2200):
        self.start = parse(stamp())
        self.seconds = seconds
    def utc(self):
        return self.start + timedelta(seconds=self.seconds)
    def monotonic(self):
        return self.seconds
    def advance(self, seconds):
        self.seconds += seconds


class AttemptDispatchTests(unittest.TestCase):
    def setUp(self):
        self.data = fixture()
        self.verified = verify(self.data)
        self.clock = Clock()
        self.session = ApprovedAttemptSession(self.verified, self.clock)
        self.addCleanup(self.session.close)

    def operation(self, slot='webIdentity'):
        return {'id': slot, 'deadline': stamp(30900), 'expected': {}}

    def state_environment(self, slot='webIdentity', *, intent=False, receipt=None, polls=0):
        """Real _state checks; inject only local file/loader/resolver observations."""
        config = deepcopy(self.data['config'])
        config.update(verified_attempt=self.verified, live=True, resource_bindings={})
        journal = MemoryJournal()
        journal.append('core_plan', {'fictional': True})
        op = self.operation(slot)
        if intent:
            journal.append('intent', {'operation_id': slot, 'request_digest': digest(op)})
        if receipt is not None:
            journal.append('progress', receipt)
        for _ in range(polls):
            journal.append('dispatch_poll_intent', {'operation_id': slot, 'at': stamp(2199)})
        resolver = Mock()
        resolver.resolve.return_value = op
        self.enterContext(patch('scripts.trial_provision.cli.verify_owner_file'))
        self.enterContext(patch.object(Path, 'read_bytes', return_value=encoded({'sources': self.data['config']['sources']})))
        self.enterContext(patch('scripts.trial_provision.cli.private_bytes', return_value=encoded(self.data['manifest'])))
        self.enterContext(patch('scripts.trial_provision.cli.git', return_value=('a' * 40).encode()))
        self.enterContext(patch('scripts.trial_provision.cli.local_sources', return_value=self.data['config']['code_sources']))
        self.enterContext(patch('scripts.trial_provision.configuration.load_configuration', return_value=config))
        opened = self.enterContext(patch('scripts.trial_provision.journal.Journal'))
        opened.return_value.__enter__.return_value = journal
        self.enterContext(patch('scripts.trial_provision.operations.create_resolver', return_value=resolver))
        return journal, config, opened

    def test_json_cannot_replace_sealed_verified_attempt(self):
        for value in ({'verified': True}, self.data['authority'], True, None):
            with self.subTest(value=type(value).__name__), self.assertRaises(Denied):
                ApprovedAttemptSession(value, self.clock)

    def test_publication_provision_and_execute_share_same_pool_and_trusted_authority(self):
        request = {'config': '/fictional/config.json', 'action': 'status'}
        before = deepcopy(request)
        with patch('scripts.trial_provision.registry_publish_cli.run_command', return_value={'status': 'publication'}) as publication, \
                patch('scripts.trial_provision.cli.run_command', return_value={'status': 'provision'}) as provision, \
                patch('scripts.trial_guard.execution.execute', return_value={'status': 'executed'}) as execute:
            self.session.dispatch('publication', request)
            self.session.dispatch('provision', request)
            self.session.execute(request)
            for command in (publication, provision, execute):
                self.assertIs(command.call_args.kwargs['owner_token_pool'], self.session.pool)
                self.assertIs(command.call_args.kwargs['clock'], self.clock)
                self.assertIsNot(command.call_args.args[0], request)
            for command in (publication, provision):
                self.assertEqual(command.call_args.kwargs['trusted_attempt_authority'], self.session.authority_sha256)
            self.assertIs(execute.call_args.kwargs['verified_attempt'], self.verified)
        self.assertEqual(request, before)

    def test_closed_session_cannot_dispatch_execute_or_reuse_pool(self):
        self.session.close()
        with patch('scripts.trial_provision.cli.run_command') as provision:
            for action in (lambda: self.session.dispatch('provision', {}), lambda: self.session.execute({}),
                    lambda: self.session.run_group('/fictional', 'foundation')):
                with self.assertRaises(Denied):
                    action()
            provision.assert_not_called()
        self.assertTrue(self.session.pool._closed)

    def test_foundation_is_exact_32_non_graph_slots_and_never_runs_owner_or_auth(self):
        expected = ('webIdentity','workerIdentity','originals','artifacts','budget','journal',
            'C1','C2','C3','C4','C5','C6','C7','guard','G1','G2','G3','G4','G5','G6',
            'R1','R2','R3','R4','R5','R6','R7','R8','R9','job','R10','app')
        self.assertEqual(FOUNDATION, expected)
        self.assertEqual(len(set(FOUNDATION)), 32)
        seen = set()
        def state(path, slot):
            if slot in seen:
                return 'complete', self.operation(slot), None
            seen.add(slot)
            return 'create', self.operation(slot), None
        with patch.object(self.session, '_state', side_effect=state), patch.object(self.session, 'dispatch') as dispatch:
            result = self.session.run_group('/fictional', 'foundation', sleep=Mock(side_effect=AssertionError('sleep')))
        self.assertEqual(result['completed'], list(expected))
        self.assertFalse(result['automatic_write_retry'])
        self.assertEqual([c.args[1]['operation_id'] for c in dispatch.call_args_list], list(expected))
        self.assertTrue(all(c.args[1]['action'] == 'create' for c in dispatch.call_args_list))
        self.assertEqual(GROUPS['owner-input'], ('O1','O2','E1','E2','E3'))
        self.assertEqual(GROUPS['owner-auth'], ('E4','auth-platform-secret','auth-config','auth-ingress'))

    def test_main_and_runtime_updates_use_exact_original_creation_ids(self):
        for group, expected in (('main-configuration', {'guardMainConfiguration': 'guard'}),
                ('runtime', {'jobRuntime': 'job', 'appRuntime': 'app'})):
            self.clock.seconds = 2200 if group == 'main-configuration' else 5000
            seen = set()
            def state(path, slot):
                result = 'complete' if slot in seen else 'create'
                seen.add(slot)
                return result, self.operation(slot), None
            with self.subTest(group=group), patch.object(self.session, '_state', side_effect=state), patch.object(self.session, 'dispatch') as dispatch:
                self.session.run_group('/fictional', group)
                self.assertEqual([(c.args[1]['operation_id'], c.args[1]['creation_id']) for c in dispatch.call_args_list], list(expected.items()))
                self.assertTrue(all(c.args[1]['action'] == 'update' for c in dispatch.call_args_list))

    def test_unknown_create_is_never_resent_even_if_next_state_still_says_create(self):
        with patch.object(self.session, '_state', return_value=('create', self.operation(), None)), \
                patch.object(self.session, 'dispatch', return_value={'status': 'unknown'}) as dispatch:
            with self.assertRaises(Denied):
                self.session.run_group('/fictional', 'foundation')
            dispatch.assert_called_once()

    def test_e4_callback_secret_is_completed_before_auth_group_advances(self):
        self.clock.seconds = 5000
        complete = set()
        def state(path, slot):
            return ('complete' if slot in complete else 'create'), self.operation(slot), None
        def dispatch(kind, request):
            slot = request['operation_id']
            complete.add(slot)
            if slot == 'E4':
                # Controller.create(addPassword) delivers its one secret in memory.
                complete.add('auth-platform-secret')
        with patch.object(self.session, '_state', side_effect=state), patch.object(self.session, 'dispatch', side_effect=dispatch) as sent:
            result = self.session.run_group('/fictional', 'owner-auth')
        self.assertEqual(result['completed'], list(GROUPS['owner-auth']))
        self.assertEqual([c.args[1]['operation_id'] for c in sent.call_args_list], ['E4', 'auth-config', 'auth-ingress'])

    def test_existing_unknown_intent_without_ack_denied_before_reconcile(self):
        journal, _, _ = self.state_environment(intent=True)
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', 'webIdentity')
        self.assertFalse(journal.values('dispatch_poll_intent'))

    def test_reconcile_requires_known_progress_and_has_durable_35_poll_limit(self):
        op = self.operation()
        receipt = {'operation_id': op['id'], 'request_digest': digest(op), 'state': 'pending',
            'terminal': False, 'write_terminal': True}
        journal, _, opened = self.state_environment(intent=True, receipt=receipt, polls=34)
        state, _, _ = self.session._state('/fictional/config.json', op['id'])
        self.assertEqual(state, 'reconcile')
        self.assertEqual(len(journal.values('dispatch_poll_intent')), 35)
        self.assertTrue(opened.call_args.kwargs['require_existing'])
        self.assertEqual(opened.call_args.kwargs['name'], 'trial-provision-next')
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', op['id'])
        self.assertEqual(len(journal.values('dispatch_poll_intent')), 35)

    def test_terminal_failed_or_wrong_digest_is_not_treated_as_complete(self):
        op = self.operation()
        receipt = {'operation_id': op['id'], 'request_digest': digest(op), 'state': 'failed', 'terminal': True,
            'write_terminal': True, 'readback_verified': True, 'created_by_run': True}
        journal, _, _ = self.state_environment(intent=True, receipt=receipt)
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', op['id'])
        journal.records[-1]['value'].update(state='succeeded', request_digest='0' * 64)
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', op['id'])

    def test_unattempted_platform_secret_is_not_generated_by_generic_group(self):
        self.state_environment('auth-platform-secret')
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', 'auth-platform-secret')

    def test_loaded_attempt_must_match_session_and_be_live(self):
        _, config, _ = self.state_environment()
        config['live'] = False
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', 'webIdentity')
        config['live'] = True
        changed = fixture()
        changed['authority']['attempt_id'] = 'another-fictional-attempt'
        changed['activation']['attempt_id'] = changed['authority']['attempt_id']
        config['verified_attempt'] = verify(changed)
        with self.assertRaises(Denied):
            self.session._state('/fictional/config.json', 'webIdentity')

    def test_expired_or_wrong_phase_window_never_reads_state_or_dispatches(self):
        for group, seconds in (('foundation', 2099), ('foundation', 4800), ('owner-input', 4799), ('owner-input', 8400)):
            self.clock.seconds = seconds
            with self.subTest(group=group, seconds=seconds), patch.object(self.session, '_state') as state, \
                    patch.object(self.session, 'dispatch') as dispatch:
                with self.assertRaises(Denied):
                    self.session.run_group('/fictional', group)
                state.assert_not_called()
                dispatch.assert_not_called()

    def test_no_reconcile_send_after_sleep_crosses_foundation_or_owner_cutoff(self):
        for group, seconds in (('foundation', 4799), ('owner-input', 8399)):
            self.clock.seconds = seconds
            with self.subTest(group=group), patch.object(self.session, '_state', return_value=('reconcile', self.operation(), {})), \
                    patch.object(self.session, 'dispatch') as dispatch:
                with self.assertRaises(Denied):
                    self.session.run_group('/fictional', group, sleep=self.clock.advance)
                dispatch.assert_not_called()

    def test_no_create_send_after_local_state_validation_crosses_cutoff(self):
        self.clock.seconds = 4799
        def state(path, slot):
            self.clock.advance(2)
            return 'create', self.operation(slot), None
        with patch.object(self.session, '_state', side_effect=state), patch.object(self.session, 'dispatch') as dispatch:
            with self.assertRaises(Denied):
                self.session.run_group('/fictional', 'foundation')
            dispatch.assert_not_called()

    def test_unknown_group_or_dispatch_kind_has_no_adapter_call(self):
        with patch('scripts.trial_provision.cli.run_command') as dispatch:
            with self.assertRaises(Denied):
                self.session.dispatch('cleanup', {})
            with self.assertRaises(Denied):
                self.session.run_group('/fictional', 'arbitrary')
            dispatch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
