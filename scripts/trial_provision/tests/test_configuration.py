"""Only fictional local files and injected ACL verification; no credential I/O."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.trial_guard.adapters import digest
from scripts.trial_provision.configuration import (
    AUTH_END, FORMAL_END, SOURCE_FILES, ConfigurationError,
    load_configuration, require_execution_window,
)
from scripts.trial_provision.tests.test_plan import fixture, guid


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.manifest, sources, bindings = fixture()
        self.head = 'a' * 40
        self.now = '2026-10-11T01:00:00Z'
        self.context = {'mode': 'AzureCliCredential', 'tenant_id': guid(3), 'principal_id': guid(2)}
        self.acl_calls = []
        self.config = {
            'schema': 1,
            'sources': {slot: self.write(SOURCE_FILES[slot], raw) for slot, raw in sources.items()},
            'frozen_head': self.head,
            'ci': self.write('ci.local.json', {
                'head_sha': self.head, 'status': 'completed', 'conclusion': 'success',
                'required_checks': [{'name': name, 'status': 'completed', 'conclusion': 'success'}
                                    for name in ('ci', 'isolated-pg16')],
                'source_url': 'https://github.com/hirokiriko/patentai-mini/actions/runs/123',
                'checked_at': '2026-10-11T00:59:00Z'}),
            'plan_bindings': {k: bindings[k] for k in ('guardian_window', 'owner_window')},
            'resource_bindings': {'deadline': self.now, 'guardian_deadline': '2026-10-11T09:00:00Z',
                                  'runtime_image': 'fixture', 'guardian_image': 'fixture',
                                  'db_secret_digests': {'web': 'b' * 64, 'worker': 'c' * 64},
                                  'code_sha': self.head},
            'recovery': {'directory': str(self.root), 'directory_digest': digest(str(self.root))},
            'control_budget': {'directory': str(self.root), 'directory_digest': digest(str(self.root)),
                'binding': {'manifest_sha256': hashlib.sha256(sources['manifest']).hexdigest(),
                            'owner_id': guid(2), 'task_id': 'fictional-task', 'source_sha256': 'd' * 64},
                'seed': {'owner_arm': 128, 'owner_control_blob': 32, 'heartbeat_blob': 0}},
            'runtime_deadline': FORMAL_END, 'auth_deadline': AUTH_END,
            'cleanup_deadlines': {'guardian': '2026-10-11T09:00:00Z', 'owner_input': '2026-10-11T03:00:00Z',
                                  'runtime': FORMAL_END, 'auth': AUTH_END},
            'policy_verifier_node': self.write('fictional-node', b'not executable')['path'],
        }
        self.path = self.root / 'configuration.local.json'

    def write(self, name, value):
        raw = value if isinstance(value, bytes) else json.dumps(value).encode()
        path = self.root / name
        path.write_bytes(raw)
        return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}

    def load(self, **kwargs):
        self.path.write_text(json.dumps(self.config), encoding='utf-8')
        args = dict(now=self.now, local_head=self.head, owner_context=self.context,
                    acl_check=lambda path: self.acl_calls.append(path))
        args.update(kwargs)
        return load_configuration(self.path, **args)

    def test_loads_raw_sources_and_defaults_to_no_send(self):
        result = self.load()
        self.assertFalse(result['live'])
        self.assertEqual(set(result['authority_bundle']), set(SOURCE_FILES))
        self.assertEqual(result['manifest'], self.manifest)
        self.assertTrue(result['gates']['ci_passed'])
        self.assertEqual(len(self.acl_calls), 16)  # configuration + six sources + CI; twice each

    def test_refuses_permissive_private_file_before_body_read(self):
        def fail(_): raise OSError('fictional private value must not leak')
        with self.assertRaisesRegex(ConfigurationError, '^config_private_file$'):
            self.load(acl_check=fail)

    def test_wrong_head_and_cross_owner_rejected(self):
        with self.assertRaisesRegex(ConfigurationError, 'config_head'):
            self.load(local_head='b' * 40)
        self.context['principal_id'] = guid(888)
        with self.assertRaisesRegex(ConfigurationError, 'config_owner'):
            self.load()

    def test_alternate_credential_mode_rejected(self):
        self.context['mode'] = 'ManagedIdentityCredential'
        with self.assertRaisesRegex(ConfigurationError, 'config_owner'):
            self.load()

    def test_source_hash_changed_and_source_name_mismatch_rejected(self):
        Path(self.config['sources']['latest']['path']).write_bytes(b'{}')
        with self.assertRaisesRegex(ConfigurationError, 'config_source_changed'):
            self.load()
        self.config['sources']['latest'] = self.write('alternate.json', b'{}')
        with self.assertRaisesRegex(ConfigurationError, 'config_source_name'):
            self.load()

    def test_source_chain_rejects_even_updated_untrusted_ref_hash(self):
        latest = json.loads(Path(self.config['sources']['latest']['path']).read_bytes())
        latest['priorApprovalSha256'] = '0' * 64
        self.config['sources']['latest'] = self.write(SOURCE_FILES['latest'], latest)
        with self.assertRaisesRegex(ConfigurationError, 'config_authority_chain'):
            self.load()

    def test_exact_ci_checks_head_status_and_source(self):
        initial = json.loads(Path(self.config['ci']['path']).read_bytes())
        for field, value, code in [('head_sha', 'f' * 40, 'config_ci'),
                                    ('conclusion', 'failure', 'config_ci'),
                                    ('source_url', 'https://example.test', 'config_ci_source')]:
            bad = copy.deepcopy(initial)
            bad[field] = value
            self.config['ci'] = self.write('ci.local.json', bad)
            with self.subTest(field=field), self.assertRaisesRegex(ConfigurationError, code):
                self.load()
        initial['required_checks'][1]['name'] = 'ci'
        self.config['ci'] = self.write('ci.local.json', initial)
        with self.assertRaisesRegex(ConfigurationError, 'config_ci'):
            self.load()

    def test_seed_cannot_be_reset_and_directory_binding_cannot_move(self):
        self.config['control_budget']['seed']['owner_arm'] = 0
        with self.assertRaisesRegex(ConfigurationError, 'config_control_seed'):
            self.load()
        self.config['control_budget']['seed']['owner_arm'] = 128
        self.config['control_budget']['directory_digest'] = '0' * 64
        with self.assertRaisesRegex(ConfigurationError, 'config_directory'):
            self.load()

    def test_unknown_fields_and_non_boolean_live_rejected(self):
        self.config['alternate_owner'] = 'fictional'
        with self.assertRaisesRegex(ConfigurationError, 'config_fields'):
            self.load()
        del self.config['alternate_owner']
        self.config['live'] = 1
        with self.assertRaisesRegex(ConfigurationError, 'config_live'):
            self.load()

    def test_optional_secret_refs_are_not_read_or_created(self):
        path = self.root / 'not-created-until-bootstrap'
        self.config['secret_sources'] = {'trial-web-database': {'path': str(path), 'sha256': 'b' * 64}}
        self.load()
        self.assertFalse(path.exists())
        self.assertNotIn(path, self.acl_calls)

    def test_local_source_digest_must_match_all_pins(self):
        self.config['code_sources'] = {'scripts/trial_provision/plan.py': 'e' * 64}
        with self.assertRaisesRegex(ConfigurationError, 'config_code_changed'):
            self.load()
        result = self.load(local_source_digests=self.config['code_sources'])
        self.assertTrue(result['gates']['code_pins_checked'])

    def test_expired_config_loads_for_cleanup_but_never_unlocks_new_grant(self):
        config = self.load(now='2026-10-12T01:00:00Z')
        with self.assertRaisesRegex(ConfigurationError, 'operation_expired'):
            require_execution_window(config, {'id': 'G1', 'deadline': '2026-10-11T09:00:00Z'}, '2026-10-12T01:00:00Z')
        with self.assertRaisesRegex(ConfigurationError, 'cleanup_requires_exact_controller_route'):
            require_execution_window(config, {'id': 'cleanup_G1', 'deadline': '2026-10-11T09:00:00Z'}, self.now)

    def test_future_owner_window_is_not_early_permission(self):
        config = self.load()
        op = {'id': 'O1', 'deadline': '2026-10-11T03:00:00Z'}
        with self.assertRaisesRegex(ConfigurationError, 'operation_window'):
            require_execution_window(config, op, self.now)
        require_execution_window(config, op, '2026-10-11T02:30:00Z')

    def test_overlong_window_and_changed_cleanup_due_rejected(self):
        self.config['plan_bindings']['owner_window']['end'] = '2026-10-11T03:00:01Z'
        with self.assertRaisesRegex(ConfigurationError, 'config_window'):
            self.load()
        self.config['plan_bindings']['owner_window']['end'] = '2026-10-11T03:00:00Z'
        self.config['cleanup_deadlines']['owner_input'] = '2026-10-11T04:00:00Z'
        with self.assertRaisesRegex(ConfigurationError, 'config_cleanup_due'):
            self.load()

    def test_live_configuration_cannot_omit_source_pins(self):
        self.config['live'] = True
        with self.assertRaisesRegex(ConfigurationError, 'config_live_code_pins'):
            self.load()

    def test_windows_absolute_drive_relative_and_stream_source_paths_rejected(self):
        for path in ('C:/outside.py', 'C:outside.py', 'scripts/file.py:alternate'):
            self.config['code_sources'] = {path: 'a' * 64}
            with self.subTest(path=path), self.assertRaisesRegex(ConfigurationError, 'config_code_sources'):
                self.load(local_source_digests=self.config['code_sources'])

    def test_delete_and_auth_cleanup_cannot_use_new_write_window_route(self):
        config = self.load()
        for fields in ({'method': 'DELETE'}, {'kind': 'cleanup:addPassword'},
                       {'expected': {'auth_action': 'cleanup:authPlatformSecret'}}):
            with self.subTest(fields=fields), self.assertRaisesRegex(ConfigurationError, 'cleanup_requires_exact_controller_route'):
                require_execution_window(config, {'id': 'guardCleanup', 'deadline': AUTH_END, **fields}, self.now)


if __name__ == '__main__':
    unittest.main()
