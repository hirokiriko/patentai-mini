"""Offline protected-artifact/real-journal bootstrap proof contracts."""
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.execution import NodeWorker, execution_binding, validate_worker_python, validate_worker_directories, execute
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_guard.test_lifecycle import Clock
from scripts.trial_guard.workflow import Receipt
from scripts.trial_provision.bootstrap import bind_bootstrap
from scripts.trial_provision.journal import Journal
from scripts.trial_provision.private_io import create_owner_file
from scripts.trial_provision.resources import _time as resource_time
from scripts.trial_provision import private_io
from . import test_cli as cli_fixtures


class BootstrapBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name).resolve(); self.clock=Clock()
        self.head='e'*40
        self.database={'host':'fictional.postgres.database.azure.com','port':5432,'database':'trial_db',
            'ownerRole':'trial_owner','migratorUser':'trial_migrator','webUser':'trial_web','workerUser':'trial_worker'}
        self.manifest={'owner':{'principal_id':'fictional-owner','tenant_id':'fictional-tenant'},
            'ids':{'guard':'/fictional/jobs/guard'},'existing':{'environment':'fictional-env','db':'/fictional'},
            'db':{'name':'trial_db','web':'trial_web','worker':'trial_worker'}}
        self.template={'containers':[{'name':'guard','image':'fictional@sha256:'+'a'*64}]}
        self.ops={'guard':{'id':'guard','method':'PUT','body':{'properties':{'template':deepcopy(self.template)}}},
            'guardMainConfiguration':{'id':'guardMainConfiguration','method':'PATCH',
                'body':{'properties':{'configuration':{'replicaTimeout':1800}}},
                'expected':{'properties':{'properties.template':deepcopy(self.template)}}}}
        self.binding={'manifest_sha256':'a'*64,'owner_id':'fictional-owner','task_id':'fictional-task'}
        self.journal=Journal(str(self.directory),digest(str(self.directory)),self.binding)
        self.addCleanup(self.journal.close)
        for key,op in self.ops.items():
            op.update(url='https://management.azure.com/fictional',deadline='2026-10-11T03:00:00Z')
            self.journal.intent(op,'2026-10-11T00:00:00Z')
            self.journal.checkpoint(op,{'operation_id':key,'request_digest':digest(op),'object_id':'/fictional/jobs/guard',
                'state':'succeeded','terminal':True,'write_terminal':True,'created_by_run':True,'readback_verified':True,
                'properties':{'principalId':'fictional-guardian'}})
        self.resolver=Mock()
        self.resolver._manifest=self.manifest;self.resolver.plan_digest='d'*64
        self.resolver.initial_plan={'resource_bindings':{'code_sha':self.head},'windows':{'owner_input':{'end':'2026-10-11T01:00:00Z'}}}
        self.resolver.resolve=lambda ident,receipts:deepcopy(self.ops[ident])
        # Exercise the real downstream UTC contract rather than letting an
        # unconstrained Mock accept an invalid '+00:00' runtime deadline.
        self.resolver.make_runtime_binding=Mock(side_effect=lambda *args,**kwargs:resource_time(kwargs['deadline']))
        self.policy={'codeSha':self.head,'database':self.database,'cost':{'databaseBaselineBytes':0},
            'localOperator':{'recoveryDirectoryDigest':hashlib.sha256(str(self.directory).encode()).hexdigest(),'ticketDigest':'a'*64},
            'endsAt':'2026-10-11T00:30:00Z'}
        self.env={'DEPLOYMENT_KIND':'trial','TRIAL_POLICY_JSON':json.dumps(self.policy),'TRIAL_POLICY_SIGNATURE':'fictional-signature',
            'TRIAL_POLICY_PUBLIC_KEY':'fictional-public'}
        self.window={'lifecycleId':'fictional-lifecycle','bindingDigest':'b'*64,'guardianNonce':'fictional-nonce',
            'ruleId':'fictional-rule','journalUrl':'https://fictional.blob.core.windows.net/journal/main.json',
            'jobStartedAt':'2026-10-11T00:00:00Z','useUntil':'2026-10-11T00:10:00Z'}
        self.config={'live_enabled':True,'owner_id':'fictional-owner','tenant_id':'fictional-tenant',
            'guardian_job':{'resource_id':'/fictional/jobs/guard','principal_id':'fictional-guardian','template':self.template,
                'image_digest':'sha256:'+'a'*64,'environment_id':'fictional-env'},'binding':{'rule_id':'fictional-rule'},
            'owner_access':{'ends_at':'2026-10-11T01:00:00Z'},'cleanup_strategy':'single_job','journal_url':self.window['journalUrl'],
            'prearm_until':'2026-10-11T00:05:00Z','seed_not_before':'2026-10-11T00:00:00Z','cloud_guard':{'nonce':'fictional-nonce'},
            'preflight':{'ci_head':self.head,'reviewed_head':self.head,'external_business_acl_verified':True,
                'all_evidence_verified':True,'no_production_change':True},
            'recovery_directory':str(self.directory),'recovery_directory_digest':digest(str(self.directory)),
            'control_budget':{'directory':str(self.directory),'directory_digest':digest(str(self.directory)),
                'binding':{**self.binding,'source_sha256':'f'*64},'seed':{'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}},
            'worker':{'payload':{'azureCliPython':str(Path(sys.executable).resolve()),'environment':self.env,
                'access':{'databaseWindow':self.window,'startsAt':'2026-10-11T00:00:00Z','endsAt':'2026-10-11T01:00:00Z'},
                'recoveryDirectory':str(self.directory),'requests':[],
                'bootstrap':{'mode':'apply','manifest':{'schema':1,'adminUser':'fictional_admin','adminCatalog':'postgres',
                    'cases':[{'id':1,'title':'FICTIONAL TRIAL SAMPLE 1'}]}}}}}
        self.bundle={'schema':1,'execution_config':self.config}
        self.name='operator-'+'9'*64+'.jsonl'
        self.base={'schema':1,'intent':'9'*64,'ticketDigest':'c'*64,'startsAt':'2026-10-11T00:00:00Z',
            'endsAt':'2026-10-11T01:00:00Z','status':'outcome_unknown','automaticResend':False}
        self.write(self.name,encoded(self.base)+b'\n'+encoded({'terminal':'completed'})+b'\n')
        final=deepcopy(self.policy);final['cost']['databaseBaselineBytes']=1024;final['localOperator']['ticketDigest']='b'*64
        self.final_env={**self.env,'TRIAL_POLICY_JSON':json.dumps(final)}
        self.write('trial-runtime-policy.json',encoded(self.final_env)+b'\n')
        self.proof={'schema':1,'bootstrap':{'status':'bootstrapped','databaseBaselineBytes':1024,'cases':1,'automaticResend':False},
            'databaseWindow':self.window,'database':{k:v for k,v in self.database.items() if k!='port'},'codeSha':self.head,
            'bootstrapManifest':self.config['worker']['payload']['bootstrap']['manifest'],
            'receipts':[{'name':self.name,'sha256':self.sha(self.name)}],'receiptScope':'verified_steps_this_invocation'}

    def write(self,name,raw):
        path=self.directory/name
        if not path.exists():os.close(create_owner_file(path))
        path.write_bytes(raw)
    def sha(self,name):return hashlib.sha256((self.directory/name).read_bytes()).hexdigest()
    def finish(self,*,mode='apply',remove_event=None,unknown_step=False):
        self.config['worker']['payload']['bootstrap']['mode']=mode
        self.proof['bootstrap']['status']='bootstrapped' if mode=='apply' else 'reconciled'
        if unknown_step:self.write(self.name,encoded(self.base)+b'\n')
        self.proof['receipts'][0]['sha256']=self.sha(self.name)
        self.write('trial-bootstrap-proof.json',encoded(self.proof)+b'\n')
        self.output={'status':'completed','completedRequests':0,'bootstrap':{'schema':1,**self.proof['bootstrap'],
            'finalRuntimePolicySha256':self.sha('trial-runtime-policy.json'),'databaseWindowDigest':digest(self.window),
            'receiptSetSha256':digest(self.proof['receipts']),'receiptCount':1,'proofSha256':self.sha('trial-bootstrap-proof.json')}}
        for name in ('trial-session.jsonl','trial-session.lock'):
            if not (self.directory/name).exists():os.close(create_owner_file(self.directory/name))
        receipt=Receipt(str(self.directory),digest(str(self.directory)),digest(execution_binding(self.config)))
        runtime={'execution_id':'/fictional/jobs/guard/executions/guard-one','principal_id':'fictional-guardian','nonce':'fictional-nonce',
            'image_digest':'sha256:'+'a'*64,'job_started_at':'2026-10-11T00:00:00Z','job_deadline':'2026-10-11T00:30:00Z'}
        events=[('start_intent',{'request_id':'fictional'}),('start_ack',{'runtime':runtime}),('work_intent',None),
            ('worker_result',{'output':self.output,'database_window':self.window}),('work_complete',None),
            ('absence_confirmed',{'evidence_digest':'c'*64,'journal_version':10}),
            ('handoff_complete',{'cleanup_responsibility_retained':False,'successor':False})]
        for event,value in events:
            if event!=remove_event:receipt.append(event,value)
        receipt.close()
    def bind(self):
        return bind_bootstrap(self.bundle,self.journal,self.resolver,self.clock,verify_policy=lambda e:json.loads(e['TRIAL_POLICY_JSON']))
    def assert_no_success(self):
        self.assertFalse((self.journal.latest('trialDatabaseBootstrap') or {}).get('readback_verified'))

    def test_completed_real_chain_and_protected_receipts_bind_once(self):
        self.assertNotIn('template',self.ops['guardMainConfiguration']['body']['properties'])
        self.finish();self.assertTrue(self.bind()['bootstrapBound'])
        count=len(self.journal.records);self.assertTrue(self.bind()['bootstrapBound']);self.assertEqual(count,len(self.journal.records))
        receipt=self.journal.latest('trialDatabaseBootstrap')
        self.assertTrue(receipt['write_terminal']);self.assertFalse(receipt['properties']['cleanup_ownership_proof'])
        self.assertEqual(digest(self.final_env),receipt['properties']['final_policy_environment_sha256'])
    def test_reconcile_is_current_state_observation_never_creation_adoption(self):
        # The original unknown attempt stays present; a new explicit read-only
        # reconciliation supplies the final verified outer-group receipt.
        self.write(self.name,encoded(self.base)+b'\n'+encoded(self.base)+b'\n'+encoded({'terminal':'completed'})+b'\n')
        self.finish(mode='reconcile');self.assertTrue(self.bind()['bootstrapBound'])
        r=self.journal.latest('trialDatabaseBootstrap');self.assertTrue(r['readback_verified']);self.assertTrue(r['terminal'])
        self.assertFalse(r['created_by_run']);self.assertFalse(r['write_terminal'])
    def test_changed_launcher_template_is_rejected_against_original_create_template(self):
        self.config['guardian_job']['template']={'containers':[{'name':'substituted'}]}
        self.finish()
        with self.assertRaises(Denied):self.bind()
        self.assert_no_success()
    def test_update_readback_template_must_still_match_original_create(self):
        self.finish()
        self.ops['guardMainConfiguration']['expected']['properties']['properties.template']={'containers':[{'name':'substituted'}]}
        receipts=self.journal.receipts()
        receipts['guardMainConfiguration']['request_digest']=digest(self.ops['guardMainConfiguration'])
        with patch.object(self.journal,'receipts',return_value=receipts),self.assertRaises(Denied):self.bind()
        self.assert_no_success()
    def test_unknown_step_cannot_be_promoted_by_proof_or_closed_guardian(self):
        self.finish(unknown_step=True)
        with self.assertRaises(Denied):self.bind()
        self.assert_no_success()
    def test_missing_actual_worker_output_cannot_be_replaced_by_artifacts(self):
        self.finish(remove_event='worker_result')
        with self.assertRaises(Denied):self.bind()
        self.assert_no_success()
    def test_guardian_closed_evidence_is_mandatory(self):
        self.finish(remove_event='absence_confirmed')
        with self.assertRaises(Denied):self.bind()
        self.assert_no_success()
    def test_tampered_step_bytes_rejected(self):
        self.finish();self.write(self.name,encoded(self.base)+b'\n')
        with self.assertRaises(Denied):self.bind()
    def test_changed_signed_policy_baseline_rejected(self):
        p=json.loads(self.final_env['TRIAL_POLICY_JSON']);p['cost']['databaseBaselineBytes']=2048
        self.final_env['TRIAL_POLICY_JSON']=json.dumps(p);self.write('trial-runtime-policy.json',encoded(self.final_env)+b'\n');self.finish()
        with self.assertRaises(Denied):self.bind()
    def test_changed_role_or_code_rejected_even_if_artifact_hash_matches(self):
        self.proof['database']['webUser']='another_role';self.finish()
        with self.assertRaises(Denied):self.bind()
    def test_different_configuration_cannot_reuse_session_chain(self):
        self.finish();self.config['worker']['payload']['bootstrap']['manifest']['cases'][0]['id']=2
        with self.assertRaises(Denied):self.bind()
    def test_arbitrary_proof_fields_are_not_a_supported_input(self):
        self.finish();self.bundle['success']=True
        with self.assertRaises(Denied):self.bind()
    def test_business_acl_preflight_is_not_inferred_from_bootstrap_catalog(self):
        self.config['preflight']['external_business_acl_verified']=False;self.finish()
        with self.assertRaises(Denied):self.bind()
    def test_wrong_head_cannot_be_hidden_by_self_consistent_proof_hash(self):
        self.config['preflight']['reviewed_head']='0'*40;self.finish()
        with self.assertRaises(Denied):self.bind()
    def test_active_guardian_receipt_lock_blocks_import(self):
        self.finish()
        live=Receipt(str(self.directory),digest(str(self.directory)),digest(execution_binding(self.config)))
        try:
            with self.assertRaisesRegex(Denied,'bootstrap_session_running'):self.bind()
        finally:live.close()
    def test_signed_policy_verifier_failure_cannot_be_replaced_by_json(self):
        self.finish()
        with self.assertRaises(Denied):
            bind_bootstrap(self.bundle,self.journal,self.resolver,self.clock,verify_policy=Mock(side_effect=Denied('bad-signature')))
        self.assert_no_success()
    def test_unknown_local_observation_is_not_readopted_on_retry(self):
        self.finish();original=self.journal.checkpoint
        def checkpoint(op,r):
            if r['state']=='succeeded':raise OSError('fictional-interruption')
            return original(op,r)
        with patch.object(self.journal,'checkpoint',side_effect=checkpoint):
            with self.assertRaises(Denied):self.bind()
        self.assertEqual('unknown',self.bind()['status']);self.assert_no_success()
    def test_worker_python_is_exact_parent_runtime_and_bound(self):
        payload=self.config['worker']['payload'];validate_worker_python(payload)
        before=digest(execution_binding(self.config));payload['azureCliPython']='other-python'
        self.assertNotEqual(before,digest(execution_binding(self.config)))
        with self.assertRaises(Denied):validate_worker_python(payload)
    def test_node_poll_requires_valid_result_and_fsync_before_success(self):
        self.finish();script=self.directory/'trial-session.js';script.write_text('')
        audit=Mock();worker=NodeWorker(str(Path(sys.executable).resolve()),str(script),self.config['worker']['payload'],receipt=audit)
        worker.window=deepcopy(self.window);worker.child=Mock();worker.child.poll.return_value=0
        worker.child.stdout=io.BytesIO(encoded(self.output));self.assertTrue(worker.poll())
        self.assertEqual('worker_result',audit.append.call_args.args[0])
        audit.reset_mock();worker.output=None;bad=deepcopy(self.output);bad['bootstrap']['databaseWindowDigest']='0'*64
        worker.child.stdout=io.BytesIO(encoded(bad));self.assertFalse(worker.poll());audit.append.assert_not_called()
        worker.child.stdout=io.BytesIO(encoded(self.output));audit.append.side_effect=OSError('fsync failed')
        with self.assertRaises(OSError):worker.poll()


class BootstrapCliTests(unittest.TestCase):
    def setUp(self):
        self.fixture=cli_fixtures.CliTests();self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.run_action()
    def test_private_bind_dispatch_has_no_credential_or_http_construction(self):
        ref=self.fixture.write('bootstrap.local.json',{'schema':1,'execution_config':{'fictional':True}})
        result={'status':'bootstrap_bound','bootstrapBound':True,'cloud_calls':0}
        with patch('scripts.trial_provision.bootstrap.bind_bootstrap',return_value=result) as bridge:
            self.assertEqual(result,self.fixture.run_action('bind-bootstrap',bootstrap_config=ref))
        self.assertEqual({'schema':1,'execution_config':{'fictional':True}},bridge.call_args.args[0])
        self.assertEqual(128,self.fixture.run_action('status')['control_requests_used'])
        self.fixture.assert_no_auth()
    def test_changed_private_reference_stops_before_bridge_or_auth(self):
        ref=self.fixture.write('bootstrap.local.json',{'schema':1,'execution_config':{}})
        self.fixture.write('bootstrap.local.json',{'schema':1,'execution_config':{'changed':True}})
        with patch('scripts.trial_provision.bootstrap.bind_bootstrap') as bridge,self.assertRaises(Denied):
            self.fixture.run_action('bind-bootstrap',bootstrap_config=ref)
        bridge.assert_not_called();self.fixture.assert_no_auth()
    def test_no_asserted_json_success_can_replace_actual_worker_receipt(self):
        ref=self.fixture.write('bootstrap.local.json',{'schema':1,'success':True})
        with self.assertRaises(Denied):self.fixture.run_action('bind-bootstrap',bootstrap_config=ref)
        self.fixture.assert_no_auth()


class WorkerDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.private=self.root/'private'
        if os.name=='nt':
            import ctypes
            from ctypes import wintypes
            kernel=ctypes.WinDLL('kernel32',use_last_error=True)
            kernel.CreateDirectoryW.argtypes=[wintypes.LPCWSTR,wintypes.LPVOID]
            kernel.CreateDirectoryW.restype=wintypes.BOOL
            with private_io._owner_security_attributes(directory=True) as attrs:
                if not kernel.CreateDirectoryW(str(self.private),ctypes.byref(attrs)):
                    raise ctypes.WinError(ctypes.get_last_error())
        else:self.private.mkdir(mode=0o700)
        self.config={'live_enabled':True,'recovery_directory':str(self.private),
            'worker':{'payload':{'azureCliPython':str(Path(sys.executable).resolve()),'recoveryDirectory':str(self.private)}}}
    def test_actual_private_directory_inherited_files_pass_launch_gate(self):
        # Plain OS creation has the same inherited DACL as Node open(wx).
        for name in ('trial-session.jsonl','trial-session.lock'):
            fd=os.open(self.private/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            try:os.write(fd,b'fictional')
            finally:os.close(fd)
        validate_worker_directories(self.config)
    def test_both_distinct_roots_are_checked(self):
        unsafe=self.root/'unsafe';unsafe.mkdir(mode=0o755)
        self.config['worker']['payload']['recoveryDirectory']=str(unsafe)
        with patch('scripts.trial_guard.execution.open_control_budget') as budget,patch('scripts.trial_guard.execution.Receipt') as receipt,patch('scripts.trial_guard.execution.AzureJobStarter') as auth:
            with self.assertRaisesRegex(Denied,'worker_private_directory'):execute(self.config)
        budget.assert_not_called();receipt.assert_not_called();auth.assert_not_called()
    def test_existing_nonprivate_receipt_stops_before_any_creation(self):
        (self.private/'trial-session.jsonl').write_bytes(b'fictional')
        with patch.object(private_io,'verify_owner_file',side_effect=OSError('denied')),patch('scripts.trial_guard.execution.open_control_budget') as budget,patch('scripts.trial_guard.execution.Receipt') as receipt:
            with self.assertRaisesRegex(Denied,'worker_private_directory'):execute(self.config)
        budget.assert_not_called();receipt.assert_not_called()


if __name__=='__main__':unittest.main()
