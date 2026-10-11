"""Offline fixed-scope registry CLI integration. No live authentication or HTTP."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.registry_cli import run_registry_cleanup, ARM, VERSION, IDENT, PUSH, MAX_PAGES
from scripts.trial_provision.tests import test_operations as operations_fixture
from scripts.trial_provision.tests import test_registry as registry_fixture
from scripts.trial_provision.tests.test_rehearsal_cli import MemoryJournal, Budget


class Wire(registry_fixture.Wire):
    def __init__(self, clock, binding):
        super().__init__(clock, binding)
        self.arm, self.arm_delay = {}, 0
    def __call__(self, method, url, headers, body, deadline):
        if url.startswith(ARM + '/'):
            self.calls.append((method, url, headers, body))
            self.clock.seconds += self.arm_delay
            if self.modify:
                changed = self.modify(method, url)
                if changed is not None:
                    if isinstance(changed, Exception): raise changed
                    return changed
            if method != 'GET': raise AssertionError('inventory is read only')
            return deepcopy(self.arm.get(url, self.response(404, body=encoded({'error': {'code': 'ResourceNotFound'}}))))
        return super().__call__(method, url, headers, body, deadline)


class RegistryCliTests(unittest.TestCase):
    def setUp(self):
        core = operations_fixture.core_fixture()
        core[0].update(cleanupImageTag='fictional-guardian', imageTag='fictional-runtime')
        with patch.object(operations_fixture, 'core_fixture', return_value=core):
            self.args = operations_fixture.fixture()
        self.resolver = operations_fixture.create_resolver(*self.args)
        _, self.manifest, _, self.resources = self.args
        self.clock = registry_fixture.Clock()
        self.clock.start = datetime(2026, 10, 11, 1, tzinfo=timezone.utc)
        self.clock.seconds = 2
        self.journal, self.budget = MemoryJournal(), Budget()
        self.journal.append('binding', {'task_id': 'fictional-task', 'owner': self.manifest['owner']['principal_id']})
        self.ids = [self.manifest['ids'][k] for k in ('app', 'job', 'guard')]
        self.binding = {'registry_id': self.manifest['registry']['id'],
            'login_server': self.manifest['registry']['loginServer'], 'repository': self.manifest['cleanupImageRepository'],
            'tenant_id': self.manifest['owner']['tenant_id'], 'authorized_resource_ids': self.ids,
            'exclusivity_evidence_digest': 'a' * 64}
        self.image_digest = self.resources['guardian_image'].split('@')[1]
        self.url = ('https://' + self.binding['login_server'] + '/v2/' + self.binding['repository']
            + '/manifests/' + self.image_digest + '?api-version=2021-07-01')
        self.preparation = {'schema': 1, 'configuration_sha256': '9' * 64,
            'manifest_sha256': self.resolver.initial_plan['source_sha256']['manifest'],
            'source_sha256': self.resolver.initial_plan['source_sha256'], 'code_sha': self.resources['code_sha'],
            'run_binding_digest': digest(self.journal.values('binding')[0]),
            **{k: self.binding[k] for k in ('registry_id', 'login_server', 'tenant_id')},
            'owner_id': self.manifest['owner']['principal_id'], 'publish_until': self.resolver.initial_plan['windows']['owner_input']['end'],
            'slots': {slot: {'repository': self.manifest['cleanupImageRepository' if slot == 'guardian' else 'imageRepository'],
                'tag': self.manifest['cleanupImageTag' if slot == 'guardian' else 'imageTag'],
                'local_image_id': 'sha256:' + '6' * 64, 'docker_sha256': '7' * 64, 'docker_path_sha256': '8' * 64,
                'docker_host': 'npipe:////./pipe/dockerDesktopLinuxEngine', 'build_receipt_sha256': '4' * 64}
                for slot in ('guardian', 'runtime')}}
        self.journal.append('publication_preparation', self.preparation)
        self.tag_url = ('https://' + self.binding['login_server'] + '/v2/' + self.binding['repository']
            + '/manifests/' + self.manifest['cleanupImageTag'] + '?api-version=2021-07-01')
        self.pushop = {'id': PUSH, 'provider': 'AzureContainerRegistry', 'kind': 'manifest', 'method': 'PUT',
            'url': self.tag_url, 'body': None, 'deadline': self.preparation['publish_until'], 'depends_on': [],
            'expected': {'manifest_digest': self.image_digest}, 'cleanup': {'created_only': True}}
        self.push = {'operation_id': PUSH, 'request_digest': digest(self.pushop), 'object_id': self.url,
            'state': 'succeeded', 'terminal': True, 'write_terminal': True, 'created_by_run': True, 'readback_verified': True,
            'observed_at': self.iso(1), 'properties': {k: self.binding[k] for k in ('registry_id', 'login_server', 'repository')}}
        self.push['properties'].update(manifest_digest=self.image_digest, purpose='guardian')
        self.namespace = {'publication_preparation_digest': digest(self.preparation),
            'run_binding_digest': digest(self.journal.values('binding')[0]),
            **{k: self.binding[k] for k in ('registry_id', 'login_server', 'repository')},
            'method': 'GET', 'url': 'https://' + self.binding['login_server'] + '/acr/v1/' + self.binding['repository'] + '?api-version=2021-07-01',
            'http': 404, 'error_code': 'NAME_UNKNOWN', 'authenticated': True, 'response_sha256': 'e' * 64,
            'observed_at': self.iso(-1), 'push_operation_id': PUSH, 'push_request_digest': digest(self.pushop)}
        self.journal.append('guardian_image_namespace', self.namespace)
        self.journal.intent(self.pushop, self.iso(0)); self.journal.checkpoint(self.pushop, self.push)
        runtime_repository = self.manifest['imageRepository']
        runtime_base = 'https://' + self.binding['login_server'] + '/v2/' + runtime_repository + '/manifests/'
        runtime_digest = self.resources['runtime_image'].split('@')[1]
        runtime_op = {**deepcopy(self.pushop), 'id': 'runtimeImagePush',
            'url': runtime_base + self.manifest['imageTag'] + '?api-version=2021-07-01'}
        runtime_receipt = {**deepcopy(self.push), 'operation_id': 'runtimeImagePush', 'request_digest': digest(runtime_op),
            'object_id': runtime_base + runtime_digest + '?api-version=2021-07-01',
            'properties': {**self.push['properties'], 'repository': runtime_repository, 'manifest_digest': runtime_digest, 'purpose': 'runtime'}}
        self.journal.intent(runtime_op, self.iso(0)); self.journal.checkpoint(runtime_op, runtime_receipt)
        self.journal.append('publication_import', {'schema': 1, 'initial_plan_digest': self.resolver.plan_digest,
            'publication_preparation_digest': digest(self.preparation), 'run_binding_digest': self.preparation['run_binding_digest'],
            'push_receipt_digests': {'guardian': digest(self.push), 'runtime': digest(runtime_receipt)}})
        self.scope = {'schema': 1, 'initial_plan_digest': self.resolver.plan_digest,
            'run_binding_digest': self.namespace['run_binding_digest'], 'authorized_resource_ids': self.ids,
            'namespace_receipt_digest': digest(self.namespace)}
        self.binding['exclusivity_evidence_digest'] = digest(self.scope)
        self.bundle = {'binding': self.binding, 'push_receipt': self.push, 'scope_proof': self.scope}
        self.credential = registry_fixture.Credential(self.clock)
        self.credential.principal = self.manifest['owner']['principal_id']
        self.credential.tenant = self.manifest['owner']['tenant_id']
        self.wire = Wire(self.clock, self.binding)
        self.wire.digest = self.image_digest

    def iso(self, second): return (self.clock.start + timedelta(seconds=second)).isoformat()
    def run_cleanup(self, bundle=None):
        return run_registry_cleanup(bundle or self.bundle, self.manifest, self.resources, self.journal,
            self.resolver, self.credential, self.wire, self.budget, self.clock)
    def present(self, rid, image='other.example/runtime@sha256:' + 'c' * 64, init=None):
        template = {'containers': [{'image': image}], 'initContainers': [] if init is None else [{'image': init}]}
        self.wire.arm[ARM + rid + '?api-version=' + VERSION] = Wire.response(200,
            body=encoded({'id': rid, 'properties': {'provisioningState': 'Succeeded', 'template': template}}))
        child = rid + ('/revisions' if '/containerApps/' in rid else '/executions')
        self.wire.arm[ARM + child + '?api-version=' + VERSION] = Wire.response(200, body=encoded({'value': []}))
        return child
    def child(self, rid, name='one', image='other.example/runtime:stable', init=None):
        return {'name': rid.rsplit('/', 1)[1] + '-' + name,
            'properties': {'template': {'containers': [{'image': image}], 'initContainers': [] if init is None else [{'image': init}]}}}
    def assert_no_delete(self): self.assertFalse(any(m == 'DELETE' for m, *_ in self.wire.calls))

    def test_initial_cleanup_and_restart_exact_head_absence_complete(self):
        result = self.run_cleanup()
        self.assertEqual('pending', result['status']); self.assertFalse(result['cleanup_verified'])
        self.assertEqual(7, len(self.wire.calls))
        self.wire.head = [404]
        result = self.run_cleanup()
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(1, sum(m == 'DELETE' for m, *_ in self.wire.calls))
        self.assertEqual(len(self.wire.calls), len(self.budget.calls))
        count = len(self.wire.calls)
        self.assertEqual(result, self.run_cleanup()); self.assertEqual(count, len(self.wire.calls))
        self.assertNotIn(self.url, json.dumps(result))

    def test_present_parents_include_current_template_all_revisions_and_executions(self):
        for rid in self.ids:
            child = self.present(rid)
            self.wire.arm[ARM + child + '?api-version=' + VERSION] = Wire.response(200, body=encoded({'value': [self.child(rid)]}))
        self.assertEqual('pending', self.run_cleanup()['status'])
        self.assertEqual(6, sum(url.startswith(ARM) for _, url, *_ in self.wire.calls))

    def test_target_image_in_parent_init_or_inactive_revision_or_execution_holds(self):
        for location in ('parent', 'init', 'revision', 'execution'):
            with self.subTest(location=location):
                self.wire.calls.clear(); self.wire.arm.clear()
                if location in ('parent', 'init'):
                    self.present(self.ids[0], **({'image': self.resources['guardian_image']} if location == 'parent' else {'init': self.resources['guardian_image']}))
                else:
                    rid = self.ids[0 if location == 'revision' else 1]
                    child = self.present(rid)
                    row = self.child(rid, init=self.resources['guardian_image']); row['properties']['active'] = False
                    self.wire.arm[ARM + child + '?api-version=' + VERSION] = Wire.response(200, body=encoded({'value': [row]}))
                with self.assertRaises(Denied): self.run_cleanup()
                self.assert_no_delete()

    def test_unknown_tag_reference_cannot_be_proven_different(self):
        self.present(self.ids[0], image=self.binding['login_server'] + '/' + self.binding['repository'] + ':latest')
        with self.assertRaises(Denied): self.run_cleanup()
        self.assert_no_delete()

    def test_complete_same_path_pagination_is_read_without_filter(self):
        rid = self.ids[0]; child = self.present(rid)
        first = ARM + child + '?api-version=' + VERSION
        second = first + '&$skipToken=fictional%3D'
        self.wire.arm[first] = Wire.response(200, body=encoded({'value': [self.child(rid, 'one')], 'nextLink': second}))
        self.wire.arm[second] = Wire.response(200, body=encoded({'value': [self.child(rid, 'two')], 'nextLink': None}))
        self.assertEqual('pending', self.run_cleanup()['status'])
        self.assertTrue(any(u == second for _, u, *_ in self.wire.calls))

    def test_foreign_or_filtered_or_cyclic_pagination_is_not_followed(self):
        rid = self.ids[0]; child = self.present(rid); first = ARM + child + '?api-version=' + VERSION
        for next_link in ('https://evil.example/', first + '&$filter=active', first,
            first.replace(child, self.ids[1] + '/executions') + '&$skipToken=x', first + '&api-version=' + VERSION + '&$skipToken=x'):
            self.wire.calls.clear()
            self.wire.arm[first] = Wire.response(200, body=encoded({'value': [], 'nextLink': next_link}))
            with self.assertRaises(Denied): self.run_cleanup()
            self.assert_no_delete()
            self.assertFalse(any(u == next_link for _, u, *_ in self.wire.calls) if next_link != first else False)

    def test_page_cap_and_missing_template_hold(self):
        rid = self.ids[0]; child = self.present(rid); first = ARM + child + '?api-version=' + VERSION
        for index in range(MAX_PAGES):
            url = first if index == 0 else first + '&$skipToken=' + str(index)
            self.wire.arm[url] = Wire.response(200, body=encoded({'value': [], 'nextLink': first + '&$skipToken=' + str(index + 1)}))
        with self.assertRaises(Denied): self.run_cleanup()
        self.assert_no_delete()
        self.wire.arm[first] = Wire.response(200, body=encoded({'value': [{'name': rid.rsplit('/', 1)[1] + '-one', 'properties': {}}]}))
        with self.assertRaises(Denied): self.run_cleanup()
        self.assert_no_delete()

    def test_duplicate_or_foreign_child_is_not_complete(self):
        rid = self.ids[1]; child = self.present(rid); url = ARM + child + '?api-version=' + VERSION
        row = self.child(rid)
        for rows in ([row, row], [{**row, 'id': self.ids[2] + '/executions/foreign'}]):
            self.wire.arm[url] = Wire.response(200, body=encoded({'value': rows}))
            with self.assertRaises(Denied): self.run_cleanup()
            self.assert_no_delete()

    def test_auth_errors_ambiguous_404_and_redirect_never_mean_absence(self):
        url = ARM + self.ids[0] + '?api-version=' + VERSION
        for status, body, headers in ((403, {}, {}), (404, {}, {}), (404, {'error': {'code': 'Unknown'}}, {}),
            (307, {}, {'Location': 'https://evil.example/'})):
            self.wire.arm[url] = Wire.response(status, headers, encoded(body))
            with self.assertRaises(Denied): self.run_cleanup()
            self.assert_no_delete()

    def test_unjournaled_or_unknown_push_and_missing_namespace_rejected_before_token(self):
        original = deepcopy(self.journal.records)
        for event in ('guardian_image_namespace', 'intent', 'progress'):
            self.journal.records = [r for r in original if r['event'] != event]
            with self.assertRaises(Denied): self.run_cleanup()
        self.journal.records = original
        changed = deepcopy(self.bundle); changed['push_receipt']['state'] = 'unknown'
        with self.assertRaises(Denied): self.run_cleanup(changed)
        self.assertFalse(self.credential.calls)

    def test_modified_namespace_or_wrong_run_binding_or_stale_before_absence_denied(self):
        for key, value in (('run_binding_digest', 'f' * 64), ('initial_plan_digest', 'f' * 64), ('schema', True)):
            changed = deepcopy(self.bundle); changed['scope_proof'][key] = value
            changed['binding']['exclusivity_evidence_digest'] = digest(changed['scope_proof'])
            with self.assertRaises(Denied): self.run_cleanup(changed)
        for row in self.journal.records:
            if row['event'] == 'guardian_image_namespace': row['value']['observed_at'] = self.iso(-31)
        changed = deepcopy(self.bundle)
        changed['scope_proof']['namespace_receipt_digest'] = digest(self.journal.values('guardian_image_namespace')[0])
        changed['binding']['exclusivity_evidence_digest'] = digest(changed['scope_proof'])
        with self.assertRaises(Denied): self.run_cleanup(changed)
        self.assertFalse(self.credential.calls)

    def test_extra_missing_inventory_other_repo_or_image_and_owner_denied(self):
        for key, value in (('authorized_resource_ids', self.ids[:-1]), ('authorized_resource_ids', self.ids + [self.ids[0]]),
            ('repository', self.manifest['imageRepository']), ('login_server', 'foreignacr.azurecr.io')):
            changed = deepcopy(self.bundle); changed['binding'][key] = value
            with self.assertRaises(Denied): self.run_cleanup(changed)
        self.credential.principal = operations_fixture.guid(9000)
        with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.credential.calls)

    def test_unknown_delete_is_not_resent_or_adopted_even_when_absent(self):
        self.wire.delete = TimeoutError('private marker')
        self.assertEqual('unknown', self.run_cleanup()['status'])
        self.wire.head = [404]; count = len(self.wire.calls)
        self.assertEqual('unknown', self.run_cleanup()['status'])
        self.assertEqual(count, len(self.wire.calls))
        self.assertEqual(1, sum(m == 'DELETE' for m, *_ in self.wire.calls))
        self.assertNotIn('private marker', json.dumps(self.journal.records))

    def test_missing_delete_checkpoint_becomes_unknown_without_calls(self):
        self.run_cleanup()
        self.journal.records = [r for r in self.journal.records if not (r['event'] == 'progress' and r['value']['operation_id'] == IDENT)]
        count = len(self.wire.calls)
        self.assertEqual('unknown', self.run_cleanup()['status']); self.assertEqual(count, len(self.wire.calls))

    def test_pending_ack_failed_head_keeps_known_ack_then_succeeds(self):
        self.run_cleanup(); self.wire.head = [403]
        self.assertEqual('unknown', self.run_cleanup()['status'])
        self.assertTrue(self.journal.latest(IDENT)['delete_acknowledged'])
        self.wire.head = [404]
        self.assertTrue(self.run_cleanup()['cleanup_verified'])

    def test_request_timeout_during_read_never_sends_delete(self):
        self.wire.arm_delay = 31
        with self.assertRaises(TimeoutError): self.run_cleanup()
        self.assert_no_delete()

    def test_clock_rollback_and_unresolved_writer_hold_before_reads(self):
        self.journal.append('clock_observation', {'at': self.iso(10)})
        with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.wire.calls)
        self.journal.records = [r for r in self.journal.records if r['event'] not in ('clock_revoked', 'clock_observation')]
        other = deepcopy(self.pushop); other['id'] = 'other'
        self.journal.intent(other, self.iso(0))
        with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.wire.calls)

    def test_shared_exhausted_budget_does_not_send_and_is_not_reset(self):
        self.budget.counts['owner_arm'] = 600
        with self.assertRaises(Denied): self.run_cleanup()
        self.assertEqual(600, self.budget.counts['owner_arm']); self.assertFalse(self.wire.calls)

    def test_bundle_change_after_initial_attempt_denied_before_token(self):
        self.run_cleanup(); count = len(self.credential.calls)
        changed = deepcopy(self.bundle); changed['scope_proof']['namespace_receipt_digest'] = 'f' * 64
        with self.assertRaises(Denied): self.run_cleanup(changed)
        self.assertEqual(count, len(self.credential.calls))

    def test_stale_readonly_inventory_can_refresh_without_renewing_deadline(self):
        for rid in self.ids: self.present(rid)
        self.wire.arm_delay = 9
        with self.assertRaises(Denied): self.run_cleanup()
        self.assert_no_delete()
        self.assertFalse(any(v['operation_id'] == IDENT for v in self.journal.values('intent')))
        self.wire.arm_delay = 0
        self.assertEqual('pending', self.run_cleanup()['status'])
        self.assertEqual(self.resources['guardian_deadline'], self.journal.values('registry_cleanup_binding')[0]['operation']['deadline'])

    def test_budget_fsync_delay_or_rollback_cannot_bypass_final_delete_fence(self):
        original = self.budget.consume
        def delayed(kind, limit):
            original(kind, limit)
            if len(self.budget.calls) == 7: self.clock.wall_offset = -100
        self.budget.consume = delayed
        self.assertEqual('unknown', self.run_cleanup()['status'])
        self.assert_no_delete()
        self.assertEqual(7, len(self.budget.calls)); self.assertEqual(6, len(self.wire.calls))
        self.assertTrue(self.journal.values('clock_revoked'))
        count = len(self.wire.calls)
        self.assertEqual('unknown', self.run_cleanup()['status'])
        self.assertEqual(count, len(self.wire.calls))

    def test_known_owned_delete_and_ack_readback_after_due_keep_original_deadline(self):
        self.clock.seconds = 8 * 3600 + 1
        # Tokens are fresh per invocation, not the fixture's old initial token.
        def token_response(method, url):
            if not url.endswith(('/oauth2/exchange', '/oauth2/token')): return None
            claims = {'aud': self.binding['login_server'], 'exp': self.clock.utc().timestamp() + 3600,
                'nbf': self.clock.utc().timestamp() - 1}
            key = 'refresh_token' if url.endswith('/oauth2/exchange') else 'access_token'
            if key == 'refresh_token': claims.update(tenant=self.binding['tenant_id'], grant_type='refresh_token')
            else: claims['access'] = [{'type': 'repository', 'name': self.binding['repository'], 'actions': ['pull', 'delete']}]
            return Wire.response(200, body=encoded({key: registry_fixture.jwt(claims)}))
        self.wire.modify = token_response
        self.assertEqual('pending', self.run_cleanup()['status'])
        op = deepcopy(self.journal.values('registry_cleanup_binding')[0]['operation'])
        self.wire.head = [404]; self.clock.seconds += 60
        self.assertTrue(self.run_cleanup()['cleanup_verified'])
        self.assertEqual(op, self.journal.values('registry_cleanup_binding')[0]['operation'])
        self.assertEqual(self.resources['guardian_deadline'], op['deadline'])
        self.assertEqual(1, sum(method == 'DELETE' for method, *_ in self.wire.calls))

    def test_preparation_and_plan_import_are_required_before_cleanup_credentials(self):
        original = deepcopy(self.journal.records)
        for event in ('publication_preparation', 'publication_import'):
            self.journal.records = [r for r in original if r['event'] != event]
            with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.credential.calls); self.assertFalse(self.wire.calls)

    def test_preparation_source_code_slot_and_import_receipts_must_match_final_plan(self):
        original = deepcopy(self.journal.records)
        changes = (
            ('publication_preparation', lambda value: value['source_sha256'].update(latest='f' * 64)),
            ('publication_preparation', lambda value: value.update(code_sha='f' * 40)),
            ('publication_preparation', lambda value: value['slots']['guardian'].update(repository=self.manifest['imageRepository'])),
            ('publication_preparation', lambda value: value['slots']['guardian'].update(build_receipt_sha256='bad')),
            ('publication_import', lambda value: value['push_receipt_digests'].update(runtime='f' * 64)),
            ('publication_import', lambda value: value.update(initial_plan_digest='f' * 64)),
        )
        for event, change in changes:
            self.journal.records = deepcopy(original)
            for row in self.journal.records:
                if row['event'] == event: change(row['value'])
            with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.credential.calls)

    def test_runtime_unknown_or_tag_intent_mismatch_cannot_be_imported(self):
        original = deepcopy(self.journal.records)
        for row in self.journal.records:
            if row['event'] == 'progress' and row['value']['operation_id'] == 'runtimeImagePush': row['value']['state'] = 'unknown'
        with self.assertRaises(Denied): self.run_cleanup()
        self.journal.records = deepcopy(original)
        for row in self.journal.records:
            if row['event'] == 'intent' and row['value']['operation_id'] == PUSH: row['value']['url'] = self.url
        with self.assertRaises(Denied): self.run_cleanup()
        self.assertFalse(self.credential.calls)

    def test_tag_intent_and_ack_actual_digest_remain_distinct(self):
        self.assertNotEqual(self.tag_url, self.url)
        self.assertNotEqual(self.preparation['slots']['guardian']['local_image_id'], self.image_digest)
        self.assertEqual('pending', self.run_cleanup()['status'])
        operation = self.journal.values('registry_cleanup_binding')[0]['operation']
        self.assertEqual(self.url, operation['url'])
        self.assertNotIn('/manifests/' + self.manifest['cleanupImageTag'] + '?', operation['url'])


if __name__ == '__main__': unittest.main()
