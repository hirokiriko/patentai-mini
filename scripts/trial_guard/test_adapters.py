import unittest
from copy import deepcopy
from datetime import timedelta
from .adapters import ArmTransport, BlobJournal, Deadline, Handoff, encoded, digest
from .runner import GuardianRunner, validate_creation_cleanup
from .lifecycle import Conflict, Denied, Controller, initial, parse
from .test_lifecycle import Clock, Journal, Transport

SERVER = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional'
RULE = SERVER + '/firewallRules/trial-only'
RID = '22222222-2222-4222-8222-222222222222'


def response(status=200, body=None, headers=None):
    return {'status': status, 'body': encoded(body) if body is not None else b'', 'headers': headers or {}}


class Credential:
    def token(self, audience, deadline):
        deadline.remaining()
        return 'fictional-memory-only'


class Wire:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def __call__(self, method, url, headers, body, deadline):
        deadline.remaining(); self.calls.append((method, url, headers, body))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.binding = {'server_id': SERVER, 'rule_id': RULE, 'ipv4': '192.0.2.1', 'mode': 'owner',
            'region': 'fictional', 'lifecycle_id': RID, 'baseline_rules': [], 'baseline_network': {'publicNetworkAccess': 'Enabled'}}
        self.op = {'method': 'PUT', 'request_id': RID, 'intent_at': self.clock.utc().isoformat()}
        self.lease_calls = []

    def arm(self, wire, mode='owner'):
        binding = {**self.binding, 'mode': mode}
        return ArmTransport(binding, Credential(), wire, self.clock, lambda t: self.lease_calls.append(t))

    def test_exact_put_body_and_guardian_cannot_put(self):
        wire = Wire(response(201, {'id': RULE, 'properties': {'startIpAddress': '192.0.2.1', 'endIpAddress': '192.0.2.1'}}))
        result = self.arm(wire).send(operation=self.op, rule_id=RULE, timeout=20)
        self.assertEqual(result['terminal'], 'succeeded'); self.assertEqual(len(self.lease_calls), 1)
        self.assertEqual(wire.calls[0][0], 'PUT')
        self.assertIn(b'192.0.2.1', wire.calls[0][3])
        with self.assertRaises(Denied):
            self.arm(wire, 'guardian').send(operation=self.op, rule_id=RULE, timeout=20)
        self.assertEqual(len(wire.calls), 1)

    def test_wrong_child_method_and_empty_put_never_succeed(self):
        wire = Wire(response(200))
        with self.assertRaises(Denied):
            self.arm(wire).send(operation=self.op, rule_id=SERVER, timeout=20)
        self.assertEqual(wire.calls, [])
        self.assertIsNone(self.arm(wire).send(operation=self.op, rule_id=RULE, timeout=20)['terminal'])

    def test_known_lro_requires_explicit_terminal_and_fixed_region(self):
        url = 'https://management.azure.com/subscriptions/11111111-1111-4111-8111-111111111111/providers/Microsoft.DBforPostgreSQL/locations/fictional/azureAsyncOperation/abc?api-version=2024-08-01'
        wire = Wire(response(202, headers={'azure-asyncoperation': url}), response(200), response(404), response(200, {'status': 'Succeeded'}))
        arm = self.arm(wire)
        first = arm.send(operation=self.op, rule_id=RULE, timeout=20)
        op = {**self.op, 'operation_url': first['operation_url'], 'operation_receipt': first['operation_receipt']}
        self.assertIsNone(arm.poll(operation=op, rule_id=RULE, timeout=20)['terminal'])
        self.assertIsNone(arm.poll(operation=op, rule_id=RULE, timeout=20)['terminal'])
        self.assertEqual(arm.poll(operation=op, rule_id=RULE, timeout=20)['terminal'], 'succeeded')
        for bad in (url.replace('fictional/', 'other/'), url.replace('management.azure.com', 'evil.invalid'), url + '&other=x'):
            with self.assertRaises(Denied):
                arm.poll(operation={**op, 'operation_url': bad}, rule_id=RULE, timeout=20)
        self.assertEqual(len(wire.calls), 4)

    def test_unknown_response_never_resends_or_invents_terminal(self):
        wire = Wire(TimeoutError())
        arm = self.arm(wire)
        with self.assertRaises(TimeoutError):
            arm.send(operation=self.op, rule_id=RULE, timeout=20)
        for _ in range(3):
            self.assertIsNone(arm.recover(operation=self.op, rule_id=RULE, timeout=20)['terminal'])
        self.assertEqual(len(wire.calls), 1)

    def test_auth_denied_throttle_server_failure_and_redirect_not_terminal(self):
        for status in (401, 403, 408, 429, 500, 302):
            result = self.arm(Wire(response(status))).send(operation=self.op, rule_id=RULE, timeout=20)
            self.assertIsNone(result['terminal'])
            self.assertEqual(result['http'], status)

    def test_server_busy_is_terminal_failure_only(self):
        result = self.arm(Wire(response(409, {'error': {'code': 'ServerIsBusy'}}))).send(operation={**self.op, 'method': 'DELETE'}, rule_id=RULE, timeout=20)
        self.assertEqual((result['terminal'], result['error_code']), ('failed', 'ServerIsBusy'))

    def test_pending_delete_body_never_becomes_terminal_from_http_success(self):
        url='https://management.azure.com/subscriptions/11111111-1111-4111-8111-111111111111/providers/Microsoft.DBforPostgreSQL/locations/fictional/operationResults/abc?api-version=2024-08-01'
        op={**self.op,'method':'DELETE','operation_url':url,'operation_receipt':{'request_id':RID,'rule_id':RULE,'method':'DELETE','url':url,'kind':'result'}}
        for body in ({'status':'Running'},{'properties':{'provisioningState':'Deleting'}},{'status':'Unknown'},{}, {'status':'Succeeded','properties':{'provisioningState':'Deleting'}}):
            for method in ('send','poll'):
                arm=self.arm(Wire(response(200,body)))
                result=getattr(arm,method)(operation=op,rule_id=RULE,timeout=20)
                self.assertIsNone(result['terminal'])
        for body,terminal in (({'status':'Failed'},'failed'),({'properties':{'provisioningState':'Canceled'}},'canceled')):
            self.assertEqual(self.arm(Wire(response(200,body))).poll(operation=op,rule_id=RULE,timeout=20)['terminal'],terminal)
        self.assertEqual(self.arm(Wire(response(204))).poll(operation=op,rule_id=RULE,timeout=20)['terminal'],'succeeded')

    def test_partial_listing_changed_network_or_foreign_ip_blocks_cleanup_proof(self):
        for page, network, exact in (
            ({'value': [], 'nextLink': 'untrusted'}, self.binding['baseline_network'], response(404)),
            ({'value': []}, {}, response(404)),
            ({'value': []}, self.binding['baseline_network'], response(200, {'id': RULE, 'properties': {'startIpAddress': '192.0.2.2'}}))):
            wire = Wire(response(200, {'id':SERVER,'properties': {'state': 'Ready', 'network': network}}), exact, response(200, page))
            r = self.arm(wire).inspect(rule_id=RULE, lifecycle_id=RID, timeout=20)
            self.assertFalse(r['complete_list'] and r['network_unchanged'] and r['rule'] == 'absent')

    def test_token_delay_consumes_shared_deadline_and_does_not_send(self):
        class Slow:
            def token(_, audience, deadline):
                self.clock.advance(21); return 'fictional'
        wire = Wire(); arm = self.arm(wire); arm.credential = Slow()
        with self.assertRaises(TimeoutError):
            arm.send(operation=self.op, rule_id=RULE, timeout=20)
        self.assertEqual(wire.calls, [])

    def test_sent_put_with_invalid_lro_is_unknown_not_a_local_rejection(self):
        wire = Wire(response(202, headers={'location':'https://evil.invalid/result'}))
        with self.assertRaises(OSError):
            self.arm(wire).send(operation=self.op,rule_id=RULE,timeout=20)
        self.assertEqual(len(wire.calls),1)

    def test_location_result_and_immutable_receipt(self):
        url='https://management.azure.com/subscriptions/11111111-1111-4111-8111-111111111111/providers/Microsoft.DBforPostgreSQL/locations/fictional/operationResults/abc?api-version=2024-08-01'
        arm=self.arm(Wire(response(202,headers={'location':url}),response(204)))
        op={**self.op,'method':'DELETE'}; first=arm.send(operation=op,rule_id=RULE,timeout=20)
        op.update(operation_url=first['operation_url'],operation_receipt=first['operation_receipt'])
        self.assertEqual(arm.poll(operation=op,rule_id=RULE,timeout=20)['terminal'],'succeeded')
        op['operation_receipt']={**op['operation_receipt'],'request_id':'other'}
        with self.assertRaises(OSError):arm.poll(operation=op,rule_id=RULE,timeout=20)

    def test_absent_value_wrong_server_duplicate_and_mismatched_list_are_not_complete(self):
        owned={'id':RULE,'properties':{'startIpAddress':'192.0.2.1','endIpAddress':'192.0.2.1'}}
        cases=[(SERVER,{},response(404)),('wrong',{'value':[]},response(404)),
            (SERVER,{'value':[owned,owned]},response(200,owned)),
            (SERVER,{'value':[{**owned,'properties':{'startIpAddress':'192.0.2.2','endIpAddress':'192.0.2.2'}}]},response(200,owned))]
        for server,page,exact in cases:
            wire=Wire(response(200,{'id':server,'properties':{'state':'Ready','network':self.binding['baseline_network']}}),exact,response(200,page))
            self.assertFalse(self.arm(wire).inspect(rule_id=RULE,lifecycle_id=RID,timeout=20)['complete_list'])


class JournalTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.state = {'version': 0, 'binding_digest': 'fictional'}

    def journal(self, wire):
        return BlobJournal('https://fictional.blob.core.windows.net/guard/state.json', 'fictional', Credential(), wire, self.clock,immutable={'binding_digest':'fictional'})

    def test_lease_conflict_and_missing_etag_fail_closed(self):
        j = self.journal(Wire(response(409)))
        with self.assertRaises(Conflict):
            with j.locked():
                self.fail('not entered')
        j.lease = RID
        j.http = Wire(response(200, self.state))
        with self.assertRaises(Conflict):
            j.load()

    def test_cas_version_binding_and_unknown_save_readback(self):
        candidate = {**self.state, 'version': 1, 'put': {'request_id': RID}}
        wire = Wire(TimeoutError(), response(200, candidate, {'etag': 'new'}))
        j = self.journal(wire); j.lease = RID; j.etag = 'old'; j.state = self.state; j.lease_until = self.clock.monotonic() + 50
        j.save(candidate, expected_version=0)
        self.assertEqual(j.state, candidate)
        self.assertEqual(wire.calls[0][2]['If-Match'], 'old')
        self.assertEqual(wire.calls[0][2]['x-ms-lease-id'], RID)
        with self.assertRaises(Conflict):
            j.save({**candidate, 'version': 2, 'binding_digest': 'other'}, expected_version=1)

    def test_unknown_save_mismatch_or_denied_is_not_committed(self):
        for first in (TimeoutError(), response(403)):
            j = self.journal(Wire(first, response(200, self.state, {'etag': 'old'})))
            j.lease = RID; j.etag = 'old'; j.state = self.state; j.lease_until = self.clock.monotonic() + 50
            with self.assertRaises(Conflict):
                j.save({**self.state, 'version': 1}, expected_version=0)

    def test_lease_margin_and_renewal_denial_prevent_arm(self):
        j = self.journal(Wire(response(412))); j.lease = RID; j.lease_until = self.clock.monotonic() + 50
        with self.assertRaises(Denied):
            j.assert_send_lease(20)

    def test_same_digest_cannot_hide_mutated_fixed_fields(self):
        j=self.journal(Wire());j.immutable={'rule_id':RULE,'deadline':'fixed'}
        j.lease=RID;j.etag='old';j.state={**self.state,'rule_id':RULE,'deadline':'fixed'};j.lease_until=self.clock.monotonic()+50
        with self.assertRaises(Conflict):j.save({**j.state,'version':1,'deadline':'extended'},expected_version=0)
        j.http=Wire(response(200,{**j.state,'rule_id':SERVER},{'etag':'x'}))
        with self.assertRaises(Conflict):j.load()
        j.lease_until = self.clock.monotonic() + 10
        with self.assertRaises(Denied):
            j.assert_send_lease(20)


class HandoffTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.state = initial(at=self.clock.utc().isoformat(), rule_id=RULE, lifecycle_id=RID, guardian_pid=1, independent_guard_verified=True)
        self.state.update(writer_actor='sender', successor_id='receiver', successor_nonce='fixed', cloud_guard={'job_deadline': (self.clock.utc()+timedelta(minutes=30)).isoformat()})
        self.journal = Journal(self.state)

    def test_offer_keeps_sender_and_claim_fences_sender(self):
        h = Handoff(self.journal, self.clock, 'sender'); h.request()
        self.assertFalse(h.accepted())
        self.assertEqual(self.journal.load()['writer_actor'], 'sender')
        class Crashed:
            actor_id='receiver'
            def tick(_):raise OSError('simulated_crash')
        with self.assertRaises(OSError):Handoff(self.journal,self.clock,'receiver').accept(Crashed())
        c = Controller(self.journal, None, self.clock, lambda: {}, actor_id='sender')
        with self.assertRaises(Denied):
            c.tick()
        self.clock.advance(31);self.assertTrue(h.reclaim_stale_claim())
        self.assertEqual(self.journal.load()['writer_actor'],'sender')

    def test_actual_receiver_step_required_and_stale_receipt_rejected(self):
        sender = Handoff(self.journal, self.clock, 'sender'); sender.request()
        class Receiver:
            actor_id = 'receiver'
            def tick(_):
                with self.journal.locked():
                    s = self.journal.load(); s.update(version=s['version']+1,tick_count=s['tick_count']+1)
                    self.journal.save(s, expected_version=s['version']-1)
                return s
        Handoff(self.journal, self.clock, 'receiver').accept(Receiver())
        self.assertTrue(sender.accepted()); self.clock.advance(16); self.assertFalse(sender.accepted())

    def test_delayed_receiver_ack_cannot_steal_a_reclaimed_writer(self):
        sender = Handoff(self.journal, self.clock, 'sender'); sender.request()
        class Receiver:
            actor_id = 'receiver'
            def tick(_):
                with self.journal.locked():
                    s=self.journal.load();s.update(version=s['version']+1,tick_count=s['tick_count']+1)
                    self.journal.save(s,expected_version=s['version']-1)
                self.clock.advance(31);self.assertTrue(sender.reclaim_stale_claim())
                return s
        with self.assertRaises(Conflict):Handoff(self.journal,self.clock,'receiver').accept(Receiver())
        self.assertFalse(sender.accepted());self.assertEqual(self.journal.load()['writer_actor'],'sender')

    def test_runner_refuses_owner_pc_dependent_successor_and_timeout_is_not_closed(self):
        runner = GuardianRunner(None, self.journal, self.clock, 'sender', lambda: {'independent_of_owner_pc': False})
        with self.assertRaises(Denied):
            runner.opening_gate()
        self.clock.advance(1801); result = runner.step()
        self.assertFalse(result['closed']); self.assertFalse(result['exit']); self.assertTrue(result['deadline_exceeded'])

    def test_cleanup_rejects_trial_objects_and_referenced_roles(self):
        closed = {'status': 'closed', 'rule_absent': True, 'cleanup_responsibility_retained': False}
        for item in ({'id':'x','kind':'job','purpose':'trial','created_by_this_run':True}, {'id':'x','kind':'roleDefinition','purpose':'guardian','created_by_this_run':True,'remaining_references':1}):
            with self.assertRaises(Denied):
                validate_creation_cleanup({'created':[item]},closed)

    def test_cleanup_requires_exact_manifest_receipt_and_explicit_zero_references(self):
        fixed={'id':'fictional-guard-role','kind':'roleDefinition','purpose':'guardian'}
        closed={'status':'closed','rule_absent':True,'cleanup_responsibility_retained':False,'cleanup_targets_digest':digest([fixed])}
        entry={**fixed,'created_by_this_run':True,'creation_receipt':{'resource_id':fixed['id'],'terminal':'succeeded','request_id':RID}}
        manifest={'approved':[fixed],'created':[entry]}
        with self.assertRaises(Denied):validate_creation_cleanup(manifest,closed)
        entry['remaining_references']=0;self.assertEqual(validate_creation_cleanup(manifest,closed)[0]['id'],fixed['id'])
        entry['id']='other'
        with self.assertRaises(Denied):validate_creation_cleanup(manifest,closed)

    def test_receiver_denied_cannot_ack_and_receiver_runner_continues_recovery(self):
        sender=Handoff(self.journal,self.clock,'sender');sender.request()
        class Receiver:
            actor_id='receiver'
            def tick(_):
                with self.journal.locked():
                    s=self.journal.load();s.update(version=s['version']+1,tick_count=s['tick_count']+1,blocked='authorization_denied')
                    self.journal.save(s,expected_version=s['version']-1)
                return s
        with self.assertRaises(Conflict):Handoff(self.journal,self.clock,'receiver').accept(Receiver())
        self.assertFalse(sender.accepted())
        class Continuing:
            def tick(_):return {'status':'cleanup_pending'}
        r=GuardianRunner(Continuing(),self.journal,self.clock,'receiver',lambda:{})
        self.assertEqual(r.step()['status'],'cleanup_pending')


if __name__ == '__main__':
    unittest.main()
