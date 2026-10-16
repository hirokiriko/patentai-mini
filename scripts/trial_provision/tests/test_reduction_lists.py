"""Actual compiler/CLI receipts and counted transport, fictional external I/O."""
from collections import Counter
from copy import deepcopy
import json
import unittest
from unittest.mock import Mock
from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import reduction_lists as target
from scripts.trial_provision.journal import ControlBudget, CountedControlHttp, scope_for_dispatch
from scripts.trial_provision.tests.test_workflow_v8 import WorkflowV8Tests
from scripts.trial_provision.tests.test_workflow_contract import Credential, response


class FixedListTests(unittest.TestCase):
    def setUp(self):
        harness = self.harness = WorkflowV8Tests('runTest')
        harness.setUp(); self.addCleanup(harness.doCleanups)
        self.credential_class = harness.timed_credential()
        self.h = h = harness.h
        for slot in target.CARRIED:
            self.assertEqual(h.f.run_action('create', operation_id=slot)['status'], 'succeeded')
        resolver, receipts = h.snapshot()
        self.facts = {s: (resolver.resolve(s, receipts), receipts[s]) for s in target.CARRIED}
        self.specs = target.carry_specifications(h.manifest, self.facts)
        self.calls = []; self.change = None
        self.pages = {}
        for spec in self.specs:
            rows = []
            if spec['kind']=='pim':
                self.pages[spec['url']]={'value':[]};continue
            for slot, item in spec['owned'].items():
                row = deepcopy(h.arm.objects[item['receipt']['object_id']])
                row.update(name=row['id'].rsplit('/', 1)[1], type=spec['resource_type'])
                rows.append(row)
            self.pages[spec['url']] = {'value': rows}

    def wire(self, method, url, headers, body, deadline):
        self.assertEqual(method, 'GET'); self.assertIsNone(body)
        deadline.remaining(); self.calls.append(url)
        value = deepcopy(self.pages[url])
        if self.change: self.change(value)
        return response(200, value)

    def collect(self, expected_cost=5):
        h = self.h; b = h.config['control_budget']; resolver, receipts = h.snapshot()
        with ControlBudget(b['directory'], b['directory_digest'], b['binding'], seed=b['seed'], require_existing=True) as budget:
            scope = scope_for_dispatch(budget, h.verified, entry_point='provision', action='create',
                                       operation=resolver.resolve('guard', receipts))
            counted = CountedControlHttp(self.wire, scope)
            credential = h.pool.bind(self.credential_class('owner', h.manifest['owner']['principal_id'], h.manifest['owner']['tenant_id']), scope, h.verified)
            before = budget.count('owner_arm')
            record = target.collect_carry(h.manifest, self.facts, counted, credential, h.clock, lambda: None)
            self.assertEqual(budget.count('owner_arm') - before, expected_cost)
        return record

    def test_real_receipts_five_counted_reads_saved_and_reloaded(self):
        before = deepcopy(self.h.snapshot()[1]); record = self.collect()
        self.assertEqual(len(self.calls), 5)
        self.assertEqual(self.h.snapshot()[1], before)
        self.assertEqual(target.validate_carry(record, self.h.manifest, self.facts, self.h.clock.utc()), digest(record))
        ref = self.h.f.write('fictional-carried-observation.json', record)
        from pathlib import Path
        reloaded = json.loads(Path(ref['path']).read_bytes())
        self.assertEqual(target.validate_carry(reloaded, self.h.manifest, self.facts, self.h.clock.utc()), digest(record))
        # The complete List is observation only; no success receipt is synthesized.
        self.assertEqual(set(reloaded['pages'][2]['readbacks']), set(target.MI))
        self.assertEqual(set(self.h.snapshot()[1]), set(before))

    def test_missing_duplicate_paged_error_and_foreign_scope_rejected_without_second_get(self):
        variants = [
            lambda v: v['value'].pop(),
            lambda v: v['value'].append(deepcopy(v['value'][0])),
            lambda v: v.update(nextLink='https://management.azure.com/forbidden'),
            lambda v: v.update(nextLink=''),
            lambda v: v.update(error={'code': 'Unclassified'}),
            lambda v: v['value'][0].update(id='/subscriptions/foreign/providers/Microsoft.ManagedIdentity/userAssignedIdentities/wrong'),
        ]
        for mutate in variants:
            spec = self.specs[2]; value = deepcopy(self.pages[spec['url']]); mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(Denied):
                target.checked_page(spec, encoded(value))

    def test_changed_mi_principal_container_public_access_and_role_permission_rejected(self):
        changes = [
            (0, lambda row: row['properties'].update(principalId='11111111-1111-4111-8111-111111111111')),
            (1, lambda row: row['properties'].update(publicAccess='Blob')),
            (1, lambda row: row['properties'].update(deleted=True)),
            (2, lambda row: row['properties']['permissions'][0]['actions'].append('*')),
            (2, lambda row: row['properties'].update(assignableScopes=['/'])),
        ]
        for index, mutate in changes:
            spec = self.specs[index+2]; value = deepcopy(self.pages[spec['url']]); mutate(value['value'][0])
            with self.subTest(index=index), self.assertRaises(Denied):
                target.checked_page(spec, encoded(value))

    def test_saved_semantic_tamper_fails_even_with_recomputed_outer_digest(self):
        record = self.collect(); bad = deepcopy(record)
        page = bad['pages'][2]; value = json.loads(page['response_raw'])
        value['value'][0]['properties']['clientId'] = '11111111-1111-4111-8111-111111111111'
        raw = encoded(value); page['response_raw'] = raw.decode()
        page['request']['body_sha256'] = target._sha(raw)
        with self.assertRaises(Denied):
            target.validate_carry(bad, self.h.manifest, self.facts, self.h.clock.utc())

    def test_freshness_and_wrong_ai_scope(self):
        record = self.collect(); self.h.clock.advance(600)
        with self.assertRaises(Denied):
            target.validate_carry(record, self.h.manifest, self.facts, self.h.clock.utc())
        manifest = deepcopy(self.h.manifest)
        manifest['existing']['ai'] = manifest['existing']['ai'].replace('/resourceGroups/', '/resourceGroups/other-')
        with self.assertRaises(Denied):
            target.carry_specifications(manifest, self.facts)

    def test_control_headers_do_not_trigger_poll_or_fallback(self):
        for header in ('Location', 'Operation-Location'):
            self.wire = Mock(return_value=response(200, {'value': []}, {header: 'https://management.azure.com/unknown'}))
            with self.assertRaises(Denied): self.collect()
            self.assertEqual(self.wire.call_count, 1)

    def test_pim_error_incomplete_and_owned_reference_stop_before_resource_reads(self):
        spec=self.specs[0];rid=next(iter(spec['owned'].values()))['receipt']['object_id']
        rows=[response(400,{'error':{'code':'AadPremiumLicenseRequired'}}),
              response(200,{'value':[],'nextLink':''}),
              response(200,{'value':[{'id':'fictional-entry','properties':{'roleDefinitionId':rid.upper()}}]}),
              response(200,{'value':[{'id':'fictional-entry','properties':{}}]})]
        before=deepcopy(self.h.snapshot()[1])
        for result in rows:
            self.wire=Mock(return_value=result)
            with self.assertRaises(Denied):self.collect()
            self.assertEqual(self.wire.call_count,1)
        self.assertEqual(before,self.h.snapshot()[1])

    def test_network_absence_uses_complete_parent_list_and_keeps_baseline(self):
        server = self.h.manifest['existing']['db']
        approved = {'server_id': server, 'rule_id': server + '/firewallRules/trial-fixed', 'rules': []}
        raw = encoded({'value': []})
        request = {'purpose': 'fresh', 'url_sha256': target._sha((target.ARM + server + '/firewallRules?api-version=2024-08-01').encode()),
                   'http': 200, 'body_sha256': target._sha(raw)}
        proof = target.network_proof(raw, request, approved)
        self.assertEqual(target.validate_network(proof, approved), [])
        for value in ({'value': [], 'nextLink': ''}, {'value': [], 'error': {'code': 'x'}},
                      {'value': [{'id': approved['rule_id'], 'name': 'trial-fixed',
                       'type': 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules',
                       'properties': {'startIpAddress': '8.8.8.8', 'endIpAddress': '8.8.8.8'}}]}):
            with self.assertRaises(Denied): target.checked_network_list(encoded(value), approved)


    def test_expired_tokens_count_refresh_and_stop_before_third_provision_acquisition(self):
        self.h.clock.advance(3600)
        self.collect(expected_cost=6)
        before = len(self.calls)
        self.h.clock.advance(3600)
        with self.assertRaises(Denied): self.collect()
        self.assertEqual(len(self.calls), before)

    def test_six_assignments_share_one_complete_page_and_guard_extras_still_stop(self):
        h = self.h
        for slot in ('guard', *target.ASSIGNMENTS):
            self.assertEqual(h.f.run_action('create', operation_id=slot)['status'], 'succeeded')
        resolver, receipts = h.snapshot()
        facts = {s: (resolver.resolve(s, receipts), receipts[s]) for s in ('guard', *target.ASSIGNMENTS)}
        spec = target.assignment_specification(h.manifest, facts); rows = []
        for slot, item in spec['owned'].items():
            row = deepcopy(h.arm.objects[item['receipt']['object_id']])
            scope, name = row['id'].rsplit('/providers/Microsoft.Authorization/roleAssignments/', 1)
            row.update(name=name, type=spec['resource_type']); row['properties']['scope'] = scope; rows.append(row)
        page = {'value': rows}
        self.assertEqual(set(target.checked_page(spec, encoded(page))), set(target.ASSIGNMENTS))
        extra = deepcopy(rows[0]); extra['name'] = '99999999-9999-4999-8999-999999999999'
        extra['id'] = extra['id'].rsplit('/', 1)[0] + '/' + extra['name']
        page['value'].append(extra)
        with self.assertRaises(Denied): target.checked_page(spec, encoded(page))
        extra['properties']['principalId'] = extra['properties']['principalId'].upper()
        with self.assertRaises(Denied): target.checked_page(spec, encoded(page))
        changed = {'value': deepcopy(rows)}
        changed['value'][-1]['properties']['condition'] = 'true'
        with self.assertRaises(Denied): target.checked_page(spec, encoded(changed))

if __name__ == '__main__':
    unittest.main()
