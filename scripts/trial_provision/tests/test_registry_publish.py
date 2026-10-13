"""Real private Journal + fake Docker/ACR. Never starts a real process or auth."""
import base64
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import Journal, ControlBudget
from scripts.trial_provision import registry_publish as publisher
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
        self.assertEqual({'auths'},set(value))
        if value['auths']=={}:
            self.assertTrue(config.name.startswith('trial-'+self.bundle['slot']+'-docker-probe-'))
            tag=self.manifest['cleanupImageTag' if self.bundle['slot']=='guardian' else 'imageTag']
            self.assertEqual(['image','inspect','--format','{{json .Id}}',self.host+'/'+self.repo+':'+tag],argv[5:])
            self.assertLessEqual(timeout,20)
        else:
            self.assertEqual({self.host},set(value['auths']))
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
        self.assertFalse(_config_path(self.journal,probe=True).exists())

    def assert_before_auth_failure(self):
        self.credential.token.assert_not_called();self.assertFalse(self.calls)
        self.assertEqual(128,self.budget.count('owner_arm'))
        self.assertFalse(self.journal.values('intent'));self.assertEqual(0,self.pushes())
        self.assertFalse(self.journal.values('guardian_image_namespace'))

    def assert_probe_failure(self,outcome,status):
        self.process_modify=lambda _argv:outcome
        with self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assert_private()
        rows=self.journal.values('guardian_docker_probe_result')
        self.assertEqual(1,len(rows));self.assertEqual(status,rows[0]['status'])
        self.assertTrue(rows[0]['temporary_config_absent'])
        self.assertEqual(0,rows[0]['new_owner_token_calls']);self.assertEqual(0,rows[0]['new_http_requests'])
        self.assertFalse(rows[0]['automatic_retry'])
        self.assertNotIn('private diagnostic',json.dumps(self.journal.records))
        before=len(self.processes)
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(before,len(self.processes));self.assert_before_auth_failure()

    def assert_push_failure(self,outcome,classification):
        self.process_modify=lambda argv:outcome if 'push' in argv else None
        result=self.publish()
        self.assertEqual('unknown',result['status']);self.assertFalse(result['terminal'])
        receipt=self.journal.latest('guardianImagePush')
        self.assertFalse(receipt['write_terminal']);self.assertFalse(receipt['readback_verified'])
        rows=self.journal.values('guardian_docker_push_failure');self.assertEqual(1,len(rows))
        self.assertEqual({'schema','operation_id','request_digest','publication_preparation_digest',
            'run_binding_digest','classification','additional_control_http_requests','automatic_retry'},set(rows[0]))
        self.assertEqual(classification,rows[0]['classification'])
        self.assertEqual(receipt['request_digest'],rows[0]['request_digest'])
        self.assertEqual('guardianImagePush',rows[0]['operation_id'])
        self.assertEqual(0,rows[0]['additional_control_http_requests']);self.assertFalse(rows[0]['automatic_retry'])
        self.assertEqual(132,self.budget.count('owner_arm'));self.assertEqual(3,len(self.calls))
        self.assertFalse(any('/manifests/' in url for _,url in self.calls))
        self.assertEqual(1,self.pushes());self.assert_private()
        self.assertNotIn(self.host,json.dumps(rows));self.assertNotIn('private failure',json.dumps(self.journal.records))
        before=(len(self.calls),len(self.processes),self.budget.counts())
        self.assertEqual('unknown',self.publish()['status'])
        self.assertEqual(before,(len(self.calls),len(self.processes),self.budget.counts()))
        self.assertEqual(rows,self.journal.values('guardian_docker_push_failure'))
        with self.assertRaises(Denied):registry_cleanup_bundle(self.manifest,self.journal,self.resolver)

    def test_real_journal_budget_known_ack_readback_cleanup_contract(self):
        result=self.publish();self.assertTrue(result['push_verified']);self.assertTrue(result['temporary_config_absent'])
        self.assertEqual(1,self.pushes());self.assertEqual(6,self.budget.count('owner_arm')-128)
        self.assert_private();self.assertNotIn(self.host,json.dumps(result))
        measurement=self.journal.values('guardian_image_measurement')[0]
        self.assertEqual(500,measurement['compressed_content_bytes']);self.assertFalse(measurement['wire_billing_cap'])
        n=len(self.calls);self.assertEqual(result,self.publish());self.assertEqual(n,len(self.calls));self.assertEqual(1,self.pushes())

    def test_unknown_process_is_never_retried_or_get_adopted(self):
        self.assert_push_failure(TimeoutError('private failure'),'timeout')

    def test_push_subprocess_timeout_keeps_output_and_stderr_out_of_diagnostic(self):
        self.assert_push_failure(subprocess.TimeoutExpired('private failure',10,
            output=b'private failure',stderr=b'private failure'),'timeout')

    def test_push_process_error_has_only_fixed_classification(self):
        self.assert_push_failure(OSError('private failure https://user:secret@invalid.example/'),'process_error')

    def test_push_missing_ack_is_unknown_with_no_remote_readback(self):
        self.assert_push_failure((0,b'private failure: no digest\n'),'missing_or_ambiguous_ack')

    def test_push_ambiguous_ack_is_unknown_with_no_remote_readback(self):
        line=(self.manifest['cleanupImageTag']+': digest: '+self.image+' size: 1\n').encode()
        self.assert_push_failure((0,line+line),'missing_or_ambiguous_ack')

    def test_push_non_utf8_output_is_unknown_without_persisting_bytes(self):
        self.assert_push_failure((0,b'private failure\xff'),'missing_or_ambiguous_ack')

    def test_push_bool_exit_cannot_manufacture_ack(self):
        line=(self.manifest['cleanupImageTag']+': digest: '+self.image+' size: 1\n').encode()
        self.assert_push_failure((False,line),'process_error')

    def test_push_diagnostic_fsync_failure_preserves_unknown_and_no_retry(self):
        self.process_modify=lambda argv:(1,b'private failure') if 'push' in argv else None
        append=self.journal.append
        def reject(event,value):
            if event=='guardian_docker_push_failure':raise OSError('private failure')
            return append(event,value)
        with patch.object(self.journal,'append',side_effect=reject):
            self.assertEqual('unknown',self.publish()['status'])
        self.assertFalse(self.journal.values('guardian_docker_push_failure'));self.assert_private()
        self.assertFalse(self.journal.latest('guardianImagePush')['write_terminal'])
        before=(len(self.calls),len(self.processes),self.budget.counts())
        self.assertEqual('unknown',self.publish()['status'])
        self.assertEqual(before,(len(self.calls),len(self.processes),self.budget.counts()))
        self.assertEqual(1,self.pushes());self.assertEqual(132,self.budget.count('owner_arm'))

    def test_push_durable_diagnostic_followed_by_error_does_not_dispatch_again(self):
        self.process_modify=lambda argv:(1,b'private failure') if 'push' in argv else None
        append=self.journal.append
        def after_durable(event,value):
            result=append(event,value)
            if event=='guardian_docker_push_failure':raise OSError('private failure')
            return result
        with patch.object(self.journal,'append',side_effect=after_durable):
            self.assertEqual('unknown',self.publish()['status'])
        rows=self.journal.values('guardian_docker_push_failure');self.assertEqual(1,len(rows))
        before=(len(self.calls),len(self.processes),self.budget.counts())
        self.assertEqual('unknown',self.publish()['status'])
        self.assertEqual(before,(len(self.calls),len(self.processes),self.budget.counts()))
        self.assertEqual(rows,self.journal.values('guardian_docker_push_failure'));self.assert_private()

    def test_known_ack_readback_failure_resumes_only_reads(self):
        self.modify=lambda m,u:OSError('private') if '/manifests/' in u else None
        self.assertEqual('pending',self.publish()['status']);self.assert_private()
        self.assertTrue(self.journal.latest('guardianImagePush')['write_terminal'])
        self.assertFalse(self.journal.values('guardian_docker_push_failure'))
        self.modify=None
        with patch.object(self,'runner',side_effect=AssertionError('known ACK cannot inspect or push')) as runner:
            self.assertTrue(self.publish()['push_verified']);runner.assert_not_called()
        self.assertEqual(1,self.pushes());self.assertEqual(1,len(self.journal.values('guardian_docker_probe_result')))

    def test_known_ack_readback_after_original_deadline_no_repush(self):
        self.modify=lambda m,u:OSError('private') if '/manifests/' in u else None
        self.assertEqual('pending',self.publish()['status'])
        self.clock.seconds=3601;self.modify=None
        with patch.object(self,'runner',side_effect=AssertionError('expired ACK cannot inspect or push')) as runner:
            self.assertTrue(self.publish()['push_verified']);runner.assert_not_called()
        self.assertEqual(1,self.pushes())

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
        self.assert_push_failure((1,(self.manifest['cleanupImageTag']+': digest: '+self.image+' size: 1').encode()),'nonzero_exit')

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
        self.assert_probe_failure((0,encoded('sha256:'+'0'*64)),'image_id')

    def test_engine_unavailable_preflight_spends_nothing_and_cannot_retry(self):
        self.assert_probe_failure((1,b'private diagnostic: missing pipe'),'exit_code')

    def test_local_spawn_failure_spends_nothing_and_cannot_retry(self):
        self.assert_probe_failure(OSError('private diagnostic'),'process_unavailable')

    def test_local_timeout_spends_nothing_and_cannot_retry(self):
        self.assert_probe_failure(subprocess.TimeoutExpired('private diagnostic',20),'timeout')

    def test_local_non_json_output_spends_nothing_and_cannot_retry(self):
        self.assert_probe_failure((0,b'private diagnostic'),'image_id')

    def test_local_bool_exit_is_not_exit_zero(self):
        self.assert_probe_failure((False,encoded(self.bundle['local_image_id'])),'exit_code')

    def test_successful_probe_is_removed_before_auth_and_post_auth_inspect_remains(self):
        observed=[]
        def observe(_method,url):
            if url.endswith('/oauth2/exchange'):
                self.assertEqual(1,len(self.processes));self.assertEqual({'auths':{}},self.config_observed)
                self.assertFalse(_config_path(self.journal,probe=True).exists())
                self.assertEqual('verified',self.journal.values('guardian_docker_probe_result')[0]['status'])
                observed.append('authentication_after_probe_cleanup')
        self.modify=observe
        self.assertTrue(self.publish()['push_verified'])
        self.assertEqual(['authentication_after_probe_cleanup'],observed)
        self.assertEqual(['inspect','inspect','push'],[p[6] for p in self.processes])
        self.assert_private()

    def test_post_auth_inspect_failure_preserves_spend_and_refuses_retry(self):
        def fail_authenticated(argv):
            if 'inspect' in argv and '-docker-probe-' not in Path(argv[2]).name:
                return 1,b'private diagnostic'
        self.process_modify=fail_authenticated
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(2,len(self.calls));self.assertEqual(131,self.budget.count('owner_arm'))
        self.credential.token.assert_called_once();self.assertFalse(self.journal.values('intent'));self.assert_private()
        before=(len(self.calls),len(self.processes))
        with self.assertRaises(Denied):self.publish()
        self.assertEqual(before,(len(self.calls),len(self.processes)));self.assertEqual(131,self.budget.count('owner_arm'))

    def test_previous_cleaned_token_slot_stops_before_auth_or_probe(self):
        publisher._write_config(self.journal,self.host,'fictional-short-lived-token','guardian')
        cleanup_docker_config(self.journal)
        with self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assertFalse(self.processes)
        self.assertFalse(self.journal.values('guardian_docker_probe_result'))

    def test_deadline_reached_during_probe_prevents_auth(self):
        def expire(_argv):self.clock.seconds=601
        self.process_modify=expire
        with self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assert_private()

    def test_probe_cleanup_failure_never_authenticates_or_claims_absence(self):
        def foreign_file(argv):
            (Path(argv[2])/'foreign').write_bytes(b'leave this file')
        self.process_modify=foreign_file
        with self.assertRaises(OSError):self.publish()
        self.assert_before_auth_failure()
        self.assertTrue((_config_path(self.journal,probe=True)/'foreign').exists())
        self.assertFalse(self.journal.values('guardian_docker_probe_config_absent'))
        self.assertFalse(self.journal.values('guardian_docker_probe_result'))

    def test_probe_result_fsync_failure_prevents_auth_after_cleanup(self):
        append=self.journal.append
        def reject_result(event,value):
            if event=='guardian_docker_probe_result':raise OSError('fictional durability failure')
            return append(event,value)
        with patch.object(self.journal,'append',side_effect=reject_result),self.assertRaises(OSError):self.publish()
        self.assert_before_auth_failure();self.assert_private()

    def test_durable_probe_directory_survives_creation_error_for_local_cleanup(self):
        append=self.journal.append
        def after_directory(event,value):
            result=append(event,value)
            if event=='guardian_docker_probe_directory':raise OSError('fictional crash after durable identity')
            return result
        with patch.object(self.journal,'append',side_effect=after_directory),self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assert_private()
        self.assertTrue(self.journal.values('guardian_docker_probe_config_absent'))

    def test_durable_probe_file_identity_allows_cleanup_before_first_byte(self):
        append=self.journal.append
        def after_file(event,value):
            result=append(event,value)
            if event=='guardian_docker_probe_config':raise OSError('fictional crash before bytes')
            return result
        with patch.object(self.journal,'append',side_effect=after_file),self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assert_private()
        self.assertTrue(self.journal.values('guardian_docker_probe_config_absent'))

    def test_complete_probe_creation_error_still_cleans_exact_identity(self):
        write=publisher._write_empty_probe
        def after_write(*args):
            write(*args);raise OSError('fictional crash after empty config fsync')
        with patch.object(publisher,'_write_empty_probe',side_effect=after_write),self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assert_private();self.assertFalse(self.processes)

    def test_unrecorded_probe_directory_is_never_adopted_or_removed(self):
        append=self.journal.append
        def before_directory(event,value):
            if event=='guardian_docker_probe_directory':raise OSError('fictional crash before durable identity')
            return append(event,value)
        with patch.object(self.journal,'append',side_effect=before_directory),self.assertRaises(Denied):self.publish()
        self.assert_before_auth_failure();self.assertTrue(_config_path(self.journal,probe=True).is_dir())
        self.assertFalse(self.journal.values('guardian_docker_probe_config_absent'))
        self.assertFalse(self.journal.values('guardian_docker_probe_result'))

    def test_replaced_probe_file_is_never_deleted(self):
        path=publisher._write_empty_probe(self.journal,'guardian')
        original=path/'config.json';old=path/'original.json';original.rename(old)
        original.write_bytes(b'foreign replacement')
        with self.assertRaises(Denied):cleanup_docker_config(self.journal,probe=True)
        self.assertEqual(b'foreign replacement',original.read_bytes());self.assertTrue(old.exists())
        self.assertFalse(self.journal.values('guardian_docker_probe_config_absent'))

    def test_dangling_unrecorded_path_is_not_reported_absent(self):
        # Model a dangling link without requiring Windows symlink privileges.
        for probe in (False,True):
            with self.subTest(probe=probe),patch.object(Path,'exists',return_value=False),\
                    patch.object(publisher.os.path,'lexists',return_value=True),\
                    patch.object(Path,'rmdir') as remove,self.assertRaises(Denied):
                cleanup_docker_config(self.journal,probe=probe)
            remove.assert_not_called()
            suffix='_docker_probe_config_absent' if probe else '_docker_config_absent'
            self.assertFalse(self.journal.values('guardian'+suffix))

    def test_recorded_dangling_probe_cannot_create_false_absence_receipt(self):
        path=publisher._write_empty_probe(self.journal,'guardian')
        # Existing directory identity replaced by a dangling/non-directory path.
        with patch.object(Path,'exists',return_value=False),patch.object(Path,'is_dir',return_value=False),\
                self.assertRaises(Denied):
            cleanup_docker_config(self.journal,probe=True)
        self.assertTrue(path.exists());self.assertTrue((path/'config.json').exists())
        self.assertFalse(self.journal.values('guardian_docker_probe_config_absent'))

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
        self.credential.token.assert_not_called();self.assertFalse(self.calls);self.assertFalse(self.processes)

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
        self.assertFalse(self.journal.values('guardian_docker_push_failure'))

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
        self.assertIs(subprocess.DEVNULL,popen.call_args.kwargs['stderr'])


if __name__=='__main__':unittest.main()
