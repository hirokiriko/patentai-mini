"""V6 digest observations with memory-only fixtures; no live auth or I/O.

The historical verifier is an explicit seam in the wire tests. Canonical V6
succession tests separately establish that capability; no production bypass is
introduced here. Actual legacy ACK validation is also exercised below.
"""
import base64
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from urllib.parse import parse_qs

from scripts.trial_guard.adapters import digest,encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a,registry_publish as p
from scripts.trial_provision import publication_bridge as bridge,registry_cli as cleanup,registry_publish_cli as cli
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal
from scripts.trial_provision.tests.test_operations import fixture


class Clock:
    def __init__(self):self.now=datetime(2026,10,14,0,0,tzinfo=timezone.utc);self.seconds=0
    def utc(self):return self.now+timedelta(seconds=self.seconds)
    def monotonic(self):return self.seconds


class Budget:
    def __init__(self):self.used={'http':0,'owner_token':0};self.after=None
    def _consume(self,purpose):
        maximum={'http':6,'owner_token':2}
        if self.used[purpose]>=maximum[purpose]:raise Denied('fictional_budget_exhausted')
        self.used[purpose]+=1
        if self.after:self.after()
    def consume(self,kind,limit):
        assert kind=='owner_arm' and limit==600
        self._consume('http')
    def consume_owner_token(self):self._consume('owner_token')


def jwt(claims):return 'fictional.'+base64.urlsafe_b64encode(encoded(claims)).decode().rstrip('=')+'.fictional'


class ReusedImageTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock();self.core,self.manifest,self.authority,self.resources=fixture()
        self.manifest.update(cleanupImageTag='fictional-guardian',imageTag='fictional-runtime')
        self.oldhead=self.resources['code_sha'];self.newhead='9'*40
        self.owner=self.manifest['owner'];self.host=self.manifest['registry']['loginServer']
        sources={k:{'sha256':str(i)*64} for i,k in enumerate(('manifest','annex','approval','latest','network_binding','network_approval'),1)}
        slot={'docker_path':'C:/fictional/docker.exe','docker_sha256':'a'*64,'docker_host':p.DOCKER_HOSTS[0],
            'local_image_id':'sha256:'+'3'*64,'build_receipt':{'path':'C:/fictional/build.json','sha256':'b'*64}}
        oldconfig={'sources':sources,'frozen_head':self.oldhead,'publication':{'publish_until':'2026-10-13T01:30:00Z',
            'slots':{k:deepcopy(slot) for k in ('guardian','runtime')}}}
        self.origin=MemoryJournal([('binding',{'old':'fictional'})])
        self.prep=p.prepare_publication(oldconfig,self.manifest,'c'*64,self.origin)
        self.bodies={};self.images={}
        for i,key in enumerate(('guardian','runtime')):
            fixed=self.prep['slots'][key];ident=key+'ImagePush'
            body=encoded({'schemaVersion':2,'config':{'digest':slot['local_image_id'],'size':120},
                'layers':[{'digest':'sha256:'+str(i+4)*64,'size':300}]})
            md='sha256:'+p.sha(body);self.bodies[key]=body
            base='https://'+self.host+'/v2/'+fixed['repository']+'/manifests/'
            request_digest=str(i+6)*64
            self.origin.append('intent',{'operation_id':ident,'request_digest':request_digest,'method':'PUT',
                'url':base+fixed['tag']+'?api-version='+p.VERSION,'at':'2026-10-13T01:00:01Z','deadline':self.prep['publish_until']})
            self.origin.append(key+'_image_namespace',{'publication_preparation_digest':digest(self.prep),
                'run_binding_digest':self.prep['run_binding_digest'],'push_request_digest':request_digest,
                'authenticated':True,'http':404,'error_code':'NAME_UNKNOWN','method':'GET','push_operation_id':ident,
                'registry_id':self.prep['registry_id'],'login_server':self.host,'repository':fixed['repository'],
                'url':'https://'+self.host+'/acr/v1/'+fixed['repository']+'?api-version='+p.VERSION,
                'response_sha256':'d'*64,'observed_at':'2026-10-13T01:00:00Z'})
            self.origin.append('progress',{'operation_id':ident,'request_digest':request_digest,'state':'succeeded',
                'ack_kind':'docker_exit0_digest','terminal':True,'write_terminal':True,'created_by_run':True,
                'readback_verified':True,'object_id':base+md+'?api-version='+p.VERSION,'observed_at':'2026-10-13T01:00:02Z',
                'properties':{'registry_id':self.prep['registry_id'],'login_server':self.host,'repository':fixed['repository'],
                    'manifest_digest':md,'purpose':key}})
            self.images[key+'_image']=self.host+'/'+fixed['repository']+'@'+md
        self.assertEqual(self.images,p.verified_publication_images(self.origin))
        self.origin_snapshot=encoded(self.origin.rows)
        self.proof={'authority':{'schema':6,'head':self.newhead,'image_build_head':self.oldhead,
            'owner_id':self.owner['principal_id'],'manifest_sha256':sources['manifest']['sha256'],
            'task_id':'fictional','attempt_id':'fictional-v6','parent':{'fictional':True},
            'tags':{k:self.prep['slots'][k]['tag'] for k in ('guardian','runtime')}},
            'activation':{'windows':{'publication':{'start':'2026-10-14T00:00:00Z','end':'2026-10-14T00:30:00Z'}}},
            'manifest_digest':digest(self.manifest),'authority_sha256':'7'*64,'activation_sha256':'8'*64}
        self.verified=a.VerifiedAttempt(self.proof,a._SEAL)
        self.source={'previous_publication':oldconfig,'previous_verified_proof':{'fictional':'sealed-elsewhere'},
            'previous_child_records':deepcopy(self.origin.rows),'publication_preparation':self.prep,
            'previous_build_artifacts':{k:{'image_id':slot['local_image_id']} for k in ('guardian','runtime')},
            'image_build_head':self.oldhead,'acknowledged_images':self.images}
        self.journal=MemoryJournal([('binding',{'manifest_sha256':sources['manifest']['sha256'],
            'owner_id':self.owner['principal_id'],'task_id':'fictional','attempt':{'schema':1,'id':'fictional-v6',
            'binding_digest':self.verified.binding_digest,'authority_sha256':'7'*64,'activation_sha256':'8'*64,
            'parent':{'fictional':True}}})])
        self.journal.receipts=lambda:{}
        self.source_patch=self.enterContext(patch.object(p,'_reuse_source',side_effect=lambda *_:(self.source,self.origin,self.images)))
        self.config={**deepcopy(oldconfig),'frozen_head':self.newhead,'verified_attempt':self.verified}
        self.config['publication']['publish_until']='2026-10-14T00:30:00Z'
        p._prepare_reused_images(self.config,self.manifest,'e'*64,self.journal)
        self.budget=Budget();self.pool=OwnerTokenPool(self.verified,self.clock);self.addCleanup(self.pool.close)
        self.owner_ttl=3600
        def token(audience,deadline):
            self.assertEqual('https://management.azure.com/',audience)
            return jwt({'oid':self.owner['principal_id'],'tid':self.owner['tenant_id'],
                'exp':self.clock.utc().timestamp()+self.owner_ttl})
        self.raw_credential=Mock(mode='owner',principal=self.owner['principal_id'],tenant=self.owner['tenant_id'])
        self.raw_credential.token.side_effect=token
        self.credential=self.pool.bind(self.raw_credential,self.budget,self.verified)
        self.calls=[];self.modify=None;self.access_actions=['pull'];self.guard=Mock()

    def wire(self,method,url,headers,body,deadline):
        self.assertEqual(1,len(self.journal.values('image_reuse_readback_intent')))
        self.calls.append((method,url));self.assertGreater(deadline.remaining(),0)
        if self.modify:
            result=self.modify(method,url)
            if isinstance(result,Exception):raise result
            if result is not None:return result
        claims={'aud':self.host,'nbf':self.clock.utc().timestamp()-1,'exp':self.clock.utc().timestamp()+3600}
        if url.endswith('/oauth2/exchange'):
            return {'status':200,'headers':{},'body':encoded({'refresh_token':jwt({**claims,
                'tenant':self.owner['tenant_id'],'grant_type':'refresh_token'})})}
        if url.endswith('/oauth2/token'):
            scope=parse_qs(body.decode())['scope'][0];repo=scope.removeprefix('repository:').removesuffix(':pull')
            self.assertEqual('repository:'+repo+':pull',scope)
            return {'status':200,'headers':{},'body':encoded({'access_token':jwt({**claims,
                'access':[{'type':'repository','name':repo,'actions':self.access_actions}]})})}
        self.assertEqual('GET',method);self.assertIn('@sha256:',self.images['guardian_image'])
        slot=next(k for k in ('guardian','runtime') if '/'+self.prep['slots'][k]['repository']+'/' in url)
        md=self.images[slot+'_image'].rsplit('@',1)[1]
        self.assertEqual('https://'+self.host+'/v2/'+self.prep['slots'][slot]['repository']+'/manifests/'+md+'?api-version='+p.VERSION,url)
        return {'status':200,'headers':{'Docker-Content-Digest':md},'body':self.bodies[slot]}

    def run_reuse(self):
        return p.verify_reused_images(self.journal,self.credential,self.wire,self.budget,self.clock,
            verified_attempt=self.verified,source_guard=self.guard)

    def assert_unchanged_origin_and_no_new_push(self):
        self.assertEqual(self.origin_snapshot,encoded(self.origin.rows))
        self.assertFalse(self.journal.values('intent'));self.assertFalse(self.journal.values('progress'))
        self.assertFalse(self.journal.values('publication_preparation'))
        self.assertNotIn('fictional.',encoded(self.journal.rows).decode())

    def test_six_http_one_cached_owner_miss_and_local_replay(self):
        self.assertEqual('reused_images_verified',self.run_reuse()['status'])
        self.assertEqual({'http':6,'owner_token':1},self.budget.used)
        self.assertEqual(['POST','POST','GET']*2,[v[0] for v in self.calls])
        self.assertEqual(self.images,p.verified_publication_images(self.journal,verified_attempt=self.verified))
        count=len(self.calls);self.clock.seconds=2000
        self.assertTrue(self.run_reuse()['replayed']);self.assertEqual(count,len(self.calls))
        self.assert_unchanged_origin_and_no_new_push()

    def test_two_owner_cache_misses_are_eight_total(self):
        self.owner_ttl=45
        self.assertEqual('reused_images_verified',self.run_reuse()['status'])
        self.assertEqual({'http':6,'owner_token':2},self.budget.used)

    def test_each_partial_failure_is_unknown_and_never_resent(self):
        for fail_at in range(1,7):
            with self.subTest(fail_at=fail_at):
                case=ReusedImageTests('runTest');case.setUp()
                try:
                    case.modify=lambda *_:TimeoutError('private diagnostic') if len(case.calls)==fail_at else None
                    self.assertEqual('unknown',case.run_reuse()['status'])
                    before=(len(case.calls),deepcopy(case.budget.used),case.raw_credential.token.call_count)
                    self.assertEqual('unknown',case.run_reuse()['status'])
                    self.assertEqual(before,(len(case.calls),case.budget.used,case.raw_credential.token.call_count))
                    self.assertFalse(case.journal.values('image_reuse_readback'))
                    self.assertNotIn('private diagnostic',encoded(case.journal.rows).decode())
                    case.assert_unchanged_origin_and_no_new_push()
                finally:case.doCleanups()

    def test_owner_auth_failure_is_counted_once_and_not_retried(self):
        self.raw_credential.token.side_effect=Denied('secret failure')
        self.assertEqual('unknown',self.run_reuse()['status']);self.assertFalse(self.calls)
        self.assertEqual({'http':0,'owner_token':1},self.budget.used)
        self.assertEqual('unknown',self.run_reuse()['status']);self.assertEqual(1,self.raw_credential.token.call_count)

    def test_push_scoped_token_is_rejected_before_manifest_read(self):
        self.access_actions=['pull','push']
        self.assertEqual('unknown',self.run_reuse()['status']);self.assertEqual(2,len(self.calls))

    def test_missing_changed_digest_or_redirect_never_completes(self):
        for response in ({'status':404,'headers':{},'body':b'{}'},
            {'status':200,'headers':{'Docker-Content-Digest':'sha256:'+'f'*64},'body':b'{}'},
            {'status':200,'headers':{'Location':'https://unapproved.invalid/'},'body':b'{}'}):
            with self.subTest(response=response):
                case=ReusedImageTests('runTest');case.setUp()
                try:
                    case.modify=lambda method,_:response if method=='GET' else None
                    self.assertEqual('unknown',case.run_reuse()['status']);self.assertEqual(3,len(case.calls))
                    with self.assertRaises(Denied):p.verified_publication_images(case.journal,verified_attempt=case.verified)
                finally:case.doCleanups()

    def test_intent_fsync_failure_prevents_auth_and_http(self):
        old=self.journal.append
        def append(event,value):
            if event=='image_reuse_readback_intent':raise OSError('fixture fsync')
            return old(event,value)
        self.journal.append=append
        with self.assertRaises(OSError):self.run_reuse()
        self.raw_credential.token.assert_not_called();self.assertFalse(self.calls)

    def test_result_fsync_failure_keeps_intent_and_zero_resend(self):
        old=self.journal.append
        def append(event,value):
            if event=='image_reuse_readback':raise OSError('fixture fsync')
            return old(event,value)
        self.journal.append=append
        self.assertEqual('unknown',self.run_reuse()['status'])
        before=deepcopy(self.budget.used)
        self.assertEqual('unknown',self.run_reuse()['status']);self.assertEqual(before,self.budget.used)

    def test_window_closes_during_durable_debit_no_send(self):
        self.budget.after=lambda:setattr(self.clock,'seconds',1800)
        self.assertEqual('unknown',self.run_reuse()['status'])
        self.assertFalse(self.calls);self.assertEqual(1,self.budget.used['owner_token'])

    def test_expired_before_intent_is_zero_token_zero_http(self):
        self.clock.seconds=1800
        with self.assertRaises(Denied):self.run_reuse()
        self.assertFalse(self.journal.values('image_reuse_readback_intent'));self.raw_credential.token.assert_not_called()

    def test_changed_saved_readback_or_foreign_binding_is_rejected(self):
        self.run_reuse();self.journal.live('image_reuse_readback')['checks']['runtime']['image_id']='sha256:'+'f'*64
        with self.assertRaises(Denied):p.verified_publication_images(self.journal,verified_attempt=self.verified)
        before=len(self.calls)
        with self.assertRaises(Denied):self.run_reuse()
        self.assertEqual(before,len(self.calls))

    def test_reuse_import_new_plan_retains_old_ownership_for_cleanup(self):
        self.run_reuse();resources={**self.resources,**self.images,'code_sha':self.oldhead,
            'guardian_deadline':'2026-10-14T08:35:00Z'}
        resolver=SimpleNamespace(plan_digest='f'*64,initial_plan={'resource_bindings':resources,
            'source_sha256':self.prep['source_sha256'],'windows':{'owner_input':{'end':'2026-10-14T02:20:00Z'}}},
            resolve=lambda *_:{'cleanup':{'deadline':resources['guardian_deadline']}})
        event=p.bind_publication(self.journal,resolver,resources,verified_attempt=self.verified)
        self.assertEqual(2,event['schema']);self.assertEqual('acknowledged-image-reuse',event['kind'])
        bundle=p.registry_cleanup_bundle(self.manifest,self.journal,resolver,verified_attempt=self.verified)
        self.assertEqual(self.origin.latest('guardianImagePush'),bundle['push_receipt'])
        binding,op=cleanup._prepare(bundle,self.manifest,resources,self.journal,resolver,self.credential,self.verified)
        self.assertEqual(self.origin.latest('guardianImagePush')['object_id'],op['url'])
        self.assertEqual('guardian',op['cleanup']['purpose']);self.assertNotEqual(self.images['runtime_image'],op['url'])
        self.assertEqual(digest(self.journal.values('binding')[0]),bundle['scope_proof']['run_binding_digest'])
        self.assert_unchanged_origin_and_no_new_push()

    def test_import_needs_complete_readback_and_matching_old_build_head(self):
        resources={**self.resources,**self.images,'code_sha':self.newhead}
        resolver=SimpleNamespace(plan_digest='f'*64,initial_plan={'resource_bindings':resources,'source_sha256':self.prep['source_sha256']})
        with self.assertRaises(Denied):p.bind_publication(self.journal,resolver,resources,verified_attempt=self.verified)
        self.run_reuse()
        with self.assertRaises(Denied):p.bind_publication(self.journal,resolver,resources,verified_attempt=self.verified)
        self.assertFalse(self.journal.values('publication_import'))

    def test_v6_cannot_enter_publisher_even_with_old_positive_ack(self):
        with patch('scripts.trial_provision.registry_retention.check_attempt'),patch.object(p.Path,'read_bytes',side_effect=AssertionError('file read')):
            with self.assertRaises(Denied):p.run_registry_publish({},self.manifest,self.journal,self.credential,self.wire,
                self.budget,self.clock,verified_attempt=self.verified,runner=Mock(side_effect=AssertionError('Docker')))
        self.raw_credential.token.assert_not_called();self.assertFalse(self.calls)

    def test_unsealed_schema6_and_legacy_reuse_are_rejected(self):
        with self.assertRaises(Denied):p.reuses_acknowledged_images(SimpleNamespace(authority={'schema':6}))
        self.assertFalse(p.reuses_acknowledged_images(None))
        # The only historical-source seam is removed for this gate.
        with self.assertRaises(Denied):a._proof(None)

    def test_bridge_keeps_local_head_and_policy_image_head_distinct(self):
        self.run_reuse()
        publication={**self.config,'schema':1,'config_sha256':'e'*64,'manifest':self.manifest,
            'authority_bundle':self.authority,'ci':{},'recovery':{},'control_budget':{},'live':True}
        inputs={'schema':1,'publication_config_sha256':'e'*64,'policy_verifier_node':'C:/fictional/node.exe',
            'plan_bindings':{'guardian_window':{'start':'2026-10-14T00:35:00Z','end':'2026-10-14T08:35:00Z'},
                'owner_window':{'start':'2026-10-14T01:20:00Z','end':'2026-10-14T02:20:00Z'}},
            'deadline':'2026-10-14T02:20:00Z','secret_sources':{
                'trial-web-database':{'path':'C:/fictional/web.secret','sha256':'a'*64},
                'trial-worker-database':{'path':'C:/fictional/worker.secret','sha256':'b'*64}}}
        with patch.object(bridge,'build_resource_operations',return_value=[]) as resource_schema:
            result=bridge.compose_configuration(publication,self.journal,inputs,verify_local_node=False)
        self.assertEqual(self.newhead,result['frozen_head']);self.assertEqual(self.oldhead,result['resource_bindings']['code_sha'])
        self.assertEqual(self.images['guardian_image'],result['resource_bindings']['guardian_image'])
        self.assertEqual(self.oldhead,resource_schema.call_args.args[2]['code_sha'])
        self.assertEqual(inputs['secret_sources'],result['secret_sources'])

    def test_build_receipts_accept_only_old_pinned_image_head(self):
        proof=deepcopy(self.proof)
        proof['authority']['tags']={s:a._slot(self.manifest,self.oldhead,s)['tag'] for s in ('guardian','runtime')}
        verified=a.VerifiedAttempt(proof,a._SEAL);config={**self.config,'verified_attempt':verified,'build_receipts':{}}
        for slot in ('guardian','runtime'):
            fixed=config['publication']['slots'][slot];selected=a.effective_slot(self.manifest,self.newhead,slot,verified)
            config['build_receipts'][slot]={'schema':1,'slot':slot,'manifest_sha256':config['sources']['manifest']['sha256'],
                'source_head':self.oldhead,'managed_build_sha':self.oldhead,'request_digest':'c'*64,'method':'docker-build',
                'attempt':1,'exit_code':0,'readback_verified':True,'docker_sha256':fixed['docker_sha256'],
                'docker_host':fixed['docker_host'],'image_id':fixed['local_image_id'],
                'image_ref':self.host+'/'+selected['repository']+':'+selected['tag']}
        cli.validate_build_receipts(config,self.manifest)
        config['build_receipts']['runtime']['source_head']=self.newhead
        with self.assertRaises(Denied):cli.validate_build_receipts(config,self.manifest)
        config['build_receipts']['runtime']['source_head']=self.oldhead
        config['verified_attempt']=None
        with self.assertRaises(Denied):cli.validate_build_receipts(config,self.manifest)

    def cli_call(self,action,**extra):
        """Only file/loader/counter acquisition is injected; actual dispatcher runs."""
        preview={'sources':self.config['sources'],'recovery':{'directory':'C:/fictional','directory_digest':'d'*64},
            'control_budget':{'directory':'C:/fictional','directory_digest':'d'*64,'binding':{'task_id':'fictional'},
                'seed':{'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}}}
        loaded={**self.config,**preview,'config_sha256':'e'*64,'manifest':self.manifest,'live':True,
            'code_sources':{'fixed':'a'*64},'gates':{'publication_window_open':True}}
        path=Mock();path.is_absolute.return_value=True;path.is_symlink.return_value=False
        path.is_file.return_value=True;path.read_bytes.return_value=encoded(preview)
        with ExitStack() as stack:
            stack.enter_context(patch.object(cli,'Path',return_value=path))
            stack.enter_context(patch.object(cli,'verify_owner_file'))
            stack.enter_context(patch.object(cli,'private_bytes',return_value=encoded(self.manifest)))
            stack.enter_context(patch.object(cli,'git',return_value=self.newhead.encode()))
            stack.enter_context(patch.object(cli,'local_sources',return_value=loaded['code_sources']))
            stack.enter_context(patch.object(cli,'load_publication_configuration',return_value=loaded))
            stack.enter_context(patch.object(cli,'validate_build_receipts'))
            stack.enter_context(patch.object(cli,'journal_descriptor',return_value=('fictional',{})))
            journal=stack.enter_context(patch.object(cli,'Journal'))
            journal.return_value.__enter__.return_value=self.journal
            budget=stack.enter_context(patch.object(cli,'ControlBudget'))
            budget.return_value.__enter__.return_value=self.budget
            self.budget.begin_attempt=Mock();self.budget.count=lambda _:302+sum(self.budget.used.values())
            scope=stack.enter_context(patch.object(cli,'scope_for_dispatch',return_value=self.budget))
            credential=stack.enter_context(patch.object(cli,'AzureCredential',return_value=self.raw_credential))
            stack.enter_context(patch.object(cli,'BoundedHttp',side_effect=AssertionError('live HTTP')))
            try:
                result=cli.run_command({'config':'C:/fictional/publication.json','action':action,**extra},
                    clock=self.clock,wire=self.wire,owner_token_pool=self.pool)
                return result,scope.call_args
            finally:self.cli_acquired=(journal.call_count,credential.call_count)

    def test_cli_strict_reuse_dispatch_and_same_pool(self):
        result,scope=self.cli_call('verify-reused-images')
        self.assertEqual('reused_images_verified',result['status']);self.assertEqual(309,result['control_requests_used'])
        self.assertEqual({'entry_point':'publication','action':'verify-reused-images'},scope.kwargs)
        self.assertEqual({'http':6,'owner_token':1},self.budget.used)

    def test_cli_v6_publish_and_old_publication_cleanup_stop_before_journal_auth(self):
        for action,extra in (('publish',{'slot':'guardian'}),('cleanup-publication',{})):
            with self.subTest(action=action),self.assertRaises(Denied):self.cli_call(action,**extra)
            self.assertEqual((0,0),self.cli_acquired)
        self.assertFalse(self.calls)

    def test_cli_reuse_cannot_accept_slot_or_arbitrary_reference(self):
        for extra in ({'slot':'guardian'},{'provision':{'path':'C:/arbitrary','sha256':'0'*64}},
                      {'source':{'path':'C:/arbitrary','sha256':'0'*64}}):
            with self.subTest(extra=extra),patch.object(cli,'Path',side_effect=AssertionError('file read')):
                with self.assertRaises(Denied):cli.run_command({'config':'C:/fictional','action':'verify-reused-images',**extra})


class CanonicalReuseTests(unittest.TestCase):
    def fixture(self):
        from scripts.trial_provision.tests import test_acknowledged_image_succession as f
        from scripts.trial_provision.tests.test_attempt import chain
        data=f.fixture();rows=deepcopy(data['child_rows']);bodies={};replacements={}
        for i,slot in enumerate(('guardian','runtime')):
            body=encoded({'schemaVersion':2,'config':{'digest':data['prep']['slots'][slot]['local_image_id'],'size':100},
                'layers':[{'digest':'sha256:'+str(i+6)*64,'size':200}]})
            bodies[slot]=body;old=data['images'][slot+'_image'].rsplit('@',1)[1]
            self.assertNotEqual(old,data['prep']['slots'][slot]['local_image_id'])
            replacements[old]='sha256:'+p.sha(body)
        def replace(value):
            if isinstance(value,str):
                for old,new in replacements.items():value=value.replace(old,new)
                return value
            if isinstance(value,dict):return {k:replace(v) for k,v in value.items()}
            if isinstance(value,(tuple,list)):return [replace(v) for v in value]
            return value
        rows=replace(rows)
        def one(event):return next(value for name,value in rows if name==event)
        origin=MemoryJournal(rows)
        pending=next(v for e,v in rows if e=='progress' and v['operation_id']=='runtimeImagePush'
            and v.get('write_terminal') is True and v['terminal'] is False)
        one('runtime_image_retention')['push_ack_sha256']=digest(pending)
        plan=one('plan');imported=one('publication_import')
        imported['initial_plan_digest']=digest(plan)
        imported['push_receipt_digests']={s:digest(origin.latest(s+'ImagePush')) for s in ('guardian','runtime')}
        for event in ('provision_bridge_intent','provision_bridge_output'):
            one(event)['image_receipt_digests']=deepcopy(imported['push_receipt_digests'])
        one('provision_bridge_prepared').update(binding_digest=digest(one('provision_bridge_intent')),
            plan_digest=digest(plan),publication_import_digest=digest(imported))
        raw,_=chain(rows);data['proof']['previous_child_raw']=raw.decode()
        owner=a._json(data['proof']['owner_cleanup_raw'].encode());owner['child_sha256']=a._sha(raw)
        data['proof']['owner_cleanup_raw']=encoded(owner).decode();f.reseal(data)
        verified=f.verify(data);config={**data['new']['config'],'verified_attempt':verified}
        _,binding=a.journal_descriptor(config,verified);journal=MemoryJournal([('binding',binding)])
        journal.receipts=lambda:{}
        before=(data['proof']['previous_child_raw'],data['counter_raw'])
        return data,verified,config,journal,bodies,before

    def test_canonical_v6_source_to_readback_import_cleanup_without_old_unknown_adoption(self):
        data,verified,config,journal,bodies,before=self.fixture()
        manifest=data['new']['manifest'];owner=manifest['owner'];host=manifest['registry']['loginServer']
        clock=Clock();clock.now=datetime.fromisoformat(verified.activation['windows']['publication']['start'].replace('Z','+00:00'))
        p.prepare_publication(config,manifest,'c'*64,journal)
        budget=Budget();pool=OwnerTokenPool(verified,clock);self.addCleanup(pool.close)
        raw=Mock(mode='owner',principal=owner['principal_id'],tenant=owner['tenant_id'])
        raw.token.return_value=jwt({'oid':owner['principal_id'],'tid':owner['tenant_id'],'exp':clock.utc().timestamp()+3600})
        credential=pool.bind(raw,budget,verified);calls=[]
        def wire(method,url,headers,body,deadline):
            calls.append((method,url));claims={'aud':host,'nbf':clock.utc().timestamp()-1,'exp':clock.utc().timestamp()+3600}
            if url.endswith('/exchange'):result={'refresh_token':jwt({**claims,'tenant':owner['tenant_id'],'grant_type':'refresh_token'})}
            elif url.endswith('/token'):
                scope=parse_qs(body.decode())['scope'][0];self.assertTrue(scope.endswith(':pull'))
                repo=scope[len('repository:'):-len(':pull')]
                result={'access_token':jwt({**claims,'access':[{'type':'repository','name':repo,'actions':['pull']}]})}
            else:
                slot=next(s for s in ('guardian','runtime') if '/'+data['prep']['slots'][s]['repository']+'/' in url)
                return {'status':200,'headers':{'Docker-Content-Digest':'sha256:'+p.sha(bodies[slot])},'body':bodies[slot]}
            return {'status':200,'headers':{},'body':encoded(result)}
        result=p.verify_reused_images(journal,credential,wire,budget,clock,verified_attempt=verified,source_guard=lambda:None)
        self.assertEqual('reused_images_verified',result['status']);self.assertEqual(6,len(calls))
        images=p.verified_publication_images(journal,verified_attempt=verified)
        self.assertEqual(a._proof(verified)['succession']['acknowledged_images'],images)
        prep=p.reused_image_preparation(journal,verified)
        resources={**images,'code_sha':verified.authority['image_build_head'],
            'guardian_deadline':verified.activation['windows']['guardian']['end']}
        resolver=SimpleNamespace(plan_digest='f'*64,initial_plan={'resource_bindings':resources,
            'source_sha256':prep['source_sha256'],'windows':verified.activation['windows']},
            resolve=lambda *_:{'cleanup':{'deadline':resources['guardian_deadline']}})
        p.bind_publication(journal,resolver,resources,verified_attempt=verified)
        bundle=p.registry_cleanup_bundle(manifest,journal,resolver,verified_attempt=verified)
        cleanup._prepare(bundle,manifest,resources,journal,resolver,credential,verified)
        self.assertFalse(journal.values('intent'));self.assertFalse(journal.values('progress'))
        self.assertEqual('unknown',a._proof(verified)['succession']['unknown_identity_receipt']['state'])
        self.assertEqual(before,(data['proof']['previous_child_raw'],data['counter_raw']))

    def test_new_child_cannot_copy_old_push_or_legacy_preparation(self):
        for event,value in (('intent',{'operation_id':'guardianImagePush'}),
                            ('progress',{'operation_id':'runtimeImagePush'}),('publication_preparation',{})):
            with self.subTest(event=event):
                data,verified,config,journal,_,_=self.fixture();journal.append(event,value)
                with self.assertRaises(Denied):p.prepare_publication(config,data['new']['manifest'],'c'*64,journal)
                self.assertFalse(journal.values('image_reuse_preparation'))


if __name__=='__main__':unittest.main()
