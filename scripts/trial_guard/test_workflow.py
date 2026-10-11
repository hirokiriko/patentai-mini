"""Continuous lifecycle with the real controller/owner session and mock I/O."""
import tempfile
import json
import os
import stat
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock,patch
from .adapters import digest
from .lifecycle import Controller,Denied,initial,parse
from .owner import OwnerSession
from .runner import GuardianRunner
from .workflow import Receipt,Workflow,closure_proven
from .execution import CountedHttp,AzureJobStarter,NodeWorker,validate_launch_preflight
from .test_lifecycle import Clock,Journal,Transport
from scripts.trial_provision.private_io import create_owner_file,verify_owner_file


class ReceiptPermissionTests(unittest.TestCase):
    def setUp(self):
        self.directory=Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def receipt(self,directory=None):
        directory=directory or self.directory
        return Receipt(str(directory),digest(str(directory)),'fictional-configuration')

    def test_new_owner_files_remain_private_after_locked_reopen(self):
        first=self.receipt()
        try:
            for path in (first.lock_path,first.path):verify_owner_file(path)
            with self.assertRaisesRegex(Denied,'concurrent_writer'):self.receipt()
            first.append('work_intent',{'fictional':True})
            original=first.path.read_bytes()
        finally:first.close()
        reopened=self.receipt()
        try:
            self.assertEqual(original,reopened.path.read_bytes())
            self.assertEqual([{'fictional':True}],reopened.find('work_intent'))
            for path in (reopened.lock_path,reopened.path):verify_owner_file(path)
        finally:reopened.close()

    @unittest.skipIf(os.name=='nt','POSIX mode contract; Windows uses OWNER ACLs')
    def test_new_files_are_0600_under_default_and_permissive_umasks(self):
        for mask in (0o022,0o000):
            with self.subTest(umask=oct(mask)):
                directory=self.directory/str(mask);directory.mkdir(mode=0o700)
                previous=os.umask(mask)
                try:
                    receipt=self.receipt(directory)
                    try:
                        for path in (receipt.lock_path,receipt.path):
                            self.assertEqual(0o600,stat.S_IMODE(path.stat().st_mode))
                            verify_owner_file(path)
                    finally:receipt.close()
                finally:os.umask(previous)

    @unittest.skipIf(os.name=='nt','POSIX unsafe mode fixture')
    def test_existing_0644_is_rejected_without_writes_or_peer_creation(self):
        for name in ('trial-session.lock','trial-session.jsonl'):
            with self.subTest(name=name):
                directory=self.directory/name;directory.mkdir(mode=0o700)
                path=directory/name;path.write_bytes(b'fictional existing evidence');path.chmod(0o644)
                with self.assertRaisesRegex(OSError,'private_file_permissions'):self.receipt(directory)
                self.assertEqual(b'fictional existing evidence',path.read_bytes())
                self.assertEqual(0o644,stat.S_IMODE(path.stat().st_mode))
                self.assertEqual([name],sorted(p.name for p in directory.iterdir()))

    @unittest.skipIf(os.name=='nt','POSIX unsafe mode fixture')
    def test_unsafe_journal_does_not_modify_existing_private_lock(self):
        lock=self.directory/'trial-session.lock';os.close(create_owner_file(lock))
        lock.write_bytes(b'fictional lock evidence')
        journal=self.directory/'trial-session.jsonl';journal.write_bytes(b'fictional journal');journal.chmod(0o644)
        with self.assertRaisesRegex(OSError,'private_file_permissions'):self.receipt()
        self.assertEqual(b'fictional lock evidence',lock.read_bytes())
        self.assertEqual(b'fictional journal',journal.read_bytes())
        verify_owner_file(lock)
        self.assertEqual(0o644,stat.S_IMODE(journal.stat().st_mode))

    def test_initial_append_interruption_closes_handles_and_releases_lock(self):
        captured=[]
        def interrupt(receipt,*args):
            captured.append(receipt)
            raise KeyboardInterrupt()
        with patch.object(Receipt,'append',interrupt),self.assertRaises(KeyboardInterrupt):self.receipt()
        self.assertTrue(captured[0].stream.closed);self.assertTrue(captured[0].lock.closed)
        reopened=self.receipt()
        try:self.assertEqual(1,len(reopened.records))
        finally:reopened.close()

    def test_initial_fsync_failure_releases_lock_without_rewriting_chain(self):
        captured=[];append=Receipt.append
        def observed(receipt,*args):
            captured.append(receipt)
            return append(receipt,*args)
        with patch.object(Receipt,'append',observed),patch('scripts.trial_guard.workflow.os.fsync',side_effect=OSError('fixture fsync')):
            with self.assertRaisesRegex(OSError,'fixture fsync'):self.receipt()
        self.assertTrue(captured[0].stream.closed);self.assertTrue(captured[0].lock.closed)
        original=captured[0].path.read_bytes()
        reopened=self.receipt()
        try:
            self.assertEqual(original,reopened.path.read_bytes())
            self.assertEqual(1,len(reopened.records))
        finally:reopened.close()


class Harness:
    def __init__(self,directory):
        self.clock=Clock();at=self.clock.utc()
        self.runtime={'execution_id':'/fixture/jobs/guard/executions/guard-one','replica_name':'guard-one-one',
            'image_digest':'sha256:'+'a'*64,'principal_id':'fixture-principal','nonce':'fixture-nonce',
            'job_started_at':at.isoformat(),'job_deadline':(at+timedelta(minutes=30)).isoformat()}
        self.state=initial(at=at.isoformat(),rule_id='/fixture/rule',lifecycle_id='fixture-session',guardian_pid=None,
            independent_guard_verified=True,cleanup_seconds=600,cloud_guard=self.runtime,cleanup_strategy='single_job')
        self.state.update(binding_digest='a'*64,owner_heartbeat={'at':at.isoformat()})
        self.journal=Journal(self.state);self.journal.url='https://fictional.blob.core.windows.net/guard/state.json'
        self.initialized=False
        def initialize(value):self.initialized=True;self.journal.state=deepcopy(value)
        self.journal.initialize=initialize
        self.transport=Transport(self.clock)
        def proof():
            hb=parse(self.journal.state['owner_heartbeat']['at'])
            return {**self.runtime,'kind':'azure_job','lifecycle_id':'fixture-session','runtime_verified':True,
                'alive':(self.clock.utc()-hb).total_seconds()<=15,'at':self.clock.utc().isoformat()}
        self.session=OwnerSession.__new__(OwnerSession)
        self.session.journal=self.journal;self.session.controller=Controller(self.journal,self.transport,self.clock,proof)
        self.session.initial=deepcopy(self.state);self.session.clock=self.clock;self.session.strategy='single_job'
        self.session.recovery_only=False
        self.session.version=-1;self.session.high=at;self.session.heartbeat_attempts=0
        guardian=Controller(self.journal,self.transport,self.clock,proof)
        self.runner=GuardianRunner(guardian,self.journal,self.clock,self.runtime['principal_id']+':'+self.runtime['execution_id'],Mock())
        self.receipt=Receipt(str(Path(directory).resolve()),digest(str(Path(directory).resolve())),'fixture-configuration')
        self.starter=Mock();self.starter.start.return_value=self.runtime;self.starter.recover.return_value=self.runtime
        self.worker=Mock();self.worker.poll.side_effect=[None,None,True];self.worker.stop.return_value=True
        self.on_sleep=lambda:None
        def sleep(seconds):
            self.clock.advance(seconds);self.on_sleep()
            if self.initialized:
                if not self.journal.state.get('guardian_ready') and not self.journal.state.get('close_requested'):self.runner.opening_gate()
                else:self.runner.step()
        self.sleep=sleep
        self.workflow=Workflow(self.receipt,self.starter,lambda *_:self.session,self.worker,self.clock,sleep)
    def close(self):self.receipt.close()


class WorkflowTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.h=Harness(self.tmp.name)
    def tearDown(self):self.h.close();self.tmp.cleanup()
    def test_one_continuous_start_prepare_work_remove_absence_handoff(self):
        result=self.h.workflow.run()
        self.assertEqual(result,{'status':'completed','cleanupConfirmed':True,'workComplete':True})
        self.h.starter.start.assert_called_once();self.h.worker.start.assert_called_once()
        self.assertEqual(self.h.transport.sends('PUT'),1);self.assertEqual(self.h.transport.sends('DELETE'),1)
        self.assertTrue(closure_proven(self.h.journal.state));self.assertTrue(self.h.receipt.find('handoff_complete'))
    def test_start_unknown_reconciles_without_opening_or_respawn(self):
        self.h.starter.start.side_effect=TimeoutError()
        result=self.h.workflow.run()
        self.assertNotEqual(result['status'],'completed');self.h.starter.start.assert_called_once()
        self.h.starter.recover.assert_called_once();self.h.worker.start.assert_not_called()
        self.assertEqual(self.h.transport.sends('PUT'),0)
    def test_unknown_initialize_after_save_is_cleanup_only(self):
        real=self.h.journal.initialize
        def unknown(s):real(s);raise TimeoutError()
        self.h.journal.initialize=unknown
        result=self.h.workflow.run()
        self.assertTrue(result['cleanupConfirmed']);self.assertFalse(result['workComplete'])
        self.h.worker.start.assert_not_called();self.assertEqual(self.h.transport.sends('PUT'),0)
    def test_unknown_open_does_not_resend_and_requires_terminal_proof(self):
        self.h.transport.enqueue('send',TimeoutError())
        self.h.transport.rule='absent'
        result=self.h.workflow.run()
        self.assertFalse(result['cleanupConfirmed']);self.assertEqual(self.h.transport.sends('PUT'),1)
        self.assertEqual(self.h.transport.sends('DELETE'),0);self.h.worker.start.assert_not_called()
        self.assertTrue(self.h.receipt.find('cleanup_deadline_warning'));self.assertTrue(self.h.receipt.find('deadline_unresolved'))
    def test_unknown_delete_404_does_not_fake_absence_receipt(self):
        original=self.h.worker.poll
        def done():
            value=original()
            if value is True:self.h.transport.enqueue('send',TimeoutError())
            return value
        self.h.worker.poll=done
        result=self.h.workflow.run()
        self.assertFalse(result['cleanupConfirmed']);self.assertEqual(self.h.transport.sends('DELETE'),1)
        self.assertFalse(self.h.receipt.find('handoff_complete'))
    def test_partial_work_never_restarts_or_reports_success(self):
        self.h.worker.poll.side_effect=[False]
        result=self.h.workflow.run()
        self.assertTrue(result['cleanupConfirmed']);self.assertFalse(result['workComplete'])
        self.h.worker.start.assert_called_once()
    def test_deadline_interrupt_and_failed_stop_never_handoff(self):
        self.h.worker.poll.side_effect=None;self.h.worker.poll.return_value=None;self.h.worker.stop.return_value=False
        self.h.on_sleep=lambda:self.h.workflow.interrupt() if self.h.worker.start.called else None
        result=self.h.workflow.run()
        self.assertFalse(result['workComplete']);self.assertFalse(self.h.receipt.find('handoff_complete'))
        self.h.worker.start.assert_called_once();self.assertGreater(self.h.worker.stop.call_count,0)
    def test_permission_snapshot_loss_stops_worker_and_requests_close(self):
        real=self.h.session.action
        def action(a):
            if self.h.worker.start.called and a=='heartbeat':raise Denied('lease_unavailable')
            return real(a)
        self.h.session.action=action
        result=self.h.workflow.run()
        self.assertTrue(result['cleanupConfirmed']);self.assertFalse(result['workComplete']);self.h.worker.stop.assert_called()
    def test_no_local_db_work_after_fixed_ten_minutes(self):
        self.h.worker.poll.side_effect=None;self.h.worker.poll.return_value=None
        self.h.on_sleep=lambda:self.h.clock.advance(600) if self.h.worker.start.called and not self.h.worker.stop.called else None
        result=self.h.workflow.run()
        self.assertTrue(result['cleanupConfirmed']);self.h.worker.stop.assert_called()
    def test_clock_rollback_aborts_use(self):
        def rollback():
            if self.h.worker.start.called and not self.h.workflow.closing:self.h.clock.wall-=timedelta(seconds=100)
        self.h.on_sleep=rollback
        self.h.worker.poll.side_effect=None;self.h.worker.poll.return_value=None
        self.assertFalse(self.h.workflow.run()['workComplete']);self.h.worker.stop.assert_called()
    def test_parent_loss_lease_expires_and_guardian_cleans_without_local_loop(self):
        self.h.journal.initialize(self.h.state);self.h.clock.advance(2);self.h.runner.opening_gate()
        self.h.session.action('open');self.h.runner.step()
        self.assertTrue(self.h.journal.state['usage_allowed'])
        self.h.clock.advance(16);self.h.runner.step();self.h.runner.step()
        self.assertTrue(closure_proven(self.h.journal.state))
    def test_receipt_reopen_is_cleanup_only_and_concurrent_writer_denied(self):
        with self.assertRaises(Denied):Receipt(str(Path(self.tmp.name).resolve()),digest(str(Path(self.tmp.name).resolve())),'fixture-configuration')
        self.h.workflow.run()
        self.h.clock.advance(1900)
        w=Workflow(self.h.receipt,self.h.starter,lambda *_:self.h.session,self.h.worker,self.h.clock,self.h.sleep)
        result=w.run();self.assertFalse(result['workComplete'])
        self.h.starter.start.assert_called_once();self.h.worker.start.assert_called_once()
    def test_bound_counters_consume_failures_before_io(self):
        wire=Mock(side_effect=TimeoutError());counted=CountedHttp(wire,self.h.receipt)
        from .adapters import Deadline
        for _ in range(2):
            with self.assertRaises(TimeoutError):counted('GET','https://management.azure.com/fixture',{},None,Deadline(1))
        self.assertEqual(self.h.receipt.count('owner_arm'),2)
        self.h.receipt.consume('test',1)
        with self.assertRaises(Denied):self.h.receipt.consume('test',1)
    def test_plain_closed_or_modified_baseline_never_passes(self):
        self.h.workflow.run();s=deepcopy(self.h.journal.state);s.pop('closure_evidence');self.assertFalse(closure_proven(s))
        s=deepcopy(self.h.journal.state);s['closure_evidence']['existing_rules_unchanged']=False;self.assertFalse(closure_proven(s))


class ExecutionTests(unittest.TestCase):
    def test_first_start_requires_current_exact_head_authority_cost_isolation_evidence(self):
        clock=Clock();sha='a'*40
        binding={'ipv4':'192.0.2.1','server_id':'/fixture/server','rule_id':'/fixture/server/firewallRules/guard'}
        preflight={**binding,'ci_head':sha,'reviewed_head':sha,'checked_at':clock.utc().isoformat(),
            'initial_forecast_yen':4311,'initial_cap_yen':5000,'all_unsettled_retained':True,
            'external_business_acl_verified':True,'no_production_change':True,'all_evidence_verified':True,
            'evidence_sha256':{k:'b'*64 for k in ('network_approval','current_ip','isolation','current_ledger','current_prices','effective_permissions','additional_authority')}}
        config={'binding':binding,'preflight':preflight,'worker':{'payload':{'environment':{'TRIAL_POLICY_JSON':json.dumps({'codeSha':sha})}}}}
        validate_launch_preflight(config,clock)
        for field,value in [('ci_head','c'*40),('initial_forecast_yen',4501),('external_business_acl_verified',False),('ipv4','192.0.2.2')]:
            changed=deepcopy(config);changed['preflight'][field]=value
            with self.assertRaises(Denied):validate_launch_preflight(changed,clock)
        clock.advance(600)
        with self.assertRaises(Denied):validate_launch_preflight(config,clock)
    def test_import_is_inert_and_live_preflight_required(self):
        with self.assertRaises((Denied,KeyError)):AzureJobStarter({'live_enabled':False},Mock(),Clock())
    def test_worker_does_not_launch_shell_and_kills_only_direct_child(self):
        with tempfile.TemporaryDirectory() as directory:
            node=Path(directory)/'node';script=Path(directory)/'trial-session.js';node.touch();script.touch()
            worker=NodeWorker(str(node.resolve()),str(script.resolve()),{'requests':[]})
            child=Mock();child.poll.side_effect=[None,None,None,0]
            with patch('subprocess.Popen',return_value=child) as spawn:
                worker.start({'useUntil':'fixture'},{'type':'permit'})
                self.assertFalse(spawn.call_args.kwargs['shell']);self.assertTrue(worker.stop())
                self.assertEqual(spawn.call_count,1)

if __name__=='__main__':unittest.main()
