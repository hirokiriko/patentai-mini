"""Offline catalog/OWNER protocol contracts; all secrets are fictional."""
import hashlib
import json
import os
import queue
import sys
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch
from . import catalog_execution as ce, execution, owner
from .__main__ import FIXED
from .adapters import Deadline, digest, encoded
from .lifecycle import Denied, parse
from .test_adapters import SERVER, RULE, RID, Credential
from .test_lifecycle import Clock
from .workflow import Receipt
from scripts.trial_provision.journal import ControlBudget
from scripts.trial_provision.private_io import create_owner_file
from scripts.trial_provision.tests.test_private_io import create_owner_directory
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.tests.test_attempt_accounting import budget_fixture, scope
from scripts.trial_provision.tests.test_owner_tokens import jwt

def private_write(path, raw):
    with os.fdopen(create_owner_file(path), 'wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())

def owner_fixture(clock):
    at=clock.utc()
    runtime={'execution_id':'fixture/jobs/guard/executions/guard-one','replica_name':'guard-one-abc',
        'image_digest':'sha256:'+'a'*64,'principal_id':RID,'nonce':'fixed',
        'job_started_at':at.isoformat(),'job_deadline':(at+timedelta(minutes=30)).isoformat()}
    config={'live_enabled':True,'cleanup_strategy':'single_job','owner_permissions_until':(at+timedelta(hours=8)).isoformat(),
        'owner_id':RID,'tenant_id':RID,'cloud_guard':runtime,'runtime_readback':{**runtime,'at':at.isoformat(),'status':'Running'},
        'binding':{'server_id':SERVER,'rule_id':RULE,'ipv4':'192.0.2.1','mode':'guardian','region':'fictional','lifecycle_id':RID},
        'cleanup_targets_digest':digest([]),'journal_url':'https://fictional.blob.core.windows.net/guard/state.json'}
    config['owner_access']={'approved':True,'readback_verified':True,'principal_id':RID,'journal_url':config['journal_url'],
        'starts_at':at.isoformat(),'ends_at':config['owner_permissions_until'],'assignment_id':RID,'evidence_sha256':'a'*64}
    config['binding']['lro_authorization']={'approved':True,'readback_verified':True,'principal_id':RID,
        'scope':'/subscriptions/'+SERVER.split('/')[2],'actions':list(owner.ArmTransport.lro_actions),
        'assignment_id':RID,'evidence_sha256':'b'*64,'ends_at':config['owner_permissions_until']}
    with patch.object(owner,'AzureCredential',return_value=Credential()),patch.object(owner,'BlobJournal',autospec=True):
        _,_,initial,_=owner.assemble_owner(config,http=Mock(),clock=clock)
    window={'lifecycleId':initial['lifecycle_id'],'bindingDigest':initial['binding_digest'],'guardianNonce':runtime['nonce'],
        'ruleId':initial['rule_id'],'journalUrl':config['journal_url'],'jobStartedAt':at.isoformat().replace('+00:00','Z'),
        'useUntil':parse(initial['cleanup_at']).isoformat().replace('+00:00','Z')}
    return config,initial,window

class LinePipe:
    def __init__(self):self.q=queue.Queue();self.closed=False
    def feed(self,value):self.q.put(value if isinstance(value,bytes) else encoded(value)+b'\n')
    def readline(self,maximum):
        value=self.q.get(timeout=5);return b'' if value is None else value[:maximum]
    def close(self):
        if not self.closed:self.closed=True;self.q.put(None)

class CapturedInput:
    def __init__(self):self.raw=[];self.lock=threading.Lock();self.on_flush=lambda _:None
    def write(self,raw):
        with self.lock:self.raw.append(bytes(raw))
        return len(raw)
    def frames(self):
        with self.lock:return [json.loads(raw) for raw in self.raw]
    def flush(self):self.on_flush(self.frames()[-1])
    def close(self):pass

class Child:
    def __init__(self):self.stdin=CapturedInput();self.stdout=LinePipe();self.status=None
    def poll(self):return self.status
    def terminate(self):self.exit(-15)
    def kill(self):self.exit(-9)
    def wait(self,timeout=None):assert self.status is not None;return self.status
    def exit(self,code):self.status=code;self.stdout.close()

class CatalogExecutionTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()/'private';create_owner_directory(self.root)
        self.guard=self.root/'guard';self.db=self.root/'db';self.budget_dir=self.root/'budget'
        for path in (self.guard,self.db,self.budget_dir):create_owner_directory(path)
        self.clock=Clock();self.config,self.initial,self.window=owner_fixture(self.clock)
        self.state=deepcopy(self.initial)
        self.state.update(status='active',usage_allowed=True,close_requested=False,blocked=None,version=3,
            use_lease_from=self.clock.utc().isoformat(),use_lease_until=(self.clock.utc()+timedelta(seconds=10)).isoformat())
        self.receipt=Receipt(str(self.guard),digest(str(self.guard)),'c'*64);self.addCleanup(self.receipt.close)
        binding={'manifest_sha256':'a'*64,'owner_id':RID,'task_id':'fixture','source_sha256':'b'*64}
        self.budget=ControlBudget(str(self.budget_dir),digest(str(self.budget_dir)),binding,
            seed={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0});self.addCleanup(self.budget.close)
        self.sent=[]
        def transport(method,url,headers,body,deadline):
            deadline.remaining();self.sent.append((method,url))
            return {'status':200,'headers':{'etag':'fictional'},'body':encoded(self.state)}
        self.counted=execution.CountedHttp(transport,self.receipt,self.budget,accounting_lock=self.receipt.mutex)
        self.script=self.root/'trial-session.js';private_write(self.script,b'fictional; never executed\n')
        self.payload=self.make_payload()
        self.enterContext(patch('scripts.trial_guard.adapters.BoundedHttp.__call__',side_effect=AssertionError('network forbidden')))
        self.enterContext(patch('scripts.trial_guard.adapters.AzureCredential.token',side_effect=AssertionError('credential forbidden')))

    def make_payload(self):
        policy={'codeSha':'a'*40,'startsAt':self.clock.utc().isoformat(),'endsAt':(self.clock.utc()+timedelta(minutes=30)).isoformat(),
            'database':{'host':'fictional.postgres.database.azure.com','database':'trial_db','ownerRole':'trial_owner',
                'migratorUser':'trial_migrator','webUser':'trial_web','workerUser':'trial_worker'}}
        plan={'schema':1,'server':policy['database']['host'],'adminUser':'fictional_admin','targetDatabase':'trial_db',
            'roles':{'owner':'trial_owner','migrator':'trial_migrator','web':'trial_web','worker':'trial_worker'},
            'excludedDatabases':[{'name':'template0','template':True,'allowConnect':False}],
            'maximumAuditConnections':6,'builtinManifestSha256':'b'*64,'querySetSha256':'c'*64,'limits':deepcopy(ce.LIMITS)}
        policy['localOperator']={'catalogPlanDigest':ce.catalog_digest(plan)}
        requests=[{'command':'initialize-ledger'},{'command':'package-import'}]
        for case_id in range(1,5):
            at=len(requests);requests.extend([{'command':'sample-save','caseId':case_id},
                {'command':'setting-save','setting':{'caseId':case_id,'base':{'$sessionResult':{'requestIndex':at,'field':'base'}},
                    'source':{'$sessionResult':{'requestIndex':at,'field':'source'}}}}])
        return {'azureCliPython':str(Path(sys.executable).resolve()),'environment':{'TRIAL_POLICY_JSON':json.dumps(policy),
            'TRIAL_POLICY_SIGNATURE':'fictional','TRIAL_POLICY_PUBLIC_KEY':'fictional'},'access':{'databaseWindow':deepcopy(self.window)},
            'databaseWindow':deepcopy(self.window),'recoveryDirectory':str(self.db),'catalogPlan':plan,'requests':requests,
            'signingPrivateKey':'FICTIONAL-SIGNING-PRIVATE-MARKER',
            'operatorDatabaseUrl':'postgresql://trial_migrator:FICTIONAL-MIGRATOR-PASSWORD@fictional.postgres.database.azure.com/trial_db',
            'bootstrap':{'mode':'apply','manifest':{'schema':1,'adminCatalog':'postgres','adminUser':'fictional_admin',
                'cases':[{'id':i,'title':'fictional'} for i in range(1,5)]},'credentials':{
                'adminUrl':'postgresql://fictional_admin:FICTIONAL-ADMIN-PASSWORD@fictional.postgres.database.azure.com/postgres',
                'migratorPassword':'FICTIONAL-MIGRATOR-PASSWORD','webPassword':'FICTIONAL-WEB-PASSWORD','workerPassword':'FICTIONAL-WORKER-PASSWORD'}}}
    def reader(self,wire=None):return ce.FixedPermitReader(self.config,self.initial,wire or self.counted,self.clock,credential=Credential())
    def worker(self,start=True):
        worker=ce.CatalogNodeWorker(str(Path(sys.executable).resolve()),str(self.script),self.payload,self.receipt,clock=self.clock)
        self.addCleanup(worker.stop);worker.install_permit_reader(self.reader());child=Child()
        self.enterContext(patch.object(ce.subprocess,'Popen',return_value=child))
        if start:worker.start(self.window,{'type':'permit','lifecycleId':self.window['lifecycleId'],
            'bindingDigest':self.window['bindingDigest'],'guardianNonce':self.window['guardianNonce'],'useUntil':self.window['useUntil'],
            'permitUntil':parse(self.state['use_lease_until']).isoformat().replace('+00:00','Z')})
        return worker,child
    def pass_value(self,pass_no):
        return {'schema':1,'pass':pass_no,'codeSha':'a'*40,'auditPlanDigest':ce.catalog_digest(self.payload['catalogPlan']),
            'querySetDigest':'c'*64,'builtinManifestSha256':'b'*64,'databaseWindowDigest':ce.catalog_digest(self.window),
            'lifecycleId':self.window['lifecycleId'],'guardianNonce':self.window['guardianNonce'],'targetInventoryDigest':'d'*64,
            'catalogDigest':'e'*64,'startedAt':self.clock.utc().isoformat(),'checkedAt':self.clock.utc().isoformat(),
            'auditConnectionAttempts':1,'counts':{'databases':1,'queries':19,'rows':1,'bytes':2},'status':'verified','automaticResend':False}
    def save_pass(self,pass_no):
        raw=ce.canonical(self.pass_value(pass_no))+b'\n';private_write(self.db/('trial-catalog-pass-%d.json'%pass_no),raw)
        return {'type':'catalog_pass','schema':1,'pass':pass_no,'sha256':hashlib.sha256(raw).hexdigest()}
    def test_actual_owner_initial_matches_every_fixed_field_and_window(self):
        reader=self.reader();self.assertEqual(reader.fixed,{k:self.initial[k] for k in FIXED});self.assertTrue(reader.matches(self.window))
        self.assertEqual(reader.read(),self.state);self.assertEqual(self.budget.count('owner_control_blob'),33)
        self.assertEqual(self.receipt.count('owner_control_blob'),1);self.assertEqual(self.sent,[('GET',self.config['journal_url'])])
        for key in ('bindingDigest','lifecycleId','guardianNonce','ruleId','journalUrl'):
            with self.subTest(key=key):self.assertFalse(reader.matches({**self.window,key:self.window[key]+'changed'}))
    def test_every_immutable_change_rejects_and_failure_is_sticky(self):
        active=deepcopy(self.state)
        for key in FIXED:
            with self.subTest(key=key):
                self.state=deepcopy(active);reader=self.reader();self.state[key]={'changed':True}
                with self.assertRaises(Denied):reader.read()
                before=len(self.sent)
                with self.assertRaises(Denied):reader.read()
                self.assertEqual(len(self.sent),before)
    def test_version_clock_and_short_lease_revoke(self):
        reader=self.reader();reader.read();self.state['version']=2
        with self.assertRaises(Denied):reader.read()
        self.state['version']=3
        for kind in ('raw','mono','lease'):
            with self.subTest(kind=kind):
                wall,mono=self.clock.wall,self.clock.mono;until=self.state['use_lease_until'];reader=self.reader()
                if kind=='raw':self.clock.wall-=timedelta(seconds=1)
                elif kind=='mono':self.clock.mono-=1
                else:self.state['use_lease_until']=(self.clock.utc()+timedelta(seconds=2.9)).isoformat()
                try:
                    with self.assertRaises(Denied):reader.read()
                finally:self.clock.wall,self.clock.mono=wall,mono;self.state['use_lease_until']=until
    def test_token_delay_cannot_send_beyond_actual_600_seconds(self):
        reader=self.reader()
        def delayed(*_):self.clock.advance(600);return 'fictional-token'
        reader.credential=Mock();reader.credential.token.side_effect=delayed
        with self.assertRaises(Denied):reader.read()
        self.assertEqual(self.sent,[]);self.assertEqual(self.budget.count('owner_control_blob'),32)
    def test_unknown_get_keeps_exactly_one_lifetime_debit(self):
        wire=execution.CountedHttp(Mock(side_effect=TimeoutError('fictional')),self.receipt,self.budget,accounting_lock=self.receipt.mutex)
        reader=self.reader(wire)
        with self.assertRaises(Denied):reader.read()
        with self.assertRaises(Denied):reader.read()
        self.assertEqual(self.budget.count('owner_control_blob'),33);self.assertEqual(self.receipt.count('owner_control_blob'),1)
    def test_start_frame_contains_admin_only_not_bootstrap_secrets(self):
        worker,child=self.worker();frames=child.stdin.frames();self.assertEqual(len(frames),2);first=frames[0]
        self.assertEqual(set(first),{'type','schema','environment','access','azureCliPython','recoveryDirectory','catalogPlan','databaseWindow','bootstrapBinding','admin'})
        self.assertEqual(first['type'],'catalog_start');text=json.dumps(first)
        for marker in ('FICTIONAL-SIGNING-PRIVATE-MARKER','FICTIONAL-MIGRATOR-PASSWORD','FICTIONAL-WEB-PASSWORD','FICTIONAL-WORKER-PASSWORD'):self.assertNotIn(marker,text)
        self.assertIn('FICTIONAL-ADMIN-PASSWORD',text);self.assertEqual(first['bootstrapBinding'],ce.bootstrap_binding(self.payload,self.window))
        self.assertEqual(frames[1]['type'],'permit')
        with self.assertRaises(Denied):worker.start(self.window,frames[1])
    def test_catalog_fsync_failure_sends_no_bootstrap_frame(self):
        worker,child=self.worker();event=self.save_pass(1)
        with patch('scripts.trial_guard.workflow.os.fsync',side_effect=OSError('fictional fsync')):
            child.stdout.feed(event);self.assertTrue(worker._eof.wait(2))
        self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop());self.assertFalse(worker.poll())
        self.assertEqual([f['type'] for f in child.stdin.frames()],['catalog_start','permit'])
        self.assertEqual(self.receipt.find('bootstrap_frame_intent'),[]);self.assertEqual(self.receipt.find('bootstrap_frame_sent'),[])
    def test_bootstrap_intent_fsync_failure_sends_zero_frames(self):
        worker,child=self.worker();event=self.save_pass(1);real_fsync=os.fsync;calls=[]
        def fsync(fd):
            calls.append(fd)
            if len(calls)==2:raise OSError('fictional intent fsync')
            return real_fsync(fd)
        with patch('scripts.trial_guard.workflow.os.fsync',side_effect=fsync):child.stdout.feed(event);self.assertTrue(worker._eof.wait(2))
        self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop());self.assertEqual(len(self.receipt.find('catalog_verified')),1)
        self.assertEqual([f['type'] for f in child.stdin.frames()],['catalog_start','permit']);self.assertEqual(self.receipt.find('bootstrap_frame_sent'),[])
    def test_successful_pass1_sends_one_bound_full_frame_then_replay_fails(self):
        worker,child=self.worker();event=self.save_pass(1);worker._accept_catalog(event);frames=child.stdin.frames()
        self.assertEqual([f['type'] for f in frames],['catalog_start','permit','bootstrap']);self.assertNotIn('catalogPlan',frames[-1]['payload'])
        self.assertEqual(frames[-1]['payload']['signingPrivateKey'],self.payload['signingPrivateKey'])
        self.assertEqual(frames[-1]['payload']['databaseWindow'],self.window);self.assertEqual(frames[-1]['catalogPass1Sha256'],event['sha256'])
        self.assertEqual(worker.payload,{})
        self.assertEqual([r['event'] for r in self.receipt.records][-3:],['catalog_verified','bootstrap_frame_intent','bootstrap_frame_sent'])
        with self.assertRaises(Denied):worker._accept_catalog(event)
        self.assertEqual(len(child.stdin.frames()),3)
    def test_receipt_binding_fingerprint_counts_and_boolean_fail(self):
        policy=ce.validate_catalog_payload(self.payload);plan=self.payload['catalogPlan'];value=self.pass_value(1)
        self.assertEqual(ce.verify_catalog_receipt(value,1,policy,plan,self.window,observed_at=self.clock.utc()),value)
        for key,item in [('schema',True),('pass',True),('codeSha','f'*40),('auditPlanDigest','f'*64),('databaseWindowDigest','f'*64),
                ('lifecycleId','different'),('guardianNonce','different'),('auditConnectionAttempts',7),('automaticResend',True)]:
            bad=deepcopy(value);bad[key]=item
            with self.subTest(key=key),self.assertRaises(Denied):ce.verify_catalog_receipt(bad,1,policy,plan,self.window)
        for key,item in (('queries',18),('databases',2),('rows',17*16384+1),('bytes',16777217)):
            bad=deepcopy(value);bad['counts'][key]=item
            with self.subTest(count=key),self.assertRaises(Denied):ce.verify_catalog_receipt(bad,1,policy,plan,self.window)
        second=self.pass_value(2);second['catalogDigest']='f'*64
        with self.assertRaises(Denied):ce.verify_catalog_receipt(second,2,policy,plan,self.window,prior=value)
    def test_private_receipt_hash_canonical_and_expired_import_are_distinct(self):
        event=self.save_pass(1);policy=ce.validate_catalog_payload(self.payload);plan=self.payload['catalogPlan']
        got=ce.read_catalog_receipt(self.db,1,event['sha256'],policy,plan,self.window);self.clock.advance(601)
        self.assertEqual(ce.read_catalog_receipt(self.db,1,event['sha256'],policy,plan,self.window),got)
        with self.assertRaises(Denied):ce.read_catalog_receipt(self.db,1,event['sha256'],policy,plan,self.window,observed_at=self.clock.utc())
        with self.assertRaises(Denied):ce.read_catalog_receipt(self.db,1,'f'*64,policy,plan,self.window)
        with self.assertRaises(ValueError):ce.strict_json(b'{"schema":1,"schema":1}')
        with self.assertRaises(ValueError):ce.strict_json(b'{"value":NaN}')
        with self.assertRaises(UnicodeError):ce.strict_json(b'{"value":"\xff"}')
    def test_signed_catalog_plan_cannot_be_replaced(self):
        changed=deepcopy(self.payload);changed['catalogPlan']['bootstrapOwnerSet']={'schema':1,'kind':'temporary-owner-set-v1','authoritySha256':'f'*64}
        with self.assertRaises(Denied):ce.validate_catalog_payload(changed)
        policy=json.loads(changed['environment']['TRIAL_POLICY_JSON']);policy['localOperator']['catalogPlanDigest']=ce.catalog_digest(changed['catalogPlan'])
        changed['environment']['TRIAL_POLICY_JSON']=json.dumps(policy);ce.validate_catalog_payload(changed)
        changed['catalogPlan']['bootstrapOwnerSet']['schema']=True
        policy['localOperator']['catalogPlanDigest']=ce.catalog_digest(changed['catalogPlan']);changed['environment']['TRIAL_POLICY_JSON']=json.dumps(policy)
        with self.assertRaises(Denied):ce.validate_catalog_payload(changed)
    def test_broker_immediate_next_request_does_not_race_pending(self):
        worker,child=self.worker();done=threading.Event()
        def respond(frame):
            if frame.get('type')=='permit_snapshot' and frame['id']==1:child.stdout.feed({'type':'permit_request','schema':1,'id':2})
            elif frame.get('type')=='permit_snapshot' and frame['id']==2:done.set()
        child.stdin.on_flush=respond;child.stdout.feed({'type':'permit_request','schema':1,'id':1});self.assertTrue(done.wait(2))
        with worker._request_lock:self.assertIsNone(worker._waiting_request)
        self.assertFalse(worker._fault.is_set());snapshots=[f for f in child.stdin.frames() if f['type']=='permit_snapshot']
        self.assertEqual([f['id'] for f in snapshots],[1,2]);self.assertEqual(self.budget.count('owner_control_blob'),34)
        self.assertEqual(set(snapshots[0]['snapshot']['cloud_guard']),{'nonce','job_started_at'});self.assertNotIn('owner_access',snapshots[0]['snapshot'])
    def test_broker_http_wait_does_not_hold_heartbeat_or_mix_purposes(self):
        entered=threading.Event();release=threading.Event();heartbeat_done=threading.Event();errors=[]
        def transport(method,url,headers,body,deadline):
            if headers.get('fixture-action')!='heartbeat':
                entered.set()
                if not release.wait(2):raise TimeoutError('fictional blocked GET')
            return {'status':200,'headers':{'etag':'"fictional"'},'body':encoded(self.state)}
        wire=execution.CountedHttp(transport,self.receipt,self.budget,accounting_lock=self.receipt.mutex);reader=self.reader(wire)
        def base_init(session,config,*,http,**kwargs):session.fixture_http=http
        def base_action(session,action):return session.fixture_http('GET',self.config['journal_url'],{'fixture-action':action},None,Deadline(5,self.clock.monotonic))
        def broker():
            try:reader.read()
            except BaseException as error:errors.append(type(error).__name__)
        with patch.object(owner.OwnerSession,'__init__',base_init),patch.object(owner.OwnerSession,'action',base_action):
            session=execution.CountedSession(self.config,wire,self.clock);thread=threading.Thread(target=broker,daemon=True);thread.start();self.assertTrue(entered.wait(1))
            def heartbeat():
                try:session.action('heartbeat')
                except BaseException as error:errors.append(type(error).__name__)
                finally:heartbeat_done.set()
            other=threading.Thread(target=heartbeat,daemon=True);other.start()
            try:
                self.assertTrue(heartbeat_done.wait(1));self.assertEqual(self.budget.count('owner_control_blob'),33);self.assertEqual(self.budget.count('heartbeat_blob'),1)
                self.assertEqual(self.receipt.count('owner_control_blob'),1);self.assertEqual(self.receipt.count('heartbeat_blob'),1)
            finally:release.set();thread.join(2);other.join(2)
        self.assertFalse(thread.is_alive());self.assertFalse(other.is_alive());self.assertEqual(errors,[])
        raw=self.receipt.path.read_bytes();self.receipt.close();reopened=Receipt(str(self.guard),digest(str(self.guard)),'c'*64)
        try:self.assertEqual(reopened.path.read_bytes(),raw)
        finally:reopened.close()
    def test_wrong_broker_id_and_partial_eof_never_report_completion(self):
        for raw in (encoded({'type':'permit_request','schema':1,'id':2})+b'\n',b'{"type":"catalog_pass"'):
            worker,child=self.worker();child.stdout.feed(raw);self.assertTrue(worker._eof.wait(2));self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop());self.assertFalse(worker.poll())
        self.assertEqual(self.receipt.find('worker_result'),[])

    def pooled_token_reader(self):
        budget,verified,_=budget_fixture(self);budget.begin_attempt(verified,initialize=True)
        pool=OwnerTokenPool(verified,self.clock);self.addCleanup(pool.close)
        config=deepcopy(self.config);config.update(owner_id=verified.authority['owner_id'],tenant_id='00000000-0000-0000-0000-000000000003')
        raw=Mock(mode='owner',principal=config['owner_id'],tenant=config['tenant_id'])
        raw.token.side_effect=lambda audience,deadline:jwt({'oid':raw.principal,'tid':raw.tenant,'aud':audience,'exp':self.clock.utc().timestamp()+3600})
        credential=pool.bind(raw,scope(budget,verified,'run'),verified)
        reader=ce.FixedPermitReader(config,self.initial,self.counted,self.clock,credential=credential)
        return reader,budget,raw

    def test_owner_token_pool_miss_is_fsynced_before_secret_and_hit_is_not_debited(self):
        reader,budget,raw=self.pooled_token_reader();events=[];fsync=os.fsync;token=raw.token.side_effect
        def durable(fd):fsync(fd);events.append('fsync')
        def acquire(audience,deadline):
            self.assertEqual(budget.count('owner_arm'),188)
            self.assertIn(b'"purpose":"owner_token"',budget.journal.path.read_bytes());events.append('credential')
            return token(audience,deadline)
        raw.token.side_effect=acquire
        with patch('scripts.trial_provision.journal.os.fsync',side_effect=durable):
            first=reader.owner_token('https://storage.azure.com/')
            self.assertEqual(reader.owner_token('https://storage.azure.com/'),first)
        self.assertEqual(events,['fsync','credential']);self.assertEqual(raw.token.call_count,1)
        self.assertEqual(set(first),{'accessToken','tenant','expires_on'})
        for journal in (self.receipt.path,budget.journal.path):self.assertNotIn(first['accessToken'].encode(),journal.read_bytes())
        reader.cancel()
        with self.assertRaises(Denied):reader.owner_token('https://storage.azure.com/')
        self.assertEqual(raw.token.call_count,1)

    def test_owner_token_unknown_audience_or_failed_fsync_never_acquires(self):
        reader,budget,raw=self.pooled_token_reader()
        for audience in ('https://graph.microsoft.com/','https://evil.example/','https://storage.azure.com'):
            with self.subTest(audience=audience),self.assertRaises(Denied):reader.owner_token(audience)
        self.assertEqual(budget.count('owner_arm'),187);raw.token.assert_not_called()
        with patch('scripts.trial_provision.journal.os.fsync',side_effect=OSError('fictional fsync failure')):
            with self.assertRaises(OSError):reader.owner_token('https://storage.azure.com/')
        raw.token.assert_not_called()

    def test_owner_token_protocol_requires_parent_fsynced_pass1(self):
        worker,child=self.worker();reader,budget,raw=self.pooled_token_reader();worker._permit_reader=reader
        child.stdout.feed({'type':'owner_token_request','schema':1,'id':1,'audience':'https://storage.azure.com/'})
        self.assertTrue(worker._eof.wait(2));self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop())
        raw.token.assert_not_called();self.assertEqual(budget.count('owner_arm'),187)
        self.assertFalse(any(frame['type']=='owner_token' for frame in child.stdin.frames()))

    def test_owner_token_responses_are_private_and_next_id_never_races_pending(self):
        worker,child=self.worker();reader,budget,raw=self.pooled_token_reader();worker._permit_reader=reader
        worker._accept_catalog(self.save_pass(1));done=threading.Event()
        def respond(frame):
            if frame.get('type')=='owner_token' and frame['id']==1:
                child.stdout.feed({'type':'owner_token_request','schema':1,'id':2,'audience':'https://storage.azure.com/'})
            elif frame.get('type')=='owner_token' and frame['id']==2:done.set()
        child.stdin.on_flush=respond
        child.stdout.feed({'type':'owner_token_request','schema':1,'id':1,'audience':'https://storage.azure.com/'})
        self.assertTrue(done.wait(2))
        with worker._request_lock:self.assertIsNone(worker._waiting_token)
        frames=[frame for frame in child.stdin.frames() if frame['type']=='owner_token']
        self.assertEqual([frame['id'] for frame in frames],[1,2]);self.assertFalse(worker._fault.is_set())
        self.assertEqual(raw.token.call_count,1);self.assertEqual(budget.count('owner_arm'),188)
        token=frames[0]['credential']['accessToken'].encode()
        for path in (self.receipt.path,budget.journal.path,self.db/'trial-catalog-pass-1.json'):self.assertNotIn(token,path.read_bytes())
        # Replayed id is terminal, cannot issue another token or recover by GET.
        child.stdout.feed({'type':'owner_token_request','schema':1,'id':2,'audience':'https://storage.azure.com/'})
        self.assertTrue(worker._eof.wait(2));self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop())
        self.assertEqual(raw.token.call_count,1);self.assertEqual(len([f for f in child.stdin.frames() if f['type']=='owner_token']),2)

    def test_owner_token_bad_id_and_audience_fail_without_pool_access(self):
        for change in ({'id':17},{'id':True},{'id':2},{'audience':'https://graph.microsoft.com/'},{'extra':True}):
            with self.subTest(change=change):
                worker,child=self.worker();reader=worker._permit_reader;reader.owner_token=Mock(side_effect=AssertionError('unexpected token'))
                worker._bootstrap_sent=True  # Isolate strict frame validation; positive pass1 is tested above.
                child.stdout.feed({'type':'owner_token_request','schema':1,'id':1,'audience':'https://storage.azure.com/',**change})
                self.assertTrue(worker._eof.wait(2));self.assertTrue(worker._fault.is_set());self.assertTrue(worker.stop());reader.owner_token.assert_not_called()

    def test_owner_token_eof_alone_cancels_and_discards_late_pending_secret(self):
        worker,child=self.worker();reader,budget,raw=self.pooled_token_reader();worker._permit_reader=reader
        worker._accept_catalog(self.save_pass(1));entered=threading.Event();release=threading.Event();acquire=raw.token.side_effect
        def delayed(audience,deadline):
            entered.set()
            if not release.wait(2):raise TimeoutError('fictional delayed token')
            return acquire(audience,deadline)
        raw.token.side_effect=delayed
        child.stdout.feed({'type':'owner_token_request','schema':1,'id':1,'audience':'https://storage.azure.com/'})
        self.assertTrue(entered.wait(1));child.stdout.close();self.assertTrue(worker._eof.wait(1))
        # EOF itself must revoke before any explicit stop()/poll() cleanup.
        self.assertTrue(reader.cancelled.is_set());self.assertTrue(worker._fault.is_set());self.assertIsNotNone(child.poll())
        release.set();self.assertTrue(worker.stop());self.assertFalse(worker.poll())
        self.assertEqual(budget.count('owner_arm'),188);self.assertEqual(raw.token.call_count,1)
        self.assertFalse(any(frame['type']=='owner_token' for frame in child.stdin.frames()))
        self.assertEqual(self.receipt.find('worker_result'),[])

    def test_stdout_eof_without_result_revokes_even_if_child_has_not_exited(self):
        worker,child=self.worker();before=child.stdin.frames();child.stdout.close()
        self.assertTrue(worker._eof.wait(1));self.assertTrue(worker._fault.is_set())
        self.assertTrue(worker._permit_reader.cancelled.is_set());self.assertIsNotNone(child.poll())
        with self.assertRaises(Denied):worker.permit(before[1])
        self.assertEqual(child.stdin.frames(),before);self.assertFalse(worker.poll())
        self.assertEqual(self.receipt.find('worker_result'),[])

    def accept_successful_result(self,worker):
        for pass_no in (1,2,3):worker._accept_catalog(self.save_pass(pass_no))
        value={'status':'completed','completedRequests':10,
            'bootstrap':{'schema':1,'status':'bootstrapped','databaseBaselineBytes':1,'cases':4,'automaticResend':False,
                'finalRuntimePolicySha256':'1'*64,'databaseWindowDigest':ce.catalog_digest(self.window),
                'receiptSetSha256':'2'*64,'receiptCount':1,'proofSha256':'3'*64},
            'catalog':{'schema':1,'auditPlanDigest':ce.catalog_digest(self.payload['catalogPlan']),'auditConnectionAttempts':1,
                **{'pass%dSha256'%i:worker.pass_hashes[i-1] for i in (1,2,3)}}}
        worker._accept_result(value);return value

    def test_periodic_permit_exit_zero_while_waiting_for_send_lock_is_not_protocol_fault(self):
        worker,child=self.worker();result=self.accept_successful_result(worker);before=child.stdin.frames()
        entered=threading.Event();errors=[];send=worker._send
        def observed(value,**kwargs):entered.set();return send(value,**kwargs)
        worker._send=observed;worker._send_lock.acquire()
        def update():
            try:worker.permit(child.stdin.frames()[1])
            except BaseException as error:errors.append(type(error).__name__)
        thread=threading.Thread(target=update,daemon=True);thread.start();self.assertTrue(entered.wait(1))
        child.exit(0);worker._send_lock.release();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[]);self.assertFalse(worker._fault.is_set())
        self.assertEqual(child.stdin.frames(),before);self.assertTrue(worker._eof.wait(1));self.assertTrue(worker.poll())
        self.assertEqual(worker.output,result);self.assertEqual(len(self.receipt.find('worker_result')),1)

    def test_complete_result_eof_waits_for_exit_and_does_not_forge_exit_zero(self):
        worker,child=self.worker();self.accept_successful_result(worker);child.stdout.close()
        self.assertTrue(worker._eof.wait(1));self.assertFalse(worker._fault.is_set())
        self.assertIsNone(worker.poll());self.assertEqual(self.receipt.find('worker_result'),[])
        child.exit(1);self.assertFalse(worker.poll());self.assertEqual(self.receipt.find('worker_result'),[])
    def test_new_preflight_separates_pending_db_acl_from_verified_launch(self):
        config=deepcopy(self.config);config['worker']={'mode':ce.MODE,'payload':deepcopy(self.payload)}
        config['preflight']={'schema':2,'catalog_acl':'pending_catalog','launch_checks_verified':True,
            'checked_at':self.clock.utc().isoformat(),'ci_head':'a'*40,'reviewed_head':'a'*40,'ipv4':config['binding']['ipv4'],
            'server_id':SERVER,'rule_id':RULE,'initial_forecast_yen':4500,'initial_cap_yen':5000,'all_unsettled_retained':True,'no_production_change':True,
            'evidence_sha256':{k:'a'*64 for k in ('network_approval','current_ip','platform_isolation','current_ledger','current_prices','effective_permissions','additional_authority')}}
        execution.validate_launch_preflight(config,self.clock)
        for key,value in (('external_business_acl_verified',True),('all_evidence_verified',True),('schema',True)):
            changed=deepcopy(config);changed['preflight'][key]=value
            with self.subTest(key=key),self.assertRaises(Denied):execution.validate_launch_preflight(changed,self.clock)
    def test_old_binding_contract_does_not_parse_catalog(self):
        config={k:'legacy-'+k for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
        payload={'requests':[],'azureCliPython':'C:\\Python\\python.exe','recoveryDirectory':'C:\\試験\\回復'};config['worker']={'payload':payload}
        expected={k:config[k] for k in ('guardian_job','binding','owner_access','cleanup_strategy','journal_url','prearm_until','seed_not_before')}
        expected.update(worker_request_digest=digest([]),worker_azure_cli_python=payload['azureCliPython'],worker_artifact_pin_digest=digest(None),
            network_source_binding_digest=digest(None),guardian_config_digest=digest(None),worker_target_digest=digest({'environment':None,'access':None,
            'recoveryDirectory':payload['recoveryDirectory'],'bootstrap':{'manifest':None,'mode':None}}),preflight=None,control_budget=None)
        with patch.object(ce,'validate_catalog_payload',side_effect=AssertionError('legacy must not parse catalog')):self.assertEqual(execution.execution_binding(config),expected)
        self.assertIn(b'\\u8a66',encoded(expected['worker_azure_cli_python']+payload['recoveryDirectory']));self.assertIn('試験'.encode(),ce.canonical(payload))
    def test_legacy_resume_keeps_cleanup_without_catalog_or_fresh_preflight(self):
        config=deepcopy(self.config);config.update(recovery_directory=str(self.guard),recovery_directory_digest=digest(str(self.guard)),
            prearm_until=self.clock.utc().isoformat(),seed_not_before=self.clock.utc().isoformat(),guardian_job={})
        payload={k:deepcopy(v) for k,v in self.payload.items() if k!='catalogPlan'}
        config['worker']={'node':str(Path(sys.executable).resolve()),'script':str(self.script),'payload':payload,'artifact_pin':{'head':'a'*40}}
        receipt=Mock();receipt.mutex=threading.RLock();receipt.find.side_effect=lambda event:[{'request_id':'existing'}] if event=='start_intent' else []
        expected={'status':'reconciliation_required','cleanupConfirmed':True,'workComplete':False}
        with patch.object(execution,'validate_worker_directories'),patch.object(execution,'validate_worker_artifact') as artifact,\
            patch.object(execution,'validate_launch_preflight') as preflight,patch.object(execution,'guardian_configuration'),\
            patch.object(execution,'open_control_budget'),patch.object(execution,'Receipt',return_value=receipt),\
            patch.object(execution,'AzureJobStarter') as starter,patch.object(execution,'Workflow') as workflow,\
            patch.object(execution.signal,'signal'),patch.object(ce,'FixedPermitReader') as reader,patch.object(execution.subprocess,'Popen') as process:
            workflow.return_value.run.return_value=expected;self.assertEqual(execution.execute(config,clock=self.clock),expected)
        self.assertTrue(starter.call_args.kwargs['recovery_only']);self.assertIsInstance(workflow.call_args.args[3],execution.NodeWorker)
        preflight.assert_not_called();reader.assert_not_called();process.assert_not_called()
        self.assertFalse(any(call.kwargs.get('verify_files') for call in artifact.call_args_list));receipt.close.assert_called_once()

if __name__=='__main__':unittest.main()
