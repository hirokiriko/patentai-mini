"""Real private journals and fictional files; no Git, auth or external calls."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import cli
from scripts.trial_provision.configuration import SOURCE_FILES, ConfigurationError
from scripts.trial_provision.private_io import create_owner_file
from scripts.trial_provision.journal import Journal
from scripts.trial_provision.plan import materialize_operation
from scripts.trial_provision.tests.test_operations import fixture

LOCAL_SOURCES = cli.local_sources


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        core, manifest, authority, resource = fixture()
        self.head = resource['code_sha']
        self.sources = {'scripts/trial_provision/cli.py': 'f' * 64}
        self.clock = Mock()
        self.clock.utc.return_value = parse('2026-10-11T01:00:00Z')
        self.clock.monotonic.return_value = 1.0
        self.config = {
            'schema': 1, 'live': False,
            'sources': {k: self.write(SOURCE_FILES[k], v) for k, v in authority.items()},
            'frozen_head': self.head,
            'ci': self.write('ci.local.json', {
                'head_sha': self.head, 'status': 'completed', 'conclusion': 'success',
                'required_checks': [{'name': name, 'status': 'completed', 'conclusion': 'success'}
                                    for name in ('ci', 'isolated-pg16')],
                'source_url': 'https://github.com/hirokiriko/patentai-mini/actions/runs/123',
                'checked_at': '2026-10-11T00:59:00Z'}),
            'plan_bindings': {'guardian_window': core['windows']['guardian'], 'owner_window': core['windows']['owner_input']},
            'resource_bindings': resource,
            'recovery': {'directory': str(self.root), 'directory_digest': digest(str(self.root))},
            'control_budget': {'directory': str(self.root), 'directory_digest': digest(str(self.root)),
                'binding': {'manifest_sha256': hashlib.sha256(authority['manifest']).hexdigest(),
                            'owner_id': manifest['owner']['principal_id'], 'task_id': 'fictional-task', 'source_sha256': 'd' * 64},
                'seed': {'owner_arm': 128, 'owner_control_blob': 32, 'heartbeat_blob': 0}},
            'runtime_deadline': '2026-10-31T00:00:00Z', 'auth_deadline': '2027-01-29T00:00:00Z',
            'cleanup_deadlines': {'guardian': core['windows']['guardian']['end'],
                                  'owner_input': core['windows']['owner_input']['end'],
                                  'runtime': '2026-10-31T00:00:00Z', 'auth': '2027-01-29T00:00:00Z'},
            'policy_verifier_node': self.write('node.exe', b'fictional never executed')['path'],
            'code_sources': self.sources,
        }
        self.config_path = self.root / 'configuration.local.json'
        stack = self.enterContext(ExitStack())
        self.git = stack.enter_context(patch.object(cli, 'git', return_value=(self.head + '\n').encode()))
        self.local = stack.enter_context(patch.object(cli, 'local_sources', return_value=self.sources))
        self.credential = stack.enter_context(patch.object(cli, 'AzureCredential', side_effect=AssertionError('credential_called')))
        self.http = stack.enter_context(patch.object(cli, 'BoundedHttp', side_effect=AssertionError('network_created')))
        self.graph = stack.enter_context(patch.object(cli, 'GraphAdapter', side_effect=AssertionError('graph_created')))
        self.auth = stack.enter_context(patch.object(cli, 'EasyAuthAdapter', side_effect=AssertionError('auth_created')))
        self.wire = Mock(side_effect=AssertionError('wire_called'))

    def write(self, name, value):
        raw = value if isinstance(value, bytes) else json.dumps(value).encode()
        path = self.root / name
        if not path.exists():
            fd = create_owner_file(path)
            os.close(fd)
        path.write_bytes(raw)
        return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}

    def run_action(self, action='prepare', **extra):
        self.write(self.config_path.name, self.config)
        return cli.run_command({'config': str(self.config_path), 'action': action, **extra},
                               clock=self.clock, wire=self.wire)

    def assert_no_auth(self):
        for mock in (self.credential, self.http, self.graph, self.auth, self.wire):
            mock.assert_not_called()

    def rows(self):
        return [json.loads(line) for line in (self.root / 'trial-provision.jsonl').read_text().splitlines()]

    def test_prepare_uses_real_private_journal_without_auth_or_cloud(self):
        result = self.run_action()
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(result['cloud_calls'], 0)
        self.assertEqual(result['control_requests_used'], 128)
        self.assertEqual(result['attempts'], 0)
        self.assertEqual(len([r for r in self.rows() if r['event'] == 'allocation']), 14)
        self.assertEqual(len([r for r in self.rows() if r['event'] == 'core_plan']), 1)
        self.assert_no_auth()

    def test_restart_reuses_exact_frozen_plan_and_allocations(self):
        self.run_action()
        before = (self.root / 'trial-provision.jsonl').read_bytes()
        self.clock.utc.return_value = parse('2026-10-11T01:01:00Z')
        result = self.run_action()
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual((self.root / 'trial-provision.jsonl').read_bytes(), before)
        self.assertEqual(self.run_action('status')['unresolved'], 0)
        self.assert_no_auth()

    def test_invalid_configuration_rejected_before_journal_or_auth(self):
        self.config['frozen_head'] = '1' * 40
        with self.assertRaisesRegex(ConfigurationError, 'config_head'):
            self.run_action()
        self.assertFalse((self.root / 'trial-provision.jsonl').exists())
        self.assert_no_auth()

    def test_live_action_requires_explicit_live_flag_before_auth(self):
        with self.assertRaisesRegex(Denied, 'live_not_enabled'):
            self.run_action('create', operation_id='webIdentity')
        self.assert_no_auth()

    def test_failed_exact_head_ci_is_not_live_permission(self):
        self.config['live'] = True
        receipt = json.loads(Path(self.config['ci']['path']).read_bytes())
        receipt['head_sha'] = '2' * 40
        self.config['ci'] = self.write('ci.local.json', receipt)
        with self.assertRaisesRegex(ConfigurationError, 'config_ci'):
            self.run_action('create', operation_id='webIdentity')
        self.assert_no_auth()

    def test_runtime_binding_requires_final_prerequisites_without_auth(self):
        self.run_action()
        policy = {'startsAt': '2026-10-11T02:00:00Z', 'endsAt': '2026-10-11T02:30:00Z'}
        ref = self.write('runtime.local.json', {'TRIAL_POLICY_JSON': json.dumps(policy),
            'TRIAL_POLICY_SIGNATURE': 'fictional', 'TRIAL_POLICY_PUBLIC_KEY': 'fictional'})
        with patch.object(cli, 'policy_verifier', return_value=lambda _: policy), self.assertRaisesRegex(Denied, 'runtime_binding'):
            self.run_action('bind-runtime', runtime_environment=ref)
        self.assertFalse(any(r['event'] == 'runtime_binding' for r in self.rows()))
        self.assert_no_auth()

    def test_fixed_source_pin_changes_block_live_before_auth(self):
        self.config['live'] = True
        self.local.return_value = {'scripts/trial_provision/cli.py': '0' * 64}
        with self.assertRaisesRegex(ConfigurationError, 'config_code_changed'):
            self.run_action('create', operation_id='webIdentity')
        self.assert_no_auth()

    def cleanup_fixture(self):
        self.run_action()
        rows = self.rows()
        core = next(row['value'] for row in rows if row['event'] == 'core_plan')
        initial = next(row['value'] for row in rows if row['event'] == 'plan')
        binding = rows[0]['value']
        op = materialize_operation(core, 'C1', {})
        receipt = {'operation_id': 'C1', 'request_digest': digest(op),
            'object_id': op['expected']['resource_id'], 'properties': {},
            'state': 'succeeded', 'terminal': True, 'write_terminal': True,
            'readback_verified': True, 'created_by_run': True}
        with Journal(str(self.root), digest(str(self.root)), binding, require_existing=True) as journal:
            journal.intent(op, '2026-10-11T01:00:00Z')
            journal.checkpoint(op, receipt)
        evidence = {'initial_plan_digest': digest(initial), 'deadline': op['cleanup']['deadline'],
                    'reference_evidence': {}}
        return self.write('cleanup-evidence.local.json', evidence)

    def test_bind_cleanup_uses_private_exact_evidence_without_send_even_after_due(self):
        ref = self.cleanup_fixture()
        self.clock.utc.return_value = parse('2026-10-12T01:00:00Z')
        result = self.run_action('bind-cleanup', operation_id='cleanup_C1', cleanup_evidence=ref)
        self.assertEqual(result, {'status': 'cleanup_bound', 'cloud_calls': 0})
        before = (self.root / 'trial-provision.jsonl').read_bytes()
        self.run_action('bind-cleanup', operation_id='cleanup_C1', cleanup_evidence=ref)
        self.assertEqual((self.root / 'trial-provision.jsonl').read_bytes(), before)
        self.assertEqual(len([r for r in self.rows() if r['event'] == 'cleanup_binding']), 1)
        self.assertEqual(self.run_action('status')['attempts'], 1)
        self.assert_no_auth()

    def test_cleanup_binding_ref_hash_or_due_change_is_rejected_without_persistence(self):
        ref = self.cleanup_fixture()
        data = json.loads(Path(ref['path']).read_bytes())
        data['deadline'] = '2027-01-29T00:00:00Z'
        changed = self.write('cleanup-evidence.local.json', data)
        with self.assertRaisesRegex(Denied, 'private_source_changed'):
            self.run_action('bind-cleanup', operation_id='cleanup_C1', cleanup_evidence=ref)
        with self.assertRaises((Denied, ValueError)):
            self.run_action('bind-cleanup', operation_id='cleanup_C1', cleanup_evidence=changed)
        self.assertFalse(any(r['event'] == 'cleanup_binding' for r in self.rows()))
        self.assert_no_auth()

    def test_untracked_dependency_gate_stops_live_before_credentials(self):
        self.config['live'] = True
        self.local.side_effect = Denied('source_not_committed')
        with self.assertRaisesRegex(Denied, 'source_not_committed'):
            self.run_action('create', operation_id='webIdentity')
        self.assert_no_auth()

    def test_rehearsal_routes_require_explicit_live_flag_without_auth(self):
        for action in ('rehearsal-start', 'rehearsal-poll', 'rehearsal-seed', 'rehearsal-verify'):
            with self.subTest(action=action), self.assertRaisesRegex(Denied, 'live_not_enabled'):
                self.run_action(action)
        self.assert_no_auth()

    def test_bootstrap_binding_routes_verified_private_input_without_credentials(self):
        self.run_action()
        bundle = {'schema': 1, 'execution_config': {'fictional': 'validation-is-owned-by-bridge'}}
        ref = self.write('bootstrap.local.json', bundle)
        result = {'status': 'bootstrap_bound', 'bootstrapBound': True, 'cloud_calls': 0}
        with patch('scripts.trial_provision.bootstrap.bind_bootstrap', return_value=result) as bridge:
            self.assertEqual(self.run_action('bind-bootstrap', bootstrap_config=ref), result)
            self.assertEqual(bridge.call_args.args[0], bundle)
            self.assertIsInstance(bridge.call_args.args[1], Journal)
        self.assert_no_auth()

    def test_bootstrap_binding_rejects_changed_private_bundle_before_bridge(self):
        self.run_action()
        ref = self.write('bootstrap.local.json', {'schema': 1})
        self.write('bootstrap.local.json', {'schema': 2})
        with patch('scripts.trial_provision.bootstrap.bind_bootstrap') as bridge:
            with self.assertRaisesRegex(Denied, 'private_source_changed'):
                self.run_action('bind-bootstrap', bootstrap_config=ref)
            bridge.assert_not_called()
        self.assert_no_auth()

    def test_registry_cleanup_requires_explicit_live_before_credentials(self):
        with self.assertRaisesRegex(Denied, 'live_not_enabled'):
            self.run_action('registry-cleanup')
        self.assert_no_auth()

    def test_graph_adapter_is_not_built_without_final_app_dependencies(self):
        self.run_action()
        self.config['live'] = True
        self.credential.side_effect = None  # Construct metadata holder only; token must never be requested.
        self.credential.return_value = Mock()
        with patch.object(cli, 'BoundedArmProvider'), self.assertRaisesRegex(Denied, 'operation_resolution'):
            self.run_action('create', operation_id='E1')
        self.credential.return_value.token.assert_not_called()
        self.graph.assert_not_called()
        self.auth.assert_not_called()
        self.wire.assert_not_called()
        self.assertFalse(any(r['event'] == 'intent' for r in self.rows()))

    def test_unrelated_iam_operation_does_not_construct_graph_adapter(self):
        self.run_action()
        self.config['live'] = True
        self.credential.side_effect = None
        self.credential.return_value = Mock()
        provider = Mock()
        provider.readback.side_effect = Denied('fictional_preflight_stop')
        with patch.object(cli, 'BoundedArmProvider', return_value=provider), self.assertRaisesRegex(Denied, 'fictional_preflight_stop'):
            self.run_action('create', operation_id='C1')
        provider.readback.assert_called_once()
        provider.send.assert_not_called()
        self.credential.return_value.token.assert_not_called()
        self.graph.assert_not_called()
        self.auth.assert_not_called()
        self.wire.assert_not_called()


class LocalSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.names = sorted(cli.REQUIRED_SOURCES)
        self.current = b'fictional = True\r\n'
        self.committed = b'fictional = True\n'
        for relative in self.names:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.current)
        self.git = Mock(side_effect=self.git_output)
        self.enterContext(patch.object(cli, 'ROOT', self.root))
        self.enterContext(patch.object(cli, 'git', self.git))
        self.module_metadata = SimpleNamespace(modules={})
        self.enterContext(patch.object(cli, 'sys', self.module_metadata))

    def git_output(self, arguments, *, input=None):
        if arguments[0] == 'ls-files':
            return ('\n'.join(self.names) + '\n').encode()
        if arguments == ['cat-file','--batch']:
            self.assertEqual(input,''.join('a'*40+':'+name+'\n' for name in self.names).encode())
            blob=self.committed;size=str(len(blob)).encode();oid=hashlib.sha1(b'blob '+size+b'\0'+blob).hexdigest().encode()
            return (oid+b' blob '+size+b'\n'+blob+b'\n')*len(self.names)
        raise AssertionError('unexpected local Git operation')

    def test_crlf_is_canonical_for_head_comparison_but_raw_bytes_remain_pinned(self):
        hashes = LOCAL_SOURCES('a' * 40, live=True)
        self.assertEqual(set(hashes), cli.REQUIRED_SOURCES)
        self.assertEqual(set(hashes.values()), {hashlib.sha256(self.current).hexdigest()})
        self.assertNotEqual(hashlib.sha256(self.current).hexdigest(), hashlib.sha256(self.committed).hexdigest())
        self.assertEqual(self.git.call_count,2)

    def test_missing_nonblob_truncated_extra_or_changed_batch_is_refused(self):
        normal=self.git_output(['cat-file','--batch'],input=''.join('a'*40+':'+n+'\n' for n in self.names).encode())
        for raw in (b'fictional missing\n',normal.replace(b' blob ',b' tree ',1),normal[:-1],normal+b'extra',normal.replace(b'fictional',b'different',1)):
            with self.subTest(prefix=raw[:45]),patch.object(cli,'git',side_effect=[('\n'.join(self.names)+'\n').encode(),raw]):
                with self.assertRaisesRegex(Denied,'source_batch'):LOCAL_SOURCES('a'*40,live=True)

    def test_untracked_required_dependency_is_refused(self):
        self.names.remove('scripts/trial_provision/rehearsal_cli.py')
        with self.assertRaisesRegex(Denied, 'source_not_committed'):
            LOCAL_SOURCES('a' * 40, live=True)
        self.assertEqual(self.git.call_count, 1)

    def test_non_newline_difference_is_refused(self):
        (self.root / 'scripts/trial_provision/cli.py').write_bytes(b'changed = True\r\n')
        with self.assertRaisesRegex(Denied, 'source_not_committed'):
            LOCAL_SOURCES('a' * 40, live=True)

    def test_loaded_module_from_other_checkout_is_refused(self):
        self.module_metadata.modules['scripts.trial_provision.plan'] = SimpleNamespace(
            __file__=str(self.root / 'other-checkout' / 'plan.py'))
        with self.assertRaisesRegex(Denied, 'loaded_source_path'):
            LOCAL_SOURCES('a' * 40, live=True)

    def test_loaded_scripts_package_from_other_checkout_is_refused(self):
        self.module_metadata.modules['scripts'] = SimpleNamespace(
            __file__=str(self.root / 'other-checkout' / '__init__.py'))
        with self.assertRaisesRegex(Denied, 'loaded_source_path'):
            LOCAL_SOURCES('a' * 40, live=True)


if __name__ == '__main__':
    unittest.main()
