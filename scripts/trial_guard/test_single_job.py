import unittest
from copy import deepcopy
from datetime import timedelta
from . import test_cloud_core as cloud
from .lifecycle import Denied, initial
from .runner import GuardianRunner

class SingleJobTests(unittest.TestCase):
    setUp=cloud.CloudGuardTests.setUp
    guard=cloud.CloudGuardTests.guard
    def single(self):
        self.journal.state['cleanup_strategy']='single_job'
        self.actor=self.binding['principal_id']+':'+self.binding['execution_id']
        self.guardian=GuardianRunner(self.runner,self.journal,self.clock,self.actor,
            lambda: (_ for _ in ()).throw(AssertionError('no successor')))
        self.guardian.opening_gate()

    def test_single_ready_required_and_fresh(self):
        self.journal.state['cleanup_strategy']='single_job'
        with self.assertRaises(Denied):self.runner.start()
        self.assertEqual(self.transport.sends('PUT'),0)
        self.single();self.runner.start();self.assertEqual(self.transport.sends('PUT'),1)

    def test_single_wrong_or_stale_ready_never_opens(self):
        for key in ('actor','nonce','execution_id','lifecycle_id','at'):
            self.setUp();self.single()
            self.journal.state['guardian_ready'][key]=((self.clock.utc()-timedelta(seconds=16)).isoformat() if key=='at' else 'foreign')
            with self.assertRaises(Denied):self.runner.start()
            self.assertEqual(self.transport.sends('PUT'),0)

    def test_single_ready_delay_does_not_move_cutoff(self):
        self.clock.advance(290);self.single();self.runner.start();self.runner.tick()
        self.clock.advance(310);self.guardian.step()
        self.assertEqual(self.transport.sends('DELETE'),1)
        self.assertTrue(self.guardian.step()['closed'])
        self.assertNotIn('handoff',self.journal.state)

    def test_single_unknown_warns_and_keeps_obligation_at_30_minutes(self):
        self.single();self.transport.enqueue('send',TimeoutError());self.runner.start();self.transport.rule='absent'
        self.clock.advance(1500);self.assertIsNotNone(self.guardian.step()['attention'])
        self.assertIn('single_job_warning',self.journal.state)
        self.clock.advance(300);r=self.guardian.step()
        self.assertTrue(r['deadline_exceeded']);self.assertFalse(r['exit']);self.assertFalse(r['closed'])
        self.assertTrue(self.journal.state['cleanup_responsibility_retained'])
        self.assertEqual(self.transport.sends('PUT'),1);self.assertEqual(self.transport.sends('DELETE'),0)

    def test_single_exact_10_and_30_minute_configuration(self):
        for seconds in (599,601):
            with self.assertRaises(ValueError):initial(at=self.clock.utc().isoformat(),rule_id='/fixture/rule',
                lifecycle_id='fixture-window',guardian_pid=None,independent_guard_verified=True,
                cleanup_seconds=seconds,cloud_guard=self.binding,cleanup_strategy='single_job')

    def test_single_put_budget_includes_ready_age_before_token_or_lease_wait(self):
        self.single();self.clock.advance(14)
        original=self.transport.send
        def send(**kw):
            self.assertLessEqual(kw['timeout'],1)
            # A real adapter's total Deadline rejects here before HTTP dispatch.
            self.clock.advance(2);raise TimeoutError()
        self.transport.send=send
        self.runner.start();self.assertEqual(self.transport.sends('PUT'),0)
        self.assertTrue(self.journal.state['cleanup_responsibility_retained'])

if __name__=='__main__':unittest.main()
