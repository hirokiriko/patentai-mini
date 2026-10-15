"""Fictional consumer contracts for a sealed reused-image attempt.

Authority/history validation is tested by the succession tests. The small seal
seam here isolates downstream consumers, never a production approval input.
Only temporary fictional files are read/written; all live capabilities stop at
injected transport/process boundaries.
"""
from contextlib import ExitStack
from copy import deepcopy
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard import execution, catalog_execution
from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_guard import test_catalog_execution as catalog_fixtures
from scripts.trial_guard.test_lifecycle import Clock
from scripts.trial_provision import attempt, bootstrap, configuration
from scripts.trial_provision.tests import test_attempt, test_bootstrap, test_configuration


def sealed_consumer_fixture(*, schema=6, image_head='a'*40, local_head='b'*40):
    data = test_attempt.fixture()
    proof = attempt._proof(test_attempt.verify(data))
    proof['authority'].update(schema=schema, head=local_head)
    if schema == 6:
        proof['authority']['image_build_head'] = image_head
    return attempt.VerifiedAttempt(proof, attempt._SEAL), data


def preflight(config, clock, local_head):
    config['preflight'] = {'schema':2, 'catalog_acl':'pending_catalog', 'launch_checks_verified':True,
        'checked_at':clock.utc().isoformat(), 'ci_head':local_head, 'reviewed_head':local_head,
        **{k:config['binding'][k] for k in ('ipv4','server_id','rule_id')},
        'initial_forecast_yen':4493, 'initial_cap_yen':5000, 'all_unsettled_retained':True,
        'no_production_change':True, 'evidence_sha256':{k:'c'*64 for k in
            ('network_approval','current_ip','platform_isolation','current_ledger',
             'current_prices','effective_permissions','additional_authority')}}


class ReusedConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.f = test_configuration.ConfigurationTests()
        self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.verified, _ = sealed_consumer_fixture()
        self.f.head = 'b'*40
        self.f.config['frozen_head'] = self.f.head
        self.f.config['ci'] = self.f.write('ci.local.json', {
            'head_sha':self.f.head,'status':'completed','conclusion':'success',
            'required_checks':[{'name':n,'status':'completed','conclusion':'success'} for n in ('ci','isolated-pg16')],
            'source_url':'https://github.com/hirokiriko/patentai-mini/actions/runs/123',
            'checked_at':'2026-10-11T00:59:00Z'})
        self.f.config['code_sources'] = {'scripts/trial_provision/providers.py':'9'*64}

    def load(self, *, verified=True, sources=None):
        common = configuration._load_common_configuration
        def checked(*args, **kwargs):
            result = common(*args, **kwargs)
            if verified: result['verified_attempt'] = self.verified
            return result
        with patch.object(configuration, '_load_common_configuration', side_effect=checked):
            return self.f.load(local_source_digests=self.f.config['code_sources'] if sources is None else sources)

    def test_new_local_ci_source_and_old_resource_head_are_both_preserved(self):
        result = self.load()
        self.assertEqual(result['frozen_head'], 'b'*40)
        self.assertEqual(result['resource_bindings']['code_sha'], 'a'*40)
        self.assertTrue(result['gates']['ci_passed'])
        self.assertTrue(result['gates']['code_pins_checked'])

    def test_no_seal_or_wrong_image_head_never_unlocks_old_build(self):
        with self.assertRaisesRegex(configuration.ConfigurationError, 'config_resource_binding'):
            self.load(verified=False)
        self.f.config['resource_bindings']['code_sha'] = self.f.head
        with self.assertRaisesRegex(configuration.ConfigurationError, 'config_resource_binding'):
            self.load()

    def test_source_and_local_ci_checks_are_not_weakened(self):
        with self.assertRaisesRegex(configuration.ConfigurationError, 'config_code_changed'):
            self.load(sources={'scripts/trial_provision/providers.py':'8'*64})
        self.f.head = 'c'*40; self.f.config['frozen_head'] = self.f.head
        with self.assertRaisesRegex(configuration.ConfigurationError, 'config_ci'):
            self.load()


class ReusedExecutionTests(unittest.TestCase):
    def setUp(self):
        self.verified, data = sealed_consumer_fixture()
        self.clock = Clock(); self.clock.wall = parse(self.verified.activation['windows']['initial']['start'])
        window = {'lifecycleId':'fictional-life','bindingDigest':'d'*64,'guardianNonce':'fictional-nonce',
            'ruleId':'fictional-rule','journalUrl':'https://fictional.blob.core.windows.net/guard/state.json',
            'jobStartedAt':self.clock.utc().isoformat(),'useUntil':test_attempt.stamp(6300)}
        payload = catalog_fixtures.CatalogExecutionTests.make_payload(SimpleNamespace(clock=self.clock, window=window, db=Path.cwd()/'fictional-db'))
        policy = json.loads(payload['environment']['TRIAL_POLICY_JSON'])
        policy.update(startsAt=self.verified.activation['windows']['initial']['start'], endsAt=self.verified.activation['windows']['initial']['end'])
        payload['environment']['TRIAL_POLICY_JSON'] = json.dumps(policy)
        payload['access'].update(startsAt=self.verified.activation['windows']['owner_input']['start'], endsAt=self.verified.activation['windows']['owner_input']['end'])
        self.config = {k:'fictional-'+k for k in ('guardian_job','owner_access','journal_url','prearm_until','seed_not_before')}
        self.config.update(live_enabled=True, cleanup_strategy='single_job', owner_id=self.verified.authority['owner_id'],
            binding={'ipv4':'192.0.2.1','server_id':'fictional-server','rule_id':'fictional-rule'},
            control_budget=deepcopy(data['config']['control_budget']),
            recovery_directory=str(Path.cwd()/'fictional-recovery'), recovery_directory_digest='e'*64,
            attempt_binding_digest=self.verified.binding_digest,
            worker={'mode':catalog_execution.MODE, 'payload':payload, 'node':str(Path(sys.executable).resolve()),
                'script':str(execution.COMPILED_ROOT/'scripts'/'trial-session.js'),
                'artifact_pin':{'schema':1,'head':'a'*40,'node_sha256':'a'*64,
                    'compiled_root':str(execution.COMPILED_ROOT),'entry':'scripts/trial-session.js',
                    'files':{'scripts/trial-session.js':'a'*64},'source_digest':'b'*64}})
        preflight(self.config, self.clock, 'b'*40)

    def test_preflight_requires_sealed_schema6_and_exact_local_head(self):
        execution.validate_launch_preflight(self.config, self.clock, verified_attempt=self.verified)
        for verified in (None, {'approved':True}):
            with self.subTest(verified=verified), self.assertRaises(Denied):
                execution.validate_launch_preflight(self.config, self.clock, verified_attempt=verified)
        for key in ('ci_head','reviewed_head'):
            bad = deepcopy(self.config); bad['preflight'][key] = 'a'*40
            with self.subTest(key=key), self.assertRaises(Denied):
                execution.validate_launch_preflight(bad, self.clock, verified_attempt=self.verified)

    def run_execute(self, *, resume=False):
        receipt = Mock(); receipt.mutex = threading.RLock()
        receipt.find.side_effect = lambda key: [{'request_id':'fictional'}] if resume and key=='start_intent' else []
        # Validate the real pin shape, but never inspect real compiled files.
        validate_pin = execution.validate_worker_artifact
        def artifact(*args, **kwargs): return validate_pin(*args, verify_files=False)
        with ExitStack() as stack:
            for name in ('validate_worker_directories','guardian_configuration','open_control_budget'):
                stack.enter_context(patch.object(execution, name))
            stack.enter_context(patch.object(execution, 'validate_worker_artifact', side_effect=artifact))
            stack.enter_context(patch.object(execution, 'Receipt', return_value=receipt))
            starter = stack.enter_context(patch.object(execution, 'AzureJobStarter'))
            worker = stack.enter_context(patch.object(catalog_execution, 'CatalogNodeWorker',
                side_effect=catalog_execution.CatalogNodeWorker))
            flow = stack.enter_context(patch.object(execution, 'Workflow'))
            scope = stack.enter_context(patch('scripts.trial_provision.journal.scope_for_dispatch'))
            stack.enter_context(patch.object(execution.signal, 'signal'))
            process = stack.enter_context(patch('subprocess.Popen', side_effect=AssertionError('no child')))
            flow.return_value.run.return_value = {'status':'fixture-completed'}
            result = execution.execute(self.config, clock=self.clock, verified_attempt=self.verified, owner_token_pool=Mock())
            process.assert_not_called()
            return result, starter, worker, scope

    def test_execute_real_catalog_binding_keeps_old_compiled_head(self):
        result, starter, worker, scope = self.run_execute()
        self.assertEqual(result['status'], 'fixture-completed')
        self.assertEqual(worker.call_args.kwargs['artifact_pin']['head'], 'a'*40)
        self.assertFalse(starter.call_args.kwargs['recovery_only'])
        self.assertEqual(scope.call_args.kwargs['entry_point'], 'owner-run')

    def test_canonical_v6_verifier_to_real_execution_and_catalog_worker(self):
        from scripts.trial_provision.tests import test_acknowledged_image_succession as succession
        data = succession.fixture(); original = data['counter_raw'], data['child_raw']
        # Only the historical V5 verifier is the existing fixture seam. The
        # V6 verifier, effective head, preflight, execution binding, windows,
        # policy/compiled-pin coupling and CatalogNodeWorker are production.
        self.verified = succession.verify(data)
        authority = self.verified.authority; windows = self.verified.activation['windows']
        self.clock.wall = parse(windows['initial']['start'])
        self.config.update(owner_id=authority['owner_id'], attempt_binding_digest=self.verified.binding_digest,
            control_budget=deepcopy(data['new']['config']['control_budget']))
        worker = self.config['worker']; payload = worker['payload']
        worker['artifact_pin']['head'] = authority['image_build_head']
        plan = payload['catalogPlan']; options = authority['catalog_options']
        plan['excludedDatabases'] = deepcopy(options['excluded_databases'])
        if options['temporary_owner_set']:
            plan['bootstrapOwnerSet'] = {'schema':1, 'kind':'temporary-owner-set-v1',
                'authoritySha256':attempt._proof(self.verified)['authority_sha256']}
        policy = json.loads(payload['environment']['TRIAL_POLICY_JSON'])
        policy.update(codeSha=authority['image_build_head'], startsAt=windows['initial']['start'], endsAt=windows['initial']['end'])
        policy['localOperator']['catalogPlanDigest'] = catalog_execution.catalog_digest(plan)
        payload['environment']['TRIAL_POLICY_JSON'] = json.dumps(policy)
        payload['access'].update(startsAt=windows['owner_input']['start'], endsAt=windows['owner_input']['end'])
        preflight(self.config, self.clock, authority['head'])
        result, _, worker_call, _ = self.run_execute()
        self.assertEqual(result['status'], 'fixture-completed')
        self.assertNotEqual(authority['head'], worker_call.call_args.kwargs['artifact_pin']['head'])
        self.assertEqual(original, (data['counter_raw'], data['child_raw']))
        self.assertEqual(self.verified.authority['counts_before']['owner_arm'], 302)
        self.assertEqual(attempt._proof(self.verified)['succession']['unknown_identity_receipt']['state'], 'unknown')

    def test_new_local_head_cannot_be_relabelled_as_old_compiled_output(self):
        self.config['worker']['artifact_pin']['head'] = 'b'*40
        with self.assertRaisesRegex(Denied, 'worker_artifact_head'): self.run_execute()

    def test_policy_using_new_local_head_stops_before_budget_or_job(self):
        environment = self.config['worker']['payload']['environment']
        policy = json.loads(environment['TRIAL_POLICY_JSON']); policy['codeSha'] = 'b'*40
        environment['TRIAL_POLICY_JSON'] = json.dumps(policy)
        with patch.object(execution, 'validate_worker_directories'), patch.object(execution, 'open_control_budget') as budget:
            with self.assertRaisesRegex(Denied, 'execution_attempt_binding'):
                execution.execute(self.config, verified_attempt=self.verified, owner_token_pool=Mock())
        budget.assert_not_called()

    def test_expired_initial_window_keeps_cleanup_path_without_new_child(self):
        self.clock.wall = parse(test_attempt.stamp(50000))
        result, starter, _, scope = self.run_execute(resume=True)
        self.assertEqual(result['status'], 'fixture-completed')
        self.assertTrue(starter.call_args.kwargs['recovery_only'])
        self.assertEqual(scope.call_args.kwargs['entry_point'], 'owner-cleanup')

    def test_legacy_schema1_through5_still_require_one_head(self):
        for schema in range(1,6):
            old, _ = sealed_consumer_fixture(schema=schema)
            with self.subTest(schema=schema), self.assertRaises(Denied):
                execution.validate_launch_preflight(self.config, self.clock, verified_attempt=old)
            same = deepcopy(self.config); environment=same['worker']['payload']['environment']
            policy=json.loads(environment['TRIAL_POLICY_JSON']); policy['codeSha']='b'*40
            environment['TRIAL_POLICY_JSON']=json.dumps(policy)
            execution.validate_launch_preflight(same, self.clock, verified_attempt=old)


class ReusedBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.f = test_bootstrap.BootstrapBridgeTests()
        self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.verified, _ = sealed_consumer_fixture(image_head=self.f.head, local_head='b'*40)
        self.f.config['preflight'].update(ci_head='b'*40, reviewed_head='b'*40)
        self.f.config['attempt_binding_digest'] = self.verified.binding_digest

    def bind(self, verified=True):
        original = self.f.journal.values
        def values(event):
            if event=='binding':
                value = {**original(event)[0], 'attempt':{'binding_digest':self.verified.binding_digest}}
                if hasattr(self,'new_manifest_hash'):value['manifest_sha256'] = self.new_manifest_hash
                return [value]
            return original(event)
        with patch.object(self.f.journal, 'values', side_effect=values):
            return bootstrap.bind_bootstrap(self.f.bundle,self.f.journal,self.f.resolver,self.f.clock,
                verify_policy=lambda env:json.loads(env['TRIAL_POLICY_JSON']),
                verified_attempt=self.verified if verified else None)

    def test_protected_bootstrap_proof_and_runtime_policy_keep_image_head(self):
        self.f.finish(); result = self.bind()
        self.assertTrue(result['bootstrapBound'])
        self.assertEqual(self.f.journal.latest('trialDatabaseBootstrap')['properties']['code_sha'], self.f.head)
        self.f.resolver.make_runtime_binding.assert_called_once()

    def test_old_proof_cannot_implicitly_authorize_split_without_seal(self):
        self.f.finish()
        with self.assertRaises(Denied): self.bind(verified=False)
        self.assertFalse(self.f.journal.values('intent')[-1]['operation_id']=='trialDatabaseBootstrap')

    def v7(self):
        proof = attempt._proof(self.verified)
        self.new_manifest_hash = 'd'*64
        proof['authority'].update(schema=7,manifest_sha256=self.new_manifest_hash,
            origin_manifest_sha256=self.f.config['control_budget']['binding']['manifest_sha256'])
        self.verified = attempt.VerifiedAttempt(proof,attempt._SEAL)
        self.f.config['attempt_binding_digest'] = self.verified.binding_digest

    def test_v7_bootstrap_keeps_original_budget_and_new_child_manifest(self):
        self.v7(); self.f.finish()
        self.assertTrue(self.bind()['bootstrapBound'])

    def test_v7_bootstrap_rejects_rebased_lifetime_counter(self):
        self.v7(); self.f.config['control_budget']['binding']['manifest_sha256'] = self.new_manifest_hash
        self.f.finish()
        with self.assertRaises(Denied):self.bind()
        self.f.resolver.make_runtime_binding.assert_not_called()

    def test_unapproved_local_head_or_mismatched_child_is_rejected(self):
        self.f.config['attempt_binding_digest']='c'*64; self.f.finish()
        with self.assertRaises(Denied): self.bind()
        self.f.resolver.make_runtime_binding.assert_not_called()


if __name__ == '__main__': unittest.main()
