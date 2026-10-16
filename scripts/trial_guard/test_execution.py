"""Real adapter contracts with fictional ARM replies; no network or CLI calls.

The sole real child is a temporary Python program that sleeps without reading
stdin. It holds no credentials, database connection, or external capability.
"""
import json
import hashlib
import os
import sys
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from .adapters import Deadline, digest, encoded
from .execution import AzureJobStarter, CountedHttp, NodeWorker, open_control_budget, execute, validate_worker_artifact, execution_binding, guardian_configuration
from .lifecycle import Denied
from .test_lifecycle import Clock
from .workflow import Receipt
from scripts.trial_provision.journal import ControlBudget, CountedControlHttp


class ArmFixture:
    def __init__(self):
        self.clock = Clock()
        self.request_id = '11111111-1111-4111-8111-111111111111'
        self.job = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.App/jobs/guard'
        environment = self.job.rsplit('/jobs/', 1)[0] + '/managedEnvironments/fictional'
        image_digest = 'sha256:' + 'a' * 64
        self.template = {'containers': [{'name': 'guard', 'image': 'fictional.azurecr.io/guard@' + image_digest,
            'env': [{'name': 'FICTIONAL_MODE', 'value': 'test'}]}], 'initContainers': []}
        self.identity = {'type': 'UserAssigned', 'userAssignedIdentities': {'fictional-identity': {'principalId': 'fictional-principal'}}}
        self.config = {'live_enabled': True, 'cleanup_strategy': 'single_job',
            'prearm_until': (self.clock.utc() + timedelta(minutes=5)).isoformat(),
            'owner_permissions_until': (self.clock.utc() + timedelta(hours=1)).isoformat(),
            'seed_not_before': (self.clock.utc() - timedelta(seconds=1)).isoformat(),
            'owner_id': 'fictional-owner', 'tenant_id': 'fictional-tenant', 'cloud_guard': {'nonce': 'fictional-nonce'},
            'guardian_job': {'resource_id': self.job, 'environment_id': environment,
                'template': deepcopy(self.template), 'template_digest': digest(self.template),
                'identity_digest': digest(self.identity), 'image_digest': image_digest,
                'principal_id': 'fictional-principal', 'readback_verified': True,
                'execution_schema_verified': True, 'approved': True}}
        self.job_reply = {'id': self.job, 'identity': deepcopy(self.identity), 'properties': {
            'environmentId': environment, 'template': deepcopy(self.template),
            'configuration': {'triggerType': 'Manual', 'replicaTimeout': 1800, 'replicaRetryLimit': 0,
                'manualTriggerConfig': {'parallelism': 1, 'replicaCompletionCount': 1}}}}
        self.execution_id = self.job + '/executions/guard-one'
        execution_template = deepcopy(self.template)
        execution_template['containers'][0]['env'].append({'name': 'TRIAL_GUARD_REQUEST_ID', 'value': self.request_id})
        self.execution_reply = {'id': self.execution_id, 'properties': {'template': execution_template,
            'startTime': self.clock.utc().isoformat(), 'status': 'Running'}}
        self.collection = None
        self.replicas = {'value': [{'name': 'guard-one-replica'}]}
        self.post_error = None
        self.post_reply = {'id': self.execution_id}
        self.calls = []

    def wire(self, method, url, headers, body, deadline):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'management.azure.com' or parsed.query != 'api-version=2025-07-01':
            raise AssertionError('unexpected fictional transport target')
        if not parsed.path.startswith(self.job):
            raise AssertionError('unexpected fictional resource')
        suffix = parsed.path[len(self.job):]
        self.calls.append((method, suffix, None if body is None else json.loads(body)))
        deadline.remaining()
        if method == 'POST' and suffix == '/start':
            if self.post_error:
                raise self.post_error
            return {'status': 202, 'headers': {}, 'body': encoded(self.post_reply)}
        if method != 'GET':
            raise AssertionError('unexpected mutation')
        values = {'': self.job_reply, '/executions': self.collection if self.collection is not None else {'value': [self.execution_reply]},
            '/executions/guard-one': self.execution_reply, '/executions/guard-one/replicas': self.replicas}
        if suffix not in values:
            raise AssertionError('unexpected execution')
        if isinstance(values[suffix], Exception):
            raise values[suffix]
        return {'status': 200, 'headers': {}, 'body': encoded(values[suffix])}

    def starter(self, **kwargs):
        return AzureJobStarter(self.config, self.wire, self.clock, **kwargs)

    def posts(self):
        return [call for call in self.calls if call[0] == 'POST']


class AzureJobExecutionTests(unittest.TestCase):
    def setUp(self):
        self.f = ArmFixture()
        self.credentials = patch(__package__ + '.execution.AzureCredential')
        self.credential_class = self.credentials.start()
        self.credential_class.return_value.token.return_value = 'fictional-token'
        self.addCleanup(self.credentials.stop)

    def main_configuration(self,f):
        c=f.config;j=c['guardian_job'];base=deepcopy(f.template)
        base['containers'][0].update(command=['python','-m','trial_guard'],resources={'cpu':0.25,'memory':'0.5Gi'},env=[])
        f.template=base;j['template']=deepcopy(base);j['template_digest']=digest(base)
        f.job_reply['properties']['template']=deepcopy(base)
        c.update(binding={'mode':'guardian','lifecycle_id':'fixed-life','rule_id':'fixed-rule'},owner_access={'fixed':'owner'},cleanup_targets_digest='b'*64,journal_url='https://fictional.blob.core.windows.net/guard/state.json')
        c['cloud_guard']={'execution_id':f.job+'/executions/$CURRENT','replica_name':'$CURRENT','image_digest':j['image_digest'],
            'principal_id':j['principal_id'],'nonce':'fictional-nonce-with-length','job_started_at':'$CURRENT','job_deadline':'$CURRENT'}
        fixed={k:'$CURRENT' for k in ('prepared_at','cleanup_at','deadline','ready_until')}
        fixed.update(lifecycle_id='fixed-life',rule_id='fixed-rule',cleanup_strategy='single_job',owner_access=deepcopy(c['owner_access']),
            cleanup_targets_digest=c['cleanup_targets_digest'],cloud_guard=deepcopy(c['cloud_guard']),successor_id=None,successor_nonce=None,successor_runtime=None)
        c['guardian_config']={k:deepcopy(c[k]) for k in ('live_enabled','tenant_id','journal_url','prearm_until','seed_not_before','binding')}
        c['guardian_config'].update(mode='main',job_name='guard',immutable=fixed)
        f.execution_reply['properties']['template']=f.starter()._template(f.request_id)

    def test_main_start_supplies_exact_guardian_override_without_changing_base_template(self):
        self.main_configuration(self.f)
        result=self.f.starter().start(self.f.request_id)
        self.assertEqual(result['execution_id'],self.f.execution_id)
        env=self.f.posts()[0][2]['containers'][0]['env']
        self.assertEqual(json.loads(env[0]['value']),self.f.config['guardian_config'])
        self.assertEqual(env[1],{'name':'TRIAL_GUARD_REQUEST_ID','value':self.f.request_id})
        self.assertEqual(self.f.config['guardian_job']['template']['containers'][0]['env'],[])

    def test_main_wrong_owner_binding_placeholder_scope_or_extra_field_blocks_credentials(self):
        self.main_configuration(self.f)
        for path,value in ((('mode',),'rehearsal'),(('tenant_id',),'different'),(('immutable','owner_access'),{}),
                (('immutable','cloud_guard','execution_id'),self.f.execution_id),(('immutable','deadline'),'fictional'),(('extra',),True)):
            c=deepcopy(self.f.config);target=c['guardian_config']
            for key in path[:-1]:target=target[key]
            target[path[-1]]=value;self.credential_class.reset_mock()
            with self.assertRaisesRegex(Denied,'guardian_configuration'):AzureJobStarter(c,self.f.wire,self.f.clock)
            self.credential_class.assert_not_called()

    def test_main_unknown_start_recovery_rejects_wrong_guardian_override_without_resend(self):
        self.main_configuration(self.f);starter=self.f.starter();self.f.post_error=TimeoutError()
        with self.assertRaises(TimeoutError):starter.start(self.f.request_id)
        env=self.f.execution_reply['properties']['template']['containers'][0]['env']
        env[0]['value']='{}'
        with self.assertRaisesRegex(Denied,'start_reconciliation_unknown'):starter.recover(self.f.request_id,None)
        self.assertEqual(len(self.f.posts()),1)

    def test_main_oversized_config_and_nonfixed_container_are_rejected(self):
        self.main_configuration(self.f);c=deepcopy(self.f.config)
        c['binding']['large']='x'*65536;c['guardian_config']['binding']=deepcopy(c['binding'])
        with self.assertRaisesRegex(Denied,'guardian_configuration'):guardian_configuration(c)
        self.f.config['guardian_job']['template']['containers'][0]['env']=[{'name':'OTHER','value':'x'}]
        self.f.config['guardian_job']['template_digest']=digest(self.f.config['guardian_job']['template'])
        with self.assertRaisesRegex(Denied,'job_template'):self.f.starter()._template(self.f.request_id)

    def test_exact_job_template_identity_and_replica_are_verified_before_runtime_is_returned(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.assertEqual([(method, suffix) for method, suffix, _ in self.f.calls],
            [('GET', ''), ('POST', '/start'), ('GET', '/executions/guard-one'), ('GET', '/executions/guard-one/replicas')])
        self.assertEqual(runtime['execution_id'], self.f.execution_id)
        self.assertEqual(runtime['replica_name'], 'guard-one-replica')
        self.assertEqual(runtime['principal_id'], 'fictional-principal')
        self.assertEqual(runtime['job_deadline'], (self.f.clock.utc() + timedelta(minutes=30)).isoformat())
        sent = self.f.posts()[0][2]
        self.assertEqual(sent, self.f.execution_reply['properties']['template'])
        self.assertEqual(self.f.config['guardian_job']['template'], self.f.template)

    def test_unverified_preflight_never_constructs_credentials_or_calls_wire(self):
        for field in ('approved', 'readback_verified', 'execution_schema_verified'):
            with self.subTest(field=field):
                f = ArmFixture(); f.config['guardian_job'][field] = False
                with self.assertRaisesRegex(Denied, 'guardian_job_preflight'):
                    f.starter()
                self.assertEqual(f.calls, [])
        self.credential_class.assert_not_called()

    def test_changed_job_target_configuration_template_or_identity_never_posts(self):
        alterations = [
            (('id',), 'different'), (('identity',), {'type': 'SystemAssigned'}),
            (('properties', 'environmentId'), 'different'),
            (('properties', 'template', 'containers', 0, 'image'), 'different'),
            (('properties', 'configuration', 'triggerType'), 'Schedule'),
            (('properties', 'configuration', 'replicaTimeout'), 1801),
            (('properties', 'configuration', 'replicaRetryLimit'), 1),
            (('properties', 'configuration', 'manualTriggerConfig', 'parallelism'), 2),
            (('properties', 'configuration', 'manualTriggerConfig', 'replicaCompletionCount'), 2),
        ]
        for path, value in alterations:
            with self.subTest(path=path):
                f = ArmFixture(); item = f.job_reply
                for key in path[:-1]: item = item[key]
                item[path[-1]] = value
                with self.assertRaisesRegex(Denied, 'guardian_job_changed'):
                    f.starter().start(f.request_id)
                self.assertEqual(f.posts(), [])

    def test_unknown_start_is_not_retried_and_can_only_be_reconciled_by_matching_gets(self):
        starter = self.f.starter(); self.f.post_error = TimeoutError('fictional response loss')
        with self.assertRaises(TimeoutError): starter.start(self.f.request_id)
        self.assertEqual(len(self.f.posts()), 1)
        runtime = starter.recover(self.f.request_id, None)
        self.assertEqual(runtime['execution_id'], self.f.execution_id)
        self.assertEqual(len(self.f.posts()), 1)
        self.assertIn(('GET', '/executions'), [(method, suffix) for method, suffix, _ in self.f.calls])

    def test_start_ack_without_execution_id_remains_unknown_without_a_second_post(self):
        starter = self.f.starter(); self.f.post_reply = {}
        with self.assertRaisesRegex(Denied, 'start_outcome_unknown'): starter.start(self.f.request_id)
        starter.recover(self.f.request_id, None)
        self.assertEqual(len(self.f.posts()), 1)

    def test_recovery_rejects_empty_duplicate_partial_and_foreign_request_collections(self):
        foreign = deepcopy(self.f.execution_reply)
        foreign['properties']['template']['containers'][0]['env'][-1]['value'] = 'different-request'
        for collection in ({'value': []}, {'value': [self.f.execution_reply, self.f.execution_reply]},
            {'value': [self.f.execution_reply], 'nextLink': 'fictional-next'}, {'value': [foreign]},
            {'value': [self.f.execution_reply] * 51}):
            with self.subTest(collection_kind=list(collection)):
                f = ArmFixture(); f.collection = deepcopy(collection)
                with self.assertRaises(Denied): f.starter().recover(f.request_id, None)
                self.assertEqual(f.posts(), [])

    def test_exact_execution_and_replica_binding_reject_substitution_or_partial_results(self):
        with self.assertRaisesRegex(Denied, 'execution_target'):
            self.f.starter().recover(self.f.request_id, self.f.job + '/executions/foreign-one')
        self.assertEqual(self.f.calls, [])
        for replicas in ({'value': []}, {'value': [{'name': 'foreign-one'}]},
            {'value': [{'name': 'guard-one-a'}, {'name': 'guard-one-b'}]},
            {'value': [{'name': 'guard-one-a'}], 'nextLink': 'fictional-next'}):
            with self.subTest(replicas=replicas):
                f = ArmFixture(); f.replicas = replicas
                with self.assertRaisesRegex(Denied, 'replica_unconfirmed'):
                    f.starter().recover(f.request_id, f.execution_id)
                self.assertEqual(f.posts(), [])
        f = ArmFixture(); f.execution_reply['properties']['template']['containers'][0]['env'][-1]['value'] = 'different-request'
        with self.assertRaisesRegex(Denied, 'execution_binding'):
            f.starter().recover(f.request_id, f.execution_id)

    def test_expired_prearm_blocks_new_start_but_terminal_recovery_uses_recorded_replica(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(1900)
        with self.assertRaisesRegex(Denied, 'prearm_window'): self.f.starter()
        for status in ('Succeeded', 'Failed', 'Stopped'):
            with self.subTest(status=status):
                self.f.execution_reply['properties']['status'] = status
                self.f.replicas = AssertionError('terminal recovery must use verified historical replica')
                self.f.calls.clear()
                starter = self.f.starter(recovery_only=True, recorded_runtime=runtime)
                with self.assertRaisesRegex(Denied, 'recovery_only'): starter.start(self.f.request_id)
                self.assertEqual(starter.recover(self.f.request_id, self.f.execution_id), runtime)
                self.assertEqual(starter.status, status)
                self.assertEqual([(method, suffix) for method, suffix, _ in self.f.calls], [('GET', '/executions/guard-one')])

    def test_exact_get_rejects_another_execution_even_with_identical_template(self):
        for discover in (False,True):
            with self.subTest(discover=discover):
                f=ArmFixture()
                # A matching collection must not let the following exact GET
                # substitute a different execution from the same Job/template.
                f.collection={'value':[deepcopy(f.execution_reply)]}
                f.execution_reply['id']=f.job+'/executions/guard-other'
                with self.assertRaisesRegex(Denied,'execution_binding'):
                    f.starter().recover(f.request_id,None if discover else f.execution_id)
                self.assertEqual(f.posts(),[])
                self.assertFalse(any(suffix.endswith('/replicas') for _,suffix,_ in f.calls))

    def test_running_recovery_still_checks_current_replica_and_does_not_assert_historical_liveness(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(310); self.f.calls.clear(); self.f.replicas = {'value': []}
        with self.assertRaisesRegex(Denied, 'replica_unconfirmed'):
            self.f.starter(recovery_only=True, recorded_runtime=runtime).recover(self.f.request_id, self.f.execution_id)
        self.assertEqual(self.f.posts(), [])

    def test_terminal_recovery_rejects_changed_recorded_runtime(self):
        runtime = self.f.starter().start(self.f.request_id)
        self.f.clock.advance(1900); self.f.execution_reply['properties']['status'] = 'Succeeded'
        for field in ('execution_id', 'job_started_at', 'image_digest', 'principal_id', 'nonce', 'replica_name'):
            with self.subTest(field=field):
                changed = {**runtime, field: 'different'}; self.f.calls.clear()
                with self.assertRaises(Denied):
                    self.f.starter(recovery_only=True, recorded_runtime=changed).recover(self.f.request_id, self.f.execution_id)
                self.assertEqual(self.f.posts(), [])

    def test_final_permission_fence_blocks_recovery_after_owner_access_expiry(self):
        self.f.clock.advance(3600)
        with self.assertRaisesRegex(Denied, 'receiver_permission_expired'):
            self.f.starter(recovery_only=True).recover(self.f.request_id, self.f.execution_id)
        self.assertEqual(self.f.calls, [])

    def test_failed_request_count_is_preserved_when_the_private_receipt_is_reopened(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory).resolve()); proof = digest(path)
            first = Receipt(path, proof, 'fictional-configuration')
            wire = Mock(side_effect=TimeoutError('fictional response loss'))
            try:
                with self.assertRaises(TimeoutError):
                    CountedHttp(wire, first)('GET', 'https://management.azure.com/fictional', {}, None, Deadline(1))
            finally: first.close()
            second = Receipt(path, proof, 'fictional-configuration')
            try:
                self.assertEqual(second.count('owner_arm'), 1)
                with self.assertRaisesRegex(Denied, 'request_budget'): second.consume('owner_arm', 1)
                self.assertEqual(second.count('owner_arm'), 1)
            finally: second.close()
            wire.assert_called_once()


class SharedLifetimeBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        path=str(Path(self.temp.name).resolve())
        self.config={'live_enabled':True,'owner_id':'11111111-1111-4111-8111-111111111111',
            'control_budget':{'directory':path,'directory_digest':digest(path),
                'binding':{'manifest_sha256':'a'*64,'owner_id':'11111111-1111-4111-8111-111111111111',
                    'task_id':'fictional-lifetime-task','source_sha256':'b'*64},
                'seed':{'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}}}

    def establish(self):
        c=self.config['control_budget']
        return ControlBudget(c['directory'],c['directory_digest'],c['binding'],seed=c['seed'])

    def execution_config(self):
        value=deepcopy(self.config)
        value.update({key:{} for key in ('guardian_job','binding','owner_access')})
        value.update(cleanup_strategy='single_job',journal_url='fictional-journal',prearm_until='fictional',
            seed_not_before='fictional',worker={'payload':{'requests':[],'azureCliPython':str(Path(sys.executable).resolve())}},
            recovery_directory=self.config['control_budget']['directory'],
            recovery_directory_digest=self.config['control_budget']['directory_digest'])
        return value

    def test_guardian_cannot_initialize_or_reset_missing_lifetime_file(self):
        with self.assertRaisesRegex(Denied,'shared_control_budget_unconfirmed'):
            open_control_budget(self.config)
        self.assertFalse((Path(self.temp.name)/'trial-control-budget.jsonl').exists())
        changed=deepcopy(self.config);changed.pop('control_budget')
        with self.assertRaisesRegex(Denied,'shared_control_budget_unconfirmed'):
            open_control_budget(changed)

    def test_missing_existing_lock_is_not_recreated_by_guardian(self):
        with self.establish():pass
        lock=Path(self.temp.name)/'trial-control-budget.lock'
        lock.unlink()
        with self.assertRaises(Denied):open_control_budget(self.config)
        self.assertFalse(lock.exists())

    def test_empty_existing_ledger_is_not_reinitialized(self):
        with self.establish():pass
        ledger=Path(self.temp.name)/'trial-control-budget.jsonl'
        ledger.write_bytes(b'')
        with self.assertRaises(Denied):open_control_budget(self.config)
        self.assertEqual(b'',ledger.read_bytes())

    def test_provision_and_guardian_share_counts_across_reopen_and_unknown(self):
        with self.establish() as budget:
            CountedControlHttp(Mock(return_value={}),budget)(
                'GET','https://graph.microsoft.com/v1.0/fictional',{},None,Deadline(1))
            self.assertEqual(129,budget.count('owner_arm'))
        phase=Mock();wire=Mock(side_effect=TimeoutError('unknown'))
        with open_control_budget(self.config) as budget:
            counted=CountedHttp(wire,phase,shared_budget=budget)
            for host,heartbeat in (('management.azure.com',False),('fictional.blob.core.windows.net',False),
                    ('fictional.blob.core.windows.net',True)):
                with self.assertRaises(TimeoutError):
                    counted.for_purpose('heartbeat_blob' if heartbeat else 'owner_control_blob')('GET','https://'+host+'/fixed',{},None,Deadline(1))
        with open_control_budget(self.config) as budget:
            self.assertEqual([130,33,1],[budget.count(k) for k in ('owner_arm','owner_control_blob','heartbeat_blob')])
        self.assertEqual(3,wire.call_count)
        self.assertEqual([('owner_arm',600),('owner_control_blob',3000),('heartbeat_blob',5250)],
            [c.args for c in phase.consume.call_args_list])

    def test_lifetime_exhaustion_blocks_new_phase_before_audit_and_wire(self):
        with self.establish() as budget:
            for _ in range(600-128):budget.consume('owner_arm',600)
        phase,wire=Mock(),Mock()
        with open_control_budget(self.config) as budget:
            with self.assertRaisesRegex(Denied,'request_budget'):
                CountedHttp(wire,phase,shared_budget=budget)(
                    'GET','https://management.azure.com/fixed',{},None,Deadline(1))
        phase.consume.assert_not_called();wire.assert_not_called()

    def test_phase_audit_failure_keeps_one_lifetime_reservation_without_send(self):
        phase=Mock();phase.consume.side_effect=OSError('audit-unknown');wire=Mock()
        with self.establish():pass
        with open_control_budget(self.config) as budget:
            with self.assertRaises(OSError):
                CountedHttp(wire,phase,shared_budget=budget)(
                    'GET','https://management.azure.com/fixed',{},None,Deadline(1))
            self.assertEqual(129,budget.count('owner_arm'))
        wire.assert_not_called()

    def test_changed_owner_manifest_task_source_seed_or_directory_cannot_rebind(self):
        with self.establish():pass
        changes=[('owner_id','other'),('manifest_sha256','c'*64),('task_id','different-task'),('source_sha256','c'*64)]
        for key,value in changes:
            changed=deepcopy(self.config);changed['control_budget']['binding'][key]=value
            with self.subTest(field=key),self.assertRaises(Denied):open_control_budget(changed)
        changed=deepcopy(self.config);changed['control_budget']['seed']['owner_arm']=0
        with self.assertRaises(Denied):open_control_budget(changed)
        changed=deepcopy(self.config);changed['control_budget']['directory_digest']='c'*64
        with self.assertRaises(Denied):open_control_budget(changed)
        with open_control_budget(self.config) as budget:self.assertEqual(128,budget.count('owner_arm'))

    def test_head_or_time_window_change_does_not_reset_lifetime_binding(self):
        with self.establish() as budget:budget.consume('owner_arm',600)
        changed={**self.config,'new_head':'c'*40,'prearm_until':'different-window'}
        with open_control_budget(changed) as budget:self.assertEqual(129,budget.count('owner_arm'))

    def test_live_execute_requires_budget_before_receipt_auth_or_worker(self):
        config=self.execution_config();config.pop('control_budget')
        with patch(__package__+'.execution.validate_worker_directories'),patch(__package__+'.execution.Receipt') as receipt,patch(__package__+'.execution.AzureJobStarter') as starter,patch(__package__+'.execution.NodeWorker') as worker:
            with self.assertRaisesRegex(Denied,'shared_control_budget_unconfirmed'):execute(config)
        receipt.assert_not_called();starter.assert_not_called();worker.assert_not_called()

    def test_legacy_fresh_execution_rejection_releases_budget_lock_without_send(self):
        with self.establish():pass
        config=self.execution_config();wire=Mock()
        with patch(__package__+'.execution.validate_worker_directories'),patch(__package__+'.execution.validate_launch_preflight',side_effect=Denied('offline-preflight')):
            with self.assertRaisesRegex(Denied,'catalog_stage_required'):execute(config,http=wire)
        wire.assert_not_called()
        with open_control_budget(self.config) as budget:self.assertEqual(128,budget.count('owner_arm'))

    def test_invalid_control_host_never_charges_lifetime_or_audit(self):
        budget,phase,wire=Mock(),Mock(),Mock()
        counted=CountedHttp(wire,phase,shared_budget=budget)
        for url in ('http://management.azure.com/fixed','https://user@management.azure.com/fixed',
                'https://management.azure.com:444/fixed','https://management.azure.com/fixed#x',
                'https://graph.microsoft.com/v1.0/fixed'):
            with self.subTest(url=url),self.assertRaises(Denied):counted('GET',url,{},None,Deadline(1))
        budget.consume.assert_not_called();phase.consume.assert_not_called();wire.assert_not_called()


class ArtifactPinTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()/'.koho-ops'/'managed';(self.root/'scripts').mkdir(parents=True)
        self.script=self.root/'scripts'/'trial-session.js';self.script.write_bytes(b'// fictional source\n')
        self.node=Path(self.temp.name).resolve()/'node.exe';self.node.write_bytes(b'fictional node, never executed')
        self.pin={'schema':1,'head':'a'*40,'node_sha256':hashlib.sha256(self.node.read_bytes()).hexdigest(),
            'compiled_root':str(self.root),'entry':'scripts/trial-session.js','files':{'scripts/trial-session.js':hashlib.sha256(self.script.read_bytes()).hexdigest()},'source_digest':'b'*64}
        p=patch(__package__+'.execution.COMPILED_ROOT',self.root);p.start();self.addCleanup(p.stop)
    def validate(self,pin=None):validate_worker_artifact(str(self.node),str(self.script),self.pin if pin is None else pin,verify_files=True)
    def test_exact_binary_and_complete_emit_are_verified_without_process(self):
        with patch(__package__+'.execution.subprocess.Popen') as child:self.validate()
        child.assert_not_called()
    def test_changed_binary_changed_emit_extra_emit_and_missing_emit_all_fail(self):
        for path,raw in ((self.node,b'changed'),(self.script,b'changed'),(self.root/'extra.js',b'//extra')):
            old=path.read_bytes() if path.exists() else None;path.write_bytes(raw)
            with self.subTest(kind=path.name),self.assertRaisesRegex(Denied,'worker_artifact_unconfirmed'):self.validate()
            if old is None:path.unlink()
            else:path.write_bytes(old)
        self.script.unlink()
        with self.assertRaises(Denied):self.validate()
    def test_noncanonical_and_case_alias_paths_cannot_escape_or_expand_fixed_root(self):
        for name in ('../outside.js','scripts/../outside.js','/root.js','scripts\\other.js','scripts//other.js','scripts/./other.js','scripts/other.js:stream','Scripts/trial-session.js'):
            p=deepcopy(self.pin);p['files'][name]='c'*64
            with self.subTest(name=name),self.assertRaises(Denied):self.validate(p)
        p=deepcopy(self.pin);p['compiled_root']=str(self.root.parent)
        with self.assertRaises(Denied):self.validate(p)
    def test_symlink_or_reparse_entry_rejected_before_hash(self):
        actual=Path.lstat
        def lstat(path,*a,**k):
            value=actual(path,*a,**k)
            if path==self.script:
                from types import SimpleNamespace
                return SimpleNamespace(st_file_attributes=1024,st_mode=value.st_mode)
            return value
        with patch.object(Path,'lstat',lstat),self.assertRaises(Denied):self.validate()
    def test_mutation_after_constructor_is_rejected_before_child_spawn(self):
        worker=NodeWorker(str(self.node),str(self.script),{'requests':[]},artifact_pin=self.pin)
        self.script.write_bytes(b'changed-after-validation')
        with patch(__package__+'.execution.subprocess.Popen') as child,self.assertRaises(Denied):worker.start({}, {})
        child.assert_not_called()
    def test_inherited_node_options_and_search_path_block_new_start_not_cleanup(self):
        for name in ('NODE_OPTIONS','NODE_PATH'):
            with patch.dict(os.environ,{name:'fictional-injection'}):
                worker=NodeWorker(str(self.node),str(self.script),{'requests':[]},artifact_pin=self.pin)
                self.assertTrue(worker.stop())
                with self.assertRaises(Denied):self.validate()
                with patch(__package__+'.execution.subprocess.Popen') as child,self.assertRaisesRegex(Denied,'worker_node_environment'):worker.start({}, {})
                child.assert_not_called()
    def test_cleanup_constructor_accepts_missing_artifacts_but_start_never_does(self):
        self.script.unlink();self.node.unlink()
        worker=NodeWorker(str(self.node),str(self.script),{'requests':[]},artifact_pin=self.pin)
        self.assertTrue(worker.stop())
        with patch(__package__+'.execution.subprocess.Popen') as child,self.assertRaises(Denied):worker.start({}, {})
        child.assert_not_called()
    def test_binding_changes_for_each_pin_network_and_guardian_input(self):
        c={k:{} for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
        c['worker']={'payload':{'requests':[]},'artifact_pin':deepcopy(self.pin)}
        baseline=execution_binding(c)
        c['worker']['artifact_pin']['source_digest']='c'*64
        self.assertNotEqual(baseline,execution_binding(c))
        c['worker']['artifact_pin']=deepcopy(self.pin);c['network_source_binding']={'source_sha256':'c'*64}
        self.assertNotEqual(baseline,execution_binding(c))
        c.pop('network_source_binding');c['guardian_config']={'mode':'main'}
        self.assertNotEqual(baseline,execution_binding(c))
    def test_execute_new_artifact_failure_precedes_credential_and_job(self):
        c={k:{} for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
        c.update(live_enabled=True,recovery_directory='fictional',recovery_directory_digest='a'*64)
        c['worker']={'node':str(self.node),'script':str(self.script),'payload':{'requests':[],'azureCliPython':str(Path(sys.executable).resolve())},'artifact_pin':deepcopy(self.pin)}
        receipt=Mock();receipt.find.return_value=[];self.script.write_bytes(b'changed')
        with patch(__package__+'.execution.validate_worker_directories'),patch(__package__+'.execution.validate_launch_preflight'),patch(__package__+'.execution.open_control_budget'),patch(__package__+'.execution.Receipt',return_value=receipt),patch(__package__+'.execution.AzureJobStarter') as starter,patch(__package__+'.execution.NodeWorker') as worker:
            with self.assertRaises(Denied):execute(c)
        starter.assert_not_called();worker.assert_not_called();receipt.close.assert_called_once()
    def test_execute_existing_intent_can_resume_cleanup_after_artifacts_disappear(self):
        c={k:{} for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
        c.update(live_enabled=True,recovery_directory='fictional',recovery_directory_digest='a'*64)
        c['worker']={'node':str(self.node),'script':str(self.script),'payload':{'requests':[],'azureCliPython':str(Path(sys.executable).resolve())},'artifact_pin':deepcopy(self.pin)}
        receipt=Mock();receipt.find.side_effect=lambda event:[{'request_id':'existing'}] if event=='start_intent' else []
        self.node.unlink();self.script.unlink()
        with patch(__package__+'.execution.validate_worker_directories'),patch(__package__+'.execution.validate_launch_preflight') as preflight,patch(__package__+'.execution.guardian_configuration'),patch(__package__+'.execution.open_control_budget'),patch(__package__+'.execution.Receipt',return_value=receipt),patch(__package__+'.execution.AzureJobStarter') as starter,patch(__package__+'.execution.Workflow') as workflow,patch(__package__+'.execution.subprocess.Popen') as child,patch.dict(os.environ,{'NODE_OPTIONS':'fictional-injection'}):
            workflow.return_value.run.return_value={'status':'reconciliation_required','cleanupConfirmed':True,'workComplete':False}
            self.assertTrue(execute(c)['cleanupConfirmed'])
        preflight.assert_not_called();child.assert_not_called()
        self.assertTrue(starter.call_args.kwargs['recovery_only'])
        self.assertIsInstance(workflow.call_args.args[3],NodeWorker)


class NodeWorkerPipeTests(unittest.TestCase):
    def test_full_stdin_pipe_and_nonreading_child_cannot_block_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            # Python accepts a script with this suffix; NodeWorker still uses
            # its exact production argv shape, shell=False and direct-child kill.
            script = Path(directory) / 'trial-session.js'
            script.write_text('import time\ntime.sleep(60)\n', encoding='utf-8')
            worker = NodeWorker(str(Path(sys.executable).resolve()), str(script.resolve()), {'requests': [], 'fixture': 'x' * (1024 * 1024)})
            stopped = threading.Event(); outcome = []
            try:
                with self.assertRaisesRegex(Denied, 'worker_pipe_unconfirmed'):
                    worker.start({'useUntil': 'fictional'}, {'type': 'permit'})
                self.assertIsNone(worker.child.poll())
                def stop():
                    try: outcome.append(worker.stop())
                    except Exception: outcome.append(False)
                    finally: stopped.set()
                threading.Thread(target=stop, daemon=True).start()
                self.assertTrue(stopped.wait(6), 'stop waited on a blocked stdin flush/lock')
                self.assertEqual(outcome, [True])
                self.assertIsNotNone(worker.child.poll())
                self.assertTrue(worker.stop())
            finally:
                if worker.child is not None:
                    if worker.child.poll() is None: worker.child.kill()
                    worker.child.wait(timeout=3)
                    # Once the reader is dead, a blocked writer gets BrokenPipe;
                    # do not make test cleanup itself an unbounded pipe close.
                    def close_pipes():
                        for stream in (worker.child.stdin, worker.child.stdout):
                            try: stream.close()
                            except (BrokenPipeError, OSError): pass
                    cleanup = threading.Thread(target=close_pipes, daemon=True)
                    cleanup.start(); cleanup.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
