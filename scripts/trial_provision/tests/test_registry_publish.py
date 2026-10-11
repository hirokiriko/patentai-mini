"""Real private Journal + fake Docker/ACR. Never starts a real process or auth."""
import base64
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import Journal, ControlBudget
from scripts.trial_provision.registry_publish import run_registry_publish, registry_cleanup_bundle, cleanup_docker_config, _config_path, prepare_publication, verified_publication_images, bind_publication, docker_command
from scripts.trial_provision.registry_cli import _prepare
from scripts.trial_provision.private_io import verify_owner_file
from scripts.trial_provision.tests import test_operations as fixtures


class Clock:
    def __init__(self): self.start=datetime(2026,10,11,1,tzinfo=timezone.utc);self.seconds=0
    def utc(self): return self.start+timedelta(seconds=self.seconds)
    def monotonic(self): return self.seconds


def jwt(value):
    return 'fixture.'+base64.urlsafe_b64encode(encoded(value)).decode().rstrip('=')+'.fixture'


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name).resolve();self.clock=Clock()
        args=fixtures.fixture()
        self.core,self.manifest,self.authority,self.resources=args
        self.manifest.update(cleanupImageTag='fictional-guardian',imageTag='fictional-runtime')
        self.authority['manifest']=encoded(self.manifest);mh=hashlib.sha256(self.authority['manifest']).hexdigest()
        annex,approval,latest=(json.loads(self.authority[k]) for k in ('annex','approval','latest'))
        annex['fixedManifestSha256']=mh;self.authority['annex']=encoded(annex);ah=hashlib.sha256(self.authority['annex']).hexdigest()
        approval.update(boundProposalSha256=ah,fixedManifestSha256=mh);self.authority['approval']=encoded(approval)
        latest.update(originalProposalSha256=ah,fixedManifestSha256=mh,priorApprovalSha256=hashlib.sha256(self.authority['approval']).hexdigest())
        self.authority['latest']=encoded(latest)
        self.body=encoded({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json',
            'config':{'digest':'sha256:'+'3'*64,'size':200},'layers':[{'digest':'sha256:'+'2'*64,'size':300}]})
        self.image='sha256:'+hashlib.sha256(self.body).hexdigest()
        self.host=self.manifest['registry']['loginServer'];self.repo=self.manifest['cleanupImageRepository']
        self.resources['guardian_image']=self.host+'/'+self.repo+'@'+self.image
        self.rebuild_resolver()
        self.docker=self.directory/('docker.exe' if os.name=='nt' else 'docker');self.docker.write_bytes(b'fake-no-execution')
        self.bundle={'schema':1,'slot':'guardian','docker_path':str(self.docker),'docker_sha256':hashlib.sha256(self.docker.read_bytes()).hexdigest(),
            'docker_host':'npipe:////./pipe/dockerDesktopLinuxEngine','local_image_id':'sha256:'+'3'*64,
            'deadline':'2026-10-11T01:10:00Z'}
        self.journal=Journal(str(self.directory),digest(str(self.directory)),{'task_id':'fixture','owner':self.manifest['owner']['principal_id']})
        self.addCleanup(self.journal.close)
        slot={k:self.bundle[k] for k in ('docker_path','docker_sha256','docker_host','local_image_id')}
        slot['build_receipt']={'path':'unused','sha256':'a'*64}
        self.config={'sources':{k:{'sha256':v} for k,v in self.resolver.initial_plan['source_sha256'].items()},
            'frozen_head':self.resources['code_sha'],'publication':{'publish_until':self.bundle['deadline'],
                'slots':{'guardian':deepcopy(slot),'runtime':deepcopy(slot)}}}
        prepare_publication(self.config,self.manifest,'f'*64,self.journal)
        self.budget=ControlBudget(str(self.directory),digest(str(self.directory)),{'fixture':'fixed'},
            seed={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0});self.addCleanup(self.budget.close)
        self.credential=Mock(mode='owner',principal=self.manifest['owner']['principal_id'],tenant=self.manifest['owner']['tenant_id'])
        self.credential.token.return_value='fixture-owner-token'
        self.calls=[];self.processes=[];self.modify=None;self.process_modify=None
        self.access=None;self.config_observed=None

    def rebuild_resolver(self):
        ops=fixtures.build_resource_operations(self.manifest,self.authority,self.resources)
        bindings={'guardian_window':self.core['windows']['guardian'],'owner_window':self.core['windows']['owner_input'],
            'prerequisite_digests':{o['id']:digest(o) for o in ops}}
        core=fixtures.build_plan(self.manifest,self.authority,bindings,'2026-10-11T01:00:00Z',lambda slot:self.core['allocation'][slot])
        self.resolver=fixtures.create_resolver(core,self.manifest,self.authority,self.resources)

    def wire(self,method,url,headers,body,deadline):
        self.calls.append((method,url))
        if self.modify:
            result=self.modify(method,url)
            if result is not None:
                if isinstance(result,Exception): raise result
                return result
        now=self.clock.utc().timestamp()
        claims={'aud':self.host,'nbf':now-10,'exp':now+3600}
        if url.endswith('/oauth2/exchange'):
            value={'refresh_token':jwt({**claims,'grant_type':'refresh_token','tenant':self.manifest['owner']['tenant_id']})}
            return self.response(200,value)
        if url.endswith('/oauth2/token'):
            self.access=jwt({**claims,'access':[{'type':'repository','name':self.repo,'actions':['pull','push']}]})
            return self.response(200,{'access_token':self.access})
        self.assertEqual('Bearer '+self.access,headers.get('Authorization'))
        if '/acr/v1/' in url: return self.response(404,{'errors':[{'code':'NAME_UNKNOWN'}]})
        return {'status':200,'headers':{'Docker-Content-Digest':self.image},'body':self.body}

    @staticmethod
    def response(status,value,headers=None): return {'status':status,'headers':headers or {},'body':encoded(value)}

    def runner(self,argv,*,timeout,environment):
        self.processes.append(argv)
        self.assertEqual(argv[0],str(self.docker));self.assertEqual(argv[1],'--config')
        self.assertEqual(argv[3:5],['--host',self.bundle['docker_host']])
        config=Path(argv[2]);verify_owner_file(config/'config.json')
        value=json.loads((config/'config.json').read_bytes());self.config_observed=value
        self.assertEqual({'auths'},set(value));self.assertEqual({self.host},set(value['auths']))
        self.assertEqual({'auth'},set(value['auths'][self.host]))
        self.assertEqual('00000000-0000-0000-0000-000000000000:'+self.access,
            base64.b64decode(value['auths'][self.host]['auth']).decode())
        self.assertEqual('',environment['PATH']);self.assertEqual(str(config),environment['DOCKER_CONFIG'])
        self.assertFalse({'DOCKER_CONTEXT','DOCKER_HOST','DOCKER_AUTH_CONFIG','HOME','USERPROFILE'} & set(environment))
        self.assertGreater(timeout,0)
        if self.process_modify:
            result=self.process_modify(argv)
            if result is not None:
                if isinstance(result,Exception): raise result
                return result
        if 'inspect' in argv: return 0,encoded(self.bundle['local_image_id'])+b'\n'
        slot=self.bundle['slot'];tag=self.manifest['cleanupImageTag' if slot=='guardian' else 'imageTag']
        self.assertEqual(['image','push',self.host+'/'+self.repo+':'+tag],argv[5:])
        # Must be durable BEFORE the process that can upload any layer.
        self.assertEqual(1,len([r for r in self.journal.values('intent') if r['operation_id']==slot+'ImagePush']))
        return 0,(tag+': digest: '+self.image+' size: '+str(len(self.body))+'\n').encode()

    def publish(self,bundle=None):
        return run_registry_publish(bundle or self.bundle,self.manifest,self.journal,
            self.credential,self.wire,self.budget,self.clock,runner=self.runner)
    def pushes(self): return sum('push' in p for p in self.processes)
    def assert_private(self):
        text=json.dumps(self.journal.records)
        self.assertNotIn(self.access or 'UNUSED_TOKEN',text)
        self.assertNotIn('fixture-owner-token',text)
        self.assertFalse(_config_path(self.journal).exists())

    def test_real_journal_budget_known_ack_readback_cleanup_contract(self):
        result=self.publish();self.assertTrue(result['push_verified']);self.assertTrue(result['temporary_config_absent'])
        self.assertEqual(1,self.pushes());self.assertEqual(6,self.budget.count('owner_arm')-128)
        self.assert_private();self.assertNotIn(self.host,json.dumps(result))
        measurement=self.journal.values('guardian_image_measurement')[0]
        self.assertEqual(500,measurement['compressed_content_bytes']);self.assertFalse(measurement['wire_billing_cap'])
        n=len(self.calls);self.assertEqual(result,self.publish());self.assertEqual(n,len(self.calls));self.assertEqual(1,self.pushes())

    def test_unknown_process_is_never_retried_or_get_adopted(self):
        self.process_modify=lambda p:TimeoutError('private output') if 'push' in p else None
        self.assertEqual('unknown',self.publish()['status']);self.assert_private()
        n=len(self.calls);self.assertEqual('unknown',self.publish()['status'])
        self.assertEqual(n,len(self.calls));self.assertEqual(1,self.pushes())
        with self.assertRaises(Denied):registry_cleanup_bundle(self.manifest,self.journal,self.resolver)

    def test_known_ack_readback_failure_resumes_only_reads(self):
        self.modify=lambda m,u:OSError('private') if '/manifests/' in u else None
        self.assertEqual('pending',self.publish()['status']);self.assert_private()
        self.assertTrue(self.journal.latest('guardianImagePush')['write_terminal'])
        self.modify=None;self.assertTrue(self.publish()['push_verified']);self.assertEqual(1,self.pushes())

    def test_known_ack_readback_after_original_deadline_no_repush(self):
        self.modify=lambda m,u:OSError('private') if '/manifests/' in u else None
        self.assertEqual('pending',self.publish()['status'])
        self.clock.seconds=3601;self.modify=None
        self.assertTrue(self.publish()['push_verified']);self.assertEqual(1,self.pushes())

    def test_two_actual_images_import_and_real_cleanup_consumer(self):
        self.assertTrue(self.publish()['push_verified'])
        with self.assertRaises(Denied):verified_publication_images(self.journal)
        self.bundle['slot']='runtime';self.repo=self.manifest['imageRepository']
        self.assertTrue(self.publish()['push_verified'])
        images=verified_publication_images(self.journal)
        self.assertEqual(2,len(images));self.resources.update(images);self.rebuild_resolver()
        event=bind_publication(self.journal,self.resolver,self.resources)
        self.assertEqual(event,bind_publication(self.journal,self.resolver,self.resources))
        bundle=registry_cleanup_bundle(self.manifest,self.journal,self.resolver)
        binding,op=_prepare(bundle,self.manifest,self.resources,self.journal,self.resolver,self.credential)
        self.assertEqual('DELETE',op['method']);self.assertEqual(self.manifest['cleanupImageRepository'],binding['repository'])
        self.assertNotIn('/trial/runtime/',op['url']);self.assertEqual(2,self.pushes())
        self.assertEqual(140,self.budget.count('owner_arm'))
        self.assertFalse(_config_path(self.journal,'runtime').exists())

    def test_local_config_digest_mismatch_cannot_pass_manifest_readback(self):
        self.body=encoded({'schemaVersion':2,'config':{'digest':'sha256:'+'7'*64,'size':200},'layers':[]})
        self.image='sha256:'+hashlib.sha256(self.body).hexdigest()
        self.assertEqual('pending',self.publish()['status'])
        self.assertTrue(self.journal.latest('guardianImagePush')['write_terminal'])

    def test_preparation_is_fixed_and_does_not_manufacture_registry_digest(self):
        old=self.journal.values('publication_preparation')[0]
        self.assertNotIn('manifest_digest',json.dumps(old));self.assertNotIn('initial_plan_digest',old)
        changed=deepcopy(self.config);changed['publication']['publish_until']='2026-10-11T01:11:00Z'
        with self.assertRaises(Denied):prepare_publication(changed,self.manifest,'f'*64,self.journal)

    def test_nonzero_process_even_matching_output_stays_unknown(self):
        self.process_modify=lambda p:(1,(self.manifest['cleanupImageTag']+': digest: '+self.image+' size: 1').encode()) if 'push' in p else None
        self.assertEqual('unknown',self.publish()['status']);self.assert_private()

    def test_wrong_push_digest_is_unknown_and_no_cleanup_receipt(self):
        self.process_modify=lambda p:(0,(self.manifest['cleanupImageTag']+': digest: sha256:'+'0'*64+' size: 1').encode()) if 'push' in p else None
        self.assertEqual('pending',self.publish()['status']);self.assertTrue(self.journal.latest('guardianImagePush')['write_terminal'])

    def test_repository_exists_or_denied_is_not_absence(self):
        self.modify=lambda m,u:self.response(403,{'errors':[{'code':'DENIED'}]}) if '/acr/v1/' in u else None
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(0,self.pushes());self.assertFalse(self.journal.values('guardian_image_namespace'));self.assert_private()

    def test_unauthenticated_404_is_not_absence(self):
        self.modify=lambda m,u:self.response(404,{'errors':[{'code':'NAME_UNKNOWN'}]},{'WWW-Authenticate':'Bearer'}) if '/acr/v1/' in u else None
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(0,self.pushes());self.assert_private()

    def test_wrong_local_image_prevents_namespace_and_push(self):
        self.process_modify=lambda p:(0,encoded('sha256:'+'0'*64)) if 'inspect' in p else None
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(0,self.pushes());self.assertFalse(any('/acr/v1/' in u for _,u in self.calls));self.assert_private()

    def test_wrong_remote_digest_keeps_known_ack_pending(self):
        self.modify=lambda m,u:{'status':200,'headers':{'Docker-Content-Digest':self.image},'body':b'changed'} if '/manifests/' in u else None
        self.assertEqual('pending',self.publish()['status']);self.assert_private()

    def test_wrong_scope_token_or_identity_rejected_before_process(self):
        self.credential.principal='not-owner'
        with self.assertRaises(Denied):self.publish()
        self.assertFalse(self.calls);self.assertFalse(self.processes)

    def test_no_default_config_helpers_or_environment_fallback(self):
        with patch.dict(os.environ,{'DOCKER_CONFIG':'default-secret-config','DOCKER_CONTEXT':'unapproved',
            'DOCKER_AUTH_CONFIG':'private','PATH':'helper-directory','HOME':'default-user'}):
            self.assertTrue(self.publish()['push_verified'])
        self.assert_private()

    def test_binary_hash_target_host_or_deadline_mismatch_before_auth(self):
        for key,value in [('docker_sha256','0'*64),('docker_host','tcp://evil.example:2375'),('deadline','2028-01-01T00:00:00Z')]:
            with self.subTest(key=key):
                bad={**self.bundle,key:value}
                with self.assertRaises(Denied):self.publish(bad)
        self.assertFalse(self.calls);self.assertFalse(self.processes)

    def test_expired_deadline_prevents_credential_and_process(self):
        self.clock.seconds=601
        with self.assertRaises(Denied):self.publish()
        self.credential.token.assert_not_called();self.assertFalse(self.calls)

    def test_stale_namespace_after_fsync_prevents_push(self):
        append=self.journal.append
        def delayed(event,value):
            result=append(event,value)
            if event=='guardian_image_namespace':self.clock.seconds+=31
            return result
        with patch.object(self.journal,'append',side_effect=delayed):
            with self.assertRaises(Denied):self.publish()
        self.assertEqual(0,self.pushes());self.assert_private()

    def test_unknown_fsync_after_process_ack_does_not_regenerate_ack(self):
        checkpoint=self.journal.checkpoint
        def fail(op,r):
            if r.get('write_terminal'):raise OSError('durability failed')
            return checkpoint(op,r)
        with patch.object(self.journal,'checkpoint',side_effect=fail):self.assertEqual('unknown',self.publish()['status'])
        self.assertEqual('unknown',self.publish()['status']);self.assertEqual(1,self.pushes());self.assert_private()

    def test_budget_exhaustion_never_reaches_docker(self):
        self.budget.seed['owner_arm']=600
        with self.assertRaises(Denied):self.publish()
        self.assertFalse(self.processes);self.credential.token.assert_not_called()

    def test_unrecorded_directory_cannot_be_deleted_or_used(self):
        path=_config_path(self.journal);path.mkdir();sentinel=path/'foreign';sentinel.write_text('not ours')
        with self.assertRaises(Denied):cleanup_docker_config(self.journal)
        self.assertTrue(sentinel.exists())

    def test_progress_output_drains_without_becoming_an_image_size_limit(self):
        tail=b'fictional-tag: digest: sha256:'+b'a'*64+b' size: 123\n'
        child=Mock(stdout=io.BytesIO(b'layer progress\n'*100000+tail))
        child.wait.return_value=0;child.poll.return_value=0
        with patch('scripts.trial_provision.registry_publish.subprocess.Popen',return_value=child) as popen:
            code,output=docker_command(['fictional-never-executed'],timeout=10,environment={'PATH':''})
        self.assertEqual(0,code);self.assertLessEqual(len(output),65536);self.assertTrue(output.endswith(tail))
        self.assertFalse(popen.call_args.kwargs['shell']);child.terminate.assert_not_called()


if __name__=='__main__':unittest.main()
