"""CLI with real strict private schema and journal, fictional file/HTTP inputs."""
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import registry_publish_cli as cli
from scripts.trial_provision.journal import Journal, ControlBudget
from scripts.trial_provision.registry_publish import _write_config, _write_empty_probe, _config_path
from scripts.trial_provision.publication_configuration import load_publication_configuration
from scripts.trial_provision.tests import test_publication_configuration as fixtures
from scripts.trial_provision.tests.test_registry_publish import Clock


class PublicationCliTests(unittest.TestCase):
    def setUp(self):
        f=fixtures.PublicationConfigurationTests('runTest');f.setUp();self.addCleanup(f.doCleanups)
        self.f=f;self.config=f.config;self.path=f.fixture.path;self.root=f.fixture.root
        self.manifest=f.fixture.manifest;self.clock=Clock()
        self.manifest.update(cleanupImageTag='fictional-guardian',imageTag='fictional-runtime')
        self.manifest.update(registry={'id':self.manifest['existing']['registry'],'loginServer':'fictionalacr.azurecr.io'},
            imageRepository='trial/runtime',cleanupImageRepository='trial/guardian')
        from scripts.trial_provision.configuration import SOURCE_FILES
        sources={k:json.loads(Path(v['path']).read_bytes()) for k,v in self.config['sources'].items()}
        def write(slot,value):
            self.config['sources'][slot]=f.fixture.write(SOURCE_FILES[slot],value)
            return self.config['sources'][slot]['sha256']
        mh=write('manifest',self.manifest)
        sources['annex']['fixedManifestSha256']=mh;ah=write('annex',sources['annex'])
        sources['approval'].update(boundProposalSha256=ah,fixedManifestSha256=mh);ph=write('approval',sources['approval'])
        sources['latest'].update(priorApprovalSha256=ph,originalProposalSha256=ah,fixedManifestSha256=mh)
        write('latest',sources['latest']);self.config['control_budget']['binding']['manifest_sha256']=mh
        self.config['live']=True
        self.proofs={}
        for slot,repo,tag in (('guardian','cleanupImageRepository','cleanupImageTag'),('runtime','imageRepository','imageTag')):
            fixed=self.config['publication']['slots'][slot]
            self.proofs[slot]={'schema':1,'slot':slot,'manifest_sha256':self.config['sources']['manifest']['sha256'],
                'source_head':self.config['frozen_head'],'request_digest':'c'*64,'method':'docker-build','attempt':1,
                'exit_code':0,'docker_sha256':fixed['docker_sha256'],'docker_host':fixed['docker_host'],
                'image_ref':self.manifest['registry']['loginServer']+'/'+self.manifest[repo]+':'+self.manifest[tag],
                'image_id':fixed['local_image_id'],'readback_verified':True,'managed_build_sha':self.config['frozen_head']}
            fixed['build_receipt']=f.fixture.write(slot+'-build.local.json',self.proofs[slot])
        self.save()
        self.addCleanup(patch.stopall)
        patch.object(cli,'verify_owner_file',return_value=None).start()
        patch.object(cli,'private_bytes',return_value=encoded(self.manifest)).start()
        patch.object(cli,'git',return_value=(f.fixture.head+'\n').encode()).start()
        patch.object(cli,'local_sources',return_value=f.code_sources).start()
        def load(*a,**kw):
            result=load_publication_configuration(*a,**kw,acl_check=lambda _:None)
            return result
        patch.object(cli,'load_publication_configuration',side_effect=load).start()
        self.credential=patch.object(cli,'AzureCredential').start()
        self.publish=patch.object(cli,'run_registry_publish',return_value={'status':'unknown'}).start()
        self.wire=Mock(side_effect=AssertionError('offline test must not send'))

    def save(self): self.path.write_bytes(encoded(self.config))
    def call(self,action,slot=None):
        request={'config':str(self.path),'action':action}
        if slot:request['slot']=slot
        return cli.run_command(request,clock=self.clock,wire=self.wire)
    def journal(self):
        r=self.config['recovery'];b=self.config['control_budget']['binding']
        return Journal(r['directory'],r['directory_digest'],{'manifest_sha256':self.config['sources']['manifest']['sha256'],
            'owner_id':self.manifest['owner']['principal_id'],'task_id':b['task_id']},require_existing=True)
    def budget(self):
        b=self.config['control_budget']
        return ControlBudget(b['directory'],b['directory_digest'],b['binding'],seed=b['seed'],require_existing=True)

    def test_prepare_creates_same_counter_once_without_auth_or_http(self):
        a=self.call('prepare');self.assertEqual('publication_prepared',a['status'])
        self.assertEqual(128,a['control_requests_used']);self.credential.assert_not_called();self.wire.assert_not_called()
        with self.budget() as budget:budget.consume('owner_arm',600)
        b=self.call('prepare');self.assertEqual(129,b['control_requests_used'])
        with self.journal() as journal:self.assertEqual(1,len(journal.values('publication_preparation')))

    def test_publish_requires_existing_preparation_and_counter(self):
        with self.assertRaises(Denied):self.call('publish','guardian')
        self.assertFalse((self.root/'trial-control-budget.jsonl').exists())
        self.credential.assert_not_called()

    def test_prepare_then_publish_uses_same_budget_and_bundle(self):
        counts=[]
        def capture(*args,**_kwargs):
            counts.append(args[5].count('owner_arm'));return {'status':'unknown'}
        self.publish.side_effect=capture
        self.call('prepare');self.call('publish','guardian')
        args=self.publish.call_args.args
        self.assertEqual({'schema','slot','docker_path','docker_sha256','docker_host','local_image_id','deadline'},set(args[0]))
        self.assertEqual('guardian',args[0]['slot']);self.assertEqual([128],counts)
        self.assertEqual('owner',self.credential.call_args.args[0])
        self.wire.assert_not_called()

    def test_changed_build_identity_rejected_before_journal_auth(self):
        self.proofs['guardian']['source_head']='f'*40
        self.config['publication']['slots']['guardian']['build_receipt']=self.f.fixture.write('changed-build.json',self.proofs['guardian']);self.save()
        with self.assertRaises(Denied):self.call('prepare')
        self.assertFalse((self.root/'trial-provision.jsonl').exists());self.credential.assert_not_called()

    def test_build_proof_false_bool_exit_or_extra_fields_rejected(self):
        loaded={**self.config,'build_receipts':deepcopy(self.proofs)}
        for key,value in [('attempt',True),('exit_code',False),('readback_verified',False),('image_id','sha256:'+'0'*64),('managed_build_sha','b'*40),('secretText','must not save')]:
            bad=deepcopy(loaded);bad['build_receipts']['runtime'][key]=value
            with self.subTest(key=key),self.assertRaises(Denied):cli.validate_build_receipts(bad,self.manifest)

    def test_no_live_or_expired_first_push_rejected_before_credential(self):
        self.config['live']=False;self.save();self.call('prepare')
        with self.assertRaises(Denied):self.call('publish','guardian')
        self.credential.assert_not_called()

    def test_expired_known_ack_may_only_reenter_existing_publisher_state_machine(self):
        self.call('prepare')
        with self.journal() as journal:
            op={'id':'guardianImagePush','method':'PUT','url':'https://fixture.invalid/tag','deadline':'2026-10-11T02:00:00Z'}
            journal.intent(op,self.clock.utc().isoformat())
        self.clock.seconds=7201
        self.call('publish','guardian');self.publish.assert_called_once()

    def test_expired_first_push_rejected(self):
        self.call('prepare');self.clock.seconds=7201
        with self.assertRaises(Denied):self.call('publish','guardian')
        self.credential.assert_not_called();self.publish.assert_not_called()

    def test_status_noauth_no_reinitialize(self):
        self.call('prepare');result=self.call('status')
        self.assertEqual(0,result['verified_images']);self.assertEqual(0,result['attempts'])
        self.credential.assert_not_called();self.wire.assert_not_called()

    def test_crash_config_cleanup_is_local_even_after_deadline(self):
        self.call('prepare')
        with self.journal() as journal:
            path=_write_config(journal,'fictional.azurecr.io','fictional-short-lived-token','guardian')
            self.assertTrue(path.exists())
        self.clock.seconds=999999
        with patch.object(cli,'load_publication_configuration',side_effect=AssertionError('not needed for local cleanup')):
            self.assertTrue(self.call('cleanup-config','guardian')['temporary_config_absent'])
        self.assertFalse(path.exists());self.credential.assert_not_called();self.wire.assert_not_called()

    def test_probe_cleanup_is_local_after_deadline_and_does_not_restart_publication(self):
        self.call('prepare')
        with self.journal() as journal:path=_write_empty_probe(journal,'guardian')
        self.clock.seconds=999999
        with patch.object(cli,'load_publication_configuration',side_effect=AssertionError('local cleanup does not revalidate live gates')):
            result=self.call('cleanup-config','guardian')
        self.assertEqual({'status':'temporary_config_removed','temporary_config_absent':True,'cloud_calls':0},result)
        self.assertFalse(path.exists());self.credential.assert_not_called();self.wire.assert_not_called();self.publish.assert_not_called()
        with self.journal() as journal:
            self.assertEqual(1,len(journal.values('guardian_docker_probe_config_absent')))
            self.assertFalse(journal.values('guardian_docker_probe_result'))
        with self.budget() as budget:self.assertEqual(128,budget.count('owner_arm'))

    def test_bad_probe_cannot_strand_recorded_token_config(self):
        self.call('prepare')
        with self.journal() as journal:
            token=_write_config(journal,'fictional.azurecr.io','fictional-short-lived-token','guardian')
            probe=_config_path(journal,probe=True);probe.mkdir()
            foreign=probe/'foreign';foreign.write_bytes(b'leave this file')
        self.clock.seconds=999999
        with self.assertRaises(Denied):self.call('cleanup-config','guardian')
        self.assertFalse(token.exists());self.assertEqual(b'leave this file',foreign.read_bytes())
        with self.journal() as journal:
            self.assertTrue(journal.values('guardian_docker_config_absent'))
            self.assertFalse(journal.values('guardian_docker_probe_config_absent'))
        self.credential.assert_not_called();self.wire.assert_not_called();self.publish.assert_not_called()

    def test_bad_token_config_still_attempts_recorded_probe_cleanup(self):
        self.call('prepare')
        with self.journal() as journal:
            probe=_write_empty_probe(journal,'guardian')
            token=_config_path(journal);token.mkdir()
            foreign=token/'foreign';foreign.write_bytes(b'leave this file')
        self.clock.seconds=999999
        with self.assertRaises(Denied):self.call('cleanup-config','guardian')
        self.assertFalse(probe.exists());self.assertEqual(b'leave this file',foreign.read_bytes())
        with self.journal() as journal:
            self.assertFalse(journal.values('guardian_docker_config_absent'))
            self.assertTrue(journal.values('guardian_docker_probe_config_absent'))
        self.credential.assert_not_called();self.wire.assert_not_called();self.publish.assert_not_called()

    def test_command_schema_no_arbitrary_slot_or_extra_action(self):
        for value in ({'config':str(self.path),'action':'push','slot':'guardian'},
                      {'config':str(self.path),'action':'publish','slot':'foreign'},
                      {'config':str(self.path),'action':'prepare','slot':'guardian'}):
            with self.assertRaises(Denied):cli.run_command(value)
        self.credential.assert_not_called()

    def test_main_output_never_includes_exception_or_private_input(self):
        incoming=Mock(buffer=io.BytesIO(b'{"private":"sensitive"}'))
        outgoing=io.StringIO()
        with patch.object(cli.sys,'stdin',incoming),patch.object(cli.sys,'stdout',outgoing):
            self.assertEqual(1,cli.main())
        self.assertEqual('{"status":"unconfirmed"}\n',outgoing.getvalue())


if __name__=='__main__':unittest.main()
