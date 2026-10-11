"""Finite resolver tests using fictional compiler inputs and journal receipts."""
from copy import deepcopy
import base64
import hashlib
import json
import unittest

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.plan import build_plan, canonical_json
from scripts.trial_provision.resources import build_resource_operations
from scripts.trial_provision.tests.test_plan import fixture as core_fixture, guid


def fixture():
    manifest, authority, bindings = core_fixture()
    rg = manifest['resourceGroupId']
    manifest['region'] = 'japaneast'
    manifest['names'] = {k: v.rsplit('/', 1)[1] for k, v in manifest['ids'].items()}
    manifest['existing']['storage'] = manifest['ids']['originals'].split('/blobServices/')[0]
    manifest['existing']['environment'] = rg + '/providers/Microsoft.App/managedEnvironments/fictional-env'
    manifest['registry'] = {'id': manifest['existing']['registry'], 'loginServer': 'fictionalacr.azurecr.io', 'anonymousPullEnabled': False}
    manifest.update(imageRepository='trial/runtime', cleanupImageRepository='trial/guardian',
                    db={'name': 'trial_db', 'web': 'trial_web', 'worker': 'trial_worker'})
    authority['manifest'] = canonical_json(manifest)
    mh = hashlib.sha256(authority['manifest']).hexdigest()
    annex, approval, latest = (json.loads(authority[k]) for k in ('annex', 'approval', 'latest'))
    annex['fixedManifestSha256'] = mh
    authority['annex'] = canonical_json(annex)
    ah = hashlib.sha256(authority['annex']).hexdigest()
    approval.update(boundProposalSha256=ah, fixedManifestSha256=mh)
    authority['approval'] = canonical_json(approval)
    latest.update(fixedManifestSha256=mh, originalProposalSha256=ah,
                  priorApprovalSha256=hashlib.sha256(authority['approval']).hexdigest())
    authority['latest'] = canonical_json(latest)
    resource_bindings = {'deadline': '2026-10-11T02:59:00Z', 'guardian_deadline': '2026-10-11T09:00:00Z',
        'runtime_image': 'fictionalacr.azurecr.io/trial/runtime@sha256:' + 'a' * 64,
        'guardian_image': 'fictionalacr.azurecr.io/trial/guardian@sha256:' + 'b' * 64,
        'db_secret_digests': {'web': 'c' * 64, 'worker': 'd' * 64}, 'code_sha': 'e' * 40}
    resources = build_resource_operations(manifest, authority, resource_bindings)
    bindings['prerequisite_digests'] = {op['id']: digest(op) for op in resources}
    allocated = {}
    def allocate(slot): return allocated.setdefault(slot, guid(1000 + len(allocated)))
    core = build_plan(manifest, authority, bindings, '2026-10-11T01:00:00Z', allocate)
    return core, manifest, authority, resource_bindings


def receipt(op, properties=None, object_id=None):
    return {'operation_id': op['id'], 'request_digest': digest(op),
        'object_id': object_id or op['expected'].get('resource_id'), 'properties': properties or {},
        'state': 'succeeded', 'terminal': True, 'readback_verified': True,
        'write_terminal': True, 'created_by_run': True}


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.args = fixture()
        self.resolver = create_resolver(*self.args)
        self.receipts = {}
        core, manifest, _, _ = self.args
        for index, key in enumerate(manifest['ids']):
            props = {}
            if key in ('webIdentity', 'workerIdentity', 'guard'):
                props = {'tenantId': manifest['owner']['tenant_id'], 'principalId': guid(2000 + index), 'clientId': guid(2100 + index)}
            elif key == 'app': props = {'defaultDomain': manifest['names']['app'] + '.fictional.japaneast.azurecontainerapps.io'}
            op = self.resolver.resolve(key, self.receipts)
            self.receipts[key] = receipt(op, props)
        op = self.resolver.resolve('R8', self.receipts)
        self.receipts['R8'] = receipt(op)
        op = self.resolver.resolve('E1', self.receipts)
        self.receipts['E1'] = receipt(op, {'kind': 'applications', 'appId': guid(3001), 'applicationObjectId': guid(3000)}, guid(3000))

    def policy(self):
        _, m, _, b = self.args
        p = {'schema': 1, 'approval': 'LIGHTWEIGHT_GROUP_TRIAL_V3', 'phase': 'initial',
             'startsAt': '2026-10-11T02:00:00Z', 'endsAt': '2026-10-11T02:30:00Z',
             'retentionReviewAt': '2027-01-29T00:00:00Z', 'codeSha': b['code_sha'], 'image': b['runtime_image'],
             'jobResourceId': m['ids']['job'], 'environmentResourceId': m['existing']['environment'],
             'identity': {role + 'ClientId': self.receipts[role + 'Identity']['properties']['clientId'] for role in ('web', 'worker')},
             'auth': {'tenantId': m['owner']['tenant_id'], 'ownerId': m['owner']['principal_id'], 'clientId': guid(3001),
                      'origin': 'https://' + self.receipts['app']['properties']['defaultDomain']},
             'database': {'host': 'fictionalpg.postgres.database.azure.com', 'port': 5432, 'database': 'trial_db',
                          'ownerRole': 'trial_owner', 'migratorUser': 'trial_migrator', 'webUser': 'trial_web', 'workerUser': 'trial_worker'},
             'cost': {'databaseBaselineBytes': 1024},
             'storage': {'account': 'fictionalstore', **{k: m['names'][k] for k in ('originals', 'artifacts', 'budget')}},
             'ai': {'resourceName': 'fictionalai'}}
        # Structural-only fictional bytes; the injected verifier tests binding,
        # never cryptographic acceptance or use of a real signing credential.
        return {'TRIAL_POLICY_JSON': json.dumps(p),
                'TRIAL_POLICY_SIGNATURE': base64.b64encode(bytes(64)).decode(),
                'TRIAL_POLICY_PUBLIC_KEY': '-----BEGIN PUBLIC KEY-----\n' +
                    base64.b64encode(bytes.fromhex('302a300506032b6570032100') + bytes(32)).decode() +
                    '\n-----END PUBLIC KEY-----'}

    def database_observation(self, env=None, known_ack=False):
        environment = {'DEPLOYMENT_KIND': 'trial', **(env or self.policy())}
        p = json.loads(environment['TRIAL_POLICY_JSON'])
        return {'operation_id': 'trialDatabaseBootstrap', 'request_digest': '9' * 64, 'object_id': '8' * 64,
                'state': 'succeeded', 'terminal': True, 'readback_verified': True,
                'created_by_run': known_ack, 'write_terminal': known_ack,
                'properties': {'final_policy_environment_sha256': digest(environment),
                    'database_baseline_bytes': p['cost']['databaseBaselineBytes'], 'code_sha': p['codeSha'],
                    'database_binding_sha256': digest({name: p['database'][name] for name in
                        ('host', 'database', 'ownerRole', 'migratorUser', 'webUser', 'workerUser')}),
                    'observation_only': True, 'cleanup_ownership_proof': False}}

    def bind_runtime(self, database=True):
        verifier = lambda env: json.loads(env['TRIAL_POLICY_JSON'])
        event = self.resolver.make_runtime_binding(self.policy(), self.receipts, verify_policy=verifier, deadline='2026-10-11T02:30:00Z')
        self.resolver.bind_runtime(event, self.receipts, verify_policy=verifier)
        if database:
            self.receipts['trialDatabaseBootstrap'] = self.database_observation()
        return event

    def add_graph(self):
        e2 = self.resolver.resolve('E2', self.receipts)
        self.receipts['E2'] = receipt(e2, {'kind': 'servicePrincipals', 'servicePrincipalObjectId': guid(3002), 'appId': guid(3001)}, guid(3002))
        e3 = self.resolver.resolve('E3', self.receipts)
        self.receipts['E3'] = receipt(e3, {'kind': 'appRoleAssignedTo', 'directoryAssignmentId': 'fictional-assignment',
            'principalId': self.args[1]['owner']['principal_id'], 'resourceId': guid(3002),
            'appRoleId': self.args[0]['allocation']['OWNER_APP_ROLE']}, 'fictional-assignment')

    def test_initial_38_fixed_operations_and_no_runtime_cycle(self):
        initial = self.resolver.initial_plan
        self.assertEqual(38, len(initial['operations']))
        self.assertLessEqual(len(self.resolver.allowed_ids), 128)
        with self.assertRaises(Denied): self.resolver.resolve('jobRuntime', self.receipts)
        with self.assertRaises(Denied): self.resolver.resolve('https://evil.invalid/op', self.receipts)
        initial['operations'].clear()
        self.assertEqual(38, len(self.resolver.initial_plan['operations']))

    def test_runtime_binding_preserves_initial_digest_and_resolves_stably_after_restart(self):
        before = self.resolver.plan_digest
        event = self.bind_runtime()
        first = self.resolver.resolve('jobRuntime', self.receipts)
        self.assertEqual(before, self.resolver.plan_digest)
        restarted = create_resolver(*self.args)
        restarted.bind_runtime(event, self.receipts, verify_policy=lambda env: json.loads(env['TRIAL_POLICY_JSON']))
        self.assertEqual(first, restarted.resolve('jobRuntime', self.receipts))
        first['body'].clear()
        self.assertTrue(self.resolver.resolve('jobRuntime', self.receipts)['body'])

    def test_changed_policy_source_receipt_deadline_or_failed_verifier_is_rejected(self):
        event = self.bind_runtime()
        for key, value in (('initial_plan_digest', '0' * 64), ('deadline', '2026-10-11T03:01:00Z')):
            changed = deepcopy(event)
            changed[key] = value
            with self.assertRaises(Denied): self.resolver.bind_runtime(changed, self.receipts, verify_policy=lambda env: json.loads(env['TRIAL_POLICY_JSON']))
        changed = deepcopy(self.receipts)
        changed['webIdentity']['properties']['clientId'] = guid(9999)
        with self.assertRaises(Denied): self.resolver.resolve('jobRuntime', changed)
        with self.assertRaises(Denied): self.resolver.make_runtime_binding(self.policy(), self.receipts, verify_policy=lambda env: None, deadline=event['deadline'])

    def test_rebinding_different_even_valid_policy_is_denied(self):
        self.bind_runtime()
        env = self.policy()
        env['TRIAL_POLICY_SIGNATURE'] = base64.b64encode(bytes([1]) * 64).decode()
        other = self.resolver.make_runtime_binding(env, self.receipts, verify_policy=lambda e: json.loads(e['TRIAL_POLICY_JSON']), deadline='2026-10-11T02:30:00Z')
        with self.assertRaises(Denied): self.resolver.bind_runtime(other, self.receipts, verify_policy=lambda e: json.loads(e['TRIAL_POLICY_JSON']))

    def test_e4_requires_both_runtime_success_receipts(self):
        self.add_graph()
        with self.assertRaises(Denied): self.resolver.resolve('E4', self.receipts)
        self.bind_runtime()
        for key in ('jobRuntime', 'appRuntime'):
            with self.assertRaises(Denied): self.resolver.resolve('E4', self.receipts)
            self.receipts[key] = receipt(self.resolver.resolve(key, self.receipts))
        self.assertEqual('E4', self.resolver.resolve('E4', self.receipts)['id'])

    def test_runtime_preparation_can_precede_db_proof_but_dispatch_cannot(self):
        self.bind_runtime(database=False)
        with self.assertRaises(Denied): self.resolver.resolve('jobRuntime', self.receipts)
        self.receipts['trialDatabaseBootstrap'] = self.database_observation(known_ack=False)
        op = self.resolver.resolve('jobRuntime', self.receipts)
        self.assertEqual('jobRuntime', op['id'])
        self.assertNotIn('cleanup_trialDatabaseBootstrap', self.resolver.allowed_ids)

    def test_runtime_rejects_db_policy_baseline_code_binding_or_state_mismatch(self):
        self.bind_runtime(database=False)
        good = self.database_observation()
        for mutate in (
            lambda r: r.update(state='unknown'),
            lambda r: r.update(terminal=False),
            lambda r: r.update(readback_verified=False),
            lambda r: r['properties'].update(final_policy_environment_sha256='0' * 64),
            lambda r: r['properties'].update(database_baseline_bytes=2048),
            lambda r: r['properties'].update(database_baseline_bytes=True),
            lambda r: r['properties'].update(code_sha='0' * 40),
            lambda r: r['properties'].update(database_binding_sha256='0' * 64),
            lambda r: r['properties'].update(cleanup_ownership_proof=True)):
            changed = deepcopy(good)
            mutate(changed)
            self.receipts['trialDatabaseBootstrap'] = changed
            with self.assertRaises(Denied): self.resolver.resolve('jobRuntime', self.receipts)

    def test_known_apply_and_observation_reconcile_each_work_but_receipt_change_does_not(self):
        event = self.bind_runtime(database=False)
        for known_ack in (False, True):
            resolver = create_resolver(*self.args)
            resolver.bind_runtime(event, self.receipts, verify_policy=lambda env: json.loads(env['TRIAL_POLICY_JSON']))
            self.receipts['trialDatabaseBootstrap'] = self.database_observation(known_ack=known_ack)
            self.assertEqual('appRuntime', resolver.resolve('appRuntime', self.receipts)['id'])
            self.receipts['trialDatabaseBootstrap']['properties']['extra_observation'] = 'changed'
            with self.assertRaises(Denied): resolver.resolve('jobRuntime', self.receipts)

    def test_auth_after_runtime_and_e4_uses_only_fixed_builders(self):
        self.add_graph()
        self.bind_runtime()
        for key in ('jobRuntime', 'appRuntime'): self.receipts[key] = receipt(self.resolver.resolve(key, self.receipts))
        with self.assertRaises(Denied): self.resolver.resolve('auth-platform-secret', self.receipts)
        e4 = self.resolver.resolve('E4', self.receipts)
        self.receipts['E4'] = receipt(e4, {'kind': 'addPassword', 'keyId': guid(3004)}, guid(3004))
        op = self.resolver.resolve('auth-platform-secret', self.receipts)
        self.assertEqual('containerApps', op['kind'])
        self.assertEqual('appRuntime', op['expected']['update_from']['operation_id'])

    def test_initial_input_or_prerequisite_tampering_is_rejected(self):
        args = list(deepcopy(self.args))
        args[3]['deadline'] = '2026-10-11T02:58:00Z'
        with self.assertRaises(Denied): create_resolver(*args)
        args = list(deepcopy(self.args))
        args[2]['latest'] += b' '
        with self.assertRaises(Denied): create_resolver(*args)

    def test_existing_concrete_operation_receipt_prevents_digest_change(self):
        self.receipts['webIdentity']['request_digest'] = '0' * 64
        with self.assertRaises(Denied): self.resolver.resolve('webIdentity', self.receipts)

    def cleanup_binding(self, source, **evidence):
        op = self.resolver.resolve(source, self.receipts)
        event = {'initial_plan_digest': self.resolver.plan_digest,
                 'deadline': op['cleanup']['deadline'], 'reference_evidence': evidence}
        slot = 'cleanup_' + source.replace('-', '_')
        self.resolver.bind_cleanup(slot, event)
        return slot, event

    def test_retained_data_and_journal_have_no_delete_slot(self):
        for source in ('originals', 'artifacts', 'budget', 'journal'):
            self.assertNotIn('cleanup_' + source, self.resolver.allowed_ids)
            with self.assertRaises(Denied): self.resolver.resolve('cleanup_' + source, self.receipts)

    def test_cleanup_fixed_due_and_latest_runtime_state(self):
        self.bind_runtime()
        runtime = self.resolver.resolve('jobRuntime', self.receipts)
        self.receipts['jobRuntime'] = receipt(runtime)
        slot, event = self.cleanup_binding('job')
        deletion = self.resolver.resolve(slot, self.receipts)
        self.assertEqual('jobRuntime', self.resolver.cleanup_creation_id(slot, self.receipts))
        self.assertEqual('2026-10-31T00:00:00Z', deletion['deadline'])
        self.assertEqual(['job', 'jobRuntime'], deletion['depends_on'])
        self.assertEqual(runtime['body']['properties']['template'],
                         deletion['expected']['properties']['properties']['template'])
        from scripts.trial_provision.providers import _validate
        self.assertEqual(deletion, _validate(deletion))
        changed = deepcopy(event)
        changed['deadline'] = '2026-11-01T00:00:00Z'
        restart = create_resolver(*self.args)
        restart.bind_runtime(self.resolver.runtime_binding, self.receipts,
                             verify_policy=lambda env: json.loads(env['TRIAL_POLICY_JSON']))
        with self.assertRaises(Denied): restart.bind_cleanup(slot, changed)

    def test_unknown_update_never_falls_back_to_original_creation_for_cleanup(self):
        self.bind_runtime()
        op = self.resolver.resolve('jobRuntime', self.receipts)
        self.receipts['jobRuntime'] = receipt(op)
        self.receipts['jobRuntime'].update(state='unknown', terminal=False, readback_verified=False)
        slot, _ = self.cleanup_binding('job')
        with self.assertRaises(Denied): self.resolver.resolve(slot, self.receipts)
        with self.assertRaises(Denied): self.resolver.cleanup_creation_id(slot, self.receipts)

    def test_multistep_app_cleanup_keeps_all_known_settings(self):
        self.add_graph()
        self.bind_runtime()
        for key in ('jobRuntime', 'appRuntime'):
            self.receipts[key] = receipt(self.resolver.resolve(key, self.receipts))
        e4 = self.resolver.resolve('E4', self.receipts)
        self.receipts['E4'] = receipt(e4, {'kind': 'addPassword', 'keyId': guid(3004)}, guid(3004))
        for key in ('auth-platform-secret', 'auth-config', 'auth-ingress'):
            self.receipts[key] = receipt(self.resolver.resolve(key, self.receipts))
        slot, _ = self.cleanup_binding('app')
        deletion = self.resolver.resolve(slot, self.receipts)
        self.assertEqual('auth-ingress', self.resolver.cleanup_creation_id(slot, self.receipts))
        self.assertEqual('2027-01-29T00:00:00Z', deletion['deadline'])
        known = deletion['expected']['properties']['properties']
        self.assertTrue(known['configuration']['ingress']['external'])
        self.assertEqual(2, len(known['configuration']['secrets']))
        self.assertTrue(all(set(s) == {'name'} for s in known['configuration']['secrets']))
        self.assertEqual(self.resolver.resolve('appRuntime', self.receipts)['body']['properties']['template'], known['template'])
        from scripts.trial_provision.providers import _validate
        self.assertEqual(deletion, _validate(deletion))

    def test_app_final_delete_reflects_closed_ingress_and_removed_auth_secret(self):
        self.test_multistep_app_cleanup_keeps_all_known_settings()
        # Resolve the same final deletion only after cleanup events in a fresh
        # resolver; a slot already journaled against an older state is immutable.
        old = self.resolver
        self.resolver = create_resolver(*self.args)
        self.resolver.bind_runtime(old.runtime_binding, self.receipts,
                                  verify_policy=lambda env: json.loads(env['TRIAL_POLICY_JSON']))
        latest = 'auth-ingress'
        for source in ('auth-ingress', 'auth-platform-secret'):
            op = self.resolver.resolve(source, self.receipts)
            proof = {'complete': True, 'creation_request_digest': digest(op),
                     'creation_receipt_digest': digest(self.receipts[source]),
                     'object_id': self.receipts[source]['object_id'], 'references_cleared': True,
                     'depends_on': [latest], 'latest_app_receipt': self.receipts[latest]}
            slot, _ = self.cleanup_binding(source, **proof)
            cleanup = self.resolver.resolve(slot, self.receipts)
            self.receipts[slot] = receipt(cleanup)
            latest = slot
        slot, _ = self.cleanup_binding('app')
        deletion = self.resolver.resolve(slot, self.receipts)
        self.assertEqual(latest, self.resolver.cleanup_creation_id(slot, self.receipts))
        cfg = deletion['expected']['properties']['properties']['configuration']
        self.assertFalse(cfg['ingress']['external'])
        self.assertEqual([{'name': 'trial-web-database'}], cfg['secrets'])

    def rehearsal_event(self):
        guard = self.resolver.resolve('guard', self.receipts)
        execution = guard['expected']['resource_id'] + '/executions/fictional-rehearsal'
        runtime = {'execution_id': execution, 'principal_id': self.receipts['guard']['properties']['principalId'],
                   'image_digest': self.args[3]['guardian_image'].split('@')[1],
                   'job_started_at': '2026-10-11T02:00:00Z', 'job_deadline': '2026-10-11T02:05:00Z'}
        journal = 'https://' + self.args[1]['existing']['storage'].rsplit('/', 1)[1] + '.blob.core.windows.net/' + self.args[1]['names']['journal'] + '/rehearsal.json'
        for ident, fingerprint, target, properties in (
            ('guardRehearsalStart', '1' * 64, execution, {}),
            ('guardRehearsalSeed', '2' * 64, journal, {'runtime': runtime})):
            self.receipts[ident] = {'operation_id': ident, 'request_digest': fingerprint, 'object_id': target,
                'state': 'succeeded', 'terminal': True, 'write_terminal': True, 'readback_verified': True,
                'created_by_run': True, 'properties': properties}
        op = {'id': 'guardRehearsal', 'provider': 'Microsoft.App', 'kind': 'guardRehearsal', 'method': 'GET',
              'url': 'https://management.azure.com' + execution + '?api-version=2025-07-01', 'body': None,
              'deadline': guard['cleanup']['deadline'], 'depends_on': ['guardRehearsalStart', 'guardRehearsalSeed'],
              'expected': {'resource_id': execution, 'start_request_digest': '1' * 64,
                           'seed_request_digest': '2' * 64, 'runtime_digest': digest(runtime), 'body_sha256': digest(None)},
              'cleanup': {'journal_retained': True, 'live_delete_verified': False}}
        p = {'job_resource_id': guard['expected']['resource_id'], 'rehearsal_reads_verified': True,
             'cleanup_verified': True, 'lease_released_verified': True, 'journal_retained': True,
             'live_delete_verified': False, 'execution_status': 'Succeeded', 'start_request_digest': '1' * 64,
             'seed_request_digest': '2' * 64, 'journal_state_digest': '3' * 64, 'journal_etag_digest': '4' * 64,
             'job_started_at': runtime['job_started_at'], 'job_ended_at': '2026-10-11T02:04:00Z'}
        proof = receipt(op, p)
        self.receipts['guardRehearsal'] = proof
        return {'initial_plan_digest': self.resolver.plan_digest, 'operation': op, 'receipt': proof}

    def test_verified_rehearsal_unlocks_same_guard_timeout_and_cleanup_state(self):
        before = self.resolver.plan_digest
        with self.assertRaises(Denied): self.resolver.resolve('guardMainConfiguration', self.receipts)
        event = self.rehearsal_event()
        self.resolver.bind_rehearsal(event, self.receipts)
        op = self.resolver.resolve('guardMainConfiguration', self.receipts)
        self.assertEqual(1800, op['body']['properties']['configuration']['replicaTimeout'])
        self.assertEqual(before, self.resolver.plan_digest)
        restarted = create_resolver(*self.args)
        restarted.bind_rehearsal(event, self.receipts)
        self.assertEqual(op, restarted.resolve('guardMainConfiguration', self.receipts))
        self.receipts[op['id']] = receipt(op, self.receipts['guard']['properties'])
        slot, _ = self.cleanup_binding('guard')
        cleanup = self.resolver.resolve(slot, self.receipts)
        self.assertEqual(1800, cleanup['expected']['properties']['properties']['configuration']['replicaTimeout'])
        self.assertEqual('guardMainConfiguration', self.resolver.cleanup_creation_id(slot, self.receipts))

    def test_rehearsal_unknown_seed_or_unreleased_lease_or_new_target_is_denied(self):
        event = self.rehearsal_event()
        for mutate in (
            lambda e, r: r['guardRehearsalSeed'].update(state='unknown'),
            lambda e, r: e['receipt']['properties'].update(lease_released_verified=False),
            lambda e, r: e['operation'].update(url=e['operation']['url'].replace('fictional-rehearsal', 'other')),
            lambda e, r: r['guardRehearsalSeed']['properties']['runtime'].update(image_digest='sha256:' + '0' * 64)):
            changed, receipts = deepcopy(event), deepcopy(self.receipts)
            mutate(changed, receipts)
            with self.assertRaises(Denied): self.resolver.bind_rehearsal(changed, receipts)


if __name__ == '__main__': unittest.main()
