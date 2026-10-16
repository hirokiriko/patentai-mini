"""Offline provider contract/fault tests; no credentials, subprocess or network."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
import json
import hashlib
import unittest
from contextlib import redirect_stdout, redirect_stderr

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.providers import BoundedArmProvider, _validate


SUB = '/subscriptions/11111111-1111-1111-1111-111111111111'
RG = SUB + '/resourceGroups/fictional'
UUID = '22222222-2222-2222-2222-222222222222'


class Clock:
    def __init__(self):
        self.wall = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.mono = 0
    def utc(self): return self.wall
    def monotonic(self): return self.mono
    def advance(self, value):
        self.mono += value
        self.wall += timedelta(seconds=value)


class Credential:
    def __init__(self, clock): self.calls, self.clock, self.delay = 0, clock, 0
    def token(self, audience, deadline):
        assert audience == 'https://management.azure.com/'
        self.calls += 1
        self.clock.advance(self.delay)
        deadline.remaining()
        return 'fixture-token-never-output'


class Http:
    def __init__(self): self.calls, self.responses = [], []
    def add(self, status, value=None, headers=None):
        if status == 404 and value is None:
            value = {'error': {'code': 'ResourceNotFound', 'message': 'Fictional fixed target is absent.'}}
        self.responses.append({'status': status, 'headers': headers or {},
                               'body': encoded(value) if value is not None else b''})
    def __call__(self, method, url, headers, body, deadline):
        self.calls.append((method, url, body))
        deadline.remaining()
        response = self.responses.pop(0)
        if isinstance(response, Exception): raise response
        return response


def operation(kind='containers'):
    if kind == 'containers':
        provider, version = 'Microsoft.Storage', '2023-05-01'
        rid = RG + '/providers/Microsoft.Storage/storageAccounts/fictionalstore/blobServices/default/containers/trial-originals'
        body = {'properties': {'publicAccess': 'None'}}
        props = {'properties.publicAccess': 'None'}
    elif kind == 'userAssignedIdentities':
        provider, version = 'Microsoft.ManagedIdentity', '2023-01-31'
        rid = RG + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trial-worker'
        body, props = {'location': 'eastus'}, {'location': 'eastus'}
    elif kind in ('roleDefinitions', 'roleAssignments'):
        provider, version = 'Microsoft.Authorization', '2022-04-01'
        rid = RG + '/providers/Microsoft.Authorization/' + kind + '/' + UUID
        p = {'roleName': 'fictional-role', 'type': 'CustomRole',
             'permissions': [{'actions': ['Microsoft.App/jobs/read'], 'notActions': [], 'dataActions': [], 'notDataActions': []}],
             'assignableScopes': [RG]}
        if kind == 'roleAssignments':
            p = {'principalId': UUID, 'principalType': 'ServicePrincipal',
                 'roleDefinitionId': RG + '/providers/Microsoft.Authorization/roleDefinitions/' + UUID}
        body = {'properties': p}
        props = {'properties.' + k: v for k, v in p.items()}
    else:
        provider, version = 'Microsoft.App', '2025-07-01'
        rid = RG + '/providers/Microsoft.App/' + kind + '/trial-app'
        body = {'location': 'eastus', 'properties': {
            'environmentId': RG + '/providers/Microsoft.App/managedEnvironments/fictional-env',
            'configuration': {'triggerType': 'Manual'} if kind == 'jobs' else {},
            'template': {'containers': [{'name': 'web', 'image': 'fictional.azurecr.io/trial@sha256:' + 'a' * 64}]}}}
        props = {'properties.environmentId': body['properties']['environmentId']}
    e = {'resource_id': rid, 'api_version': version, 'body_sha256': digest(body),
         'properties': props, 'created_by_run': True, 'before_absent': True}
    if provider == 'Microsoft.App': e['location'] = 'eastus'
    if kind == 'userAssignedIdentities': e['receipt_properties'] = ['principalId', 'tenantId']
    return {'id': 'create-' + kind, 'provider': provider, 'kind': kind, 'method': 'PUT',
            'url': 'https://management.azure.com' + rid + '?api-version=' + version,
            'body': body, 'deadline': '2026-01-01T00:10:00Z', 'depends_on': [], 'expected': e,
            'cleanup': {'created_only': True, 'zero_reference_required': kind in ('roleDefinitions', 'userAssignedIdentities')}}


def resource(op):
    value = deepcopy(op['body'])
    value['id'] = op['expected']['resource_id']
    if op['provider'] == 'Microsoft.App': value['properties']['provisioningState'] = 'Succeeded'
    if op['kind'] == 'userAssignedIdentities': value['properties'] = {'principalId': UUID, 'tenantId': UUID, 'clientId': UUID}
    return value


def deletion(op):
    value = deepcopy(op)
    value.update(id='delete-' + op['kind'], method='DELETE', body=None)
    value['expected']['body_sha256'] = digest(None)
    return value


class ProvidersTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.http = Clock(), Http()
        self.credential = Credential(self.clock)
        self.provider = BoundedArmProvider(self.credential, self.http, self.clock)

    def absent(self, op):
        self.http.add(404)
        return self.provider.readback(op)

    def created(self, op):
        precondition = self.absent(op)
        self.http.add(201, resource(op))
        ack = self.provider.send(op, precondition)
        self.assertEqual('pending', ack['state'])
        self.http.add(200, resource(op))
        return self.provider.readback(op, ack)

    def current(self, op):
        self.http.add(200, resource(op))
        return self.provider.readback(op)

    def test_all_supported_sync_contracts_need_ack_and_exact_readback(self):
        for kind in ('containers', 'userAssignedIdentities', 'roleDefinitions', 'roleAssignments', 'containerApps', 'jobs'):
            with self.subTest(kind=kind):
                result = self.created(operation(kind))
                self.assertEqual('succeeded', result['state'])
                self.assertTrue(result['readback_verified'])
                self.assertTrue(result['terminal'])
        self.assertEqual(18, len(self.http.calls))

    def test_binding_errors_happen_before_token_or_http(self):
        for field, value in (('provider', 'Microsoft.DBforPostgreSQL'), ('method', 'POST'), ('kind', 'storageAccounts'),
                             ('url', 'https://management.azure.com.evil.invalid/'), ('body', {'properties': {'publicAccess': 'Blob'}})):
            op = operation()
            op[field] = value
            with self.subTest(field=field), self.assertRaises(Denied): self.provider.send(op, {})
        self.assertEqual(0, self.credential.calls)
        self.assertEqual([], self.http.calls)

    def test_identity_documented_id_casing_needs_ack_and_readback(self):
        op = operation('userAssignedIdentities')
        pre = self.absent(op)
        value = resource(op)
        value['id'] = value['id'].replace('/resourceGroups/', '/resourcegroups/')
        self.http.add(201, value)
        ack = self.provider.send(op, pre)
        self.assertEqual('pending', ack['state'])
        self.assertTrue(ack['write_terminal'])
        self.assertFalse(ack['terminal'])
        self.assertFalse(ack['readback_verified'])
        value['id'] = value['id'].upper()
        self.http.add(200, value)
        result = self.provider.readback(op, ack)
        self.assertEqual('succeeded', result['state'])
        self.assertTrue(result['readback_verified'])
        self.assertEqual(op['expected']['resource_id'], result['object_id'])
        self.assertEqual(UUID, result['properties']['principalId'])
        self.assertTrue(all(call[1] == op['url'] for call in self.http.calls))

    def test_identity_casing_does_not_relax_scope_paths_or_properties(self):
        op = operation('userAssignedIdentities')
        expected = op['expected']['resource_id']
        invalid = [None, 1, expected.replace('11111111', '33333333'),
                   expected.replace('/fictional/', '/another/'), expected + '-other',
                   expected + '/', expected + '?secret=canary-secret',
                   expected.replace('/resourceGroups/', '/resourceGroups/../'),
                   expected.replace('/trial-worker', '/trial-wor\u212aer'),
                   expected.replace('/trial-worker', '/trial%2dworker')]
        for actual in invalid:
            with self.subTest(actual=actual):
                pre = self.absent(op)
                value = resource(op); value['id'] = actual
                self.http.add(201, value)
                ack = self.provider.send(op, pre)
                self.assertEqual('unknown', ack['state'])
                self.assertFalse(ack['write_terminal'])
                self.assertEqual('resource_id_mismatch', ack['ack_rejection'])
                self.assertNotIn('canary-secret', json.dumps(ack))
        known = self.created(op)
        value = resource(op); value['id'] = expected.upper(); value['location'] = 'westus'
        self.http.add(200, value)
        self.assertNotEqual('matching', self.provider.inspect_cleanup(op, known)['state'])

    def test_identity_explicit_lro_diagnostic_does_not_accept_or_expose_header(self):
        op = operation('userAssignedIdentities')
        for header in ('Operation-Location', 'Azure-AsyncOperation'):
            pre = self.absent(op)
            self.http.add(201, resource(op), {header: 'https://evil.invalid/canary-secret'})
            ack = self.provider.send(op, pre)
            self.assertEqual('unknown', ack['state'])
            self.assertFalse(ack['write_terminal'])
            self.assertEqual('unsupported_lro_headers', ack['ack_rejection'])
            self.assertNotIn('canary-secret', json.dumps(ack))
            self.assertNotIn('operation_url', ack)

    def test_identity_201_self_location_requires_complete_ack_and_fixed_readback(self):
        op = operation('userAssignedIdentities')
        for headers in ({}, {'Location': op['url']}, {'location': op['url'].split('?')[0]}):
            with self.subTest(headers=headers):
                self.http.calls.clear()
                pre = self.absent(op)
                value = resource(op)
                value['properties']['provisioningState'] = 'Succeeded'
                self.http.add(201, value, headers)
                ack = self.provider.send(op, pre)
                self.assertEqual('pending', ack['state'])
                self.assertTrue(ack['write_terminal'])
                self.assertFalse(ack['terminal'])
                self.assertFalse(ack['readback_verified'])
                self.assertNotIn('operation_url', ack)
                self.assertEqual('ignored_sync_201' if headers else 'absent',
                                 ack['ack_header_evidence']['location'])
                self.http.add(200, value)
                self.assertEqual('succeeded', self.provider.readback(op, ack)['state'])
                self.assertEqual(['GET', 'PUT', 'GET'], [call[0] for call in self.http.calls])
                self.assertTrue(all(call[1] == op['url'] for call in self.http.calls))

    def test_identity_201_location_is_not_authority_or_a_redirect(self):
        op = operation('userAssignedIdentities')
        url = op['url']
        references = [url, url.split('?')[0],
                   url.replace('management.azure.com', 'evil.invalid'),
                   url.replace('management.azure.com', 'management.azure.com:443'),
                   url.replace('management.azure.com', 'canary-secret@management.azure.com'),
                   url.replace('11111111', '33333333'), url.replace('/fictional/', '/other/'),
                   url.replace('trial-worker', 'another'), url + '&canary-secret=1',
                   url.replace('2023-01-31', '2024-01-31'), url + '#canary-secret',
                   op['expected']['resource_id'], url.replace('trial-worker', 'trial%2dworker'),
                   url.replace('/resourceGroups/', '/resourcegroups/'),
                   url.replace('/trial-worker', '/../trial-worker'),
                   url.split('?')[0] + '/', url.split('?')[0] + '?',
                   '/operationStatuses/canary-secret', '//evil.invalid/canary-secret',
                   '../canary-secret', '?api-version=2023-01-31', 'urn:fixture:canary-secret']
        for location in references:
            with self.subTest(shape='synthetic_reference'):
                self.http.calls.clear()
                pre = self.absent(op)
                self.http.add(201, resource(op), {'Location': location})
                ack = self.provider.send(op, pre)
                self.assertEqual('pending', ack['state'])
                self.assertTrue(ack['write_terminal'])
                self.assertFalse(ack['terminal'])
                self.assertFalse(ack['readback_verified'])
                self.assertEqual('ignored_sync_201', ack['ack_header_evidence']['location'])
                self.assertFalse(ack['ack_header_evidence']['location_used_for_authority_or_polling'])
                self.assertNotIn('operation_url', ack)
                self.assertNotIn('canary-secret', json.dumps(ack))
                self.http.add(200, resource(op))
                self.assertEqual('succeeded', self.provider.readback(op, ack)['state'])
                self.assertEqual(['GET', 'PUT', 'GET'], [call[0] for call in self.http.calls])
                self.assertTrue(all(call[1] == op['url'] for call in self.http.calls))

    def test_identity_201_malformed_location_preserves_safe_diagnostics(self):
        op = operation('userAssignedIdentities')
        url = op['url']
        invalid = [None, '', 1, [], 'x'*8193, '\n' + url, url + '\t',
                   url + '\x7f', url + ' canary-secret', url + '%xx',
                   url.replace('trial-worker', 'trial-wor\u212aer'),
                   'https:\\evil.invalid\\canary-secret', '<canary-secret>']
        for location in invalid:
            with self.subTest(shape='malformed_reference'):
                self.http.calls.clear()
                pre = self.absent(op)
                self.http.add(201, resource(op), {'Location': location})
                ack = self.provider.send(op, pre)
                self.assertEqual('unknown', ack['state'])
                self.assertFalse(ack['write_terminal'])
                self.assertEqual('unsupported_lro_headers', ack['ack_rejection'])
                self.assertEqual('unsupported', ack['ack_header_evidence']['location'])
                self.assertNotIn('canary-secret', json.dumps(ack))
                self.assertNotIn('operation_url', ack)
                self.assertEqual(['GET', 'PUT'], [call[0] for call in self.http.calls])

    def test_ignored_location_never_overrides_body_or_old_unknown_evidence(self):
        op = operation('userAssignedIdentities')
        op['body']['tags'] = {'trial': 'fixture'}
        op['expected']['body_sha256'] = digest(op['body'])
        for field in ('id', 'location', 'tags', 'principalId', 'tenantId', 'clientId', 'state', 'error'):
            with self.subTest(field=field):
                pre = self.absent(op)
                body = resource(op)
                if field == 'id': body['id'] += '-other'
                elif field == 'location': body['location'] = 'westus'
                elif field == 'tags': body['tags'] = {'unexpected': 'canary-secret'}
                elif field in ('principalId', 'tenantId', 'clientId'): del body['properties'][field]
                elif field == 'state': body['properties']['provisioningState'] = 'Creating'
                else: body['error'] = 'canary-secret'
                self.http.add(201, body, {'Location': 'https://evil.invalid/canary-secret'})
                unknown = self.provider.send(op, pre)
                self.assertEqual('unknown', unknown['state'])
                self.assertFalse(unknown['write_terminal'])
                self.assertNotIn('canary-secret', json.dumps(unknown))
                self.http.add(200, resource(op))
                self.assertEqual('unknown', self.provider.readback(op, unknown)['state'])

    def test_ignored_location_ack_requires_same_uuid_readback(self):
        op = operation('userAssignedIdentities')
        for field in ('principalId', 'tenantId', 'clientId'):
            with self.subTest(field=field):
                pre = self.absent(op)
                self.http.add(201, resource(op), {'Location': '/operationStatuses/canary-secret'})
                ack = self.provider.send(op, pre)
                changed = resource(op)
                changed['properties'][field] = 'abcdef01-2345-6789-abcd-ef0123456789'
                self.http.add(200, changed)
                current = self.provider.readback(op, ack)
                self.assertFalse(current['terminal'])
                self.assertFalse(current['readback_verified'])
                self.assertEqual('identity_mismatch', current['readback_state'])

    def test_identity_async_header_presence_or_duplicate_control_headers_is_unknown(self):
        op = operation('userAssignedIdentities')
        cases = [{'Location': op['url'], header: value}
                 for header in ('Azure-AsyncOperation', 'Operation-Location')
                 for value in ('', None, 1, op['url'], 'https://evil.invalid/canary-secret')]
        cases += [{'Location': op['url'], 'location': op['url']},
                  {'Location': 'https://evil.invalid/canary-secret', 'LOCATION': op['url']}]
        for headers in cases:
            with self.subTest(headers=headers):
                pre = self.absent(op)
                self.http.add(201, resource(op), headers)
                ack = self.provider.send(op, pre)
                self.assertEqual('unknown', ack['state'])
                self.assertFalse(ack['write_terminal'])
                self.assertEqual('unsupported_lro_headers', ack['ack_rejection'])
                self.assertNotIn('operation_url', ack)
                self.assertNotIn('canary-secret', json.dumps(ack))

    def test_identity_200_and_202_cannot_be_adopted_with_self_location(self):
        op = operation('userAssignedIdentities')
        for code in (200, 202):
            pre = self.absent(op)
            self.http.add(code, resource(op), {'Location': op['url']})
            ack = self.provider.send(op, pre)
            self.assertEqual('unknown', ack['state'])
            self.assertFalse(ack['write_terminal'])
            self.http.add(200, resource(op))
            self.assertEqual('unknown', self.provider.readback(op, ack)['state'])

    def test_identity_ack_and_readback_validate_complete_body_without_projection(self):
        op = operation('userAssignedIdentities')
        op['expected']['receipt_properties'] = []
        op['body']['tags'] = {'trial': 'fixture'}
        op['expected']['body_sha256'] = digest(op['body'])
        mutations = [({'location': 'westus'}, None), ({'tags': {}}, None),
                     ({'error': 'canary-secret'}, None), ({'status': 'Running'}, None),
                     ({'provisioningState': 'Failed'}, None), ({'properties': []}, None)]
        mutations += [({}, {key: value}) for key in ('principalId', 'tenantId', 'clientId')
                      for value in (None, '', 1, 'canary-secret', UUID.replace('-', ''))]
        mutations += [({}, {key: value}) for key in ('status', 'provisioningState')
                      for value in ('Creating', 'Failed', None)]
        mutations += [({}, {'error': 'canary-secret'})]
        for root, properties in mutations:
            with self.subTest(root=root, properties=properties):
                pre = self.absent(op)
                value = resource(op); value.update(root)
                if properties is not None:
                    value['properties'].update(properties)
                self.http.add(201, value, {'Location': op['url']})
                rejected = self.provider.send(op, pre)
                self.assertEqual('unknown', rejected['state'])
                self.assertEqual('identity_response_mismatch', rejected['ack_rejection'])
                self.assertFalse(rejected['write_terminal'])
                self.assertNotIn('canary-secret', json.dumps(rejected))
                pre = self.absent(op)
                self.http.add(201, resource(op), {'Location': op['url']})
                known = self.provider.send(op, pre)
                self.assertTrue(known['write_terminal'])
                self.http.add(200, value)
                result = self.provider.readback(op, known)
                self.assertEqual('pending', result['state'])
                self.assertFalse(result['readback_verified'])
                self.assertFalse(result['terminal'])

    def test_identity_each_missing_uuid_blocks_ack_and_readback(self):
        op = operation('userAssignedIdentities')
        op['expected']['receipt_properties'] = []
        for key in ('principalId', 'tenantId', 'clientId'):
            with self.subTest(key=key):
                value = resource(op); del value['properties'][key]
                pre = self.absent(op)
                self.http.add(201, value)
                self.assertFalse(self.provider.send(op, pre)['write_terminal'])
                pre = self.absent(op)
                self.http.add(201, resource(op))
                ack = self.provider.send(op, pre)
                self.http.add(200, value)
                self.assertFalse(self.provider.readback(op, ack)['readback_verified'])

    def test_identity_malformed_or_incomplete_ack_keeps_safe_diagnostics(self):
        op = operation('userAssignedIdentities')
        for body in (b'{', b'[]', b'', encoded({'id': op['expected']['resource_id']})):
            pre = self.absent(op)
            self.http.responses.append({'status': 201, 'headers': {'Location': op['url']}, 'body': body})
            ack = self.provider.send(op, pre)
            self.assertEqual('unknown', ack['state'])
            self.assertFalse(ack['write_terminal'])
            self.assertEqual(64, len(ack['initial_ack_digest']))
            self.assertIn(ack['ack_rejection'], ('resource_id_mismatch', 'identity_response_mismatch'))

    def test_identity_readback_and_cleanup_bind_all_ack_uuids(self):
        op = operation('userAssignedIdentities')
        op['expected']['receipt_properties'] = []
        for key in ('principalId', 'tenantId', 'clientId'):
            with self.subTest(key=key):
                pre = self.absent(op)
                self.http.add(201, resource(op), {'Location': op['url']})
                ack = self.provider.send(op, pre)
                changed = resource(op)
                changed['properties'][key] = 'abcdef01-2345-6789-abcd-ef0123456789'
                self.http.add(200, changed)
                result = self.provider.readback(op, ack)
                self.assertEqual('pending', result['state'])
                self.assertEqual('identity_mismatch', result['readback_state'])
                self.assertFalse(result['readback_verified'])
                self.http.add(200, resource(op))
                created = self.provider.readback(op, ack)
                self.assertEqual('succeeded', created['state'])
                self.http.add(200, changed)
                current = self.provider.inspect_cleanup(op, created)
                before = len(self.http.calls)
                with self.assertRaisesRegex(Denied, 'changed_resource'):
                    self.provider.cleanup(deletion(op), op, created, current)
                self.assertEqual(before, len(self.http.calls))

    def test_identity_uuid_case_does_not_change_binding_and_missing_binding_is_not_inferred(self):
        op = operation('userAssignedIdentities')
        value = resource(op)
        value['properties']['clientId'] = 'abcdef01-2345-6789-abcd-ef0123456789'
        pre = self.absent(op)
        self.http.add(201, value)
        ack = self.provider.send(op, pre)
        value['properties']['clientId'] = value['properties']['clientId'].upper()
        self.http.add(200, value)
        self.assertEqual('succeeded', self.provider.readback(op, ack)['state'])
        legacy = deepcopy(ack); del legacy['identity_properties_digest']
        self.http.add(200, value)
        result = self.provider.readback(op, legacy)
        self.assertEqual('pending', result['state'])
        self.assertFalse(result['readback_verified'])
        self.assertNotIn('identity_properties_digest', legacy)

    def test_identity_unknown_201_is_not_promoted_by_case_insensitive_get(self):
        op = operation('userAssignedIdentities')
        # Historical receipt bytes, not an old response reinterpreted by new code.
        unknown = self.provider._base(op, 'unknown', 201)
        unknown['initial_ack_digest'] = 'a' * 64
        before = deepcopy(unknown)
        value = resource(op); value['id'] = value['id'].lower()
        self.http.add(200, value)
        result = self.provider.readback(op, unknown)
        self.assertEqual(before, unknown)
        self.assertEqual('unknown', result['state'])
        self.assertFalse(result['terminal'])
        self.assertFalse(result['write_terminal'])
        self.assertFalse(result['readback_verified'])

    def test_identity_comparison_change_does_not_broaden_other_providers(self):
        op = operation('containers')
        pre = self.absent(op)
        value = resource(op); value['id'] = value['id'].upper()
        self.http.add(201, value)
        ack = self.provider.send(op, pre)
        self.assertEqual('unknown', ack['state'])
        self.assertFalse(ack['write_terminal'])

    def test_invalid_paths_extra_queries_versions_and_encoded_paths_fail(self):
        for suffix in ('/listKeys', '/..', '%2fsecret', '?extra=1'):
            op = operation()
            op['expected']['resource_id'] += suffix
            op['url'] = 'https://management.azure.com' + op['expected']['resource_id'] + '?api-version=2023-05-01'
            with self.assertRaises(Denied): self.provider.readback(op)
        op = operation()
        op['url'] += '&api-version=2023-05-01'
        with self.assertRaises(Denied): self.provider.readback(op)
        self.assertEqual(0, self.credential.calls)

    def test_expected_plan_property_cannot_disagree_with_role_body(self):
        op = operation('roleAssignments')
        op['expected']['properties']['properties.principalId'] = '33333333-3333-3333-3333-333333333333'
        with self.assertRaises(Denied): self.provider.readback(op)
        self.assertEqual(0, self.credential.calls)

    def test_existing_mismatching_or_stale_precondition_denies_create(self):
        op = operation()
        for state, status in (('matching', 200), ('unknown', 403)):
            pre = self.absent(op)
            pre.update(state=state, http=status)
            with self.assertRaises(Denied): self.provider.send(op, pre)
        pre = self.absent(op)
        self.clock.advance(31)
        with self.assertRaises(Denied): self.provider.send(op, pre)
        self.assertEqual(['GET'] * 3, [x[0] for x in self.http.calls])

    def test_unknown_put_is_never_adopted_by_matching_get(self):
        op = operation()
        pre = self.absent(op)
        self.http.responses.append(TimeoutError('canary-secret'))
        ack = self.provider.send(op, pre)
        self.http.add(200, resource(op))
        result = self.provider.readback(op, ack)
        self.assertEqual('unknown', result['state'])
        self.assertFalse(result['readback_verified'])
        self.assertEqual(['GET', 'PUT', 'GET'], [x[0] for x in self.http.calls])

    def test_create_200_existing_container_is_not_created_by_run(self):
        op = operation()
        pre = self.absent(op)
        self.http.add(200, resource(op))
        self.assertEqual('unknown', self.provider.send(op, pre)['state'])

    def test_nonsupported_lro_headers_and_missing_body_fail_closed(self):
        for kind in ('containers', 'userAssignedIdentities', 'roleDefinitions', 'roleAssignments'):
            op = operation(kind)
            pre = self.absent(op)
            self.http.add(202, headers={'location': 'https://evil.invalid/secret'})
            self.assertEqual('unknown', self.provider.send(op, pre)['state'])

    def test_deadline_includes_credential_and_monotonic_rollback(self):
        op = operation()
        pre = self.absent(op)
        self.credential.delay = 31
        self.assertEqual('unknown', self.provider.send(op, pre)['state'])
        self.assertEqual(1, len(self.http.calls))
        self.credential.delay = 0
        self.clock.advance(600)
        self.clock.wall -= timedelta(hours=1)
        self.assertEqual('unknown', self.provider.readback(op)['state'])
        self.assertEqual(1, len(self.http.calls))

    def test_no_stdout_or_error_secret_or_raw_resource_in_receipt(self):
        op = operation()
        pre = self.absent(op)
        self.http.add(500, {'secret': 'canary-secret', 'error': {'message': 'canary-secret'}})
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err): result = self.provider.send(op, pre)
        self.assertEqual('', out.getvalue() + err.getvalue())
        self.assertNotIn('canary-secret', json.dumps(result))
        self.assertNotIn('fixture-token', json.dumps(result))

    def lro(self, kind='containerApps', family='regional', header='azure-asyncoperation'):
        op = operation(kind)
        pre = self.absent(op)
        if family == 'regional':
            segment = 'containerapp' if kind == 'containerApps' else 'containerappsjob'
            path = SUB + '/providers/Microsoft.App/locations/eastus/' + segment + 'OperationStatuses/' + UUID
        else:
            path = SUB + '/providers/Microsoft.App/' + kind + '/trial-app/operationResults/' + UUID
        url = 'https://management.azure.com' + path + '?api-version=2025-07-01'
        self.http.add(201, headers={header: url, 'retry-after': '2'})
        return op, self.provider.send(op, pre)

    def test_aca_regional_and_resource_lro_terminal_then_readback(self):
        for kind in ('containerApps', 'jobs'):
            for family in ('regional', 'resource'):
                op, receipt = self.lro(kind, family)
                self.assertEqual('pending', receipt['state'])
                self.assertFalse(receipt['write_terminal'])
                with self.assertRaises(Denied): self.provider.poll(op, receipt)
                self.clock.advance(2)
                self.http.add(200, {'status': 'Succeeded'})
                ack = self.provider.poll(op, receipt)
                self.assertTrue(ack['write_terminal'])
                self.http.add(200, resource(op))
                self.assertEqual('succeeded', self.provider.readback(op, ack)['state'])

    def test_lro_cross_subscription_region_family_path_and_version_denied(self):
        op, receipt = self.lro()
        self.clock.advance(2)
        for old, new in (('eastus', 'westus'), ('containerappOperationStatuses', 'containerappsjobOperationStatuses'),
                         ('2025-07-01', '2024-03-01'), ('management.azure.com', 'management.azure.com.evil.invalid'),
                         (SUB, '/subscriptions/' + UUID)):
            forged = deepcopy(receipt)
            forged['operation_url'] = forged['operation_url'].replace(old, new)
            forged['operation_url_digest'] = digest(forged['operation_url'])
            with self.assertRaises(Denied): self.provider.poll(op, forged)
        self.assertEqual(2, len(self.http.calls))

    def test_location_returns_exact_final_resource_for_create_and_update(self):
        for kind in ('containerApps', 'jobs'):
            for method in ('PUT', 'PATCH'):
                for mismatch in (None, 'id', 'image', 'error'):
                    with self.subTest(kind=kind, method=method, mismatch=mismatch):
                        prior, pending = self.lro(kind, 'resource', 'location')
                        op = prior if method == 'PUT' else self.patch_operation(prior)
                        if method == 'PATCH':
                            pending = self.provider.normalize_write(op, {'status': 202, 'body': b'',
                                'headers': {'location': pending['operation_url'], 'retry-after': '2'}})
                        actual = resource(prior)
                        actual['properties']['template'] = deepcopy(op['body']['properties']['template'])
                        if mismatch == 'id': actual['id'] += '-other'
                        if mismatch == 'image': actual['properties']['template']['containers'][0]['image'] += '-other'
                        if mismatch == 'error': actual['error'] = {'code': 'fictional'}
                        self.clock.advance(2)
                        self.http.add(200, actual)
                        ack = self.provider.poll(op, pending)
                        self.assertEqual(mismatch is None, ack['write_terminal'])
                        if mismatch is None:
                            self.http.add(200, actual)
                            self.assertEqual('succeeded', self.provider.readback(op, ack)['state'])

    def test_lro_conflicting_success_never_becomes_terminal(self):
        for state in ('InProgress', 'Deleting', 'Failed', 'Canceled', 'Unknown'):
            op, pending = self.lro()
            self.clock.advance(2)
            self.http.add(200, {'status': 'Succeeded', 'properties': {'provisioningState': state}})
            ack = self.provider.poll(op, pending)
            self.assertFalse(ack['write_terminal'])
            self.assertTrue(ack['poll_observation_unknown'])

    def test_lro_receipt_for_different_operation_is_rejected(self):
        op, receipt = self.lro()
        changed = deepcopy(op)
        changed['deadline'] = '2026-01-01T00:11:00Z'
        with self.assertRaises(Denied): self.provider.poll(changed, receipt)

    def test_lro_failed_canceled_and_pending_are_distinct(self):
        for state, expected in (('Failed', 'failed'), ('Canceled', 'failed'), ('Cancelled', 'failed'), ('InProgress', 'pending')):
            for error in (False, True):
                op, receipt = self.lro()
                self.clock.advance(2)
                value = {'status': state}
                if error: value['error'] = {'code': 'fictional-detail'}
                self.http.add(200, value)
                result = self.provider.poll(op, receipt)
                self.assertEqual(expected, result['state'])
                self.assertEqual(expected == 'failed', result['terminal'])
                self.assertNotIn('fictional-detail', json.dumps(result))

    def test_lro_mismatching_id_redirect_or_invalid_json_retains_only_initial_ack(self):
        for body, headers in (({'status': 'Succeeded', 'id': '/wrong'}, {}), ({'status': 'Succeeded'}, {'location': 'https://evil.invalid/'}), (['Succeeded'], {})):
            op, receipt = self.lro()
            self.clock.advance(2)
            self.http.add(200, body, headers)
            result = self.provider.poll(op, receipt)
            self.assertEqual('pending', result['state'])
            self.assertTrue(result['poll_observation_unknown'])
            self.assertFalse(result['write_terminal'])

    def test_aca_inprogress_without_lro_never_adopted(self):
        op = operation('jobs')
        pre = self.absent(op)
        value = resource(op)
        value['properties']['provisioningState'] = 'InProgress'
        self.http.add(201, value)
        ack = self.provider.send(op, pre)
        self.assertEqual('unknown', ack['state'])

    def test_delete_requires_known_created_and_exact_current_binding(self):
        op = operation()
        receipt = self.created(op)
        current = self.current(op)
        bad = deepcopy(receipt)
        bad['readback_verified'] = False
        with self.assertRaises(Denied): self.provider.cleanup(deletion(op), op, bad, current)
        bad = deepcopy(current)
        bad['binding_digest'] = 'a' * 64
        with self.assertRaises(Denied): self.provider.cleanup(deletion(op), op, receipt, bad)
        self.assertNotIn('DELETE', [x[0] for x in self.http.calls])

    def test_delete_ack_needs_exact_404_before_success(self):
        op = operation()
        receipt = self.created(op)
        current = self.current(op)
        delete = deletion(op)
        self.http.add(204)
        ack = self.provider.cleanup(delete, op, receipt, current)
        self.assertFalse(ack['terminal'])
        self.http.add(404)
        final = self.provider.readback(delete, ack)
        self.assertEqual('succeeded', final['state'])
        self.assertTrue(final['readback_verified'])

    def test_unknown_delete_plus_404_stays_unknown(self):
        op = operation()
        receipt = self.created(op)
        current = self.current(op)
        delete = deletion(op)
        self.http.responses.append(OSError('canary'))
        ack = self.provider.cleanup(delete, op, receipt, current)
        self.http.add(404)
        self.assertEqual('unknown', self.provider.readback(delete, ack)['state'])

    def test_delete_nonterminal_or_contradictory_body_cannot_promote_404(self):
        bodies = [
            {'status': state, 'properties': {'provisioningState': 'Deleting'}}
            for state in ('InProgress', 'Failed', 'Canceled', 'Unknown', 'Succeeded')]
        bodies += [{}, {'unexpected': True}, {'status': 'Succeeded', 'id': '/other'},
                   {'status': 'Succeeded', 'error': {}}, {'properties': []}]
        for code in (200, 204):
            for body in bodies:
                with self.subTest(code=code, body=body):
                    op = operation('jobs')
                    created, current = self.created(op), self.current(op)
                    delete = deletion(op)
                    self.http.add(code, body)
                    ack = self.provider.cleanup(delete, op, created, current)
                    self.assertFalse(ack['write_terminal'])
                    self.http.add(404)
                    self.assertNotEqual('succeeded', self.provider.readback(delete, ack)['state'])

    def test_location_delete_204_requires_empty_wire_body(self):
        op, pending = self.lro('jobs', 'resource', 'location')
        delete = deletion(op)
        pending = self.provider.normalize_write(delete, {'status': 202, 'body': b'',
            'headers': {'location': pending['operation_url'], 'retry-after': '2'}})
        self.clock.advance(2)
        self.http.add(204, {})
        ack = self.provider.poll(delete, pending)
        self.assertFalse(ack['write_terminal'])
        self.http.add(204)
        self.assertTrue(self.provider.poll(delete, pending)['write_terminal'])

    def test_stale_evidence_blocks_wire_after_credentials_and_budget_fsync(self):
        from scripts.trial_provision.journal import CountedControlHttp
        for method in ('PUT', 'PATCH', 'DELETE'):
            for delay_point in ('credential', 'budget'):
                with self.subTest(method=method, delay_point=delay_point):
                    self.setUp()
                    prior = operation('jobs')
                    if method == 'PUT':
                        before = self.absent(prior)
                        send = lambda: self.provider.send(prior, before)
                    else:
                        created, current = self.created(prior), self.current(prior)
                        send = (lambda: self.provider.update(self.patch_operation(prior), prior, created, current)) if method == 'PATCH' else (
                            lambda: self.provider.cleanup(deletion(prior), prior, created, current))
                    self.clock.advance(25)
                    if delay_point == 'credential':
                        self.credential.delay = 6
                    else:
                        clock = self.clock
                        class DelayedBudget:
                            def consume(self, kind, limit): clock.advance(6)
                        self.provider.http = CountedControlHttp(self.http, DelayedBudget())
                    count = len(self.http.calls)
                    ack = send()
                    self.assertEqual(count, len(self.http.calls))
                    self.assertFalse(ack['write_terminal'])

    def test_reference_evidence_is_rechecked_after_budget_fsync(self):
        from scripts.trial_provision.journal import CountedControlHttp
        op = operation('userAssignedIdentities')
        created, current = self.created(op), self.current(op)
        evidence = {'object_id': created['object_id'], 'creation_request_digest': digest(op), 'complete': True,
            'references': 0, 'all_trial_apps_and_jobs': True, 'observed_at': self.clock.utc().isoformat()}
        self.clock.advance(25)
        current = self.current(op)
        clock = self.clock
        class DelayedBudget:
            def consume(self, kind, limit): clock.advance(6)
        self.provider.http = CountedControlHttp(self.http, DelayedBudget())
        count = len(self.http.calls)
        ack = self.provider.cleanup(deletion(op), op, created, current, evidence)
        self.assertEqual(count, len(self.http.calls))
        self.assertFalse(ack['write_terminal'])

    def test_role_cleanup_requires_all_scopes_eligible_zero_reference(self):
        op = operation('roleDefinitions')
        receipt = self.created(op)
        current = self.current(op)
        evidence = {'object_id': receipt['object_id'], 'creation_request_digest': digest(op), 'complete': True,
                    'references': 0, 'eligible_references': 0, 'assignable_scopes': [RG],
                    'observed_at': self.clock.utc().isoformat()}
        for field, value in (('complete', False), ('references', False), ('references', 1), ('eligible_references', 1), ('assignable_scopes', [SUB])):
            bad = deepcopy(evidence)
            bad[field] = value
            with self.assertRaises(Denied): self.provider.cleanup(deletion(op), op, receipt, current, bad)
        self.http.add(200)
        self.assertTrue(self.provider.cleanup(deletion(op), op, receipt, current, evidence)['write_terminal'])

    def test_uami_cleanup_requires_app_job_reference_proof(self):
        op = operation('userAssignedIdentities')
        receipt = self.created(op)
        current = self.current(op)
        with self.assertRaises(Denied): self.provider.cleanup(deletion(op), op, receipt, current)
        evidence = {'object_id': receipt['object_id'], 'creation_request_digest': digest(op), 'complete': True,
                    'references': 0, 'all_trial_apps_and_jobs': True, 'observed_at': self.clock.utc().isoformat()}
        self.http.add(204)
        self.assertTrue(self.provider.cleanup(deletion(op), op, receipt, current, evidence)['write_terminal'])

    def test_get_is_not_write_success_and_wrong_id_is_unknown(self):
        op = operation()
        self.http.add(200, resource(op))
        result = self.provider.readback(op)
        self.assertEqual('matching', result['state'])
        self.assertFalse(result['readback_verified'])
        value = resource(op)
        value['id'] += '-other'
        self.http.add(200, value)
        self.assertEqual('unknown', self.provider.readback(op)['state'])

    def test_plan_body_hash_types_unknown_fields_and_secrets_projection_rejected(self):
        for mutate in (lambda op: op.update(extra=True), lambda op: op['expected'].update(body_sha256='0' * 64),
                       lambda op: op['expected'].update(properties={'properties.password': 'canary'}),
                       lambda op: op['expected'].update(receipt_properties=['token'])):
            op = operation()
            mutate(op)
            with self.assertRaises(Denied): _validate(op)

    def test_each_response_no_retry_including_429_and_5xx(self):
        for code in (401, 403, 409, 429, 500, 503):
            op = operation()
            pre = self.absent(op)
            self.http.add(code, {'error': {'message': 'canary-secret'}})
            before = len(self.http.calls)
            result = self.provider.send(op, pre)
            self.assertEqual(before + 1, len(self.http.calls))
            self.assertIn(result['state'], ('unknown', 'failed'))
            self.assertNotIn('canary-secret', json.dumps(result))

    def secret_operation(self):
        op = operation('containerApps')
        fingerprint = hashlib.sha256(b'canary-secret').hexdigest()
        op['body']['properties']['configuration']['secrets'] = [{'name': 'trial-web-database',
            'value': {'$secretBinding': 'trial-web-database', 'sha256': fingerprint}}]
        op['expected']['secret_bindings'] = [{'source': 'trial-web-database', 'sha256': fingerprint}]
        op['expected']['body_sha256'] = digest(op['body'])
        return op

    def test_private_secret_resolves_only_wire_and_never_receipt(self):
        op = self.secret_operation()
        self.provider.private_secret_resolver = lambda source: 'canary-secret'
        validation = self.provider.validate(op)
        self.assertEqual(digest(op), validation['request_digest'])
        self.assertEqual([], self.http.calls)
        pre = self.absent(op)
        masked = resource(op)
        masked['properties']['configuration']['secrets'] = [{'name': 'trial-web-database'}]
        self.http.add(201, masked)
        ack = self.provider.send(op, pre)
        self.assertIn(b'canary-secret', self.http.calls[-1][2])
        self.http.add(200, masked)
        result = self.provider.readback(op, ack)
        self.assertEqual('succeeded', result['state'])
        self.assertNotIn('canary-secret', json.dumps(result))
        self.assertNotIn('canary-secret', json.dumps(op))

    def test_secret_missing_mismatch_unknown_source_and_raw_value_deny_before_token(self):
        op = self.secret_operation()
        with self.assertRaises(Denied): self.provider.validate(op)
        self.provider.private_secret_resolver = lambda source: 'wrong'
        with self.assertRaises(Denied): self.provider.validate(op)
        for value in ('canary-secret', {'$secretBinding': 'other', 'sha256': 'a' * 64}):
            bad = deepcopy(op)
            bad['body']['properties']['configuration']['secrets'][0]['value'] = value
            bad['expected']['body_sha256'] = digest(bad['body'])
            with self.assertRaises(Denied): self.provider.validate(bad)
        self.assertEqual(0, self.credential.calls)
        self.assertEqual([], self.http.calls)

    def test_secret_resolver_change_after_validation_never_sends(self):
        op = self.secret_operation()
        self.provider.private_secret_resolver = lambda source: 'canary-secret'
        self.provider.validate(op)
        pre = self.absent(op)
        self.provider.private_secret_resolver = lambda source: 'changed'
        with self.assertRaises(Denied): self.provider.send(op, pre)
        self.assertEqual(['GET'], [x[0] for x in self.http.calls])

    def test_unlisted_secret_placeholder_elsewhere_rejected(self):
        op = self.secret_operation()
        op['body']['properties']['template']['containers'][0]['env'] = [{'name': 'OTHER', 'value': {'$secretBinding': 'trial-web-database', 'sha256': 'a' * 64}}]
        op['expected']['body_sha256'] = digest(op['body'])
        self.provider.private_secret_resolver = lambda source: 'canary-secret'
        with self.assertRaises(Denied): self.provider.validate(op)
        self.assertEqual(0, self.credential.calls)

    def test_readback_compares_all_supplied_body_fields_not_only_projection(self):
        op = operation('containerApps')
        value = resource(op)
        value['properties']['template']['containers'][0]['image'] = 'changed'
        self.http.add(200, value)
        self.assertEqual('unknown', self.provider.readback(op)['state'])

    def test_create_200_never_confers_ownership_for_any_provider(self):
        for kind in ('userAssignedIdentities', 'roleAssignments', 'containerApps', 'jobs'):
            op = operation(kind)
            pre = self.absent(op)
            self.http.add(200, resource(op))
            self.assertEqual('unknown', self.provider.send(op, pre)['state'])

    def test_delete_body_and_target_cannot_change(self):
        op = operation()
        receipt, current = self.created(op), self.current(op)
        changed = deletion(op)
        changed['expected']['properties']['properties.publicAccess'] = 'Blob'
        with self.assertRaises(Denied): self.provider.cleanup(changed, op, receipt, current)
        self.assertNotIn('DELETE', [x[0] for x in self.http.calls])

    def patch_operation(self, prior):
        op = deepcopy(prior)
        op.update(id='configure-' + prior['kind'], method='PATCH',
                  body={'properties': {'template': {'containers': [{'name': 'web', 'image': 'fictional.azurecr.io/trial@sha256:' + 'b' * 64}]}}})
        op['expected'].update(before_absent=False, update_from={'operation_id': prior['id'], 'request_digest': digest(prior)},
                              body_sha256=digest(op['body']))
        if prior['kind'] == 'jobs':
            op['expected']['properties']['properties.configuration.triggerType'] = 'Manual'
        return op

    def test_patch_requires_known_owned_prior_and_preserves_target(self):
        prior = operation('containerApps')
        receipt, current = self.created(prior), self.current(prior)
        op = self.patch_operation(prior)
        for field, change in (('request_digest', '0' * 64), ('operation_id', 'other')):
            bad = deepcopy(op)
            bad['expected']['update_from'][field] = change
            with self.assertRaises(Denied): self.provider.update(bad, prior, receipt, current)
        bad = deepcopy(receipt)
        bad['state'] = 'unknown'
        with self.assertRaises(Denied): self.provider.update(op, prior, bad, current)
        self.assertNotIn('PATCH', [x[0] for x in self.http.calls])

    def test_patch_known_ack_plus_matching_get_retains_ownership(self):
        prior = operation('containerApps')
        receipt, current = self.created(prior), self.current(prior)
        op = self.patch_operation(prior)
        actual = resource(prior)
        actual['properties']['template'] = deepcopy(op['body']['properties']['template'])
        self.http.add(200, actual)
        ack = self.provider.update(op, prior, receipt, current)
        self.assertTrue(ack['write_terminal'])
        self.http.add(200, actual)
        final = self.provider.readback(op, ack)
        self.assertEqual('succeeded', final['state'])
        self.assertTrue(final['created_by_run'])

    def test_nested_provider_defaults_allowed_but_extra_identity_denied(self):
        op = operation('containerApps')
        identity = RG + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trial-web'
        op['body']['identity'] = {'type': 'UserAssigned', 'userAssignedIdentities': {identity: {}}}
        op['expected']['properties']['identity.userAssignedIdentities'] = {identity: {}}
        op['expected']['properties']['properties.template'] = deepcopy(op['body']['properties']['template'])
        op['expected']['body_sha256'] = digest(op['body'])
        actual = resource(op)
        actual['identity']['userAssignedIdentities'][identity] = {'clientId': UUID, 'principalId': UUID}
        actual['properties']['template']['containers'][0]['resources'] = {'ephemeralStorage': '1Gi'}
        self.http.add(200, actual)
        self.assertEqual('matching', self.provider.readback(op)['state'])
        actual['identity']['userAssignedIdentities'][identity + '-other'] = {}
        self.http.add(200, actual)
        self.assertEqual('unknown', self.provider.readback(op)['state'])

    def test_aca_delete_location_lro_then_absence(self):
        op = operation('containerApps')
        receipt, current = self.created(op), self.current(op)
        delete = deletion(op)
        url = 'https://management.azure.com' + SUB + '/providers/Microsoft.App/locations/eastus/containerappOperationResults/' + UUID + '?api-version=2025-07-01'
        self.http.add(202, headers={'location': url})
        pending = self.provider.cleanup(delete, op, receipt, current)
        self.clock.advance(1)
        self.http.add(204)
        ack = self.provider.poll(delete, pending)
        self.assertTrue(ack['write_terminal'])
        self.http.add(404)
        self.assertEqual('succeeded', self.provider.readback(delete, ack)['state'])

    def test_normalize_auth_patch_response_has_no_http_or_raw_body(self):
        prior = operation('containerApps')
        op = self.patch_operation(prior)
        value = resource(prior)
        value['properties']['configuration']['secrets'] = [{'name': 'auth', 'value': 'canary-secret'}]
        receipt = self.provider.normalize_write(op, {'status': 200, 'headers': {}, 'body': encoded(value)})
        self.assertTrue(receipt['write_terminal'])
        self.assertFalse(receipt['readback_verified'])
        self.assertNotIn('canary-secret', json.dumps(receipt))
        self.assertEqual([], self.http.calls)
        self.assertEqual(0, self.credential.calls)

    def test_create_200_cannot_bypass_ownership_rejection_with_async_header(self):
        op = operation('containerApps')
        pre = self.absent(op)
        url = 'https://management.azure.com' + SUB + '/providers/Microsoft.App/locations/eastus/containerappOperationStatuses/' + UUID + '?api-version=2025-07-01'
        self.http.add(200, resource(op), {'azure-asyncoperation': url})
        receipt = self.provider.send(op, pre)
        self.assertEqual('unknown', receipt['state'])
        self.http.add(200, resource(op))
        self.assertEqual('unknown', self.provider.readback(op, receipt)['state'])

    def test_known_write_ack_survives_get_failure_without_resending(self):
        op = operation()
        pre = self.absent(op)
        self.http.add(201, resource(op))
        receipt = self.provider.send(op, pre)
        self.http.responses.append(TimeoutError('canary'))
        pending = self.provider.readback(op, receipt)
        self.assertEqual('pending', pending['state'])
        self.assertTrue(pending['write_terminal'])
        self.assertEqual(receipt['initial_ack_digest'], pending['initial_ack_digest'])
        self.http.add(200, resource(op))
        self.assertEqual('succeeded', self.provider.readback(op, pending)['state'])
        self.assertEqual(1, sum(x[0] == 'PUT' for x in self.http.calls))

    def test_known_initial_lro_ack_survives_poll_failure(self):
        op, receipt = self.lro()
        self.clock.advance(2)
        self.http.responses.append(TimeoutError('canary'))
        pending = self.provider.poll(op, receipt)
        self.assertEqual('pending', pending['state'])
        self.assertFalse(pending['write_terminal'])
        self.assertEqual(receipt['operation_url'], pending['operation_url'])
        self.http.add(200, {'status': 'Succeeded'})
        ack = self.provider.poll(op, pending)
        self.assertTrue(ack['write_terminal'])
        self.assertEqual(1, sum(x[0] == 'PUT' for x in self.http.calls))

    def test_provisioner_never_uses_guardian_credential(self):
        self.credential.mode = 'guardian'
        with self.assertRaises(Denied): BoundedArmProvider(self.credential, self.http, self.clock)
        self.assertEqual(0, self.credential.calls)
        self.assertEqual([], self.http.calls)

    def test_auth_metadata_does_not_enable_new_provider_or_operation(self):
        prior = operation('containerApps')
        op = self.patch_operation(prior)
        op['expected'].update(auth_action='authPlatformSecret', credentialOperationId='credential-slot',
                              creation_request_digest='a' * 64, references_cleared=False)
        self.assertEqual(op, _validate(op))
        for key, value in (('method', 'POST'), ('provider', 'Microsoft.Graph'), ('kind', 'authConfigs')):
            bad = deepcopy(op)
            bad[key] = value
            with self.assertRaises(Denied): _validate(bad)

    def test_actual_resource_compiler_operations_satisfy_provider_contract(self):
        from scripts.trial_provision.resources import build_resource_operations
        from scripts.trial_provision.tests.test_resources import fixture
        operations = build_resource_operations(*fixture())
        self.assertEqual(9, len(operations))
        for op in operations:
            with self.subTest(slot=op['id']):
                self.assertEqual(op, _validate(op))

    def test_manual_job_timeout_patch_preserves_manual_trigger_binding(self):
        prior = operation('jobs')
        op = self.patch_operation(prior)
        op['body'] = {'properties': {'configuration': {'replicaTimeout': 1800}}}
        op['expected']['body_sha256'] = digest(op['body'])
        op['expected']['properties']['properties.configuration.triggerType'] = 'Manual'
        self.assertEqual(op, _validate(op))
        op['expected']['properties']['properties.configuration.triggerType'] = 'Schedule'
        with self.assertRaises(Denied): _validate(op)

    def test_expired_cleanup_due_does_not_abandon_known_created_target(self):
        op = operation()
        receipt = self.created(op)
        self.clock.advance(601)
        self.assertEqual('unknown', self.provider.readback(op)['state'])
        self.http.add(200, resource(op))
        current = self.provider.inspect_cleanup(op, receipt)
        self.assertEqual('matching', current['state'])
        delete = deletion(op)
        self.http.add(204)
        ack = self.provider.cleanup(delete, op, receipt, current)
        self.assertTrue(ack['cleanup_overdue'])
        self.http.add(404)
        self.assertEqual('succeeded', self.provider.readback(delete, ack)['state'])
        self.assertEqual(op['deadline'], delete['deadline'])

    def test_expired_inspect_cleanup_cannot_adopt_unknown_creation(self):
        op = operation()
        receipt = self.created(op)
        receipt.update(state='unknown', readback_verified=False)
        self.clock.advance(601)
        with self.assertRaises(Denied): self.provider.inspect_cleanup(op, receipt)

    def test_cleanup_composed_body_requires_additional_exact_readback(self):
        op = operation('containerApps')
        receipt = self.created(op)
        delete = deletion(op)
        delete['expected']['properties'] = deepcopy(op['body'])
        ordinary = self.current(op)
        with self.assertRaises(Denied): self.provider.cleanup(delete, op, receipt, ordinary)
        self.http.add(200, resource(op))
        current = self.provider.inspect_cleanup(op, receipt, delete)
        self.assertEqual(digest(delete), current['cleanup_binding_digest'])
        self.http.add(204)
        self.assertTrue(self.provider.cleanup(delete, op, receipt, current)['write_terminal'])

    def test_composed_cleanup_cannot_weaken_last_body_or_ignore_changed_image(self):
        op = operation('containerApps')
        receipt = self.created(op)
        delete = deletion(op)
        delete['expected']['properties'] = deepcopy(op['body'])
        bad = deepcopy(delete)
        bad['expected']['properties']['properties'].pop('template')
        before = len(self.http.calls)
        with self.assertRaises(Denied): self.provider.inspect_cleanup(op, receipt, bad)
        self.assertEqual(before, len(self.http.calls))
        actual = resource(op)
        actual['properties']['template']['containers'][0]['image'] = 'fictional.azurecr.io/changed'
        self.http.add(200, actual)
        self.assertEqual('unknown', self.provider.inspect_cleanup(op, receipt, delete)['state'])

    def test_cleanup_cross_adapter_receipt_checks_declared_projection_and_full_state(self):
        op = operation('containerApps')
        receipt = self.created(op)
        # Auth's final journal receipt contains additional preservation proofs;
        # they are not ARM projection fields or raw resource response values.
        receipt['properties'].update(kind='authIngress', retainedConfigurationDigest='1' * 64,
                                     retainedTemplateDigest='2' * 64)
        delete = deletion(op)
        delete['expected']['properties'] = deepcopy(op['body'])
        self.http.add(200, resource(op))
        current = self.provider.inspect_cleanup(op, receipt, delete)
        self.http.add(204)
        self.assertTrue(self.provider.cleanup(delete, op, receipt, current)['write_terminal'])


if __name__ == '__main__': unittest.main()
