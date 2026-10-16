"""Fictional history, real OWNER files/accounting, fake credentials and wire."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a, acknowledged_image_succession as succession
from scripts.trial_provision import unknown_observation as o
from scripts.trial_provision.journal import ControlBudget
from scripts.trial_provision.private_io import create_owner_file
from scripts.trial_provision.tests.test_acknowledged_image_succession import fixture, verify
from scripts.trial_provision.tests.test_attempt import chain
from scripts.trial_provision.tests.test_owner_tokens import Clock
from scripts.trial_provision.tests.test_private_io import create_owner_directory


class UnknownObservationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        with patch.object(Path, 'cwd', return_value=root):
            data = fixture()
        verified = verify(data); new = data['new']; config = new['config']
        self.directory = Path(config['control_budget']['directory'])
        create_owner_directory(self.directory)
        requests = [('fresh_read', 'owner_token')]+[('fresh_read', 'http')]*5+[('publication', 'http')]*6+[('provision', 'http')]*2
        rows = deepcopy(data['counter_rows'])+[('attempt_transition', succession.transition_value(verified))]
        rows += [('request', {'kind': 'owner_arm', 'attempt': verified.binding_digest, 'phase': p, 'purpose': q}) for p, q in requests]
        counter = chain(rows)[0]
        _, binding = a.journal_descriptor(config, verified)
        op = data['identity_operation']; rid = new['manifest']['ids']['webIdentity']
        intent = {'operation_id': 'webIdentity', 'method': 'PUT', 'url': op['url'],
                  'request_digest': 'b'*64}
        receipt = {'operation_id': 'webIdentity', 'request_digest': 'b'*64, 'object_id': rid,
            'state': 'unknown', 'http': 201, 'ack_rejection': 'unsupported_lro_headers',
            'terminal': False, 'write_terminal': False, 'readback_verified': False}
        # The old preparation payload is opaque to this observer. Its immutable
        # SHA, sole UNKNOWN and child binding are checked; no fake bridge PASS.
        child_rows = [('binding', binding)]+[('clock_observation', {'fixture': i}) for i in range(31)]
        child, tail = chain(child_rows+[('intent', intent), ('progress', receipt)])
        authority = encoded(new['authority']); manifest = config['authority_bundle']['manifest']
        stopped = {'status': 'STOPPED_UNKNOWN_MANAGED_IDENTITY_ACK_V6',
            'authority': {'sha256': o.sha(authority)}, 'counter': {'sha256': o.sha(counter)},
            'child': {'sha256': o.sha(child)}, 'counts': {'owner_arm': 316, 'owner_control_blob': 32, 'heartbeat_blob': 0},
            'counter_rows': 197, 'child_rows': 34, 'child_tail': tail,
            'historical_unknowns_preserved': True, 'unknown_receipt_promoted': False,
            'unknown_receipt': receipt, 'new_write_intents': [intent]}
        self.evidence = {'counter': counter, 'child': child, 'authority': authority,
                         'manifest': manifest, 'stopped': encoded(stopped)}
        self.clock = Clock(); self.sources = {'fictional_observer.py': 'a'*64}
        self.g = {'schema': 1, 'kind': o.KIND, 'start': self.clock.utc().isoformat(),
            'end': (self.clock.utc()+timedelta(minutes=10)).isoformat(), 'owner': new['manifest']['owner'],
            'target': {'resource_id': rid, 'url': op['url'], 'request_digest': 'b'*64},
            'source_digests': self.sources, 'evidence_sha256': {k: o.sha(v) for k, v in self.evidence.items()},
            'counter_binding': config['control_budget']['binding'], 'seed': a.SEED,
            'directory': str(self.directory), 'child_binding': binding, 'attempt': verified.binding_digest,
            'counter_rows': 197, 'counts': stopped['counts'], 'maximum': {'http': 1, 'owner_token': 1}}
        self.grant = self.verify()
        for name, raw in (('trial-control-budget', counter), ('trial-provision-successor-v6', child)):
            fd = create_owner_file(self.directory/(name+'.jsonl'))
            with os.fdopen(fd, 'wb') as stream: stream.write(raw)
            os.close(create_owner_file(self.directory/(name+'.lock')))
        owner = self.g['owner']
        self.credential = Mock(mode='owner', principal=owner['principal_id'].lower(), tenant=owner['tenant_id'].lower())
        self.credential.token.return_value = 'fictional-memory-only-token'
        self.wire = Mock(return_value={'status': 404, 'headers': {}, 'body': b'{"error":{"code":"ResourceNotFound"}}'})

    def verify(self):
        raw = encoded(self.g)
        return o.verify_grant(raw, trusted_sha256=o.sha(raw), evidence=self.evidence,
                              source_digests=self.sources, now=self.clock.utc())

    def run_observation(self, grant=None):
        return o.observe_once(grant or self.grant, clock=self.clock, credential=self.credential,
            wire=self.wire, current_sources=lambda: self.sources)

    def counter(self):
        return (self.directory/'trial-control-budget.jsonl').read_bytes()

    def test_current_absence_charges_token_and_get_without_old_receipt_promotion(self):
        events = []
        def token(*_):
            events.append('token'); self.assertEqual(len(self.counter().splitlines()), 198)
            return 'fictional-memory-only-token'
        def wire(*args):
            events.append('get'); self.assertEqual(len(self.counter().splitlines()), 199)
            self.assertEqual(args[:2], ('GET', self.g['target']['url']))
            self.assertIsNone(args[3]); return {'status': 404, 'headers': {}, 'body': b'{"error":{"code":"ResourceNotFound"}}'}
        self.credential.token.side_effect = token; self.wire.side_effect = wire
        result = self.run_observation()
        self.assertEqual(events, ['token', 'get']); self.assertEqual(result['status'], 'current_absent')
        self.assertEqual(result['counts']['owner_arm'], 318); self.assertEqual(result['requests'], 2)
        self.assertFalse(result['adoption_authorized']); self.assertFalse(result['deletion_authorized'])
        self.assertEqual((self.directory/'trial-provision-successor-v6.jsonl').read_bytes(), self.evidence['child'])
        for path in self.directory.iterdir():
            if path.is_file(): self.assertNotIn(b'fictional-memory-only-token', path.read_bytes())

    def test_grant_reissue_cannot_repeat_or_reset_counter(self):
        self.run_observation(); before = self.counter()
        self.g['end'] = (self.clock.utc()+timedelta(minutes=9)).isoformat()
        with self.assertRaises(Denied): self.run_observation(self.verify())
        self.assertEqual(before, self.counter()); self.assertEqual(self.wire.call_count, 1)

    def test_existing_empty_marker_blocks_before_any_debit(self):
        os.close(create_owner_file(self.directory/o.MARKER))
        with self.assertRaises(FileExistsError): self.run_observation()
        self.credential.token.assert_not_called(); self.wire.assert_not_called()
        self.assertEqual(self.counter(), self.evidence['counter'])

    def test_token_failure_is_one_debit_and_no_retry(self):
        self.credential.token.side_effect = Denied('fictional-login-required')
        result = self.run_observation()
        self.assertEqual(result['status'], 'unconfirmed'); self.assertEqual(result['requests'], 1)
        self.assertEqual(result['counts']['owner_arm'], 317); self.wire.assert_not_called()
        with self.assertRaises(Denied): self.run_observation()

    def test_token_timeout_prevents_http(self):
        def acquire(*_): self.clock.advance(61); return 'fictional'
        self.credential.token.side_effect = acquire
        result = self.run_observation()
        self.assertEqual(result['requests'], 1); self.assertEqual(result['status'], 'unconfirmed')
        self.wire.assert_not_called()

    def test_source_change_after_token_prevents_http(self):
        def acquire(*_): self.sources = {'changed': '0'*64}; return 'fictional'
        self.credential.token.side_effect = acquire
        result = self.run_observation()
        self.assertEqual(result['requests'], 1); self.assertEqual(result['status'], 'unconfirmed')
        self.wire.assert_not_called()

    def test_http_debit_fsync_deadline_prevents_send_without_refund(self):
        original = ControlBudget._append
        def append(budget, event, value):
            original(budget, event, value)
            if value.get('purpose') == 'http': self.clock.advance(61)
        with patch.object(ControlBudget, '_append', append): result = self.run_observation()
        self.assertEqual(result['requests'], 2); self.assertEqual(result['status'], 'unconfirmed')
        self.wire.assert_not_called()

    def test_late_http_result_is_not_absence(self):
        def wire(*_): self.clock.advance(61); return {'status': 404, 'headers': {}, 'body': b'{"error":{"code":"ResourceNotFound"}}'}
        self.wire.side_effect = wire
        result = self.run_observation()
        self.assertEqual(result['status'], 'unconfirmed'); self.assertEqual(result['requests'], 2)

    def test_clock_rollback_is_denied_after_token(self):
        def token(*_): self.clock.wall -= timedelta(seconds=1); return 'fictional'
        self.credential.token.side_effect = token
        result = self.run_observation(); self.assertEqual(result['status'], 'unconfirmed')
        self.wire.assert_not_called()

    def test_changed_prefix_or_child_is_denied_before_token(self):
        for name in ('trial-control-budget', 'trial-provision-successor-v6'):
            path = self.directory/(name+'.jsonl'); raw = path.read_bytes(); path.write_bytes(raw+b'{}\n')
            with self.subTest(name=name), self.assertRaises(Denied): self.run_observation()
            path.write_bytes(raw)
        self.credential.token.assert_not_called()

    def test_grant_window_target_limits_and_history_changes_are_denied(self):
        original = deepcopy(self.g)
        for key, value in (('end', (self.clock.utc()+timedelta(minutes=11)).isoformat()),
                ('start', (self.clock.utc()+timedelta(seconds=1)).isoformat()),
                ('counter_rows', 196), ('maximum', {'http': 2, 'owner_token': 1}),
                ('target', {**self.g['target'], 'url': self.g['target']['url']+'&extra=1'}),
                ('counts', {**self.g['counts'], 'owner_arm': 315})):
            self.g = deepcopy(original); self.g[key] = value
            with self.subTest(key=key), self.assertRaises(Denied): self.verify()

    def test_current_exists_requires_exact_id_tenant_and_valid_identity_body(self):
        rid = self.g['target']['resource_id']
        body = {'id': rid, 'name': rid.rsplit('/', 1)[-1],
            'type': 'Microsoft.ManagedIdentity/userAssignedIdentities', 'properties': {
            'principalId': '11111111-1111-4111-8111-111111111111',
            'clientId': '22222222-2222-4222-8222-222222222222', 'tenantId': self.g['owner']['tenant_id']}}
        result = o.classify({'status': 200, 'headers': {}, 'body': encoded(body)}, self.grant)
        self.assertEqual(result['status'], 'current_exists'); self.assertFalse(result['adoption_authorized'])
        for field, value in (('id', rid+'other'), ('error', {}), ('error', {'code': 'failed'})):
            changed = deepcopy(body); changed[field] = value
            with self.subTest(field=field), self.assertRaises(Denied):
                o.classify({'status': 200, 'headers': {}, 'body': encoded(changed)}, self.grant)
        changed = deepcopy(body); changed['properties']['tenantId'] = '33333333-3333-4333-8333-333333333333'
        with self.assertRaises(Denied): o.classify({'status': 200, 'headers': {}, 'body': encoded(changed)}, self.grant)

    def test_non404_and_async_headers_are_never_absence(self):
        for status in (201, 202, 204, 301, 401, 403, 429, 500):
            self.assertEqual(o.classify({'status': status, 'headers': {}, 'body': b'{}'}, self.grant)['status'], 'unconfirmed')
        for name in ('Location', 'Azure-AsyncOperation', 'Operation-Location'):
            with self.subTest(name=name), self.assertRaises(Denied):
                o.classify({'status': 404, 'headers': {name: ''}, 'body': b'{}'}, self.grant)

    def test_404_requires_fixed_arm_resource_not_found_error(self):
        for body in (b'{}', b'<html>404</html>', b'{"error":null}',
                     b'{"error":{"code":"AuthorizationFailed"}}',
                     b'{"error":{"code":"ResourceNotFound"},"other":true}'):
            with self.subTest(body=body), self.assertRaises(Denied):
                o.classify({'status': 404, 'headers': {}, 'body': body}, self.grant)

    def test_scope_refuses_reordering_second_get_and_other_class(self):
        o._save(self.directory/o.MARKER, {'grant_sha256': self.grant.checksum,
            'old_attempt': self.g['attempt'], 'target_digest': o.digest(self.g['target'])})
        with ControlBudget(self.directory, o.digest(str(self.directory)), self.g['counter_binding'],
                           seed=self.g['seed'], require_existing=True) as budget:
            scope = budget.begin_unknown_observation(self.grant, guard=lambda: None)
            with self.assertRaises(Denied): scope.consume('owner_arm', 600)
            with self.assertRaises(Denied): scope.consume('heartbeat_blob', 5250)
            scope.consume_owner_token()
            with self.assertRaises(Denied): scope.consume_owner_token()
            scope.consume('owner_arm', 600)
            with self.assertRaises(Denied): scope.consume('owner_arm', 600)
            with self.assertRaises(Denied): budget.begin_unknown_observation(self.grant, guard=lambda: None)
            self.assertEqual(budget.count('owner_arm'), 318)


if __name__ == '__main__': unittest.main()
