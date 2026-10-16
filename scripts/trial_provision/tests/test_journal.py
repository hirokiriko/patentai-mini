import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import Journal,ControlBudget,CountedControlHttp


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name).resolve()
        self.directory_digest=digest(str(self.path))
    def tearDown(self):self.temp.cleanup()
    def journal(self,binding=None):return Journal(self.path,self.directory_digest,binding or {'fixed':'test'})
    def op(self):return {'id':'C1','method':'PUT','url':'https://management.azure.com/fixed',
        'deadline':'2026-10-11T12:00:00Z','body':{}}

    def test_same_noncredential_guid_survives_reopen(self):
        with self.journal() as j:value=j.allocate_id('C1')
        with self.journal() as j:self.assertEqual(j.allocate_id('C1'),value)

    def test_unknown_send_intent_cannot_be_repeated_after_restart(self):
        op=self.op()
        with self.journal() as j:j.intent(op,'2026-10-11T11:00:00Z')
        with self.journal() as j:
            with self.assertRaises(Denied):j.intent(op,'2026-10-11T11:01:00Z')

    def test_partial_record_denied_not_truncated(self):
        with self.journal() as j:pass
        p=self.path/'trial-provision.jsonl'
        with p.open('ab') as f:f.write(b'{')
        with self.assertRaises(Denied):self.journal()
        self.assertTrue(p.read_bytes().endswith(b'{'))

    def test_hash_changed_and_binding_changed_denied(self):
        with self.journal() as j:pass
        with self.assertRaises(Denied):self.journal({'fixed':'other'})
        p=self.path/'trial-provision.jsonl';raw=p.read_bytes().replace(b'test',b'evil')
        p.write_bytes(raw)
        with self.assertRaises(Denied):self.journal()

    def test_exclusive_writer(self):
        with self.journal():
            with self.assertRaises((Denied,OSError)):self.journal()

    def test_secret_value_never_enters_file(self):
        with self.journal() as j:
            with self.assertRaises(Denied):j.append('progress',{'secretText':'TOPSECRET'})
        self.assertNotIn(b'TOPSECRET',(self.path/'trial-provision.jsonl').read_bytes())

    def test_plan_is_fixed_not_replaced(self):
        with self.journal() as j:
            j.fix_plan({'resources':1});j.fix_plan({'resources':1})
            with self.assertRaises(Denied):j.fix_plan({'resources':2})

    def test_receipt_progress_preserves_creation_identity(self):
        op=self.op()
        p={'operation_id':'C1','request_digest':digest(op),'object_id':'fixed',
           'state':'pending','terminal':False,'write_terminal':True}
        with self.journal() as j:
            j.intent(op,'2026-10-11T11:00:00Z');j.checkpoint(op,p)
            with self.assertRaises(Denied):j.checkpoint(op,{**p,'object_id':'other'})
            with self.assertRaises(Denied):j.checkpoint(op,{**p,'state':'succeeded','terminal':True})
            done={**p,'state':'succeeded','terminal':True,'readback_verified':True}
            j.checkpoint(op,done);j.checkpoint(op,done)
            with self.assertRaises(Denied):j.checkpoint(op,p)
        with self.journal() as j:self.assertEqual(j.latest('C1'),done)

    def test_response_without_durable_intent_rejected(self):
        op=self.op()
        with self.journal() as j:
            with self.assertRaises(Denied):j.checkpoint(op,{'operation_id':'C1','request_digest':digest(op),'state':'unknown'})

    def test_persistent_shared_budget_does_not_reset_per_phase(self):
        seed={'owner_arm':599,'owner_control_blob':32,'heartbeat_blob':0}
        with ControlBudget(self.path,self.directory_digest,{'trial':'fixed'},seed=seed) as b:
            b.consume('owner_arm',600)
        with ControlBudget(self.path,self.directory_digest,{'trial':'fixed'},seed=seed) as b:
            self.assertEqual(b.count('owner_arm'),600)
            with self.assertRaises(Denied):b.consume('owner_arm',600)
            with self.assertRaises(Denied):b.consume('owner_arm',601)
        with self.assertRaises(Denied):
            ControlBudget(self.path,self.directory_digest,{'trial':'fixed'},seed={**seed,'owner_arm':0})

    def test_wire_failure_consumes_without_refund(self):
        seed={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}
        with ControlBudget(self.path,self.directory_digest,{},seed=seed) as b:
            wire=Mock(side_effect=OSError('unknown'))
            counted=CountedControlHttp(wire,b)
            with self.assertRaises(OSError):counted('GET','https://graph.microsoft.com/v1.0/fixed',{},None,Mock())
            self.assertEqual(b.count('owner_arm'),129)

    def test_bad_host_has_no_budget_or_send(self):
        seed={'owner_arm':0,'owner_control_blob':0,'heartbeat_blob':0}
        with ControlBudget(self.path,self.directory_digest,{},seed=seed) as b:
            wire=Mock();counted=CountedControlHttp(wire,b)
            for url in ('https:/missing','https://graph.microsoft.com.evil/v1.0/x','http://graph.microsoft.com/v1.0/x'):
                with self.assertRaises(Denied):counted('GET',url,{},None,Mock())
            wire.assert_not_called();self.assertEqual(b.count('owner_arm'),0)


if __name__=='__main__':unittest.main()
