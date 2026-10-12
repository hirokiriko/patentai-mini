"""Offline publication -> real normal prepare contracts using fictional files.

Only Git/source observations and external adapters are injected. Both loaders,
both CLI entrypoints, private I/O, builders, resolver and locks are real.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
import uuid
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import cli, publication_bridge as bridge
from scripts.trial_provision import registry_publish_cli as publication_cli
from scripts.trial_provision.configuration import SOURCE_FILES, ConfigurationError
from scripts.trial_provision.controller import Controller
from scripts.trial_provision.journal import Journal, ControlBudget
from scripts.trial_provision.plan import PlanError, build_plan
from scripts.trial_provision.private_io import verify_owner_file
from scripts.trial_provision.publication_configuration import load_publication_configuration
from scripts.trial_provision.providers import BoundedArmProvider
from scripts.trial_provision.registry_publish import VERSION, verified_publication_images
from scripts.trial_provision.resources import build_resource_operations
from scripts.trial_provision.tests import test_cli as cli_fixtures
from scripts.trial_provision.tests.test_private_io import create_owner_directory


class PublicationBridgeTests(unittest.TestCase):
    def setUp(self):
        self.set_up_fixture()

    def set_up_fixture(self, *, tenant_id=None, live=True, region=None):
        fixture = cli_fixtures.CliTests('runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.root, self.clock = fixture.root, fixture.clock
        self.directory = self.root / 'recovery'
        create_owner_directory(self.directory)
        self.config = deepcopy(fixture.config)
        self.config['recovery'] = {'directory': str(self.directory),
                                   'directory_digest': digest(str(self.directory))}
        self.config['control_budget'].update(self.config['recovery'])
        self.code_sources = fixture.sources
        self.code_sources['scripts/trial_provision/publication_bridge.py'] = '7' * 64
        self.config['code_sources'] = self.code_sources
        self.manifest = json.loads(Path(self.config['sources']['manifest']['path']).read_bytes())
        self.manifest.update(cleanupImageTag='fictional-guardian', imageTag='fictional-runtime')
        if region is not None:
            self.manifest['region'] = region
        if tenant_id is not None:
            self.manifest['owner']['tenant_id'] = tenant_id
        self.rehash_authority()
        self.plan_bindings = {
            'guardian_window': {'start': '2026-10-11T01:00:00Z', 'end': '2026-10-11T01:30:00Z'},
            'owner_window': {'start': '2026-10-11T01:01:00Z', 'end': '2026-10-11T01:20:00Z'},
        }
        node = self.config['policy_verifier_node']
        for key in ('plan_bindings', 'resource_bindings', 'runtime_deadline',
                    'auth_deadline', 'cleanup_deadlines', 'policy_verifier_node'):
            self.config.pop(key)
        # Keep the publication's approved switch; bridge itself only prepares.
        self.config['live'] = live
        executable = fixture.write('docker.exe', b'fictional never executed')
        self.config['publication'] = {'publish_until': '2026-10-11T01:10:00Z', 'slots': {}}
        for slot, repository, tag, image in (
                ('guardian', 'cleanupImageRepository', 'cleanupImageTag', 'a'),
                ('runtime', 'imageRepository', 'imageTag', 'b')):
            fixed = {'docker_path': executable['path'], 'docker_sha256': executable['sha256'],
                     'docker_host': 'npipe:////./pipe/dockerDesktopLinuxEngine',
                     'local_image_id': 'sha256:' + image * 64}
            proof = {'schema': 1, 'slot': slot,
                     'manifest_sha256': self.config['sources']['manifest']['sha256'],
                     'source_head': fixture.head, 'request_digest': 'c' * 64,
                     'method': 'docker-build', 'attempt': 1, 'exit_code': 0,
                     'docker_sha256': fixed['docker_sha256'], 'docker_host': fixed['docker_host'],
                     'image_ref': self.manifest['registry']['loginServer'] + '/' +
                                  self.manifest[repository] + ':' + self.manifest[tag],
                     'image_id': fixed['local_image_id'], 'readback_verified': True,
                     'managed_build_sha': fixture.head}
            fixed['build_receipt'] = fixture.write(slot + '-build.local.json', proof)
            self.config['publication']['slots'][slot] = fixed
        self.config_path = self.root / 'publication.local.json'
        self.save_config()
        self.inputs = {
            'schema': 1, 'publication_config_sha256': self.config_ref['sha256'],
            'plan_bindings': deepcopy(self.plan_bindings), 'deadline': '2026-10-11T01:15:00Z',
            # Deliberately absent: neither bridge nor prepare may read a secret.
            'secret_sources': {
                'trial-web-database': {'path': str(self.root / 'absent-web.secret'), 'sha256': 'c' * 64},
                'trial-worker-database': {'path': str(self.root / 'absent-worker.secret'), 'sha256': 'd' * 64},
            },
            'policy_verifier_node': node,
        }
        self.reference = fixture.write('bridge-input.local.json', self.inputs)
        self.git = self.enterContext(patch.object(publication_cli, 'git',
            return_value=(fixture.head + '\n').encode()))
        self.sources = self.enterContext(patch.object(publication_cli, 'local_sources',
            return_value=self.code_sources))
        self.credential = self.enterContext(patch.object(publication_cli, 'AzureCredential',
            side_effect=AssertionError('publication_auth_called')))
        self.http = self.enterContext(patch.object(publication_cli, 'BoundedHttp',
            side_effect=AssertionError('publication_http_created')))
        self.publisher = self.enterContext(patch.object(publication_cli, 'run_registry_publish',
            side_effect=AssertionError('publication_started')))
        self.wire = Mock(side_effect=AssertionError('network_called'))
        self.publish_action('prepare')
        self.seed_images()
        self.output = self.directory / bridge.OUTPUT_NAME

    def rehash_authority(self):
        values = {key: json.loads(Path(ref['path']).read_bytes())
                  for key, ref in self.config['sources'].items()}
        def save(key, value):
            self.config['sources'][key] = self.fixture.write(SOURCE_FILES[key], value)
            return self.config['sources'][key]['sha256']
        mh = save('manifest', self.manifest)
        values['annex']['fixedOwner'] = deepcopy(self.manifest['owner'])
        values['annex']['fixedManifestSha256'] = mh
        ah = save('annex', values['annex'])
        values['approval'].update(boundProposalSha256=ah, fixedManifestSha256=mh)
        ph = save('approval', values['approval'])
        values['latest'].update(priorApprovalSha256=ph, originalProposalSha256=ah, fixedManifestSha256=mh)
        save('latest', values['latest'])
        self.config['control_budget']['binding']['manifest_sha256'] = mh

    def save_config(self):
        self.config_ref = self.fixture.write(self.config_path.name, self.config)

    def publish_action(self, action, **extra):
        return publication_cli.run_command({'config': str(self.config_path), 'action': action, **extra},
                                           clock=self.clock, wire=self.wire)

    def bind(self, reference=None):
        return self.publish_action('bind-provision', provision=reference or self.reference)

    def journal(self):
        b = self.config['control_budget']['binding']
        return Journal(str(self.directory), digest(str(self.directory)),
                       {'manifest_sha256': self.config['sources']['manifest']['sha256'],
                        'owner_id': self.manifest['owner']['principal_id'], 'task_id': b['task_id']},
                       require_existing=True)

    def budget(self):
        b = self.config['control_budget']
        return ControlBudget(b['directory'], b['directory_digest'], b['binding'],
                             seed=b['seed'], require_existing=True)

    def publication(self):
        return load_publication_configuration(self.config_path, now=self.clock.utc(),
            local_head=self.fixture.head, owner_context={'mode': 'AzureCliCredential',
                'tenant_id': self.manifest['owner']['tenant_id'],
                'principal_id': self.manifest['owner']['principal_id']},
            local_source_digests=self.code_sources)

    def seed_images(self):
        """Seed authenticated absence + acknowledged/read-verified fake pushes."""
        with self.journal() as journal:
            prep = journal.values('publication_preparation')[0]
            self.images = {}
            for slot, value in (('guardian', '4'), ('runtime', '5')):
                fixed = prep['slots'][slot]
                ident = slot + 'ImagePush'
                host, repo = prep['login_server'], fixed['repository']
                prefix = 'https://' + host + '/v2/' + repo + '/manifests/'
                actual = 'sha256:' + value * 64
                op = {'id': ident, 'method': 'PUT',
                      'url': prefix + fixed['tag'] + '?api-version=' + VERSION,
                      'deadline': prep['publish_until']}
                journal.append(slot + '_image_namespace', {
                    'publication_preparation_digest': digest(prep),
                    'run_binding_digest': prep['run_binding_digest'],
                    'push_request_digest': digest(op), 'authenticated': True,
                    'http': 404, 'error_code': 'NAME_UNKNOWN', 'method': 'GET',
                    'push_operation_id': ident, 'registry_id': prep['registry_id'],
                    'login_server': host, 'repository': repo,
                    'url': 'https://' + host + '/acr/v1/' + repo + '?api-version=' + VERSION,
                    'response_sha256': '6' * 64, 'observed_at': '2026-10-11T01:00:00Z'})
                journal.intent(op, '2026-10-11T01:00:00Z')
                journal.checkpoint(op, {'operation_id': ident, 'request_digest': digest(op),
                    'object_id': prefix + actual + '?api-version=' + VERSION,
                    'state': 'succeeded', 'ack_kind': 'docker_exit0_digest',
                    'terminal': True, 'write_terminal': True, 'created_by_run': True,
                    'readback_verified': True, 'observed_at': '2026-10-11T01:00:01Z',
                    'properties': {'registry_id': prep['registry_id'], 'login_server': host,
                                   'repository': repo, 'manifest_digest': actual, 'purpose': slot}})
                self.images[slot + '_image'] = host + '/' + repo + '@' + actual
            self.assertEqual(self.images, verified_publication_images(journal))

    def values(self, event):
        with self.journal() as journal:
            return journal.values(event)

    def assert_no_external_calls(self):
        self.fixture.assert_no_auth()
        for mock in (self.credential, self.http, self.publisher, self.wire):
            mock.assert_not_called()

    def assert_prepared_once(self):
        for event in ('provision_bridge_intent', 'provision_bridge_output', 'provision_bridge_prepared',
                      'core_plan', 'plan', 'publication_import'):
            self.assertEqual(1, len(self.values(event)), event)
        with self.budget() as budget:
            self.assertEqual(128, budget.count('owner_arm'))
        self.assert_no_external_calls()

    def test_cli_calls_real_normal_prepare_after_releasing_both_locks(self):
        result = self.bind()
        self.assertEqual('provision_prepared', result['status'])
        self.assertEqual(0, result['cloud_calls'])
        self.assertFalse(result['replayed'])
        self.assertEqual(bridge.OUTPUT_NAME, result['config_file'])
        self.assertEqual(1, self.fixture.git.call_count)
        verify_owner_file(self.output)
        output = json.loads(self.output.read_bytes())
        self.assertIs(self.config['live'], output['live'])
        for key in ('sources', 'frozen_head', 'ci', 'recovery', 'control_budget', 'code_sources'):
            self.assertEqual(self.config[key], output[key], key)
        self.assertEqual(self.inputs['secret_sources'], output['secret_sources'])
        self.assertEqual(self.plan_bindings, output['plan_bindings'])
        self.assertEqual(self.inputs['deadline'], output['resource_bindings']['deadline'])
        self.assertEqual({'web': 'c' * 64, 'worker': 'd' * 64}, output['resource_bindings']['db_secret_digests'])
        for name, image in self.images.items():
            self.assertEqual(image, output['resource_bindings'][name])
        self.assertNotIn('publication', output)
        self.assert_prepared_once()

    def test_false_live_publication_remains_false_through_real_prepare(self):
        case = PublicationBridgeTests('runTest')
        self.addCleanup(case.doCleanups)
        case.set_up_fixture(live=False)
        result = case.bind()
        self.assertEqual('provision_prepared', result['status'])
        self.assertIs(False, json.loads(case.output.read_bytes())['live'])
        self.assertEqual(1, case.fixture.git.call_count)
        case.assert_prepared_once()

    def test_live_output_reaches_fixed_resource_create_with_real_provider_and_controller(self):
        self.bind()
        self.assertIs(cli.Controller, Controller)
        self.assertIs(cli.BoundedArmProvider, BoundedArmProvider)
        self.assertIs(True, json.loads(self.output.read_bytes())['live'])
        original_output = self.output.read_bytes()
        original_core = self.values('core_plan')
        original_plan = self.values('plan')
        original_bridge = self.values('provision_bridge_prepared')
        self.assertEqual(self.plan_bindings['guardian_window'], original_core[0]['windows']['guardian'])
        self.assertEqual(self.plan_bindings['owner_window'], original_core[0]['windows']['owner_input'])
        operation = original_plan[0]['operations']['webIdentity']
        self.assertEqual('webIdentity', operation['id'])
        self.assertEqual(self.inputs['deadline'], operation['deadline'])
        expected_id = self.manifest['ids']['webIdentity']
        expected_url = 'https://management.azure.com' + expected_id + '?api-version=2023-01-31'
        expected_body = {'location': 'japaneast'}
        self.assertEqual(expected_url, operation['url'])
        self.assertEqual(expected_body, operation['body'])
        self.clock.utc.return_value = parse('2026-10-11T01:02:00Z')
        projected = {'principalId': str(uuid.UUID(int=7100)),
                     'tenantId': self.manifest['owner']['tenant_id'],
                     'clientId': str(uuid.UUID(int=7101))}
        resource = {**expected_body, 'id': expected_id, 'properties': projected}
        responses = [
            {'status': 404, 'headers': {}, 'body': b''},
            {'status': 201, 'headers': {}, 'body': encoded(resource)},
            {'status': 200, 'headers': {}, 'body': encoded(resource)},
        ]
        calls = []
        def fake_wire(method, url, headers, body, deadline):
            # This function has no transport. Every request must target exactly
            # the first fixed identity; arbitrary URLs or extra calls fail.
            index = len(calls)
            self.assertLess(index, 3)
            self.assertEqual(('GET', 'PUT', 'GET')[index], method)
            self.assertEqual(expected_url, url)
            self.assertEqual(encoded(expected_body) if method == 'PUT' else None, body)
            self.assertEqual('Bearer fictional-offline-token', headers['Authorization'])
            deadline.remaining()
            calls.append((method, url, body))
            return responses[index]
        credential = Mock(mode='owner')
        def fake_token(audience, deadline):
            self.assertEqual('https://management.azure.com/', audience)
            deadline.remaining()
            return 'fictional-offline-token'
        credential.token.side_effect = fake_token
        self.fixture.credential.side_effect = None
        self.fixture.credential.return_value = credential
        result = cli.run_command({'action': 'create', 'config': str(self.output),
                                  'operation_id': 'webIdentity'}, clock=self.clock, wire=fake_wire)
        self.assertEqual('succeeded', result['status'])
        self.assertTrue(result['terminal'])
        self.assertEqual(0, result['unresolved'])
        self.assertEqual(131, result['control_requests_used'])
        self.assertEqual(['GET', 'PUT', 'GET'], [call[0] for call in calls])
        self.fixture.credential.assert_called_once()
        self.assertEqual(3, credential.token.call_count)
        with self.journal() as journal:
            receipt = journal.latest('webIdentity')
            intent = [value for value in journal.values('intent') if value['operation_id'] == 'webIdentity']
        self.assertEqual(1, len(intent))
        self.assertEqual(self.inputs['deadline'], intent[0]['deadline'])
        self.assertEqual(expected_url, intent[0]['url'])
        self.assertEqual(digest(operation), receipt['request_digest'])
        self.assertEqual(expected_id, receipt['object_id'])
        self.assertEqual(projected, receipt['properties'])
        self.assertEqual('succeeded', receipt['state'])
        for field in ('terminal', 'write_terminal', 'readback_verified', 'created_by_run'):
            self.assertIs(True, receipt[field], field)
        with self.budget() as budget:
            self.assertEqual(131, budget.count('owner_arm'))
            self.assertEqual(32, budget.count('owner_control_blob'))
            self.assertEqual(0, budget.count('heartbeat_blob'))
            self.assertEqual(self.config['control_budget']['seed'], budget.seed)
        self.assertEqual(original_core, self.values('core_plan'))
        self.assertEqual(original_plan, self.values('plan'))
        self.assertEqual(original_bridge, self.values('provision_bridge_prepared'))
        self.assertEqual(original_output, self.output.read_bytes())
        for mock in (self.fixture.http, self.fixture.graph, self.fixture.auth, self.fixture.wire,
                     self.credential, self.http, self.publisher, self.wire):
            mock.assert_not_called()

    def test_finished_replay_does_not_call_normal_prepare_twice(self):
        first = self.bind()
        raw = self.output.read_bytes()
        rows = (self.directory / 'trial-provision.jsonl').read_bytes()
        repeated = self.bind()
        self.assertTrue(repeated['replayed'])
        self.assertEqual(first['config_sha256'], repeated['config_sha256'])
        self.assertEqual(1, self.fixture.git.call_count)
        self.assertEqual(raw, self.output.read_bytes())
        self.assertEqual(rows, (self.directory / 'trial-provision.jsonl').read_bytes())
        self.assert_prepared_once()

    def test_restart_after_output_before_normal_prepare_resumes_exact_output(self):
        publication = self.publication()
        with self.journal() as journal, self.budget():
            binding = bridge.prepare_bridge(publication, journal, self.reference, now=self.clock.utc())
        raw = self.output.read_bytes()
        self.assertEqual(binding['output']['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(1, len(self.values('core_plan')))
        self.assertFalse(self.values('plan'))
        self.assertEqual(0, self.fixture.git.call_count)
        self.bind()
        self.assertEqual(raw, self.output.read_bytes())
        self.assertEqual(1, self.fixture.git.call_count)
        self.assert_prepared_once()

    def test_clock_advancing_past_start_reuses_frozen_core_and_allocations(self):
        publication = self.publication()
        with self.journal() as journal, self.budget():
            bridge.prepare_bridge(publication, journal, self.reference, now=self.clock.utc())
        core = self.values('core_plan')
        allocations = self.values('allocation')
        raw = self.output.read_bytes()
        self.assertEqual(1, len(core))
        self.assertTrue(allocations)
        self.clock.utc.return_value = parse('2026-10-11T01:02:00Z')
        self.bind()
        self.assertEqual(core, self.values('core_plan'))
        self.assertEqual(allocations, self.values('allocation'))
        self.assertEqual(raw, self.output.read_bytes())
        self.assertEqual(1, self.fixture.git.call_count)
        self.assert_prepared_once()

    def test_restart_after_prepare_before_completion_preserves_plan_and_allocations(self):
        append = Journal.append
        def stop_before_completion(journal, event, value):
            if event == 'provision_bridge_prepared':
                raise OSError('fictional crash before completion record')
            return append(journal, event, value)
        with patch.object(Journal, 'append', new=stop_before_completion):
            with self.assertRaises(OSError):
                self.bind()
        plan, allocations = self.values('plan'), self.values('allocation')
        self.assertEqual(1, len(plan))
        self.assertFalse(self.values('provision_bridge_prepared'))
        self.bind()
        self.assertEqual(plan, self.values('plan'))
        self.assertEqual(allocations, self.values('allocation'))
        self.assert_prepared_once()

    def test_missing_receipt_ack_or_terminal_evidence_is_denied(self):
        mutations = ({'state': 'unknown'}, {'ack_kind': 'unknown'}, {'terminal': False},
                     {'write_terminal': False}, {'created_by_run': False}, {'readback_verified': False})
        with self.journal() as journal:
            valid = journal.latest('guardianImagePush')
        for change in mutations:
            with self.subTest(change=change):
                with self.journal() as journal:
                    journal.append('progress', {**valid, **change})
                with self.assertRaises(Denied):
                    self.bind()
                self.assertFalse(self.output.exists())
        self.assertFalse(self.values('provision_bridge_intent'))
        self.assertEqual(0, self.fixture.git.call_count)
        self.assert_no_external_calls()

    def test_unauthenticated_namespace_is_denied(self):
        with self.journal() as journal:
            extra = journal.values('guardian_image_namespace')[0]
            extra['authenticated'] = False
            journal.append('guardian_image_namespace', extra)
        with self.assertRaises(Denied):
            self.bind()
        self.assertFalse(self.output.exists())
        self.assert_no_external_calls()

    def test_changed_input_bytes_cannot_use_old_reference(self):
        Path(self.reference['path']).write_bytes(encoded({**self.inputs, 'deadline': '2026-10-11T01:16:00Z'}))
        with self.assertRaises(Denied):
            self.bind()
        self.assertFalse(self.output.exists())
        self.assertEqual(0, self.fixture.git.call_count)
        self.assert_no_external_calls()

    def test_input_schema_or_secret_alias_extension_is_denied(self):
        changes = [dict(self.inputs, unapproved=True), dict(self.inputs, schema=True),
                   dict(self.inputs, live=True), dict(self.inputs, live=False),
                   dict(self.inputs, publication_config_sha256='0' * 64),
                   dict(self.inputs, secret_sources={}),
                   dict(self.inputs, secret_sources={**self.inputs['secret_sources'],
                        'extra': self.inputs['secret_sources']['trial-web-database']})]
        missing = deepcopy(self.inputs)
        del missing['deadline']
        changes.append(missing)
        for index, inputs in enumerate(changes):
            with self.subTest(index=index):
                ref = self.fixture.write('invalid-input-' + str(index) + '.json', inputs)
                with self.assertRaises((Denied, ConfigurationError)):
                    self.bind(ref)
                self.assertFalse(self.output.exists())
        self.assertFalse(self.values('provision_bridge_intent'))
        self.assert_no_external_calls()

    def test_approved_iam_windows_preserve_separate_job_runtime(self):
        inputs = deepcopy(self.inputs)
        inputs['plan_bindings']['guardian_window']['end'] = '2026-10-11T09:00:00Z'
        inputs['plan_bindings']['owner_window']['end'] = '2026-10-11T02:01:00Z'
        reference = self.fixture.write('approved-iam-windows.json', inputs)
        self.assertEqual('provision_prepared', self.bind(reference)['status'])
        output = json.loads(self.output.read_bytes())
        self.assertEqual(inputs['plan_bindings'], output['plan_bindings'])
        operations = self.values('plan')[0]['operations']
        self.assertEqual(1800, operations['job']['body']['properties']['configuration']['replicaTimeout'])
        self.assertEqual(300, operations['guard']['body']['properties']['configuration']['replicaTimeout'])
        self.assert_prepared_once()

    def test_iam_limits_and_publication_deadline_are_not_extended(self):
        invalid = []
        for key, end in (('guardian_window', '2026-10-11T09:00:01Z'),
                         ('owner_window', '2026-10-11T01:09:59Z')):
            value = deepcopy(self.inputs)
            value['plan_bindings'][key]['end'] = end
            invalid.append(value)
        value = deepcopy(self.inputs)
        value['plan_bindings']['guardian_window']['end'] = '2026-10-11T09:00:00Z'
        value['plan_bindings']['owner_window']['end'] = '2026-10-11T02:01:01Z'
        invalid.append(value)
        for deadline in ('2026-10-11T01:01:00Z', '2026-10-11T01:20:01Z'):
            invalid.append(dict(self.inputs, deadline=deadline))
        for index, value in enumerate(invalid):
            with self.subTest(index=index):
                ref = self.fixture.write('invalid-window-' + str(index) + '.json', value)
                with self.assertRaises((Denied, ConfigurationError)):
                    self.bind(ref)
        self.assertFalse(self.output.exists())
        self.assert_no_external_calls()

    def test_changed_source_code_or_authority_stops_before_bridge(self):
        self.sources.return_value = {**self.code_sources, 'scripts/trial_provision/cli.py': '9' * 64}
        with self.assertRaises(ConfigurationError):
            self.bind()
        self.sources.return_value = self.code_sources
        Path(self.config['sources']['annex']['path']).write_bytes(b'{}')
        with self.assertRaises(ConfigurationError):
            self.bind()
        self.assertFalse(self.output.exists())
        self.assertEqual(0, self.fixture.git.call_count)
        self.assert_no_external_calls()

    def test_stale_plan_start_is_rejected_before_freezing_any_output(self):
        stale = deepcopy(self.inputs)
        stale['plan_bindings']['guardian_window'] = {
            'start': '2026-10-11T00:59:00Z', 'end': '2026-10-11T01:29:00Z'}
        ref = self.fixture.write('stale-start.local.json', stale)
        with self.assertRaises((Denied, ConfigurationError, PlanError)):
            self.bind(ref)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.values('provision_bridge_intent'))
        self.assertFalse(self.values('core_plan'))
        self.assert_no_external_calls()

    def test_resolver_only_rejection_precedes_all_durable_bridge_writes(self):
        # Both raw authority files agree; the pure core builder accepts and
        # normalizes this GUID, while the resolver requires an exact raw match.
        case = PublicationBridgeTests('runTest')
        self.addCleanup(case.doCleanups)
        tenant = 'ABCDEFAB-1234-5678-9ABC-ABCDEFABCDEF'
        case.set_up_fixture(tenant_id=tenant)
        publication = case.publication()
        with case.journal() as journal:
            config = bridge.compose_configuration(publication, journal, case.inputs)
        resources = build_resource_operations(publication['manifest'], publication['authority_bundle'],
                                               config['resource_bindings'])
        core = build_plan(publication['manifest'], publication['authority_bundle'],
            {**config['plan_bindings'], 'prerequisite_digests': {op['id']: digest(op) for op in resources}},
            case.clock.utc(), lambda slot: str(uuid.uuid5(uuid.NAMESPACE_URL, 'fictional-test:' + slot)))
        self.assertEqual(tenant.lower(), core['prerequisites']['app']['tenant_id'])
        before = (case.directory / 'trial-provision.jsonl').read_bytes()
        with self.assertRaisesRegex(Denied, 'approved_operation_binding'):
            case.bind()
        self.assertFalse(case.output.exists())
        self.assertFalse(case.values('provision_bridge_intent'))
        self.assertFalse(case.values('core_plan'))
        self.assertEqual(before, (case.directory / 'trial-provision.jsonl').read_bytes())
        self.assertEqual(0, case.fixture.git.call_count)
        case.assert_no_external_calls()

    def test_preexisting_identical_output_is_not_adopted_or_overwritten(self):
        publication = self.publication()
        with self.journal() as journal:
            raw = encoded(bridge.compose_configuration(publication, journal, self.inputs))
        from scripts.trial_provision.private_io import create_owner_file
        import os
        fd = create_owner_file(self.output)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
        with self.assertRaises(Denied):
            self.bind()
        self.assertEqual(raw, self.output.read_bytes())
        self.assertFalse(self.values('provision_bridge_intent'))
        self.assertEqual(0, self.fixture.git.call_count)
        self.assert_no_external_calls()

    def test_changed_input_after_output_cannot_replace_frozen_config(self):
        with self.journal() as journal:
            bridge.prepare_bridge(self.publication(), journal, self.reference, now=self.clock.utc())
        raw = self.output.read_bytes()
        changed = deepcopy(self.inputs)
        changed['deadline'] = '2026-10-11T01:16:00Z'
        ref = self.fixture.write('changed-input.local.json', changed)
        with self.assertRaises(Denied):
            self.bind(ref)
        self.assertEqual(raw, self.output.read_bytes())
        self.assertFalse(self.values('plan'))
        self.assert_no_external_calls()

    def test_changed_output_is_never_repaired_by_overwriting(self):
        with self.journal() as journal:
            bridge.prepare_bridge(self.publication(), journal, self.reference, now=self.clock.utc())
        self.output.write_bytes(b'{"fictional":"changed"}')
        raw = self.output.read_bytes()
        with self.assertRaises(Denied):
            self.bind()
        self.assertEqual(raw, self.output.read_bytes())
        self.assertFalse(self.values('plan'))
        self.assert_no_external_calls()

    def test_changed_verified_image_after_output_cannot_rebind(self):
        with self.journal() as journal:
            bridge.prepare_bridge(self.publication(), journal, self.reference, now=self.clock.utc())
            changed = journal.latest('guardianImagePush')
            old_digest = changed['properties']['manifest_digest']
            new_digest = 'sha256:' + '8' * 64
            changed['properties']['manifest_digest'] = new_digest
            changed['object_id'] = changed['object_id'].replace(old_digest, new_digest)
            journal.append('progress', changed)
            self.assertNotEqual(self.images, verified_publication_images(journal))
        raw = self.output.read_bytes()
        with self.assertRaises(Denied):
            self.bind()
        self.assertEqual(raw, self.output.read_bytes())
        self.assertFalse(self.values('plan'))
        self.assert_no_external_calls()

    def test_command_shape_cannot_attach_provision_input_to_other_actions(self):
        for request in ({'action': 'bind-provision'},
                        {'action': 'bind-provision', 'provision': self.reference, 'slot': 'guardian'},
                        {'action': 'prepare', 'provision': self.reference},
                        {'action': 'bind-provision', 'provision': self.reference, 'extra': True}):
            with self.subTest(request_keys=sorted(request)), self.assertRaises(Denied):
                publication_cli.run_command({'config': str(self.config_path), **request}, clock=self.clock)
        self.assertFalse(self.output.exists())
        self.assert_no_external_calls()

    def test_bridge_module_is_covered_by_required_source_pins(self):
        self.assertIn('publication_bridge', cli.MODULES['trial_provision'])
        self.assertIn('scripts/trial_provision/publication_bridge.py', cli.REQUIRED_SOURCES)


if __name__ == '__main__':
    unittest.main()
