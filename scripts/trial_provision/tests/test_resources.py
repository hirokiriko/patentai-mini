"""Fictional offline resource isolation, policy/DAG and secret-boundary tests."""
from contextlib import redirect_stdout, redirect_stderr
from copy import deepcopy
import base64
import io
import json
import unittest

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.resources import (
    SLOTS, build_resource_operations, build_runtime_operations, build_resource_cleanup,
    build_guard_main_operation, public_trial_origin)


SUB = '/subscriptions/11111111-1111-1111-1111-111111111111'
RG = SUB + '/resourceGroups/fictional'
TENANT = '22222222-2222-2222-2222-222222222222'
OWNER = '33333333-3333-3333-3333-333333333333'


def fixture():
    names = {slot: 'trial-' + slot.lower() for slot in SLOTS}
    existing = {k: RG + '/providers/' + p + '/' + t + '/' + n for k, p, t, n in (
        ('storage', 'Microsoft.Storage', 'storageAccounts', 'fictionalstorage'),
        ('registry', 'Microsoft.ContainerRegistry', 'registries', 'fictionalregistry'),
        ('environment', 'Microsoft.App', 'managedEnvironments', 'existing-env'),
        ('app', 'Microsoft.App', 'containerApps', 'production-app'),
        ('job', 'Microsoft.App', 'jobs', 'production-job'),
        ('db', 'Microsoft.DBforPostgreSQL', 'flexibleServers', 'fictional-db'),
        ('ai', 'Microsoft.CognitiveServices', 'accounts', 'fictional-ai'))}
    ids = {}
    for slot, name in names.items():
        if slot in ('originals', 'artifacts', 'budget', 'journal'):
            ids[slot] = existing['storage'] + '/blobServices/default/containers/' + name
        elif slot.endswith('Identity'):
            ids[slot] = RG + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + name
        else:
            ids[slot] = RG + '/providers/Microsoft.App/' + ('containerApps' if slot == 'app' else 'jobs') + '/' + name
    manifest = {'ids': ids, 'names': names, 'existing': existing, 'resourceGroupId': RG,
        'region': 'japaneast', 'owner': {'principal_id': OWNER, 'tenant_id': TENANT},
        'registry': {'id': existing['registry'], 'loginServer': 'fictionalregistry.azurecr.io', 'anonymousPullEnabled': False},
        'imageRepository': 'trial/runtime', 'cleanupImageRepository': 'trial/guardian',
        'db': {'name': 'trial_db', 'web': 'trial_web', 'worker': 'trial_worker'}}
    bindings = {'deadline': '2026-10-11T01:00:00Z', 'guardian_deadline': '2026-10-11T08:00:00Z',
        'runtime_image': 'fictionalregistry.azurecr.io/trial/runtime@sha256:' + 'a' * 64,
        'guardian_image': 'fictionalregistry.azurecr.io/trial/guardian@sha256:' + 'b' * 64,
        'db_secret_digests': {'web': 'c' * 64, 'worker': 'd' * 64}, 'code_sha': 'e' * 40}
    return manifest, {'manifest': json.dumps(manifest).encode()}, bindings


def runtime_fixture():
    manifest, authority, bindings = fixture()
    ops = {op['id']: op for op in build_resource_operations(manifest, authority, bindings)}
    receipts = {slot: {'operation_id': slot, 'request_digest': digest(op), 'object_id': op['expected']['resource_id'],
        'state': 'succeeded', 'terminal': True, 'write_terminal': True, 'readback_verified': True,
        'created_by_run': True, 'properties': {}} for slot, op in ops.items()}
    for slot, digit in (('webIdentity', '4'), ('workerIdentity', '5')):
        receipts[slot]['properties'] = {'tenantId': TENANT,
            'principalId': digit * 8 + '-' + '-'.join([digit * 4] * 3) + '-' + digit * 12,
            'clientId': ('6' if digit == '4' else '7') * 8 + '-6666-6666-6666-666666666666'}
    receipts['app']['properties'] = {'defaultDomain': 'trial-app.internal.fictional.japaneast.azurecontainerapps.io'}
    auth_operation = {'id': 'E1', 'body': {'displayName': 'fictional-dedicated-trial'}}
    receipts['E1'] = {'operation_id': 'E1', 'request_digest': digest(auth_operation),
        'state': 'succeeded', 'terminal': True, 'write_terminal': True, 'readback_verified': True,
        'created_by_run': True, 'properties': {'appId': '88888888-8888-8888-8888-888888888888'}}
    policy = {'schema': 1, 'approval': 'LIGHTWEIGHT_GROUP_TRIAL_V3', 'phase': 'initial',
        'startsAt': '2026-10-11T02:00:00Z', 'endsAt': '2026-10-11T02:30:00Z',
        'retentionReviewAt': '2027-01-29T00:00:00Z', 'codeSha': bindings['code_sha'],
        'image': bindings['runtime_image'], 'jobResourceId': manifest['ids']['job'],
        'environmentResourceId': manifest['existing']['environment'],
        'identity': {role + 'ClientId': receipts[role + 'Identity']['properties']['clientId'] for role in ('web', 'worker')},
        'auth': {'tenantId': TENANT, 'ownerId': OWNER, 'clientId': receipts['E1']['properties']['appId'],
                 'origin': public_trial_origin(manifest, receipts['app']['properties']['defaultDomain'])},
        'database': {'database': 'trial_db', 'webUser': 'trial_web', 'workerUser': 'trial_worker',
                     'host': 'fictional-db.postgres.database.azure.com', 'port': 5432},
        'storage': {'account': 'fictionalstorage', **{k: manifest['names'][k] for k in ('originals', 'artifacts', 'budget')}},
        'ai': {'resourceName': 'fictional-ai'}}
    public = base64.b64encode(bytes.fromhex('302a300506032b6570032100') + bytes(32)).decode()
    env = {'TRIAL_POLICY_JSON': json.dumps(policy), 'TRIAL_POLICY_SIGNATURE': 'A' * 86 + '==',
           'TRIAL_POLICY_PUBLIC_KEY': '-----BEGIN PUBLIC KEY-----\n' + public + '\n-----END PUBLIC KEY-----'}
    return manifest, authority, bindings, receipts, env, auth_operation


class ResourceTests(unittest.TestCase):
    def test_nine_fixed_slots_and_versions(self):
        manifest, authority, bindings = fixture()
        ops = build_resource_operations(manifest, authority, bindings)
        self.assertEqual([op['id'] for op in ops], list(SLOTS))
        for op in ops:
            self.assertEqual(set(op), {'id', 'provider', 'kind', 'method', 'url', 'body', 'deadline', 'depends_on', 'expected', 'cleanup'})
            self.assertEqual(op['expected']['body_sha256'], digest(op['body']))
            self.assertEqual(op['expected']['resource_id'], manifest['ids'][op['id']])
        self.assertEqual([op['expected']['api_version'] for op in ops], ['2023-01-31'] * 2 + ['2023-05-01'] * 4 + ['2025-07-01'] * 3)

    def test_actual_builders_satisfy_provider_contract(self):
        from scripts.trial_provision.providers import _validate
        for op in build_resource_operations(*fixture()) + self.runtime(runtime_fixture()):
            with self.subTest(slot=op['id']):
                self.assertEqual(_validate(op), op)

    def test_initial_runtime_is_fail_closed_and_internal(self):
        ops = {op['id']: op for op in build_resource_operations(*fixture())}
        for slot in ('app', 'job'):
            env = ops[slot]['body']['properties']['template']['containers'][0]['env']
            self.assertEqual({e['name'] for e in env}, {'DEPLOYMENT_KIND', 'TRIAL_RUNTIME_ROLE', 'AI_PROVIDER'})
            self.assertFalse(any('secretRef' in e for e in env))
        app = ops['app']['body']['properties']
        self.assertIs(app['configuration']['ingress']['external'], False)
        self.assertEqual(app['template']['scale'], {'minReplicas': 0, 'maxReplicas': 1})
        self.assertEqual(ops['app']['depends_on'], ['webIdentity', 'R8'])
        self.assertEqual(ops['job']['depends_on'], ['workerIdentity', 'R9'])

    def test_jobs_hard_limits_and_guard_no_configuration(self):
        ops = {op['id']: op for op in build_resource_operations(*fixture())}
        for slot, cpu, memory in (('guard', .25, '0.5Gi'), ('job', 2, '4Gi')):
            p = ops[slot]['body']['properties']
            self.assertEqual(p['configuration']['replicaTimeout'], 300 if slot == 'guard' else 1800)
            self.assertEqual(p['configuration']['replicaRetryLimit'], 0)
            self.assertEqual(p['configuration']['manualTriggerConfig'], {'replicaCompletionCount': 1, 'parallelism': 1})
            self.assertEqual(p['template']['containers'][0]['resources'], {'cpu': cpu, 'memory': memory})
        self.assertEqual(ops['guard']['body']['properties']['template']['containers'][0]['env'], [])
        self.assertEqual(ops['guard']['body']['identity'], {'type': 'SystemAssigned'})

    def test_metadata_secrets_only(self):
        ops = {op['id']: op for op in build_resource_operations(*fixture())}
        for slot, role in (('app', 'web'), ('job', 'worker')):
            secret = ops[slot]['body']['properties']['configuration']['secrets'][0]
            self.assertEqual(secret['value']['$secretBinding'], 'trial-' + role + '-database')
            self.assertEqual(set(secret['value']), {'$secretBinding', 'sha256'})
        self.assertNotIn('postgresql://', json.dumps(ops))

    def test_modified_manifest_rejected_before_build(self):
        m, a, b = fixture()
        m['ids']['app'] = m['existing']['app']
        with self.assertRaises(Denied): build_resource_operations(m, a, b)

    def test_production_id_alias_rejected_even_in_source(self):
        m, a, b = fixture()
        m['names']['app'] = 'production-app'
        m['ids']['app'] = m['existing']['app']
        a['manifest'] = json.dumps(m).encode()
        with self.assertRaises(Denied): build_resource_operations(m, a, b)

    def test_scope_image_and_extra_input_rejected(self):
        for mutate in (
            lambda m, b: b.update(runtime_image=b['runtime_image'].replace('trial/runtime', 'foreign/runtime')),
            lambda m, b: b.update(runtime_image=b['runtime_image'].split('@')[0] + ':latest'),
            lambda m, b: b.update(secret_value='must-never-output'),
            lambda m, b: m['ids'].update(journal=m['ids']['budget']),
            lambda m, b: m['existing'].update(environment=m['existing']['environment'].replace('fictional', 'foreign'))):
            m, a, b = fixture()
            mutate(m, b)
            a['manifest'] = json.dumps(m).encode()
            with self.assertRaises(Denied): build_resource_operations(m, a, b)

    def test_no_error_value_leak_or_stdout(self):
        m, a, b = fixture()
        b['db_secret_digests']['web'] = 'postgresql://private-sentinel'
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out), self.assertRaises(Denied) as raised:
            build_resource_operations(m, a, b)
        self.assertNotIn('private-sentinel', str(raised.exception))
        self.assertEqual(out.getvalue(), '')

    def runtime(self, args):
        m, a, b, r, env, auth = args
        return build_runtime_operations(m, a, b, r, env,
            verify_policy=lambda e: json.loads(e['TRIAL_POLICY_JSON']), auth_operation=auth,
            deadline='2026-10-11T02:20:00Z')

    def test_runtime_patch_does_not_replace_auth_or_db_secrets(self):
        ops = self.runtime(runtime_fixture())
        for op in ops:
            self.assertEqual(op['method'], 'PATCH')
            self.assertEqual(set(op['body']), {'properties'})
            self.assertEqual(set(op['body']['properties']), {'template'})
            self.assertNotIn('secrets', json.dumps(op['body']))
            self.assertFalse(op['expected']['before_absent'])
            self.assertIn('trialDatabaseBootstrap', op['depends_on'])
            self.assertEqual(len(op['body']['properties']['template']['containers'][0]['env']), 7)

    def test_runtime_rejects_unconfirmed_or_changed_receipts(self):
        for key in ('created_by_run', 'terminal', 'write_terminal', 'readback_verified'):
            args = runtime_fixture()
            args[3]['webIdentity'][key] = False
            with self.assertRaises(Denied): self.runtime(args)
        for slot in ('app', 'E1'):
            args = runtime_fixture()
            args[3][slot]['request_digest'] = '0' * 64
            with self.assertRaises(Denied): self.runtime(args)

    def test_policy_bound_to_trial_targets_owner_image_code_and_interval(self):
        for change in (
            lambda p: p.update(codeSha='0' * 40),
            lambda p: p.update(image=p['image'].replace('a' * 64, '0' * 64)),
            lambda p: p['auth'].update(ownerId='99999999-9999-9999-9999-999999999999'),
            lambda p: p['storage'].update(budget='foreign'),
            lambda p: p.update(endsAt='2026-10-11T03:00:00Z')):
            args = runtime_fixture()
            policy = json.loads(args[4]['TRIAL_POLICY_JSON'])
            change(policy)
            args[4]['TRIAL_POLICY_JSON'] = json.dumps(policy)
            with self.assertRaises(Denied): self.runtime(args)

    def test_verifier_errors_redacted(self):
        m, a, b, r, env, auth = runtime_fixture()
        def fail(_): raise RuntimeError('private-sentinel')
        with self.assertRaises(Denied) as raised:
            build_runtime_operations(m, a, b, r, env, verify_policy=fail, auth_operation=auth, deadline='2026-10-11T02:20:00Z')
        self.assertNotIn('private-sentinel', str(raised.exception))

    def test_private_key_cannot_enter_safe_policy_plan(self):
        args = runtime_fixture()
        args[4]['TRIAL_POLICY_PUBLIC_KEY'] = '-----BEGIN PRIVATE KEY-----\nprivate-sentinel\n-----END PRIVATE KEY-----'
        with self.assertRaises(Denied) as raised: self.runtime(args)
        self.assertNotIn('private-sentinel', str(raised.exception))

    def test_cleanup_requires_terminal_created_receipt(self):
        m, a, b, receipts, _, _ = runtime_fixture()
        guard = next(op for op in build_resource_operations(m, a, b) if op['id'] == 'guard')
        cleanup = build_resource_cleanup(guard, receipts['guard'], deadline=b['guardian_deadline'])
        self.assertEqual(cleanup['method'], 'DELETE')
        self.assertEqual(cleanup['url'], guard['url'])
        self.assertIsNone(cleanup['body'])
        receipts['guard']['write_terminal'] = False
        with self.assertRaises(Denied): build_resource_cleanup(guard, receipts['guard'], deadline=b['guardian_deadline'])

    def test_internal_origin_maps_only_fixed_app_and_region(self):
        m, _, _ = fixture()
        public = 'https://trial-app.fictional.japaneast.azurecontainerapps.io'
        self.assertEqual(public_trial_origin(m, public.removeprefix('https://')), public)
        self.assertEqual(public_trial_origin(m, 'trial-app.internal.fictional.japaneast.azurecontainerapps.io'), public)
        for name in ('other.internal.fictional.japaneast.azurecontainerapps.io',
                     'trial-app.internal.fictional.westus.azurecontainerapps.io',
                     'trial-app.internal.evil.example', 'trial-app---revision.fictional.japaneast.azurecontainerapps.io'):
            with self.assertRaises(Denied): public_trial_origin(m, name)

    def test_auth_plan_callback_matches_runtime_policy_origin(self):
        from scripts.trial_provision.plan import materialize_operation
        from scripts.trial_provision.tests.test_plan import CompilerTests
        compiler = CompilerTests()
        compiler.setUp()
        plan = compiler.build()
        receipts = compiler.prerequisites(plan)
        pull = materialize_operation(plan, 'R8', receipts)
        receipts['R8'] = compiler.receipt(pull, pull['expected']['resource_id'], {})
        name = compiler.manifest['ids']['app'].rsplit('/', 1)[-1]
        region = compiler.manifest.get('region', 'region')
        projection = {'names': {'app': name}, 'region': region}
        for internal in ('', 'internal.'):
            domain = name + '.' + internal + 'fictional.' + region + '.azurecontainerapps.io'
            receipts['app']['properties']['defaultDomain'] = domain
            app = materialize_operation(plan, 'E1', receipts)
            self.assertEqual(app['body']['web']['redirectUris'],
                [public_trial_origin(projection, domain) + '/.auth/login/aad/callback'])

    def test_main_timeout_needs_proven_same_job_rehearsal(self):
        m, a, b, receipts, _, _ = runtime_fixture()
        guard = next(op for op in build_resource_operations(m, a, b) if op['id'] == 'guard')
        rehearsal = {'id': 'guardRehearsal', 'expected': {'resource_id': m['ids']['guard'] + '/executions/fictional'}}
        receipt = {'operation_id': 'guardRehearsal', 'request_digest': digest(rehearsal),
            'object_id': rehearsal['expected']['resource_id'], 'state': 'succeeded',
            'created_by_run': True, 'write_terminal': True, 'terminal': True, 'readback_verified': True,
            'properties': {'job_resource_id': m['ids']['guard'], 'rehearsal_reads_verified': True, 'cleanup_verified': True}}
        op = build_guard_main_operation(guard, receipts['guard'], rehearsal, receipt, deadline=b['guardian_deadline'])
        from scripts.trial_provision.providers import _validate
        self.assertEqual(_validate(op), op)
        self.assertEqual(op['body'], {'properties': {'configuration': {'triggerType': 'Manual',
            'replicaTimeout': 1800, 'replicaRetryLimit': 0,
            'manualTriggerConfig': {'replicaCompletionCount': 1, 'parallelism': 1}}}})
        self.assertEqual(op['url'], guard['url'])
        self.assertEqual(op['depends_on'], ['guard', 'guardRehearsal'])
        main_receipt = deepcopy(receipts['guard'])
        main_receipt.update(operation_id=op['id'], request_digest=digest(op))
        cleanup = build_resource_cleanup(guard, receipts['guard'], deadline=b['guardian_deadline'],
            current_operation=op, current_receipt=main_receipt)
        self.assertEqual(cleanup['expected']['properties']['properties.configuration.replicaTimeout'], 1800)
        self.assertEqual(cleanup['depends_on'], ['guard', 'guardMainConfiguration'])
        self.assertEqual(_validate(cleanup), cleanup)
        receipt['properties']['cleanup_verified'] = False
        with self.assertRaises(Denied):
            build_guard_main_operation(guard, receipts['guard'], rehearsal, receipt, deadline=b['guardian_deadline'])


if __name__ == '__main__':
    unittest.main()
