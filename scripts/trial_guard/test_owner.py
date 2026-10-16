import unittest
from copy import deepcopy
from datetime import timedelta
from unittest.mock import Mock,patch
from . import owner
from .test_lifecycle import Clock,Journal
from .test_adapters import SERVER,RULE,RID,Credential
from .adapters import digest
from .lifecycle import Denied

class OwnerTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock();at=self.clock.utc()
        runtime={'execution_id':'fixture/jobs/guard/executions/guard-one','replica_name':'guard-one-abc','image_digest':'sha256:'+'a'*64,
            'principal_id':RID,'nonce':'fixed','job_started_at':at.isoformat(),'job_deadline':(at+timedelta(minutes=30)).isoformat()}
        self.config={'live_enabled':True,'cleanup_strategy':'single_job','owner_permissions_until':(at+timedelta(hours=8)).isoformat(),
            'owner_id':RID,'tenant_id':RID,'cloud_guard':runtime,'runtime_readback':{**runtime,'at':at.isoformat(),'status':'Running'},
            'binding':{'server_id':SERVER,'rule_id':RULE,'ipv4':'192.0.2.1','mode':'guardian','region':'fictional','lifecycle_id':RID},
            'cleanup_targets_digest':digest([]),'journal_url':'https://fictional.blob.core.windows.net/guard/state.json'}
        self.config['owner_access']={'approved':True,'readback_verified':True,'principal_id':RID,'journal_url':self.config['journal_url'],
            'starts_at':at.isoformat(),'ends_at':self.config['owner_permissions_until'],'assignment_id':RID,'evidence_sha256':'a'*64}
        self.config['binding']['lro_authorization']={'approved':True,'readback_verified':True,'principal_id':RID,
            'scope':'/subscriptions/'+SERVER.split('/')[2],'actions':list(owner.ArmTransport.lro_actions),'assignment_id':RID,
            'evidence_sha256':'b'*64,'ends_at':self.config['owner_permissions_until']}

    def test_normal_owner_chain_creates_guardian_digest_without_network_write(self):
        with patch.object(owner,'AzureCredential',return_value=Credential()),patch.object(owner,'BlobJournal',autospec=True) as journal:
            _,_,state,_=owner.assemble_owner(self.config,http=Mock(),clock=self.clock)
        self.assertEqual(state['cleanup_at'],(self.clock.utc()+timedelta(minutes=10)).isoformat())
        self.assertEqual(state['binding_digest'],digest({'binding':self.config['binding'],'immutable':{k:state[k] for k in owner.FIXED}}))
        journal.return_value.initialize.assert_not_called()

    def test_no_live_default_or_extended_owner_window(self):
        for change in ({'live_enabled':False},{'owner_permissions_until':(self.clock.utc()+timedelta(hours=9)).isoformat()}):
            with self.assertRaises(Denied):owner.assemble_owner({**self.config,**change},clock=self.clock)

    def test_five_minute_rehearsal_has_no_open_or_use_path(self):
        self.config['cleanup_strategy']='rehearsal'
        self.config['journal_url']=self.config['journal_url'].replace('state.json','rehearsal.json')
        self.config['owner_access']['journal_url']=self.config['journal_url']
        end=(self.clock.utc()+timedelta(seconds=300)).isoformat()
        self.config['cloud_guard']['job_deadline']=end;self.config['runtime_readback']['job_deadline']=end
        with patch.object(owner,'AzureCredential',return_value=Credential()),patch.object(owner,'BlobJournal',autospec=True):
            _,_,state,_=owner.assemble_owner(self.config,http=Mock(),clock=self.clock)
        self.assertEqual(state['deadline'],end);self.assertFalse(state['usage_allowed']);self.assertIsNone(state['put'])
        for action in ('open','heartbeat','close'):
            with self.assertRaises(Denied):owner.owner_action(self.config,action)

    def test_heartbeat_has_fixed_cadence_and_stops_at_use_cutoff(self):
        with patch.object(owner,'AzureCredential',return_value=Credential()),patch.object(owner,'BlobJournal',autospec=True):
            _,_,state,_=owner.assemble_owner(self.config,http=Mock(),clock=self.clock)
        journal=Journal(state)
        with patch.object(owner,'assemble_owner',return_value=(journal,Mock(),state,self.clock)):
            with self.assertRaises(Denied):owner.owner_action(self.config,'heartbeat')
            self.clock.advance(2);owner.owner_action(self.config,'heartbeat');self.assertEqual(journal.saves,1)
            self.clock.advance(598)
            with self.assertRaises(Denied):owner.owner_action(self.config,'heartbeat')
            self.assertEqual(journal.saves,1)

if __name__=='__main__':unittest.main()
