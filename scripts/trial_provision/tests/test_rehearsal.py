"""Offline rehearsal boundaries, using real OwnerSession/BlobJournal code.

AzureCredential is replaced by a fixture; no subprocess or network is used.
All IDs, hosts, image strings and the documentation IP are fictional.
"""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import unittest
from unittest.mock import patch

from scripts.trial_guard.__main__ import FIXED
from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.rehearsal import GuardianRehearsalAdapter, ARM, VERSION
from scripts.trial_provision.resources import build_guard_main_operation


SUB = '11111111-1111-4111-8111-111111111111'
OWNER = '22222222-2222-4222-8222-222222222222'
TENANT = '33333333-3333-4333-8333-333333333333'
PRINCIPAL = '44444444-4444-4444-8444-444444444444'
RG = '/subscriptions/' + SUB + '/resourceGroups/fictional'
JOB = RG + '/providers/Microsoft.App/jobs/fictional-guard'
EXECUTION = JOB + '/executions/fictional-guard-one'
BLOB = 'https://fictional.blob.core.windows.net/journal/rehearsal.json'
IMAGE = 'sha256:' + 'a' * 64


class Clock:
    def __init__(self):
        self.at = datetime(2026, 10, 11, tzinfo=timezone.utc)
        self.seconds = self.offset = 0
    def utc(self): return self.at + timedelta(seconds=self.seconds + self.offset)
    def monotonic(self): return self.seconds
    def iso(self, seconds=0): return (self.at + timedelta(seconds=seconds)).isoformat().replace('+00:00', 'Z')


class Credential:
    mode, principal, tenant = 'owner', OWNER, TENANT
    def __init__(self): self.calls = []
    def token(self, audience, deadline):
        deadline.remaining(); self.calls.append(audience)
        return 'fixture-token-memory-only'


def response(status, body=None, headers=None):
    return {'status': status, 'body': encoded(body) if body is not None else b'', 'headers': headers or {}}


class Wire:
    def __init__(self, clock, create):
        self.clock, self.create = clock, create
        self.state, self.lease, self.template = None, None, None
        self.calls = []
        self.start_response = response(200, {'id': EXECUTION})
        self.job_status, self.job_end = 'Running', 10
        self.modify = None
        self.execution_id = EXECUTION
        self.replica_rows = [{'name': 'fictional-guard-one-replica'}]
        self.next_link = None
    def __call__(self, method, url, headers, body, deadline):
        self.calls.append((method, url, deepcopy(headers), body))
        if self.modify:
            changed = self.modify(method, url, headers, body)
            if changed is not None:
                if isinstance(changed, Exception): raise changed
                return changed
        if url == self.create['url']:
            value = deepcopy(self.create['body'])
            value.update(id=JOB)
            value['identity'].update(principalId=PRINCIPAL, tenantId=TENANT)
            value['properties']['provisioningState'] = 'Succeeded'
            return response(200, value)
        if url == ARM + JOB + '/start?api-version=' + VERSION:
            self.template = json.loads(body)
            if isinstance(self.start_response, Exception): raise self.start_response
            return deepcopy(self.start_response)
        if url == ARM + EXECUTION + '?api-version=' + VERSION:
            props = {'template': self.template, 'startTime': self.clock.iso(), 'status': self.job_status}
            if self.job_status != 'Running': props['endTime'] = self.clock.iso(self.job_end)
            return response(200, {'id': self.execution_id, 'properties': props})
        if url == ARM + EXECUTION + '/replicas?api-version=' + VERSION:
            return response(200, {'value': self.replica_rows, 'nextLink': self.next_link})
        if url == BLOB + '?comp=lease':
            action = headers['x-ms-lease-action']
            if action == 'acquire':
                self.lease = headers['x-ms-proposed-lease-id']
                return response(201, headers={'x-ms-lease-id': self.lease})
            if action == 'release':
                self.lease = None
                return response(200)
            raise AssertionError('unexpected lease action')
        if url == BLOB:
            if method == 'GET':
                if self.state is None: return response(404, headers={'x-ms-error-code': 'BlobNotFound'})
                return response(200, self.state, {'etag': 'fixture-etag',
                    'x-ms-lease-state': 'leased' if self.lease else 'available',
                    'x-ms-lease-status': 'locked' if self.lease else 'unlocked'})
            if method == 'PUT':
                if self.state is not None: return response(412)
                self.state = json.loads(body)
                return response(201, headers={'etag': 'fixture-etag'})
        raise AssertionError('unexpected offline request')
    def finish(self):
        self.clock.seconds = 10
        self.job_status = 'Succeeded'
        self.state['version'] = 1
        self.state['rehearsal'] = {'at': self.clock.iso(5), 'reads_and_cas': True, 'delete_measured': False}


class RehearsalTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.credential = Clock(), Credential()
        template = {'containers': [{'name': 'fictional-guard', 'image': 'fictional.azurecr.io/guardian@' + IMAGE,
            'command': ['python', '-m', 'trial_guard'], 'args': [], 'resources': {'cpu': 0.25, 'memory': '0.5Gi'}, 'env': []}], 'initContainers': []}
        self.create = {'id': 'guard', 'provider': 'Microsoft.App', 'kind': 'jobs', 'method': 'PUT',
            'url': ARM + JOB + '?api-version=' + VERSION, 'deadline': self.clock.iso(300), 'depends_on': [],
            'body': {'location': 'fictional', 'identity': {'type': 'SystemAssigned'},
                'properties': {'environmentId': RG + '/providers/Microsoft.App/managedEnvironments/fictional',
                    'template': template, 'configuration': {'triggerType': 'Manual', 'replicaTimeout': 300,
                        'replicaRetryLimit': 0, 'manualTriggerConfig': {'parallelism': 1, 'replicaCompletionCount': 1}}}},
            'expected': {'resource_id': JOB, 'location': 'fictional', 'properties': {}},
            'cleanup': {'deadline': self.clock.iso(28800)}}
        self.created = {'operation_id': 'guard', 'request_digest': digest(self.create), 'object_id': JOB,
            'state': 'succeeded', 'terminal': True, 'write_terminal': True, 'created_by_run': True,
            'readback_verified': True, 'properties': {'principalId': PRINCIPAL, 'tenantId': TENANT}}
        server = RG + '/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional'
        bind = {'server_id': server, 'rule_id': server + '/firewallRules/fictional-trial', 'ipv4': '192.0.2.1',
            'mode': 'guardian', 'region': 'fictional', 'lifecycle_id': SUB, 'baseline_rules': [], 'baseline_network': {}}
        access = {'approved': True, 'readback_verified': True, 'principal_id': OWNER, 'journal_url': BLOB,
            'starts_at': self.clock.iso(), 'ends_at': self.clock.iso(28800), 'assignment_id': SUB, 'evidence_sha256': 'b' * 64}
        self.owner = {'live_enabled': True, 'cleanup_strategy': 'rehearsal', 'owner_permissions_until': self.clock.iso(28800),
            'owner_id': OWNER, 'tenant_id': TENANT, 'binding': bind, 'owner_access': access,
            'cleanup_targets_digest': digest([]), 'journal_url': BLOB, 'prearm_until': self.clock.iso(300), 'seed_not_before': self.clock.iso()}
        runtime = {'execution_id': JOB + '/executions/$CURRENT', 'replica_name': '$CURRENT', 'image_digest': IMAGE,
            'principal_id': PRINCIPAL, 'nonce': 'fictional-nonce-bound-to-run', 'job_started_at': '$CURRENT', 'job_deadline': '$CURRENT'}
        immutable = {k: None for k in FIXED}
        immutable.update(lifecycle_id=SUB, rule_id=bind['rule_id'], cleanup_strategy='rehearsal', cloud_guard=runtime,
            owner_access=access, cleanup_targets_digest=digest([]))
        immutable.update({k: '$CURRENT' for k in ('prepared_at', 'cleanup_at', 'deadline', 'ready_until')})
        self.guardian = {'live_enabled': True, 'mode': 'rehearsal', 'journal_url': BLOB, 'tenant_id': TENANT,
            'job_name': 'fictional-guard', 'binding': bind, 'immutable': immutable,
            'prearm_until': self.clock.iso(300), 'seed_not_before': self.clock.iso()}
        self.wire = Wire(self.clock, self.create)
        self.intents, self.checkpoints = {}, []
        self.patch = patch('scripts.trial_guard.owner.AzureCredential', return_value=self.credential)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.adapter = self.make()
    def before(self, op):
        if op['id'] in self.intents: raise Denied('duplicate_durable_intent')
        self.intents[op['id']] = digest(op)
    def checkpoint(self, receipt):
        self.assertEqual(self.intents.get(receipt['operation_id']), receipt['request_digest'])
        self.checkpoints.append(deepcopy(receipt))
    def make(self, **kw):
        return GuardianRehearsalAdapter(kw.get('create', self.create), kw.get('created', self.created),
            kw.get('owner', self.owner), kw.get('guardian', self.guardian), self.credential, self.wire, self.clock,
            before_send=kw.get('before_send', self.before), checkpoint=kw.get('checkpoint', self.checkpoint))
    def seed(self):
        _, started = self.adapter.start()
        seedop, seed = self.adapter.initialize(started)
        return started, seedop, seed
    def finish(self):
        started, seedop, seed = self.seed()
        self.wire.finish()
        return self.adapter.verify(started, seedop, seed)
    def test_real_owner_session_completion_builds_main_contract(self):
        operation, receipt = self.finish()
        self.assertTrue(receipt['terminal']); self.assertTrue(receipt['properties']['cleanup_verified'])
        self.assertFalse(receipt['properties']['live_delete_verified']); self.assertIsNotNone(self.wire.state)
        op = build_guard_main_operation(self.create, self.created, operation, receipt, deadline='2026-10-11T01:00:00Z')
        self.assertEqual(op['body']['properties']['configuration']['replicaTimeout'], 1800)
        self.assertEqual(1, sum(c[0] == 'POST' for c in self.wire.calls))
        self.assertFalse(any(c[0] == 'DELETE' or 'firewallRules' in c[1] for c in self.wire.calls))
        self.assertEqual(['guardRehearsalStart', 'guardRehearsalSeed'], list(self.intents))
    def test_1800_seconds_and_other_image_rejected_before_credentials(self):
        create = deepcopy(self.create); create['body']['properties']['configuration']['replicaTimeout'] = 1800
        created = deepcopy(self.created); created['request_digest'] = digest(create)
        with self.assertRaises(Denied): self.make(create=create, created=created)
        guardian = deepcopy(self.guardian); guardian['immutable']['cloud_guard']['image_digest'] = 'sha256:' + 'b' * 64
        with self.assertRaises(Denied): self.make(guardian=guardian)
        self.assertFalse(self.credential.calls)
    def test_config_mode_target_and_runtime_substitution_rejected(self):
        for mutate in (lambda x: x.update(mode='main'), lambda x: x.update(journal_url=BLOB.replace('rehearsal', 'state')),
            lambda x: x['immutable']['cloud_guard'].update(execution_id=EXECUTION),
            lambda x: x['immutable']['cloud_guard'].update(principal_id=OWNER)):
            g = deepcopy(self.guardian); mutate(g)
            with self.assertRaises(Denied): self.make(guardian=g)
        self.assertFalse(self.wire.calls)
    def test_owner_chain_and_expired_grant_rejected(self):
        self.credential.mode = 'guardian'
        with self.assertRaises(Denied): self.make()
        self.credential.mode = 'owner'
        owner = deepcopy(self.owner); owner['owner_access']['approved'] = False
        with self.assertRaises(Denied): self.make(owner=owner)
    def test_existing_or_unknown_seed_prevents_job_start(self):
        self.wire.modify = lambda m,u,h,b: response(403) if u == BLOB else None
        with self.assertRaises(Denied): self.adapter.start()
        self.assertFalse(self.intents); self.assertFalse(any(c[0] == 'POST' for c in self.wire.calls))
    def test_unknown_start_never_adopted_or_resent_after_restart(self):
        self.wire.start_response = TimeoutError('private token must not escape')
        _, unknown = self.adapter.start()
        self.assertFalse(unknown['write_terminal'])
        with self.assertRaises(Denied): self.adapter.initialize(unknown)
        with self.assertRaises(Denied): self.adapter.start()
        self.adapter = self.make(); _, again = self.adapter.start()
        self.assertFalse(again['terminal'])
        self.assertEqual(1, sum(c[0] == 'POST' for c in self.wire.calls))
        self.assertNotIn('private token', json.dumps(self.checkpoints))
    def test_known_202_only_exact_location_poll_no_collection_lookup(self):
        url = ARM + '/subscriptions/' + SUB + '/providers/Microsoft.App/jobs/fictional-guard/operationResults/' + OWNER + '?api-version=' + VERSION
        self.wire.start_response = response(202, headers={'Location': url, 'Retry-After': '1'})
        _, receipt = self.adapter.start()
        with self.assertRaises(Denied): self.adapter.poll_start(receipt)
        self.clock.seconds = 1
        self.wire.modify = lambda m,u,h,b: response(200, {'id': EXECUTION}) if u == url else None
        known = self.adapter.poll_start(receipt)
        self.assertTrue(known['write_terminal']); self.assertEqual(EXECUTION, known['object_id'])
        self.assertFalse(any('/executions?' in c[1] for c in self.wire.calls))
    def test_redirect_and_foreign_lro_never_followed(self):
        for r in (response(307, headers={'Location': 'https://evil.example'}), response(202, headers={'Location': 'https://evil.example'})):
            self.intents = {}; self.adapter = self.make(); self.wire.calls = []; self.wire.start_response = r
            _, result = self.adapter.start()
            self.assertFalse(result['write_terminal'])
            self.assertFalse(any('evil.example' in c[1] for c in self.wire.calls))
    def test_actual_execution_and_replica_must_match_start(self):
        _, started = self.adapter.start(); self.wire.execution_id = EXECUTION + '-foreign'
        with self.assertRaises(Denied): self.adapter.initialize(started)
        self.wire.execution_id = EXECUTION; self.wire.next_link = 'unapproved-next-page'
        with self.assertRaises(Denied): self.adapter.initialize(started)
        self.assertNotIn('guardRehearsalSeed', self.intents)
    def test_unknown_seed_is_not_adopted_from_later_valid_blob(self):
        _, started = self.adapter.start()
        def modify(m,u,h,b):
            if u == BLOB and m == 'PUT':
                self.wire.state = json.loads(b)
                return TimeoutError('uncertain seed')
        self.wire.modify = modify
        op, unknown = self.adapter.initialize(started)
        self.assertFalse(unknown['write_terminal'])
        self.wire.modify = None; self.wire.finish()
        with self.assertRaises(Denied): self.adapter.verify(started, op, unknown)
        with self.assertRaises(Denied): self.adapter.initialize(started)
        self.assertEqual(1, sum(c[0] == 'PUT' and c[1] == BLOB for c in self.wire.calls))
    def test_failed_stopped_running_and_timeout_are_not_success(self):
        started, op, seed = self.seed(); self.wire.finish()
        for status in ('Failed', 'Stopped', 'Running'):
            self.wire.job_status = status
            self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
        self.wire.job_status = 'Succeeded'; self.wire.job_end = 301; self.clock.seconds = 301
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
    def test_missing_cas_wrong_proof_or_firewall_write_cannot_normalize(self):
        started, op, seed = self.seed(); self.wire.finish(); good = deepcopy(self.wire.state)
        for change in ({'version': 0}, {'rehearsal': {}}, {'put': {'unknown': True}}, {'usage_allowed': True},
                       {'rehearsal': {'at': self.clock.iso(5), 'reads_and_cas': True, 'delete_measured': True}}):
            self.wire.state = {**deepcopy(good), **change}
            self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
    def test_release_failure_or_still_leased_blob_cannot_complete(self):
        started, op, seed = self.seed(); self.wire.finish()
        self.wire.modify = lambda m,u,h,b: response(403) if u.endswith('?comp=lease') and h.get('x-ms-lease-action') == 'release' else None
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
        def leased(m,u,h,b):
            if u == BLOB and m == 'GET' and 'x-ms-lease-id' not in h:
                return response(200, self.wire.state, {'etag': 'fixture-etag', 'x-ms-lease-state': 'leased', 'x-ms-lease-status': 'locked'})
        self.wire.modify = leased
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
    def test_state_changed_after_owner_status_cannot_complete(self):
        started, op, seed = self.seed(); self.wire.finish()
        def changed(m,u,h,b):
            if u == BLOB and m == 'GET' and 'x-ms-lease-id' not in h:
                self.wire.state['version'] += 1
        self.wire.modify = changed
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
    def test_seed_intent_delay_past_runtime_sends_no_put(self):
        def before(op):
            self.before(op)
            if op['id'] == 'guardRehearsalSeed': self.clock.seconds = 301
        self.adapter = self.make(before_send=before)
        _, started = self.adapter.start()
        with self.assertRaises(Denied): self.adapter.initialize(started)
        self.assertFalse(any(c[0] == 'PUT' for c in self.wire.calls))
    def test_permission_deadline_and_rollback_never_extend_authority(self):
        started, op, seed = self.seed(); self.wire.finish()
        self.clock.seconds = 28801; self.clock.offset = -30000
        count = len(self.wire.calls)
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
        self.assertEqual(count, len(self.wire.calls))
    def test_durable_seed_checkpoint_failure_does_not_yield_success(self):
        started, op, seed = self.seed(); self.wire.finish()
        def fail(receipt): raise OSError('private journal path')
        self.adapter.checkpoint = fail
        self.assertFalse(self.adapter.verify(started, op, seed)[1]['terminal'])
    def test_every_http_uses_injected_shared_budget_and_no_secret_receipt(self):
        op, receipt = self.finish()
        self.assertGreater(len(self.wire.calls), 8)
        self.assertNotIn('fixture-token-memory-only', json.dumps(self.checkpoints + [receipt]))
        self.assertTrue(all(c[1].startswith(ARM + JOB) or c[1].startswith(BLOB) for c in self.wire.calls))


if __name__ == '__main__': unittest.main()
