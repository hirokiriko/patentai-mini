"""Stopped read grant on the real local V8 pipeline with fictional I/O."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import Mock
import json
import os
import unittest

from scripts.trial_guard.adapters import encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import stopped_reads as target
from scripts.trial_provision.journal import ControlBudget, scope_for_dispatch
from scripts.trial_provision.private_io import create_owner_file


class StoppedReadsTests(unittest.TestCase):
    def setUp(self):
        from scripts.trial_provision.tests.test_workflow_v8 import WorkflowV8Tests
        case = WorkflowV8Tests('runTest'); case.setUp(); self.addCleanup(case.doCleanups)
        h = self.h = case.h
        for slot in target.SLOTS:
            self.assertEqual('succeeded', h.f.run_action('create', operation_id=slot)['status'])
        b = h.config['control_budget']
        resolver, receipts = h.snapshot()
        with ControlBudget(b['directory'], b['directory_digest'], b['binding'], seed=b['seed'], require_existing=True) as budget:
            scope = scope_for_dispatch(budget, h.verified, entry_point='provision', action='create', operation=resolver.resolve('guard', receipts))
            scope.consume('owner_arm', 600)
            cleanup = scope_for_dispatch(budget, h.verified, entry_point='owner-cleanup', action='recover')
            cleanup.consume_owner_token(); cleanup.consume('owner_arm', 600); cleanup.consume('owner_arm', 600)
        h.pool.close()
        counter = (h.root/'trial-control-budget.jsonl').read_bytes()
        child = (h.root/(target.CHILD+'.jsonl')).read_bytes()
        self.assertEqual(261, len(counter.splitlines())); self.assertEqual(87, len(child.splitlines()))
        authority = encoded(case.data['new']['authority'])
        stop = {'status': 'STOPPED_V8_CLEANUP_REFERENCE_LIST_UNCONFIRMED', 'authority_sha256': target.sha(authority),
            'delete_sent': False, 'cleanup_binding_written': False, 'old_unknown_reservations_retained': True,
            'all_token_pools_closed': True, 'counts': {'owner_arm':377, 'owner_control_blob':32, 'heartbeat_blob':0},
            'counter': {'sha256':target.sha(counter), 'rows':261}, 'child':{'sha256':target.sha(child), 'rows':87}}
        guard = {'status':'STOPPED_V8_GUARD_ABSENCE_UNCONFIRMED', 'authority_sha256':target.sha(authority), 'guard_new_mutation_sent':False}
        scope = h.manifest['resourceGroupId'].split('/resourceGroups/',1)[0]
        targets = [{'slot':'guard', 'url':resolver.resolve('guard',receipts)['url'], 'resource_id':h.manifest['ids']['guard']}]
        for collection, version in target.COLLECTIONS:
            targets.append({'slot':collection, 'url':'https://management.azure.com'+scope+'/providers/Microsoft.Authorization/'+collection+'?api-version='+version,
                'role_id':resolver.resolve('C1',receipts)['expected']['resource_id']})
        self.evidence = {'counter':counter, 'child':child, 'authority':authority, 'manifest':h.authority['manifest'],
            'stop_guard':encoded(guard), 'stop_cleanup':encoded(stop), 'direct_request':b'fictional explicit read-only diagnosis request'}
        self.sources = {'fixture.py':'a'*64}
        self.g = {'schema':1, 'kind':target.KIND, 'start':h.clock.utc().isoformat(), 'end':(h.clock.utc()+timedelta(minutes=10)).isoformat(),
            'owner':h.manifest['owner'], 'targets':targets, 'source_digests':self.sources, 'evidence_sha256':{k:target.sha(v) for k,v in self.evidence.items()},
            'counter_binding':b['binding'], 'seed':b['seed'], 'directory':str(h.root), 'child_binding':json.loads(child.splitlines()[0])['value'],
            'attempt':h.verified.binding_digest, 'counter_rows':261, 'counts':stop['counts'], 'maximum':{'http':4,'owner_token':1},
            'direct_request_sha256':target.sha(self.evidence['direct_request'])}
        owner = h.manifest['owner']
        self.credential = Mock(mode='owner', principal=owner['principal_id'].lower(), tenant=owner['tenant_id'].lower())
        self.credential.token.return_value='fictional-memory-only-token'
        self.wire = Mock(side_effect=[{'status':404,'headers':{},'body':b'{"error":{"code":"ResourceNotFound"}}'}]+
            [{'status':200,'headers':{},'body':b'{"value":[]}'}]*3)

    def verify(self):
        raw=encoded(self.g)
        return target.verify_grant(raw,trusted_sha256=target.sha(raw), evidence=self.evidence, source_digests=self.sources,now=self.h.clock.utc())

    def run_reads(self):
        return target.observe_once(self.verify(),clock=self.h.clock,credential=self.credential,wire=self.wire,current_sources=lambda:self.sources)

    def test_four_reads_are_debited_before_send_and_do_not_change_acks(self):
        count=[]
        original=self.wire.side_effect
        replies=iter(original)
        def wire(*args):
            count.append(len((self.h.root/'trial-control-budget.jsonl').read_bytes().splitlines()))
            self.assertEqual('GET',args[0]);self.assertIsNone(args[3]);return next(replies)
        self.wire.side_effect=wire
        result=self.run_reads()
        self.assertEqual([263,264,265,266],count)
        self.assertEqual(382,result['counts']['owner_arm']);self.assertEqual(5,result['requests'])
        self.assertFalse(result['deletion_authorized']);self.assertFalse(result['restart_authorized'])
        self.assertEqual('absent_verified',result['observations'][0]['validation'])
        self.assertEqual((self.h.root/(target.CHILD+'.jsonl')).read_bytes(),self.evidence['child'])
        self.assertNotIn('fictional-memory-only-token',json.dumps(result))
        before=(self.h.root/'trial-control-budget.jsonl').read_bytes()
        with self.assertRaises(Denied):self.run_reads()
        self.assertEqual(before,(self.h.root/'trial-control-budget.jsonl').read_bytes())

    def test_auth_failure_counts_once_and_never_sends_get(self):
        self.credential.token.side_effect=OSError('canary-secret')
        result=self.run_reads();self.assertEqual(378,result['counts']['owner_arm'])
        self.wire.assert_not_called();self.assertNotIn('canary-secret',json.dumps(result))

    def test_changed_target_or_ack_snapshot_is_rejected(self):
        old=deepcopy(self.g)
        self.g['targets'][0]['url']+='&extra=1'
        with self.assertRaises(Denied):self.verify()
        self.g=old;self.evidence['child']+=b'\n'
        with self.assertRaises(Denied):self.verify()

    def test_existing_marker_blocks_even_with_no_previous_debit(self):
        os.close(create_owner_file(self.h.root/target.MARKER))
        with self.assertRaises(FileExistsError):self.run_reads()
        self.credential.token.assert_not_called();self.wire.assert_not_called()

    def test_grant_end_bounds_token_and_no_get_follows_expiry(self):
        self.g['end']=(self.h.clock.utc()+timedelta(seconds=2)).isoformat()
        def token(audience,deadline):
            self.assertLessEqual(deadline.remaining(),2)
            self.h.clock.advance(3)
            deadline.remaining()
        self.credential.token.side_effect=token
        result=self.run_reads();self.assertEqual(1,result['requests']);self.wire.assert_not_called()

    def test_source_change_after_token_stops_before_get(self):
        def token(*_):
            self.sources['fixture.py']='b'*64
            return 'fictional-memory-only-token'
        self.credential.token.side_effect=token
        result=self.run_reads();self.assertEqual(1,result['requests']);self.wire.assert_not_called()

    def test_concurrent_counter_lock_blocks_before_token(self):
        b=self.h.config['control_budget']
        with ControlBudget(b['directory'],b['directory_digest'],b['binding'],seed=b['seed'],require_existing=True):
            with self.assertRaises(Denied):self.run_reads()
        self.credential.token.assert_not_called();self.wire.assert_not_called()


if __name__=='__main__':unittest.main()
