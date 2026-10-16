"""Fictional publication chain + real registry adapter. No external capability."""
import sys,json,unittest
from pathlib import Path
from copy import deepcopy
from datetime import datetime,timezone,timedelta


from scripts.trial_provision.tests import test_publication_bridge as bridge_fixture
from scripts.trial_provision.tests.test_rehearsal_cli import MemoryJournal,Budget
from scripts.trial_provision.tests.test_registry import Clock,Credential,Wire
from scripts.trial_guard.adapters import encoded,digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import publication_only_cleanup as target

class AbsentWire(Wire):
    def __init__(self,*args):super().__init__(*args);self.arm_status=404;self.arm_code='ResourceNotFound';self.arm_delay=0
    def __call__(self,method,url,headers,body,deadline):
        if url.startswith(target.ARM+'/'):
            self.calls.append((method,url,headers,body));self.clock.seconds+=self.arm_delay
            if method!='GET':raise AssertionError('arm_mutation')
            return self.response(self.arm_status,body=encoded({'error':{'code':self.arm_code}}))
        return super().__call__(method,url,headers,body,deadline)

class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.f=bridge_fixture.PublicationBridgeTests('runTest');self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.config=self.f.publication()
        with self.f.journal() as real:self.journal=MemoryJournal();self.journal.records=deepcopy(real.records)
        self.clock=Clock();self.clock.start=datetime(2026,10,11,1,tzinfo=timezone.utc);self.clock.seconds=601
        self.budget=Budget()
        self.binding,self.operation,_,_=target.prepare(self.config,self.journal,self.clock.utc())
        self.wire=AbsentWire(self.clock,self.binding);self.wire.digest=self.operation['expected']['manifest_digest']
        self.credential=Credential(self.clock)
        self.credential.principal=self.config['manifest']['owner']['principal_id']
        self.credential.tenant=self.config['manifest']['owner']['tenant_id']
    def run_cleanup(self):return target.run(self.config,self.journal,self.budget,self.credential,self.wire,self.clock,lambda:None)
    def deletes(self):return [v for v in self.wire.calls if v[0]=='DELETE']
    def test_expired_owned_delete_ack_then_absence_and_completed_replay(self):
        before=deepcopy(self.config);seed=deepcopy(self.budget.counts)
        self.assertEqual('pending',self.run_cleanup()['status']);self.assertEqual(1,len(self.deletes()))
        self.wire.head=[404];self.assertTrue(self.run_cleanup()['cleanup_verified'])
        calls=len(self.wire.calls);self.assertTrue(self.run_cleanup()['cleanup_verified']);self.assertEqual(calls,len(self.wire.calls))
        self.assertEqual(before,self.config);self.assertEqual('2026-10-11T01:10:00Z',self.operation['deadline'])
        self.assertGreater(self.budget.counts['owner_arm'],seed['owner_arm']);self.assertFalse(self.journal.values('core_plan'))
        self.assertNotIn(self.config['manifest']['imageRepository']+'/manifests',self.deletes()[0][1])
    def test_unknown_delete_never_retries_or_adopts_404(self):
        self.wire.delete=TimeoutError();self.assertEqual('unknown',self.run_cleanup()['status'])
        calls=len(self.wire.calls);self.wire.head=[404]
        self.assertEqual('unknown',self.run_cleanup()['status']);self.assertEqual(calls,len(self.wire.calls));self.assertEqual(1,len(self.deletes()))
    def test_known_ack_read_failure_retains_ack(self):
        self.run_cleanup();self.wire.head=[403]
        self.assertFalse(self.run_cleanup()['cleanup_verified']);self.assertTrue(self.journal.latest(target.IDENT)['delete_acknowledged'])
        self.wire.head=[404];self.assertTrue(self.run_cleanup()['cleanup_verified']);self.assertEqual(1,len(self.deletes()))
    def test_present_forbidden_or_wrong_absence_never_deletes(self):
        for status,code in ((200,'ResourceNotFound'),(403,'AuthorizationFailed'),(404,'Other')):
            self.wire.arm_status=status;self.wire.arm_code=code
            with self.subTest(status=status,code=code),self.assertRaises(Denied):self.run_cleanup()
            self.assertFalse(self.deletes())
    def test_inventory_expiry_never_deletes(self):
        self.wire.arm_delay=11
        with self.assertRaises((Denied,TimeoutError)):self.run_cleanup()
        self.assertFalse(self.deletes())
    def test_authentication_delay_expiry_never_deletes(self):
        self.credential.delay=16
        with self.assertRaises((Denied,TimeoutError)):self.run_cleanup()
        self.assertFalse(self.deletes())
    def test_clock_revoked_denies_before_auth(self):
        self.journal.append('clock_revoked',{'at':self.clock.utc().isoformat()})
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls);self.assertFalse(self.wire.calls)
    def test_provision_plan_or_bridge_is_not_adopted(self):
        original=deepcopy(self.journal.records)
        for event in ('core_plan','plan','publication_import','provision_bridge_intent'):
            self.journal.records=deepcopy(original);self.journal.append(event,{})
            with self.subTest(event=event),self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)
    def test_unrelated_intent_is_not_adopted(self):
        self.journal.records.append({'event':'intent','value':{'operation_id':'guard'}})
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)
    def test_open_publication_window_denies_before_auth(self):
        self.clock.seconds=1
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)
    def test_source_head_or_owner_change_denies_before_auth(self):
        original=deepcopy(self.config)
        for mutate in (lambda c:c.update(frozen_head='0'*40 if c['frozen_head']!='0'*40 else '1'*40),
                       lambda c:c['sources']['latest'].update(sha256='0'*64 if c['sources']['latest']['sha256']!='0'*64 else '1'*64),
                       lambda c:c['manifest']['owner'].update(principal_id='00000000-0000-4000-8000-000000000099')):
            self.config=deepcopy(original);mutate(self.config)
            with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)
    def test_namespace_or_push_ack_change_denies_before_auth(self):
        original=deepcopy(self.journal.records)
        for event,key,value in (('guardian_image_namespace','authenticated',False),('progress','ack_kind','unknown')):
            self.journal.records=deepcopy(original)
            row=next(r for r in self.journal.records if r['event']==event and (event!='progress' or r['value'].get('operation_id')==target.PUSH))
            row['value'][key]=value
            with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)

    def test_unknown_runtime_intent_is_retained_and_only_exact_guardian_is_deleted(self):
        self.journal.records=[row for row in self.journal.records
            if not (row['event']=='progress' and row['value'].get('operation_id')=='runtimeImagePush')]
        runtime_intents=deepcopy([v for v in self.journal.values('intent') if v['operation_id']=='runtimeImagePush'])
        self.assertEqual(len(runtime_intents),1)
        self.assertEqual('pending',self.run_cleanup()['status'])
        self.assertEqual([v[1] for v in self.deletes()],[self.operation['url']])
        self.assertEqual(runtime_intents,[v for v in self.journal.values('intent') if v['operation_id']=='runtimeImagePush'])
        self.assertIsNone(self.journal.latest('runtimeImagePush'))
        self.assertFalse(any('/'+self.config['manifest']['imageRepository']+'/' in v[1] for v in self.wire.calls))

    def test_unknown_guardian_ack_is_not_replaced_with_readonly_adoption(self):
        row=next(r for r in self.journal.records if r['event']=='progress' and r['value'].get('operation_id')==target.PUSH)
        row['value'].update(state='unknown',terminal=False,write_terminal=False,readback_verified=False)
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls)
        self.assertFalse(self.wire.calls)

    def test_no_runtime_upload_is_needed_for_verified_guardian_cleanup(self):
        self.journal.records=[row for row in self.journal.records if not row['event'].startswith('runtime_image_')
            and row['value'].get('operation_id')!='runtimeImagePush']
        self.assertEqual('pending',self.run_cleanup()['status'])
        self.assertEqual([v[1] for v in self.deletes()],[self.operation['url']])

class LinkedCleanupTests(unittest.TestCase):
    def setUp(self):
        from scripts.trial_provision.tests.test_attempt import fixture,sha,stamp
        from scripts.trial_provision.tests.test_registry_retention import publication_fixture
        from scripts.trial_provision.configuration import SOURCE_FILES
        from scripts.trial_provision.registry_publish import prepare_publication
        data=fixture();manifest=data['manifest']
        prefix=manifest['existing']['registry'].split('/providers/')[0]+'/providers/Microsoft.App/'
        manifest['ids']={'app':prefix+'containerApps/trial-app','job':prefix+'jobs/trial-worker','guard':prefix+'jobs/trial-guardian'}
        manifest['registry']['id']=manifest['existing']['registry']
        raw=encoded(manifest);mh=sha(raw)
        data['config']['authority_bundle']['manifest']=raw
        data['config']['sources']['manifest']['sha256']=mh
        data['config']['control_budget']['binding']['manifest_sha256']=mh
        data['authority']['manifest_sha256']=mh
        data['authority']['budget_binding_sha256']=digest(data['config']['control_budget']['binding'])
        parent_binding=next(v for e,v in data['parent_rows'] if e=='binding');parent_binding['manifest_sha256']=mh
        prep=next(v for e,v in data['parent_rows'] if e=='publication_preparation')
        prep.update(manifest_sha256=mh,run_binding_digest=digest(parent_binding))
        for event,value in data['parent_rows']:
            if event.endswith('_image_namespace'):
                value.update(publication_preparation_digest=digest(prep),run_binding_digest=digest(parent_binding))
        for slot in ('guardian','runtime'):
            proof=json.loads(data['artifacts'][slot+'_build']);proof['manifest_sha256']=mh
            data['artifacts'][slot+'_build']=encoded(proof)
            data['config']['publication']['slots'][slot]['build_receipt']['sha256']=sha(data['artifacts'][slot+'_build'])
        memory,verified,_=publication_fixture(data)
        self.config=deepcopy(data['config'])
        self.config.update(manifest=manifest,live=True,config_sha256='f'*64,verified_attempt=verified,
            build_receipts={slot:json.loads(data['artifacts'][slot+'_build']) for slot in ('guardian','runtime')})
        self.config['attempt']['sha256']=sha(encoded(verified.activation))
        for key in SOURCE_FILES:
            self.config['sources'].setdefault(key,{'sha256':'f'*64})
        for slot in self.config['publication']['slots'].values():slot['docker_path']='/fictional/docker.exe'
        self.journal=MemoryJournal()
        self.journal.records=[{'event':e,'value':v} for e,v in memory.rows if e!='publication_preparation']
        # Regenerate the complete publication envelope from pinned inputs.
        prep=prepare_publication(self.config,manifest,self.config['config_sha256'],self.journal)
        namespace=next(r['value'] for r in self.journal.records if r['event']=='guardian_image_namespace')
        namespace['publication_preparation_digest']=digest(prep)
        self.journal.records=[r for r in self.journal.records if not r['event'].startswith('runtime_image_')
            and not(r['event']=='progress' and r['value'].get('operation_id')=='runtimeImagePush')]
        self.clock=Clock();self.clock.start=datetime.fromisoformat(stamp().replace('Z','+00:00'));self.clock.seconds=1801
        self.budget=Budget()
        self.binding,self.operation,_,_=target.prepare(self.config,self.journal,self.clock.utc())
        self.wire=AbsentWire(self.clock,self.binding);self.wire.digest=self.operation['expected']['manifest_digest']
        self.credential=Credential(self.clock)
        self.credential.principal=manifest['owner']['principal_id'];self.credential.tenant=manifest['owner']['tenant_id']
    def run_cleanup(self):return target.run(self.config,self.journal,self.budget,self.credential,self.wire,self.clock,lambda:None)
    def test_child_attempt_unknown_runtime_deletes_guardian_only_then_reads_absence(self):
        before=deepcopy([v for v in self.journal.values('intent') if v['operation_id']=='runtimeImagePush'])
        self.assertEqual(len(before),1)
        self.assertEqual('pending',self.run_cleanup()['status'])
        self.wire.head=[404];self.assertTrue(self.run_cleanup()['cleanup_verified'])
        deleted=[v[1] for v in self.wire.calls if v[0]=='DELETE']
        self.assertEqual(deleted,[self.operation['url']])
        self.assertIn('/trial/guardian/manifests/',deleted[0])
        self.assertFalse(any('/trial/runtime/' in v[1] for v in self.wire.calls))
        self.assertEqual(before,[v for v in self.journal.values('intent') if v['operation_id']=='runtimeImagePush'])
        self.assertIsNone(self.journal.latest('runtimeImagePush'))
        self.assertFalse(self.journal.values('publication_import'))
    def test_missing_child_authority_or_changed_parent_binding_denies_before_auth(self):
        original=self.config.pop('verified_attempt')
        with self.assertRaises(Denied):self.run_cleanup()
        self.config['verified_attempt']=original
        binding=next(r['value'] for r in self.journal.records if r['event']=='binding')
        binding['attempt']['parent']['final_sha256']='0'*64
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls);self.assertFalse(self.wire.calls)
    def test_child_guardian_without_ack_cannot_authenticate_or_delete(self):
        push=next(r['value'] for r in self.journal.records if r['event']=='progress' and r['value'].get('operation_id')==target.PUSH)
        push['ack_kind']='unknown'
        with self.assertRaises(Denied):self.run_cleanup()
        self.assertFalse(self.credential.calls);self.assertFalse(self.wire.calls)

if __name__=='__main__':
    def block(event,args):
        if event.startswith('socket.') or event in ('subprocess.Popen','os.system'):raise RuntimeError('external_event_forbidden')
    sys.addaudithook(block)
    suite=unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result=unittest.TextTestRunner(verbosity=1).run(suite)
    print(json.dumps({'tests':result.testsRun,'passed':result.wasSuccessful(),'external_services':False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
