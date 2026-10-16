"""Fictional files only: pre-push config cannot invent image/plan digests."""
import copy
import hashlib
import json
from pathlib import Path
import unittest

from scripts.trial_provision.configuration import ConfigurationError
from scripts.trial_provision.publication_configuration import load_publication_configuration
from scripts.trial_provision.tests import test_configuration as fixtures


class PublicationConfigurationTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.ConfigurationTests('runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.config = fixture.config
        for key in ('plan_bindings', 'resource_bindings', 'runtime_deadline', 'auth_deadline',
                    'cleanup_deadlines', 'policy_verifier_node'):
            self.config.pop(key)
        executable = fixture.write('docker.exe', b'fictional never executed')
        self.code_sources = {'scripts/trial_provision/publication_configuration.py': 'e' * 64}
        self.config['code_sources'] = self.code_sources
        self.config['publication'] = {
            'publish_until': '2026-10-11T02:00:00Z',
            'slots': {slot: {'docker_path': executable['path'], 'docker_sha256': executable['sha256'],
                'docker_host': 'npipe:////./pipe/dockerDesktopLinuxEngine', 'local_image_id': 'sha256:' + value * 64,
                'build_receipt': fixture.write(slot + '-build.local.json', {'schema': 1, 'image_id': 'sha256:' + value * 64})}
                for slot, value in (('guardian', 'a'), ('runtime', 'b'))}}

    def load(self, **kwargs):
        fixture = self.fixture
        fixture.path.write_text(json.dumps(self.config), encoding='utf-8')
        args = dict(now=fixture.now, local_head=fixture.head, owner_context=fixture.context,
                    local_source_digests=self.code_sources, acl_check=lambda _: None)
        args.update(kwargs)
        return load_publication_configuration(fixture.path, **args)

    def test_no_auth_prepare_inputs_do_not_need_registry_or_resource_digests(self):
        result = self.load()
        self.assertFalse(result['live'])
        self.assertNotIn('resource_bindings', result)
        self.assertNotIn('plan_bindings', result)
        self.assertEqual(set(result['build_receipts']), {'guardian', 'runtime'})
        self.assertTrue(result['gates']['publication_window_open'])
        self.assertTrue(result['gates']['code_pins_checked'])
        self.assertFalse((self.fixture.root / 'trial-control-budget.jsonl').exists())

    def test_normal_plan_or_manifest_digest_cannot_be_faked_into_preplan(self):
        self.config['resource_bindings'] = {'runtime_image': 'sha256:' + '0' * 64}
        with self.assertRaisesRegex(ConfigurationError, 'config_fields'):
            self.load()
        del self.config['resource_bindings']
        self.config['publication']['slots']['guardian']['registry_manifest_digest'] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(ConfigurationError, 'config_fields'):
            self.load()

    def test_source_pins_required_even_for_prepare(self):
        self.config['code_sources'] = {}
        with self.assertRaisesRegex(ConfigurationError, 'publication_source_pins'):
            self.load(local_source_digests={})
        self.config.pop('code_sources')
        with self.assertRaisesRegex(ConfigurationError, 'config_fields'):
            self.load()

    def test_shared_owner_head_and_exact_ci_gates_still_apply(self):
        with self.assertRaisesRegex(ConfigurationError, 'config_head'):
            self.load(local_head='f' * 40)
        context = {**self.fixture.context, 'mode': 'ManagedIdentityCredential'}
        with self.assertRaisesRegex(ConfigurationError, 'config_owner'):
            self.load(owner_context=context)
        ci = json.loads(Path(self.config['ci']['path']).read_bytes())
        ci['required_checks'][1]['conclusion'] = 'failure'
        self.config['ci'] = self.fixture.write('ci.local.json', ci)
        with self.assertRaisesRegex(ConfigurationError, 'config_ci'):
            self.load()

    def test_same_existing_seed_and_directory_binding_are_required(self):
        self.config['control_budget']['seed']['owner_arm'] = 0
        with self.assertRaisesRegex(ConfigurationError, 'config_control_seed'):
            self.load()

    def test_docker_bytes_are_rehashed_without_execution(self):
        path = Path(self.config['publication']['slots']['guardian']['docker_path'])
        path.write_bytes(b'changed binary')
        with self.assertRaisesRegex(ConfigurationError, 'publication_docker_changed'):
            self.load()

    def test_only_two_known_local_pipes_and_one_fixed_docker_are_allowed(self):
        for host in ('tcp://127.0.0.1:2375', 'npipe:////./pipe/unapproved', ['invalid']):
            self.config['publication']['slots']['guardian']['docker_host'] = host
            with self.subTest(host=host), self.assertRaisesRegex(ConfigurationError, 'publication_docker_host'):
                self.load()
        for slot in ('guardian', 'runtime'):
            self.config['publication']['slots'][slot]['docker_host'] = 'npipe:////./pipe/docker_engine'
        self.load()
        self.config['publication']['slots']['runtime']['docker_host'] = 'npipe:////./pipe/dockerDesktopLinuxEngine'
        with self.assertRaisesRegex(ConfigurationError, 'publication_docker_binding'):
            self.load()

    def test_exact_two_slots_and_image_id_shape(self):
        self.config['publication']['slots']['extra'] = copy.deepcopy(self.config['publication']['slots']['guardian'])
        with self.assertRaisesRegex(ConfigurationError, 'config_fields'):
            self.load()
        del self.config['publication']['slots']['extra']
        self.config['publication']['slots']['guardian']['local_image_id'] = 'latest'
        with self.assertRaisesRegex(ConfigurationError, 'publication_local_image'):
            self.load()

    def test_duplicate_local_image_ids_are_not_unapproved_extra_constraint(self):
        self.config['publication']['slots']['runtime']['local_image_id'] = self.config['publication']['slots']['guardian']['local_image_id']
        self.load()  # Publisher still checks each build proof against its exact slot.

    def test_protected_build_receipt_hash_is_checked(self):
        ref = self.config['publication']['slots']['guardian']['build_receipt']
        Path(ref['path']).write_bytes(b'{}')
        with self.assertRaisesRegex(ConfigurationError, 'config_source_changed'):
            self.load()

    def test_expired_preparation_can_be_read_but_is_not_publication_permission(self):
        result = self.load(now='2026-10-12T00:00:00Z')
        self.assertFalse(result['gates']['publication_window_open'])
        self.config['publication']['publish_until'] = '2026-11-01T00:00:00Z'
        with self.assertRaisesRegex(ConfigurationError, 'publication_deadline'):
            self.load()

    def test_raw_configuration_hash_pins_preparation_inputs(self):
        result = self.load()
        self.assertEqual(result['config_sha256'], hashlib.sha256(self.fixture.path.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
