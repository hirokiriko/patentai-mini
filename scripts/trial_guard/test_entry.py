"""Actual entry wiring with fake credentials, clock and transports only."""
import unittest
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch, Mock
from . import __main__ as entry
from .adapters import digest
from .lifecycle import Denied, initial
from .test_lifecycle import Clock, Journal, Transport
from .test_adapters import SERVER, RULE, RID, Credential,response


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        now = self.clock.utc()
        self.runtime = {'execution_id': '/fictional/jobs/guard/executions/guard-one', 'replica_name': 'guard-one-abc',
            'image_digest': 'sha256:'+'a'*64, 'principal_id': RID, 'nonce': 'fixed',
            'job_started_at': now.isoformat(), 'job_deadline': (now+timedelta(minutes=30)).isoformat()}
        self.receiver = {**self.runtime, 'execution_id': '/fictional/jobs/receiver/executions/receiver-one',
            'replica_name': 'receiver-one-abc', 'nonce': 'successor', 'available_until': (now+timedelta(hours=6,minutes=5)).isoformat(),
            'permissions_until': (now+timedelta(hours=7)).isoformat()}
        self.state = initial(at=now.isoformat(), rule_id=RULE, lifecycle_id=RID, guardian_pid=None,
            independent_guard_verified=True, cleanup_seconds=600, cloud_guard=self.runtime, ready_seconds=300)
        self.state.update(successor_id=RID+':'+self.receiver['execution_id'], successor_nonce='successor',
            successor_runtime=self.receiver, cleanup_targets_digest=digest([]),
            runtime_readback={**self.runtime,'at':now.isoformat(),'status':'Running'})
        self.fixed = {k:deepcopy(self.state[k]) for k in entry.FIXED}
        self.config = {'live_enabled':True,'mode':'main','immutable':self.fixed,'job_name':'guard','tenant_id':RID,
            'journal_url':'https://fictional.blob.core.windows.net/private/state.json',
            'binding':{'server_id':SERVER,'rule_id':RULE,'ipv4':'192.0.2.1','mode':'guardian','region':'fictional','lifecycle_id':RID}}
        self.environment = {'CONTAINER_APP_JOB_NAME':'guard','CONTAINER_APP_JOB_EXECUTION_NAME':'guard-one','CONTAINER_APP_REPLICA_NAME':'guard-one-abc'}
        self.journal = Journal(self.state)
        self.journal.assert_send_lease = lambda timeout: None

    def assemble(self):
        with patch.object(entry,'AzureCredential',return_value=Credential()), patch.object(entry,'BlobJournal',return_value=self.journal):
            return entry.assemble(self.config,http=Mock(side_effect=AssertionError('no_live_http')),clock=self.clock,environment=self.environment)

    def test_mode_binds_separate_rehearsal_and_main_keys_before_credentials(self):
        for mode, wrong in [('main','rehearsal.json'),('rehearsal','state.json'),('receiver','rehearsal.json')]:
            self.config.update(mode=mode,journal_url='https://fictional.blob.core.windows.net/private/'+wrong)
            with patch.object(entry,'AzureCredential') as credentials:
                with self.assertRaises(Denied):self.assemble()
                credentials.assert_not_called()

    def test_single_seed_uses_actual_owner_start_and_rejects_changed_deadline(self):
        self.state.update(cleanup_strategy='single_job',successor_id=None,successor_nonce=None,successor_runtime=None)
        self.fixed={k:deepcopy(self.state[k]) for k in entry.FIXED}
        self.state['binding_digest']=digest({'binding':self.config['binding'],'immutable':self.fixed})
        self.config.update(immutable=deepcopy(self.fixed),seed_not_before=self.clock.utc().isoformat(),
            prearm_until=(self.clock.utc()+timedelta(seconds=300)).isoformat())
        for k in ('prepared_at','cleanup_at','deadline','ready_until'):self.config['immutable'][k]='$CURRENT'
        for k in ('job_started_at','job_deadline'):self.config['immutable']['cloud_guard'][k]='$CURRENT'
        self.journal.state=deepcopy(self.state)
        seed=Mock();seed._request.return_value=response(200,self.state,{'etag':'fixed'})
        with patch.object(entry,'AzureCredential',return_value=Credential()),patch.object(entry,'BlobJournal',side_effect=[seed,self.journal]):
            runner,*_=entry.assemble(self.config,http=Mock(),clock=self.clock,environment=self.environment)
        self.assertEqual(runner.actor_id,RID+':'+self.runtime['execution_id'])
        bad=deepcopy(self.state);bad['cleanup_at']=(self.clock.utc()+timedelta(seconds=601)).isoformat()
        seed._request.return_value=response(200,bad,{'etag':'fixed'})
        with patch.object(entry,'AzureCredential',return_value=Credential()),patch.object(entry,'BlobJournal',return_value=seed):
            with self.assertRaises(Denied):entry.assemble(self.config,http=Mock(),clock=self.clock,environment=self.environment)

    def test_main_resolves_only_current_platform_execution_and_requires_readback(self):
        self.config['immutable']['cloud_guard']['execution_id']='/fictional/jobs/guard/executions/$CURRENT'
        self.config['immutable']['cloud_guard']['replica_name']='$CURRENT'
        runner,*_=self.assemble()
        self.assertEqual(runner.actor_id,RID+':'+self.runtime['execution_id'])
        self.journal.state['runtime_readback']['image_digest']='foreign'
        with self.assertRaises(Denied):self.assemble()
        self.journal.state['runtime_readback']=self.state['runtime_readback']
        self.environment['CONTAINER_APP_JOB_EXECUTION_NAME']='other-one'
        with self.assertRaises(Denied):self.assemble()

    def test_rehearsal_runs_read_lease_cas_without_any_firewall_write(self):
        self.config.update(mode='rehearsal',journal_url='https://fictional.blob.core.windows.net/private/rehearsal.json')
        runtime={**self.runtime,'job_deadline':(self.clock.utc()+timedelta(seconds=300)).isoformat()}
        self.state.update(initial(at=self.clock.utc().isoformat(),rule_id=RULE,lifecycle_id=RID,guardian_pid=None,
            independent_guard_verified=True,cloud_guard=runtime,cleanup_strategy='rehearsal'))
        self.state['runtime_readback']={**runtime,'at':self.clock.utc().isoformat(),'status':'Running'}
        self.config['immutable']={k:deepcopy(self.state[k]) for k in entry.FIXED};self.journal.state=deepcopy(self.state)
        runner,*_=self.assemble()
        wire=Transport(self.clock)
        with patch.object(entry,'assemble',return_value=(runner,self.journal,wire,self.clock)),patch.object(entry.Clock,'utc',self.clock.utc):
            result=entry.run(self.config)
        self.assertEqual(result['status'],'rehearsal_reads_verified')
        self.assertFalse(result['live_delete_verified']);self.assertEqual(wire.sends('PUT'),0);self.assertEqual(wire.sends('DELETE'),0)

    def test_receiver_uses_own_runtime_without_mutating_original_guard(self):
        self.config.update(mode='receiver',job_name='receiver')
        self.environment={'CONTAINER_APP_JOB_NAME':'receiver','CONTAINER_APP_JOB_EXECUTION_NAME':'receiver-one','CONTAINER_APP_REPLICA_NAME':'receiver-one-abc'}
        self.journal.state['successor_readback']={**self.receiver,'at':self.clock.utc().isoformat(),'status':'Running',
            'entrypoint':'python -m trial_guard','mode':'receiver','independent_of_owner_pc':True}
        runner,*_=self.assemble()
        self.assertEqual(runner.actor_id,self.state['successor_id'])
        self.assertEqual(self.journal.load()['cloud_guard'],self.runtime)
        self.clock.advance(301)
        with patch.object(entry,'assemble',return_value=(runner,self.journal,None,self.clock)),patch.object(entry.Clock,'utc',self.clock.utc),patch.object(entry,'run_receiver',return_value={'status':'fixture'}) as receiver:
            self.assertEqual(entry.run(self.config)['status'],'fixture')
            receiver.assert_called_once()

    def test_receiver_entry_emits_bound_proof_then_accepts_and_continues(self):
        from .adapters import Handoff
        from .runner import GuardianRunner
        sender=RID+':'+self.runtime['execution_id'];target=self.state['successor_id']
        self.journal.state['writer_actor']=sender
        Handoff(self.journal,self.clock,sender).request()
        class Controller:
            actor_id=target
            def tick(_):
                with self.journal.locked():
                    s=self.journal.load();s.update(version=s['version']+1,tick_count=s['tick_count']+1)
                    if s['handoff'].get('accepted'):s['status']='closed'
                    self.journal.save(s,expected_version=s['version']-1)
                    return s
        runner=GuardianRunner(Controller(),self.journal,self.clock,target,lambda:{})
        result=entry.run_receiver(runner,self.journal,self.clock,self.config,pause=lambda _:None)
        self.assertTrue(result['closed']);self.assertTrue(self.journal.load()['handoff']['accepted'])
        proof=self.journal.load()['successor_runtime_proof']
        self.assertEqual(proof['execution_id'],self.receiver['execution_id']);self.assertEqual(proof['mode'],'receiver')

    def test_receiver_retries_contention_and_post_accept_fault_without_false_exit(self):
        from .lifecycle import Conflict
        done={'status':'closed','closed':True}
        with patch.object(entry,'receiver_step',side_effect=[Conflict('lease'),OSError('post_accept'),done]) as step:
            self.assertEqual(entry.run_receiver(None,self.journal,self.clock,self.config,pause=lambda _:None),done)
            self.assertEqual(step.call_count,3)

    def test_sender_crash_before_offer_is_fenced_at_its_fixed_deadline(self):
        from .adapters import Handoff
        from .lifecycle import Controller
        actor=self.state['successor_id'];sender=RID+':'+self.runtime['execution_id']
        self.journal.state['writer_actor']=sender
        original={'request_id':RID,'method':'PUT','intent_at':self.clock.utc().isoformat(),'terminal':None,'operation_url':None}
        self.journal.state['put']=deepcopy(original)
        h=Handoff(self.journal,self.clock,actor)
        self.assertIsNone(h.offer_after_sender_deadline())
        self.clock.advance(1801);h.offer_after_sender_deadline()
        transport=Transport(self.clock)
        controller=Controller(self.journal,transport,self.clock,lambda:{},actor_id=actor)
        h.accept(controller)
        state=self.journal.load();self.assertTrue(state['handoff']['accepted']);self.assertFalse(state['usage_allowed'])
        self.assertEqual(state['put']['request_id'],original['request_id']);self.assertEqual(transport.sends('PUT'),0)
        self.assertEqual(state['cloud_guard']['job_deadline'],self.runtime['job_deadline'])
        with self.assertRaises(Denied):Controller(self.journal,transport,self.clock,lambda:{},actor_id=sender).tick()

    def test_final_receiver_send_checks_permission_after_token_and_lease_delay(self):
        from .adapters import ArmTransport, Deadline
        wire=Mock(side_effect=AssertionError('must_not_send'))
        fenced=entry.PermissionHttp(wire,self.clock,(self.clock.utc()+timedelta(seconds=30)).isoformat())
        class SlowCredential:
            def token(_,audience,deadline):self.clock.advance(15);return 'fictional'
        def lease(_):self.clock.advance(16)
        arm=ArmTransport(self.config['binding'],SlowCredential(),fenced,self.clock,lease)
        with self.assertRaises((Denied,TimeoutError)):
            arm.send(operation={'request_id':RID,'method':'DELETE','intent_at':self.clock.utc().isoformat()},rule_id=RULE,timeout=40)
        wire.assert_not_called()
        with self.assertRaises(Denied):fenced('GET','fictional',{},None,Deadline(1,self.clock.monotonic))

    def test_broken_log_sink_cannot_stop_cleanup_loop(self):
        done={'status':'closed','closed':True}
        with patch.object(entry,'receiver_step',side_effect=[{'status':'recovery_active','closed':False},done]) as step,patch('builtins.print',side_effect=BrokenPipeError()):
            self.assertEqual(entry.run_receiver(None,self.journal,self.clock,self.config,pause=lambda _:None),done)
            self.assertEqual(step.call_count,2)

    def test_journal_high_water_fences_transport_after_restart_clock_rollback(self):
        from .adapters import BlobJournal, Deadline
        from .test_adapters import response, Wire
        end=self.clock.utc()+timedelta(seconds=60)
        value={'binding_digest':'fixed','version':0,'last_now':(end-timedelta(seconds=5)).isoformat()}
        wire=Wire(response(200,value,{'etag':'one'}))
        fenced=entry.PermissionHttp(wire,self.clock,end.isoformat())
        journal=BlobJournal(self.config['journal_url'],'fixed',Credential(),fenced,self.clock,immutable={})
        journal.lease=RID;journal.load()
        with self.assertRaises(Denied):fenced('DELETE','fictional',{},None,Deadline(20,self.clock.monotonic))
        self.clock.advance(6)
        with self.assertRaises(Denied):fenced('DELETE','fictional',{},None,Deadline(1,self.clock.monotonic))
        self.assertEqual(len(wire.calls),1)

    def test_restarted_core_and_runner_advance_from_persisted_future_high_water(self):
        from .lifecycle import Controller
        from .runner import GuardianRunner
        future=self.clock.utc()+timedelta(seconds=55)
        self.journal.state['last_now']=future.isoformat()
        controller=Controller(self.journal,Transport(self.clock),self.clock,lambda:{})
        with self.journal.locked():controller._load()
        runner=GuardianRunner(controller,self.journal,self.clock,'fixture',lambda:{})
        self.assertEqual(runner.effective_now(self.journal.load()),future)
        self.clock.advance(6);controller._refresh()
        self.assertEqual(controller.at,future+timedelta(seconds=6))
        self.assertEqual(runner.effective_now(self.journal.load()),future+timedelta(seconds=6))

    def test_forward_wall_observation_then_rollback_keeps_elapsed_send_time(self):
        from .adapters import Deadline
        wire=Mock(return_value={})
        fenced=entry.PermissionHttp(wire,self.clock,(self.clock.utc()+timedelta(seconds=60)).isoformat())
        self.clock.wall+=timedelta(seconds=45)
        fenced('GET','fictional',{},None,Deadline(10,self.clock.monotonic))
        self.clock.mono+=8;self.clock.wall-=timedelta(seconds=37)
        with self.assertRaises(Denied):fenced('GET','fictional',{},None,Deadline(10,self.clock.monotonic))
        wire.assert_called_once()

    def test_unacked_claim_continues_cleanup_after_availability_without_new_acceptance(self):
        from .runner import GuardianRunner
        actor=self.state['successor_id']
        self.journal.state.update(writer_actor=actor,handoff={'to':actor,'accepted':False,'claim_token':RID,'nonce':RID,
            'deadline':self.state['deadline'],'claim_at':self.clock.utc().isoformat()})
        controller=Mock();controller.tick.return_value={'status':'cleanup_pending'}
        runner=GuardianRunner(controller,self.journal,self.clock,actor,lambda:{})
        self.clock.advance(6*3600+301)
        with patch.object(entry.Handoff,'accept',side_effect=AssertionError('no_new_claim')):
            self.assertEqual(entry.receiver_step(runner,self.journal,self.clock)['status'],'cleanup_availability_expired')
        controller.tick.assert_called_once();self.assertFalse(self.journal.load()['handoff']['accepted'])

    def test_availability_expiry_keeps_accepted_cleanup_but_permissions_end_blocks_sends(self):
        from .runner import GuardianRunner
        actor=self.state['successor_id']
        self.journal.state.update(writer_actor=actor,handoff={'to':actor,'accepted':True})
        controller=Mock();controller.tick.return_value={'status':'cleanup_pending'}
        runner=GuardianRunner(controller,self.journal,self.clock,actor,lambda:{})
        self.clock.advance(6*3600+301)
        result=entry.receiver_step(runner,self.journal,self.clock)
        self.assertEqual(result['status'],'cleanup_availability_expired');self.assertFalse(result['closed']);controller.tick.assert_called_once()
        self.clock.advance(3600)
        self.assertEqual(entry.receiver_step(runner,self.journal,self.clock)['status'],'cleanup_permissions_expired')
        controller.tick.assert_called_once()
        self.journal.state['handoff']['accepted']=False
        self.clock.advance(-3600)
        self.assertEqual(entry.receiver_step(runner,self.journal,self.clock)['status'],'cleanup_permissions_expired')
        controller.tick.assert_called_once()


if __name__=='__main__':unittest.main()
