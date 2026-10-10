"""Cloud proof/deadline regression tests; fictional targets, no network."""
import unittest
from copy import deepcopy
from datetime import timedelta
from .lifecycle import Controller, Denied, initial
from .test_lifecycle import Clock, Journal, Transport

class CloudGuardTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock()
        self.binding={'execution_id':'fixture/execution','replica_name':'fixture-replica',
                      'image_digest':'sha256:'+'a'*64,'principal_id':'fixture-mi','nonce':'fixture-nonce',
                      'job_started_at':self.clock.utc().isoformat(),
                      'job_deadline':(self.clock.utc()+timedelta(minutes=30)).isoformat()}
        self.journal=Journal(initial(at=self.clock.utc().isoformat(),rule_id='/fixture/rule',
            lifecycle_id='fixture-window',guardian_pid=None,independent_guard_verified=True,
            cleanup_seconds=600,cloud_guard=self.binding,ready_seconds=300))
        self.transport=Transport(self.clock)
        self.override={}
        self.runner=Controller(self.journal,self.transport,self.clock,self.guard)
    def guard(self):
        return {'kind':'azure_job','runtime_verified':True,'alive':True,
            'at':self.clock.utc().isoformat(),'lifecycle_id':'fixture-window',**self.binding,**self.override}
    def test_prearmed_wait_does_not_close_or_write(self):
        for _ in range(3):
            self.assertEqual(self.runner.tick()['status'],'ready_waiting')
            self.clock.advance(30)
        self.assertEqual(self.transport.sends('PUT'),0)
        self.assertEqual(self.transport.sends('DELETE'),0)
    def test_ready_expiry_closes_without_opening(self):
        self.clock.advance(300)
        self.assertEqual(self.runner.tick()['status'],'closed')
        self.assertEqual(self.transport.sends('PUT'),0)
    def test_typed_proof_can_open_without_windows_pid_forgery(self):
        self.runner.start()
        self.assertTrue(self.runner.tick()['usage_allowed'])
        self.assertNotIn('process_handle_verified',self.guard())
    def test_every_cloud_binding_field_is_required(self):
        for key in self.binding:
            with self.subTest(key=key):
                self.setUp(); self.override[key]='foreign'
                with self.assertRaises(Denied): self.runner.start()
                self.assertEqual(self.transport.sends('PUT'),0)
    def test_stale_heartbeat_refuses_open(self):
        self.override['at']=(self.clock.utc()-timedelta(seconds=16)).isoformat()
        with self.assertRaises(Denied): self.runner.start()
    def test_runtime_verification_is_required(self):
        self.override['runtime_verified']=False
        with self.assertRaises(Denied): self.runner.start()
    def test_windows_proof_cannot_replace_cloud_proof(self):
        self.override={'kind':'windows','pid':123,'process_handle_verified':True}
        with self.assertRaises(Denied): self.runner.start()
    def test_short_work_cutoff_removes_rule(self):
        self.runner.start(); self.runner.tick()
        self.clock.advance(600)
        self.assertFalse(self.runner.tick()['usage_allowed'])
        self.assertEqual(self.transport.sends('DELETE'),1)
        self.assertEqual(self.runner.tick()['status'],'closed')
    def test_clock_rollback_never_reopens_ready_phase(self):
        self.runner.tick(); self.clock.advance(-1)
        state=self.runner.tick()
        self.assertTrue(state['close_requested'])
        self.assertFalse(state['usage_allowed'])
        self.clock.advance(2)
        self.assertFalse(self.runner.tick()['usage_allowed'])
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'),0)
    def test_cloud_requires_explicit_short_cutoff(self):
        with self.assertRaises(ValueError):
            initial(at=self.clock.utc().isoformat(),rule_id='/fixture/rule',
                lifecycle_id='fixture-window',guardian_pid=None,independent_guard_verified=True,
                cloud_guard=self.binding)
    def test_direct_start_after_ready_deadline_is_rejected(self):
        self.clock.advance(300)
        with self.assertRaises(Denied): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'),0)
    def test_inspect_crossing_ready_deadline_never_sends(self):
        self.clock.advance(295); self.transport.delay['inspect']=6
        state=self.runner.start()
        self.assertFalse(state['usage_allowed'])
        self.assertEqual(self.transport.sends('PUT'),0)
    def test_intent_commit_crossing_ready_deadline_never_sends(self):
        self.clock.advance(299)
        save=self.journal.save
        def delayed(value,expected_version):
            save(value,expected_version)
            if value['put'] is not None and value['put']['terminal'] is None:
                self.clock.advance(2)
        self.journal.save=delayed
        self.runner.start()
        self.assertEqual(self.transport.sends('PUT'),0)
    def test_job_cleanup_margin_required_at_creation(self):
        with self.assertRaises(ValueError):
            initial(at=self.clock.utc().isoformat(),rule_id='/fixture/rule',
                lifecycle_id='fixture-window',guardian_pid=None,independent_guard_verified=True,
                cloud_guard=self.binding,cleanup_seconds=901)
    def test_corrupt_reload_cannot_extend_cleanup_to_five_hours(self):
        self.journal.state['cleanup_at']=(self.clock.utc()+timedelta(hours=5)).isoformat()
        with self.assertRaises(ValueError): self.runner.start()
        self.assertEqual(self.transport.sends('PUT'),0)

if __name__=='__main__': unittest.main()
