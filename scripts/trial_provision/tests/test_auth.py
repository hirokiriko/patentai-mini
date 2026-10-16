"""Offline state-boundary tests; no Azure CLI, token, network or real IDs."""
from copy import deepcopy
import json
import unittest

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_provision.auth import (
    AuthDenied, GraphAdapter, GRAPH, EXPIRY, completed, progress,
    EasyAuthAdapter, auth_configuration, build_auth_operations, ARM, API_VERSION,
    build_auth_cleanup, instant,
)


APP = '11111111-1111-4111-8111-111111111111'
CLIENT = '22222222-2222-4222-8222-222222222222'
SP = '33333333-3333-4333-8333-333333333333'
OWNER = '44444444-4444-4444-8444-444444444444'
TENANT = '55555555-5555-4555-8555-555555555555'
ROLE = '66666666-6666-4666-8666-666666666666'
KEY = '77777777-7777-4777-8777-777777777777'
OTHER = '88888888-8888-4888-8888-888888888888'
T0 = '2026-10-11T00:00:00Z'
END = '2026-10-11T00:01:00Z'
SECRET = 'fixture-secret-not-for-receipts'


class Clock:
    def __init__(self):
        from scripts.trial_provision.auth import instant
        self.value = instant(T0)
        self.mono = 0

    def __call__(self):
        return self.value

    def monotonic(self):
        return self.mono

    def utc(self):
        from datetime import datetime, timezone
        return datetime.fromtimestamp(self.value, timezone.utc)


class Credential:
    mode, principal, tenant = 'owner', OWNER, TENANT
    def __init__(self):
        self.audiences = []

    def token(self, audience, deadline):
        self.audiences.append(audience)
        deadline.remaining()
        return 'offline-fixture-token'


class Wire:
    def __init__(self, responses=()):
        self.responses, self.calls = list(responses), []

    def __call__(self, method, url, headers, body, deadline):
        self.calls.append((method, url, json.loads(body) if body else None, headers))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def response(status, body=None, headers=None):
    return {'status': status, 'body': encoded(body) if body is not None else b'', 'headers': headers or {}}


def binding():
    return {'tenant_id': TENANT, 'owner_id': OWNER, 'app_role_id': ROLE,
            'application_display_name': 'fictional-trial-auth',
            'credential_display_name': 'fictional-trial-one-secret',
            'credential_expires_at': EXPIRY,
            'redirect_uri': 'https://fictional-trial.fictional-env.japaneast.azurecontainerapps.io/.auth/login/aad/callback'}


def operation(kind, body, url, ident=None):
    return {'id': ident or kind, 'provider': 'Microsoft.Graph', 'kind': kind,
            'method': 'POST', 'url': url, 'body': body, 'deadline': END,
            'depends_on': [], 'expected': {'body_sha256': digest(body)}, 'cleanup': {}}


def operations():
    e1 = operation('applications', {'displayName': 'fictional-trial-auth',
        'signInAudience': 'AzureADMyOrg', 'web': {'redirectUris': [binding()['redirect_uri']],
            'implicitGrantSettings': {'enableIdTokenIssuance': True, 'enableAccessTokenIssuance': False}},
        'requiredResourceAccess': [], 'passwordCredentials': [],
        'appRoles': [{'id': ROLE, 'displayName': 'OWNER', 'description': 'OWNER',
                      'allowedMemberTypes': ['User'], 'isEnabled': True, 'value': 'OWNER'}]}, GRAPH + '/applications')
    e2 = operation('servicePrincipals', {'appId': CLIENT, 'appRoleAssignmentRequired': True}, GRAPH + '/servicePrincipals')
    e3 = operation('appRoleAssignedTo', {'principalId': OWNER, 'resourceId': SP, 'appRoleId': ROLE}, GRAPH + '/servicePrincipals/' + SP + '/appRoleAssignedTo')
    e4 = operation('addPassword', {'passwordCredential': {'displayName': binding()['credential_display_name'], 'startDateTime': T0, 'endDateTime': EXPIRY}}, GRAPH + '/applications/' + APP + '/addPassword')
    for i, op in enumerate((e1, e2, e3, e4)):
        op['depends_on'] = [p['id'] for p in (e1, e2, e3, e4)[:i]]
    return e1, e2, e3, e4


def receipts():
    props = [dict(kind='applications', applicationObjectId=APP, appId=CLIENT),
             dict(kind='servicePrincipals', servicePrincipalObjectId=SP, appId=CLIENT),
             dict(kind='appRoleAssignedTo', directoryAssignmentId='opaque-assignment', principalId=OWNER, resourceId=SP, appRoleId=ROLE)]
    return {op['id']: completed(progress(op, ident, prop, True)) for op, ident, prop in zip(operations()[:3], (APP, SP, 'opaque-assignment'), props)}


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.wire = Wire()
        self.credential = Credential()
        self.adapter = GraphAdapter(binding(), self.credential, self.wire, self.clock, self.clock.monotonic)
        self.intents, self.checkpoints = [], []

    def run_op(self, op, previous=None, delivery=None):
        return self.adapter.execute(op, previous or {}, self.intents.append, self.checkpoints.append, delivery)

    def test_application_success_post_ack_then_exact_get(self):
        op = operations()[0]
        value = dict(op['body'], id=APP, appId=CLIENT)
        self.wire.responses = [response(201, value), response(200, value)]
        result = self.run_op(op)
        self.assertTrue(result['readback_verified'])
        self.assertEqual([c[0] for c in self.wire.calls], ['POST', 'GET'])
        self.assertEqual(self.wire.calls[1][1], GRAPH + '/applications/' + APP)
        self.assertFalse(self.checkpoints[0]['terminal'])
        self.assertTrue(self.checkpoints[0]['write_terminal'])
        self.assertEqual(self.credential.audiences, ['https://graph.microsoft.com/'] * 2)

    def test_graph_server_app_role_metadata_does_not_break_exact_role_count(self):
        op = operations()[0]
        value = dict(deepcopy(op['body']), id=APP, appId=CLIENT)
        value['appRoles'][0]['origin'] = 'Application'
        self.wire.responses = [response(201, value), response(200, value)]
        self.assertTrue(self.run_op(op)['terminal'])
        other = deepcopy(value)
        other['appRoles'].append(dict(value['appRoles'][0], id=OTHER))
        self.wire.responses = [response(200, other)]
        known = progress(op, APP, {'kind': 'applications', 'appId': CLIENT, 'applicationObjectId': APP}, True)
        self.assertFalse(self.adapter.readback(op, known)['terminal'])

    def test_unknown_post_no_list_or_retry_even_same_process(self):
        op = operations()[0]
        self.wire.responses = [TimeoutError('sensitive-response')]
        result = self.run_op(op)
        self.assertFalse(result['terminal'])
        self.run_op(op)
        self.assertEqual(len(self.wire.calls), 1)
        with self.assertRaises(AuthDenied):
            self.run_op(op, {op['id']: result})
        self.assertNotIn('sensitive', json.dumps(result))

    def test_creation_readback_wrong_id_remains_pending_with_cleanup_id(self):
        op = operations()[0]
        value = dict(op['body'], id=APP, appId=CLIENT)
        self.wire.responses = [response(201, value), response(200, dict(value, id=OTHER))]
        result = self.run_op(op)
        self.assertEqual(result['object_id'], APP)
        self.assertTrue(result['write_terminal'])
        self.assertFalse(result['terminal'])

    def test_readback_resume_is_get_only(self):
        op = operations()[0]
        value = dict(op['body'], id=APP, appId=CLIENT)
        pending = progress(op, APP, {'kind': 'applications', 'appId': CLIENT, 'applicationObjectId': APP}, True)
        self.wire.responses = [response(200, value)]
        self.assertTrue(self.adapter.readback(op, pending)['terminal'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET'])

    def test_body_hash_mismatch_rejected_before_token(self):
        op = operations()[0]
        op['body']['signInAudience'] = 'AzureADMultipleOrgs'
        with self.assertRaises(AuthDenied):
            self.run_op(op)
        self.assertEqual(self.credential.audiences, [])

    def test_second_redirect_and_permission_denied(self):
        for mutate in (lambda b: b['web']['redirectUris'].append('https://other.example/callback'),
                       lambda b: b['requiredResourceAccess'].append({'resourceAppId': OTHER})):
            op = operations()[0]
            mutate(op['body'])
            op['expected']['body_sha256'] = digest(op['body'])
            with self.assertRaises(AuthDenied):
                self.run_op(op)
        self.assertEqual(self.wire.calls, [])

    def test_sp_and_owner_assignment_exact_readback(self):
        for op, ident in zip(operations()[1:3], (SP, 'opaque-assignment')):
            value = dict(op['body'], id=ident)
            self.wire.responses = [response(201, value), response(200, value)]
            previous = {k: v for k, v in receipts().items() if k != op['id']}
            self.assertTrue(self.run_op(op, previous)['terminal'])

    def test_wrong_owner_rejected_before_token(self):
        op = operations()[2]
        op['body']['principalId'] = OTHER
        op['expected']['body_sha256'] = digest(op['body'])
        previous = {k: v for k, v in receipts().items() if k != op['id']}
        with self.assertRaises(AuthDenied):
            self.run_op(op, previous)
        self.assertEqual(self.credential.audiences, [])

    def test_password_checkpoint_before_delivery_no_secret_persisted(self):
        op = operations()[3]
        value = dict(op['body']['passwordCredential'], keyId=KEY, secretText=SECRET)
        self.wire.responses = [response(200, value), response(200, {'id': APP, 'passwordCredentials': [dict(op['body']['passwordCredential'], keyId=KEY)]})]
        delivered = []
        def deliver(secret, receipt):
            self.assertEqual(secret, SECRET)
            self.assertEqual(len(self.checkpoints), 2)
            self.assertTrue(self.checkpoints[-1]['readback_verified'])
            delivered.append(receipt)
        result = self.run_op(op, receipts(), deliver)
        self.assertTrue(result['terminal'])
        self.assertEqual(len(delivered), 1)
        self.assertNotIn(SECRET, json.dumps(self.intents + self.checkpoints + [result]))

    def test_password_checkpoint_failure_prevents_delivery_and_recreation(self):
        op = operations()[3]
        value = dict(op['body']['passwordCredential'], keyId=KEY, secretText=SECRET)
        self.wire.responses = [response(200, value)]
        def failed(_):
            raise OSError('private path')
        delivered = []
        result = self.adapter.execute(op, receipts(), self.intents.append, failed, lambda *v: delivered.append(v))
        self.assertEqual(result['object_id'], KEY)
        self.assertFalse(result['terminal'])
        self.assertEqual(delivered, [])
        self.assertEqual([x[0] for x in self.wire.calls], ['POST'])

    def test_password_delivery_failure_retains_checkpoint_no_retry(self):
        op = operations()[3]
        value = dict(op['body']['passwordCredential'], keyId=KEY, secretText=SECRET)
        self.wire.responses = [response(200, value), response(200, {'id': APP, 'passwordCredentials': [dict(op['body']['passwordCredential'], keyId=KEY)]})]
        def failed(*_):
            raise TimeoutError(SECRET)
        self.run_op(op, receipts(), failed)
        self.assertTrue(self.checkpoints[-1]['terminal'])
        self.run_op(op, receipts(), failed)
        self.assertEqual([x[0] for x in self.wire.calls], ['POST', 'GET'])

    def test_password_expiry_extension_rejected(self):
        op = operations()[3]
        op['body']['passwordCredential']['endDateTime'] = '2027-01-30T00:00:00Z'
        op['expected']['body_sha256'] = digest(op['body'])
        with self.assertRaises(AuthDenied):
            self.run_op(op, receipts(), lambda *_: None)
        self.assertEqual(self.wire.calls, [])

    def test_deadline_and_rollback_use_monotonic_highwater(self):
        self.clock.mono = 61
        self.clock.value -= 600
        with self.assertRaises(AuthDenied):
            self.run_op(operations()[0])
        self.assertEqual(self.wire.calls, [])

    def test_durable_intent_failure_sends_nothing(self):
        def fail(_):
            raise OSError('private journal path')
        result = self.adapter.execute(operations()[0], {}, fail, self.checkpoints.append)
        self.assertFalse(result['write_terminal'])
        self.assertEqual(self.wire.calls, [])

    def cleanup_op(self, create, ident):
        op = operation('cleanup:' + create['kind'], None, create['url'] + '/' + ident, 'cleanup-' + create['kind'])
        op['method'] = 'DELETE'
        op['expected'].update(creation_request_digest=digest(create), references_cleared=True)
        return op

    def test_cleanup_terminal_delete_and_404_only(self):
        create = operations()[0]
        receipt = receipts()[create['id']]
        op = self.cleanup_op(create, APP)
        value = dict(create['body'], id=APP, appId=CLIENT)
        self.wire.responses = [response(200, value), response(204), response(404)]
        result = self.adapter.cleanup(create, receipt, op, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['absent'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET', 'DELETE', 'GET'])

    def test_unknown_delete_never_get404_to_false_closed_or_resend(self):
        create = operations()[0]
        op = self.cleanup_op(create, APP)
        value = dict(create['body'], id=APP, appId=CLIENT)
        self.wire.responses = [response(200, value), TimeoutError(), response(200, value)]
        result = self.adapter.cleanup(create, receipts()[create['id']], op, self.intents.append, self.checkpoints.append)
        self.assertFalse(result['terminal'])
        self.adapter.cleanup(create, receipts()[create['id']], op, self.intents.append, self.checkpoints.append)
        self.assertEqual(sum(x[0] == 'DELETE' for x in self.wire.calls), 1)

    def test_cleanup_foreign_receipt_rejected(self):
        create = operations()[0]
        receipt = receipts()[create['id']]
        receipt['request_digest'] = '0' * 64
        with self.assertRaises(AuthDenied):
            self.adapter.cleanup(create, receipt, self.cleanup_op(create, APP), self.intents.append, self.checkpoints.append)
        self.assertEqual(self.wire.calls, [])

    def test_cleanup_wrong_current_body_sends_no_delete(self):
        create = operations()[0]
        value = dict(create['body'], id=APP, appId=CLIENT, displayName='foreign')
        self.wire.responses = [response(200, value)]
        result = self.adapter.cleanup(create, receipts()[create['id']], self.cleanup_op(create, APP), self.intents.append, self.checkpoints.append)
        self.assertFalse(result['terminal'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET'])

    def test_unknown_cleanup_readback_does_not_issue_get_or_claim_absence(self):
        create = operations()[0]
        op = self.cleanup_op(create, APP)
        unknown = progress(op, APP)
        result = self.adapter.readback_cleanup(create, receipts()[create['id']], op, unknown)
        self.assertFalse(result['terminal'])
        self.assertEqual(self.wire.calls, [])

    def test_boolean_integer_not_treated_as_assignment_required(self):
        op = operations()[1]
        op['body']['appRoleAssignmentRequired'] = 1
        op['expected']['body_sha256'] = digest(op['body'])
        with self.assertRaises(AuthDenied):
            self.run_op(op, {'applications': receipts()['applications']})
        self.assertEqual(self.wire.calls, [])

    def test_guardian_or_foreign_owner_credential_rejected(self):
        credential = Credential()
        credential.mode = 'guardian'
        with self.assertRaises(AuthDenied):
            GraphAdapter(binding(), credential, self.wire, self.clock)

    def test_password_cleanup_missing_collection_does_not_prove_absent(self):
        create = operations()[3]
        creation = all_receipts()[create['id']]
        proof = {'complete': True, 'creation_request_digest': digest(create),
                 'creation_receipt_digest': digest(creation), 'object_id': KEY, 'depends_on': []}
        op = build_auth_cleanup(create, creation, easy_binding(), END, proof)
        current = {'id': APP, 'passwordCredentials': [dict(create['body']['passwordCredential'], keyId=KEY)]}
        self.wire.responses = [response(200, current), response(204), response(200, {'id': APP})]
        pending = self.adapter.cleanup(create, creation, op, self.intents.append, self.checkpoints.append)
        self.assertTrue(pending['write_terminal'])
        self.assertFalse(pending['terminal'])
        self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': []})]
        done = self.adapter.readback_cleanup(create, creation, op, pending)
        self.assertTrue(done['absent'])
        self.assertEqual(sum(x[0] == 'POST' for x in self.wire.calls), 1)

    def test_password_cleanup_malformed_collection_never_absent(self):
        create = operations()[3]
        creation = all_receipts()[create['id']]
        proof = {'complete': True, 'creation_request_digest': digest(create),
                 'creation_receipt_digest': digest(creation), 'object_id': KEY, 'depends_on': []}
        op = build_auth_cleanup(create, creation, easy_binding(), END, proof)
        acknowledged = progress(op, KEY)
        acknowledged['write_terminal'] = True
        for value in (None, [None], [{'keyId': 'invalid'}], [{'keyId': KEY}, {'keyId': KEY}]):
            self.wire.responses = [response(200, {'id': APP, 'passwordCredentials': value})]
            self.assertFalse(self.adapter.readback_cleanup(create, creation, op, acknowledged)['terminal'])

    def test_application_cleanup_factory_requires_complete_bound_references(self):
        create = operations()[0]
        creation = receipts()[create['id']]
        proof = {'complete': True, 'creation_request_digest': digest(create),
                 'creation_receipt_digest': digest(creation), 'object_id': APP,
                 'depends_on': ['cleanup_E2'], 'references_cleared': False}
        with self.assertRaises(AuthDenied):
            build_auth_cleanup(create, creation, easy_binding(), END, proof)
        proof['references_cleared'] = True
        op = build_auth_cleanup(create, creation, easy_binding(), END, proof)
        self.assertEqual(op['url'], GRAPH + '/applications/' + APP)
        self.assertEqual(op['depends_on'], ['cleanup_E2'])
        self.assertIsNone(op['body'])


TARGET = '/subscriptions/' + OTHER + '/resourceGroups/fictional-trial/providers/Microsoft.App/containerApps/fictional-trial'
RUNTIME_SECRET = 'trial-web-database'
AUTH_SECRET = 'trial-auth-secret'


def easy_binding():
    return dict(binding(), target_app_id=TARGET, platform_secret_name=AUTH_SECRET,
                runtime_secret_names=[RUNTIME_SECRET], location='japaneast',
                environment_id=TARGET.split('/providers/')[0] + '/providers/Microsoft.App/managedEnvironments/fictional-env')


def app_value(names=None, external=False):
    return {'id': TARGET, 'location': 'japaneast', 'properties': {'provisioningState': 'Succeeded',
            'environmentId': easy_binding()['environment_id'],
            'configuration': {'secrets': [{'name': n} for n in (names if names is not None else [RUNTIME_SECRET])],
                'ingress': {'external': external, 'targetPort': 3000,
                    'fqdn': 'fictional-trial.' + ('' if external else 'internal.') + 'fictional-env.japaneast.azurecontainerapps.io'}, 'activeRevisionsMode': 'Single'},
            'template': {'containers': [{'name': 'web', 'env': [{'name': 'DATABASE_URL', 'secretRef': RUNTIME_SECRET}]}]}}}


def all_receipts():
    result = receipts()
    app_op = operation('containerApps', {}, ARM + TARGET + '?api-version=' + API_VERSION, 'trial-app')
    result['trial-app'] = completed(progress(app_op, TARGET, {'kind': 'containerApps'}, True))
    e4 = operations()[3]
    result[e4['id']] = completed(progress(e4, KEY, {'kind': 'addPassword', 'keyId': KEY, 'startDateTime': T0, 'endDateTime': EXPIRY}, True))
    return result


class EasyAuthTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.wire, self.credential = Wire(), Credential()
        self.adapter = EasyAuthAdapter(easy_binding(), self.credential, self.wire,
            lambda: {RUNTIME_SECRET: 'fictional-db-value'}, self.clock, self.clock.monotonic)
        self.receipts = all_receipts()
        self.ops = build_auth_operations(easy_binding(), self.receipts, END, 'trial-app')
        self.intents, self.checkpoints = [], []

    def deliver(self):
        return self.adapter.deliver(self.ops[0], SECRET, self.receipts['addPassword'],
            self.intents.append, self.checkpoints.append, self.receipts['trial-app'])

    def seed_config_dependencies(self):
        self.receipts['auth-platform-secret'] = completed(progress(self.ops[0], TARGET,
            {'kind': 'authPlatformSecret', 'secretName': AUTH_SECRET, 'credentialOperationId': 'addPassword'}, True))

    def test_secret_delivery_preserves_runtime_only_memory(self):
        before = app_value()
        after = app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, after)]
        result = self.deliver()
        self.assertTrue(result['terminal'])
        sent = self.wire.calls[2][2]['properties']['configuration']['secrets']
        self.assertEqual(sent, [{'name': RUNTIME_SECRET, 'value': 'fictional-db-value'}, {'name': AUTH_SECRET, 'value': SECRET}])
        self.assertNotIn(SECRET, json.dumps(self.intents + self.checkpoints + [result]))
        self.assertNotIn('fictional-db-value', json.dumps(self.intents + self.checkpoints + [result]))
        self.assertTrue(all('listSecrets' not in c[1] for c in self.wire.calls))

    def test_unknown_platform_patch_does_not_regenerate_or_resend(self):
        before = app_value()
        self.wire.responses = [response(200, before), response(200, before), TimeoutError(SECRET)]
        result = self.deliver()
        self.assertFalse(result['write_terminal'])
        self.assertFalse(self.adapter.readback(self.ops[0], result)['terminal'])
        self.assertEqual(sum(c[0] == 'PATCH' for c in self.wire.calls), 1)

    def test_opaque_foreign_secret_rejects_before_private_values_or_write(self):
        self.adapter.preserved_runtime_secrets = lambda: self.fail('must not obtain secret values')
        self.wire.responses = [response(200, app_value([RUNTIME_SECRET, 'foreign']))]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET'])

    def test_mount_all_secret_volume_rejected(self):
        app = app_value()
        app['properties']['template']['volumes'] = [{'name': 'all', 'storageType': 'Secret'}]
        self.wire.responses = [response(200, app)]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual(len(self.wire.calls), 1)

    def test_auth_secret_env_exposure_rejected(self):
        app = app_value()
        app['properties']['template']['containers'][0]['env'].append({'name': 'BAD', 'secretRef': AUTH_SECRET})
        self.wire.responses = [response(200, app)]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual(len(self.wire.calls), 1)

    def test_auth_secret_scaler_exposure_rejected(self):
        app = app_value()
        app['properties']['template']['scale'] = {'rules': [{'name': 'scaler', 'custom': {'auth': [
            {'triggerParameter': 'token', 'secretRef': AUTH_SECRET}]}}]}
        self.wire.responses = [response(200, app)]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual(len(self.wire.calls), 1)

    def test_changed_config_between_reads_no_write(self):
        first, second = app_value(), app_value()
        second['properties']['configuration']['ingress']['targetPort'] = 8080
        self.wire.responses = [response(200, first), response(200, second)]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET'])

    def test_external_initial_app_refused(self):
        self.wire.responses = [response(200, app_value(external=True))]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET'])

    def test_runtime_callback_extra_name_refused(self):
        self.adapter.preserved_runtime_secrets = lambda: {RUNTIME_SECRET: 'original', 'extra': 'foreign'}
        self.wire.responses = [response(200, app_value()), response(200, app_value())]
        self.assertFalse(self.deliver()['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET'])

    def test_auth_put_shape_owner_only_and_readback(self):
        self.seed_config_dependencies()
        app = app_value([RUNTIME_SECRET, AUTH_SECRET])
        value = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
        self.wire.responses = [response(200, app), response(200, app), response(404), response(200, value), response(200, value)]
        result = self.adapter.execute(self.ops[1], self.receipts, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['terminal'])
        sent = self.wire.calls[3][2]
        self.assertEqual(sent['properties']['globalValidation']['unauthenticatedClientAction'], 'Return401')
        self.assertFalse(sent['properties']['login']['tokenStore']['enabled'])
        self.assertNotIn('requireAuthentication', json.dumps(sent))

    def test_auth_readback_extra_group_and_enabled_provider_refused(self):
        for mutation in ('group', 'provider', 'redirect', 'certificate'):
            self.seed_config_dependencies()
            app = app_value([RUNTIME_SECRET, AUTH_SECRET])
            expected = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
            wrong = deepcopy(expected)
            if mutation == 'group':
                wrong['properties']['identityProviders']['azureActiveDirectory']['validation']['defaultAuthorizationPolicy']['allowedPrincipals']['groups'] = [OTHER]
            elif mutation == 'provider':
                wrong['properties']['identityProviders']['google'] = {'enabled': True}
            elif mutation == 'redirect':
                wrong['properties']['login']['allowedExternalRedirectUrls'] = ['https://other.example']
            else:
                wrong['properties']['identityProviders']['azureActiveDirectory']['registration']['clientSecretCertificateThumbprint'] = 'a' * 40
            self.wire.responses = [response(200, wrong)]
            known = progress(self.ops[1], TARGET + '/authConfigs/current', {'kind': 'authConfigs', 'appId': CLIENT}, True)
            self.assertFalse(self.adapter.readback_config(self.ops[1], known)['terminal'])

    def test_platform_postreadback_other_config_changed_remains_pending(self):
        before = app_value()
        after = app_value([RUNTIME_SECRET, AUTH_SECRET])
        changed = deepcopy(after)
        changed['properties']['configuration']['activeRevisionsMode'] = 'Multiple'
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, changed)]
        result = self.deliver()
        self.assertTrue(result['write_terminal'])
        self.assertFalse(result['terminal'])

    def test_cleanup_secret_preserves_runtime_and_requires_no_auth_reference(self):
        self.seed_config_dependencies()
        creation = self.ops[0]
        op = deepcopy(creation)
        op['id'] = 'cleanup-auth-platform'
        op['body']['properties']['configuration']['secrets'] = [{'name': RUNTIME_SECRET}]
        op['expected'].update(auth_action='cleanup:authPlatformSecret', body_sha256=digest(op['body']),
            creation_request_digest=digest(creation), references_cleared=True)
        before, after = app_value([RUNTIME_SECRET, AUTH_SECRET]), app_value()
        cfg = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
        cfg['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
        self.wire.responses = [response(200, before), response(200, before), response(200, cfg), response(200, after), response(200, after)]
        result = self.adapter.cleanup_secret(creation, self.receipts['auth-platform-secret'], op, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['absent'])
        self.assertEqual(self.wire.calls[3][2]['properties']['configuration']['secrets'], [{'name': RUNTIME_SECRET, 'value': 'fictional-db-value'}])

    def test_cleanup_auth_removes_reference_keeps_enforced_auth_and_other_fields(self):
        creation = self.ops[1]
        known = completed(progress(creation, TARGET + '/authConfigs/current', {'kind': 'authConfigs', 'appId': CLIENT}, True))
        op = deepcopy(creation)
        op['id'], op['kind'] = 'cleanup-auth-config', 'cleanup:authConfigs'
        op['body']['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
        op['expected'].update(body_sha256=digest(op['body']), creation_request_digest=digest(creation))
        before = dict(deepcopy(creation['body']), id=TARGET + '/authConfigs/current')
        before['properties']['platform']['runtimeVersion'] = '~1'
        after = deepcopy(before)
        after['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
        app = app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.wire.responses = [response(200, app), response(200, app), response(200, before), response(200, after), response(200, after)]
        result = self.adapter.cleanup_auth(creation, known, op, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['absent'])
        sent = self.wire.calls[3][2]['properties']
        self.assertTrue(sent['platform']['enabled'])
        self.assertEqual(sent['platform']['runtimeVersion'], '~1')
        self.assertEqual(sent['globalValidation']['unauthenticatedClientAction'], 'Return401')

    def test_ingress_requires_fresh_graph_owner_and_auth(self):
        self.seed_config_dependencies()
        self.receipts['auth-config'] = completed(progress(self.ops[1], TARGET + '/authConfigs/current', {'kind': 'authConfigs', 'appId': CLIENT}, True))
        app = app_value([RUNTIME_SECRET, AUTH_SECRET])
        cfg = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
        sp = {'id': SP, 'appId': CLIENT, 'appRoleAssignmentRequired': True}
        assignment = dict(operations()[2]['body'], id='opaque-assignment')
        after = app_value([RUNTIME_SECRET, AUTH_SECRET], external=True)
        self.wire.responses = [response(200, app), response(200, app), response(200, cfg), response(200, sp), response(200, assignment), response(200, after), response(200, after)]
        result = self.adapter.enable_ingress(self.ops[2], self.receipts, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET'] * 5 + ['PATCH', 'GET'])

    def test_ingress_bad_owner_never_patch(self):
        self.seed_config_dependencies()
        self.receipts['auth-config'] = completed(progress(self.ops[1], TARGET + '/authConfigs/current', {'kind': 'authConfigs', 'appId': CLIENT}, True))
        app = app_value([RUNTIME_SECRET, AUTH_SECRET])
        cfg = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
        sp = {'id': SP, 'appId': CLIENT, 'appRoleAssignmentRequired': True}
        assignment = dict(operations()[2]['body'], id='opaque-assignment', principalId=OTHER)
        self.wire.responses = [response(200, app), response(200, app), response(200, cfg), response(200, sp), response(200, assignment)]
        result = self.adapter.enable_ingress(self.ops[2], self.receipts, self.intents.append, self.checkpoints.append)
        self.assertFalse(result['terminal'])
        self.assertTrue(all(c[0] == 'GET' for c in self.wire.calls))

    def test_final_public_fqdn_must_match_approved_callback_host(self):
        op = self.ops[2]
        app = app_value([RUNTIME_SECRET, AUTH_SECRET], external=True)
        wrong = deepcopy(app)
        wrong['properties']['configuration']['ingress']['fqdn'] = 'other.example'
        receipt = progress(op, TARGET, {'kind': 'authIngress',
            'retainedConfigurationDigest': digest(wrong['properties']['configuration']),
            'retainedTemplateDigest': digest(wrong['properties']['template'])}, True)
        self.wire.responses = [response(200, wrong)]
        self.assertFalse(self.adapter.readback_ingress(op, receipt)['terminal'])
        receipt['properties']['retainedConfigurationDigest'] = digest(app['properties']['configuration'])
        self.wire.responses = [response(200, app)]
        result = self.adapter.readback_ingress(op, receipt)
        self.assertTrue(result['terminal'])
        self.assertEqual(result['properties']['defaultDomain'], 'fictional-trial.fictional-env.japaneast.azurecontainerapps.io')

    def test_platform_intent_precedes_preservation_checkpoint_and_wire(self):
        before, after = app_value(), app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, after)]
        def checkpoint(receipt):
            self.assertEqual([v['id'] for v in self.intents], [self.ops[0]['id']])
            self.checkpoints.append(receipt)
        result = self.adapter.deliver(self.ops[0], SECRET, self.receipts['addPassword'],
            self.intents.append, checkpoint, self.receipts['trial-app'])
        self.assertTrue(result['terminal'])
        self.assertFalse(self.checkpoints[0]['write_terminal'])
        self.assertIn('retainedConfigurationDigest', self.checkpoints[0]['properties'])

    def test_platform_preimage_checkpoint_failure_prevents_patch(self):
        before = app_value()
        self.wire.responses = [response(200, before), response(200, before)]
        def checkpoint(_):
            raise OSError('private-path')
        result = self.adapter.deliver(self.ops[0], SECRET, self.receipts['addPassword'],
            self.intents.append, checkpoint, self.receipts['trial-app'])
        self.assertFalse(result['terminal'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET', 'GET'])
        self.assertEqual(len(self.intents), 1)

    def test_real_arm_provider_202_ack_then_get_only_resume(self):
        from scripts.trial_provision.providers import BoundedArmProvider
        self.adapter.arm_provider = BoundedArmProvider(self.credential, self.wire, self.clock)
        before, after = app_value(), app_value([RUNTIME_SECRET, AUTH_SECRET])
        url = ARM + '/subscriptions/' + OTHER + '/providers/Microsoft.App/containerApps/fictional-trial/operationResults/' + KEY + '?api-version=' + API_VERSION
        self.wire.responses = [response(200, before), response(200, before), response(202, headers={'location': url})]
        pending = self.deliver()
        self.assertEqual(pending.get('operation_url'), url)
        self.assertFalse(pending['write_terminal'])
        self.clock.value += 2
        self.clock.mono += 2
        self.wire.responses = [response(200, {'status': 'Succeeded'}), response(200, after)]
        result = self.adapter.readback(self.ops[0], pending)
        self.assertTrue(result['terminal'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET', 'GET', 'PATCH', 'GET', 'GET'])
        self.assertNotIn(SECRET, json.dumps(self.checkpoints + [result]))

    def test_real_arm_provider_cross_subscription_lro_stays_unknown(self):
        from scripts.trial_provision.providers import BoundedArmProvider
        self.adapter.arm_provider = BoundedArmProvider(self.credential, self.wire, self.clock)
        before = app_value()
        url = ARM + '/subscriptions/' + APP + '/providers/Microsoft.App/containerApps/fictional-trial/operationResults/' + KEY + '?api-version=' + API_VERSION
        self.wire.responses = [response(200, before), response(200, before), response(202, headers={'location': url})]
        pending = self.deliver()
        self.assertFalse(pending['write_terminal'])
        result = self.adapter.readback(self.ops[0], pending)
        self.assertFalse(result['terminal'])
        self.assertEqual([x[0] for x in self.wire.calls], ['GET', 'GET', 'PATCH'])

    def test_real_arm_provider_known_200_and_name_readback(self):
        from scripts.trial_provision.providers import BoundedArmProvider
        self.adapter.arm_provider = BoundedArmProvider(self.credential, self.wire, self.clock)
        before, after = app_value(), app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, after)]
        self.assertTrue(self.deliver()['terminal'])

    def close_fixture(self):
        creation = self.ops[2]
        current = app_value([RUNTIME_SECRET, AUTH_SECRET], external=True)
        known = completed(progress(creation, TARGET, {'kind': 'authIngress',
            'retainedConfigurationDigest': digest(current['properties']['configuration']),
            'retainedTemplateDigest': digest(current['properties']['template'])}, True))
        proof = {'complete': True, 'creation_request_digest': digest(creation),
            'creation_receipt_digest': digest(known), 'object_id': TARGET,
            'depends_on': [creation['id']]}
        op = build_auth_cleanup(creation, known, easy_binding(), END, proof)
        return creation, known, op, current

    def test_close_ingress_exact_owned_app_after_deadline_preserves_other_config(self):
        create, known, op, before = self.close_fixture()
        after = app_value([RUNTIME_SECRET, AUTH_SECRET])
        self.clock.value = instant(EXPIRY) + 1
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, after)]
        result = self.adapter.cleanup_ingress(create, known, op, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['terminal'])
        self.assertTrue(result['absent'])
        self.assertEqual(op['deadline'], END)
        self.assertEqual(self.wire.calls[2][2], {'location': 'japaneast', 'properties': {'configuration': {'ingress': {'external': False}}}})
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET', 'PATCH', 'GET'])
        self.assertFalse(self.checkpoints[0]['write_terminal'])

    def test_close_ingress_unknown_never_resends_or_adopts_closed_get(self):
        create, known, op, before = self.close_fixture()
        self.wire.responses = [response(200, before), response(200, before), TimeoutError('no-secret')]
        pending = self.adapter.cleanup_ingress(create, known, op, self.intents.append, self.checkpoints.append)
        self.assertFalse(pending['write_terminal'])
        restart = EasyAuthAdapter(easy_binding(), self.credential, self.wire,
            lambda: self.fail('close must not retrieve secrets'), self.clock)
        self.assertFalse(restart.readback(op, pending)['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET', 'PATCH'])

    def test_close_ingress_changed_current_or_postconfig_never_succeeds(self):
        create, known, op, before = self.close_fixture()
        changed = deepcopy(before)
        changed['properties']['configuration']['ingress']['targetPort'] = 8000
        self.wire.responses = [response(200, changed), response(200, changed)]
        self.assertFalse(self.adapter.cleanup_ingress(create, known, op, self.intents.append, self.checkpoints.append)['terminal'])
        self.assertEqual(self.intents, [])
        after = app_value([RUNTIME_SECRET, AUTH_SECRET])
        after['properties']['configuration']['ingress']['fqdn'] = 'foreign.example'
        self.wire.responses = [response(200, before), response(200, before), response(200, after), response(200, after)]
        result = self.adapter.cleanup_ingress(create, known, op, self.intents.append, self.checkpoints.append)
        self.assertTrue(result['write_terminal'])
        self.assertFalse(result['terminal'])

    def test_close_ingress_unknown_creation_rejected_before_http(self):
        create, known, op, before = self.close_fixture()
        known['write_terminal'] = False
        with self.assertRaises(AuthDenied):
            self.adapter.cleanup_ingress(create, known, op, self.intents.append, self.checkpoints.append)
        self.assertEqual(self.wire.calls, [])

    def test_close_ingress_intent_precedes_checkpoint_and_checkpoint_failure_stops_write(self):
        create, known, op, before = self.close_fixture()
        self.wire.responses = [response(200, before), response(200, before)]
        def fail(_):
            self.assertEqual(self.intents, [op])
            raise OSError('fixture')
        result = self.adapter.cleanup_ingress(create, known, op, self.intents.append, fail)
        self.assertFalse(result['terminal'])
        self.assertEqual([c[0] for c in self.wire.calls], ['GET', 'GET'])

    def test_secret_cleanup_builder_binds_latest_closed_app_receipt(self):
        create, known, close_op, _ = self.close_fixture()
        closed = completed(progress(close_op, TARGET, {'kind': 'cleanup:authIngress'}, True))
        secret_op = self.ops[0]
        secret_receipt = completed(progress(secret_op, TARGET, {'kind': 'authPlatformSecret'}, True))
        proof = {'complete': True, 'creation_request_digest': digest(secret_op),
            'creation_receipt_digest': digest(secret_receipt), 'object_id': TARGET,
            'depends_on': [close_op['id']], 'references_cleared': True, 'latest_app_receipt': closed}
        cleanup = build_auth_cleanup(secret_op, secret_receipt, easy_binding(), END, proof)
        self.assertEqual(cleanup['expected']['update_from'], {'operation_id': close_op['id'], 'request_digest': digest(close_op)})
        proof['latest_app_receipt']['object_id'] = TARGET + '-foreign'
        with self.assertRaises(AuthDenied):
            build_auth_cleanup(secret_op, secret_receipt, easy_binding(), END, proof)


class ExpiredReadbackTests(unittest.TestCase):
    """Actual adapters, known wire ACKs, process restart and a crossed deadline."""

    def expire(self, fixture):
        fixture.clock.value = instant(END) + 120
        fixture.clock.mono += 180

    def graph_pending(self, index):
        f = GraphTests('runTest'); f.setUp()
        op = operations()[index]
        if index == 0: value = dict(deepcopy(op['body']), id=APP, appId=CLIENT)
        elif index == 1: value = dict(op['body'], id=SP)
        elif index == 2: value = dict(op['body'], id='opaque-assignment')
        else: value = dict(op['body']['passwordCredential'], keyId=KEY, secretText=SECRET)
        after = {'id': APP, 'passwordCredentials': [{k:v for k,v in value.items() if k != 'secretText'}]} if index == 3 else value
        f.wire.responses = [response(200 if index == 3 else 201, value), response(503)]
        delivered = []
        previous = {key: value for key, value in receipts().items() if key in op['depends_on']}
        pending = f.run_op(op, previous, lambda *args: delivered.append(args))
        self.assertTrue(pending['write_terminal']); self.assertFalse(pending['terminal'])
        self.assertEqual([], delivered)
        self.expire(f)
        f.adapter = GraphAdapter(binding(), f.credential, f.wire, f.clock, f.clock.monotonic)
        return f, op, pending, after

    def easy_pending(self, kind, *, lro=False):
        from scripts.trial_provision.providers import BoundedArmProvider
        f = EasyAuthTests('runTest'); f.setUp()
        if lro:
            f.adapter.arm_provider = BoundedArmProvider(f.credential, f.wire, f.clock)
        app = app_value([RUNTIME_SECRET, AUTH_SECRET])
        cfg = dict(auth_configuration(easy_binding(), CLIENT), id=TARGET + '/authConfigs/current')
        if kind == 'secret':
            op, after = f.ops[0], app
            prefix = [response(200, app_value()), response(200, app_value())]
            run = f.deliver
        elif kind == 'config':
            op, after = f.ops[1], cfg
            f.seed_config_dependencies()
            prefix = [response(200, app), response(200, app), response(404)]
            run = lambda: f.adapter.execute(op, f.receipts, f.intents.append, f.checkpoints.append)
        else:
            op, after = f.ops[2], app_value([RUNTIME_SECRET, AUTH_SECRET], external=True)
            f.seed_config_dependencies()
            f.receipts['auth-config'] = completed(progress(f.ops[1], TARGET + '/authConfigs/current', {'kind': 'authConfigs', 'appId': CLIENT}, True))
            prefix = [response(200, app), response(200, app), response(200, cfg),
                response(200, {'id': SP, 'appId': CLIENT, 'appRoleAssignmentRequired': True}),
                response(200, dict(operations()[2]['body'], id='opaque-assignment'))]
            run = lambda: f.adapter.enable_ingress(op, f.receipts, f.intents.append, f.checkpoints.append)
        if lro:
            url = ARM + '/subscriptions/' + OTHER + '/providers/Microsoft.App/containerApps/fictional-trial/operationResults/' + KEY + '?api-version=' + API_VERSION
            f.wire.responses = prefix + [response(202, headers={'location': url})]
        else:
            f.wire.responses = prefix + [response(201 if kind == 'config' else 200, after), response(503)]
        pending = run()
        self.assertFalse(pending['terminal']); self.assertTrue(pending['created_by_run'])
        self.assertEqual(not lro, pending['write_terminal'])
        self.expire(f)
        provider = BoundedArmProvider(f.credential, f.wire, f.clock) if lro else None
        f.adapter = EasyAuthAdapter(easy_binding(), f.credential, f.wire,
            lambda: {RUNTIME_SECRET: 'fictional-db-value'}, f.clock, f.clock.monotonic, arm_provider=provider)
        reader = {'secret': f.adapter.readback, 'config': f.adapter.readback_config, 'ingress': f.adapter.readback_ingress}[kind]
        return f, op, pending, after, reader

    def test_all_graph_known_acks_resume_get_only_after_window_without_redelivery(self):
        for index in range(4):
            with self.subTest(index=index):
                f, op, pending, after = self.graph_pending(index)
                before = len(f.wire.calls)
                f.wire.responses = [response(200, after)]
                known = f.adapter.readback(op, pending)
                self.assertTrue(known['terminal']); self.assertTrue(known['readback_verified'])
                self.assertEqual(['GET'], [v[0] for v in f.wire.calls[before:]])
                self.assertEqual(pending['object_id'], known['object_id'])
                self.assertEqual(pending['created_by_run'], known['created_by_run'])
                self.assertNotIn(SECRET, json.dumps(f.checkpoints + [known]))

    def test_graph_unknown_or_changed_ack_never_reads_matching_object_after_window(self):
        f, op, pending, _ = self.graph_pending(3)
        for mutate in (lambda r: r.update(write_terminal=False, created_by_run=False),
                       lambda r: r.update(request_digest='0'*64),
                       lambda r: r.update(operation_id='foreign')):
            unknown = deepcopy(pending); mutate(unknown)
            before = len(f.wire.calls)
            with self.assertRaises(AuthDenied): f.adapter.readback(op, unknown)
            self.assertEqual(before, len(f.wire.calls))

    def test_recovery_receipt_cannot_authorize_mutation_or_new_creation(self):
        f, op, pending, _ = self.graph_pending(3)
        before = len(f.wire.calls)
        with self.assertRaises(AuthDenied):
            f.adapter._request('POST', op['url'], op['body'], op, recovery_receipt=pending)
        with self.assertRaises(AuthDenied):
            f.adapter.execute(op, receipts(), f.intents.append, f.checkpoints.append, lambda *_: None)
        self.assertEqual(before, len(f.wire.calls))

    def test_recovered_password_remains_exact_owned_for_cleanup_without_new_key(self):
        f, op, pending, after = self.graph_pending(3)
        f.wire.responses = [response(200, after)]
        known = f.adapter.readback(op, pending)
        proof = {'complete': True, 'creation_request_digest': digest(op), 'creation_receipt_digest': digest(known),
                 'object_id': KEY, 'depends_on': []}
        cleanup = build_auth_cleanup(op, known, binding(), EXPIRY, proof)
        f.wire.responses = [response(200, after), response(204), response(200, {'id': APP, 'passwordCredentials': []})]
        result = f.adapter.cleanup(op, known, cleanup, f.intents.append, f.checkpoints.append)
        self.assertTrue(result['terminal']); self.assertTrue(result['absent'])
        self.assertEqual(1, sum(m == 'POST' and u.endswith('/addPassword') for m,u,_,_ in f.wire.calls))

    def test_secret_config_ingress_known_terminal_acks_recover_after_expiry(self):
        for kind in ('secret', 'config', 'ingress'):
            with self.subTest(kind=kind):
                f, op, pending, after, reader = self.easy_pending(kind)
                before = len(f.wire.calls); f.wire.responses = [response(200, after)]
                result = reader(op, pending)
                self.assertTrue(result['terminal']); self.assertTrue(result['readback_verified'])
                self.assertEqual(['GET'], [v[0] for v in f.wire.calls[before:]])
                self.assertEqual(pending['created_by_run'], result['created_by_run'])

    def test_secret_and_ingress_known_lro_recover_after_expiry_with_real_provider(self):
        for kind in ('secret', 'ingress'):
            with self.subTest(kind=kind):
                f, op, pending, after, reader = self.easy_pending(kind, lro=True)
                before = len(f.wire.calls)
                f.wire.responses = [response(200, {'status': 'Succeeded'}), response(200, after)]
                result = reader(op, pending)
                self.assertTrue(result['terminal']); self.assertTrue(result['readback_verified'])
                self.assertEqual(['GET', 'GET'], [v[0] for v in f.wire.calls[before:]])
                self.assertNotIn('cleanup_overdue', result)

    def test_easy_unknown_acks_never_read_or_adopt_current_matching_state(self):
        for kind in ('secret', 'ingress'):
            with self.subTest(kind=kind):
                f, op, pending, _, reader = self.easy_pending(kind)
                pending.update(created_by_run=False, write_terminal=False)
                before = len(f.wire.calls)
                result = reader(op, pending)
                self.assertFalse(result['terminal']); self.assertFalse(result['readback_verified'])
                self.assertEqual(before, len(f.wire.calls))
        f, op, pending, _, reader = self.easy_pending('config')
        pending.update(created_by_run=False, write_terminal=False)
        before = len(f.wire.calls)
        with self.assertRaises(AuthDenied): reader(op, pending)
        self.assertEqual(before, len(f.wire.calls))

    def test_changed_lro_route_is_refused_without_http_and_failure_never_adopts(self):
        for kind in ('secret', 'ingress'):
            with self.subTest(kind=kind):
                f, op, pending, _, reader = self.easy_pending(kind, lro=True)
                bad = deepcopy(pending); bad['operation_url'] = pending['operation_url'].replace(OTHER, APP)
                bad['operation_url_digest'] = digest(bad['operation_url'])
                before = len(f.wire.calls)
                self.assertFalse(reader(op, bad)['readback_verified'])
                self.assertEqual(before, len(f.wire.calls))
                f.wire.responses = [response(200, {'status': 'Failed'})]
                result = reader(op, pending)
                self.assertEqual('failed', result['state']); self.assertFalse(result['readback_verified'])
                self.assertEqual(['GET'], [v[0] for v in f.wire.calls[before:]])

    def test_recovery_30s_bound_is_checked_after_counted_fsync(self):
        from scripts.trial_provision.journal import CountedControlHttp
        f, op, pending, after = self.graph_pending(3)
        class Budget:
            count = 0
            def consume(self, kind, limit):
                self.count += 1
                f.clock.value += 31; f.clock.mono += 31
        budget = Budget()
        f.adapter.http = CountedControlHttp(f.wire, budget)
        before = len(f.wire.calls); f.wire.responses = [response(200, after)]
        result = f.adapter.readback(op, pending)
        self.assertEqual(1, budget.count)
        self.assertEqual(before, len(f.wire.calls))
        self.assertFalse(result['terminal']); self.assertTrue(result['write_terminal'])




class ExpiredReadbackCliTests(unittest.TestCase):
    """Real CLI/config/resolver/journal path; only external boundaries fictional."""

    def check_recovery(self, slot):
        from urllib.parse import urlsplit
        from scripts.trial_guard.lifecycle import parse
        from scripts.trial_provision.tests.test_workflow_contract import WorkflowContractTests, response
        f = WorkflowContractTests('runTest')
        self.addCleanup(f.doCleanups)
        f.setUp()
        f.publish_and_prepare(); f.provision(all_permissions=True)
        f.rehearse(); f.guardian_execute(); f.bind_and_deploy()
        for dependency in ('E2', 'E3'):
            self.assertEqual('succeeded', f.f.run_action('create', operation_id=dependency)['status'])
        if slot in ('auth-config', 'auth-ingress'):
            self.assertEqual('succeeded', f.f.run_action('create', operation_id='E4')['status'])
        if slot == 'auth-ingress':
            self.assertEqual('succeeded', f.f.run_action('create', operation_id='auth-config')['status'])
        app = f.manifest['ids']['app']
        target = {'E4': '/v1.0/applications/' + f.snapshot()[1]['E1']['object_id'],
                  'auth-platform-secret': app, 'auth-config': app + '/authConfigs/current',
                  'auth-ingress': app}[slot]
        acknowledged = False

        def wire(method, url, headers, body, deadline):
            nonlocal acknowledged
            path = urlsplit(url).path
            if acknowledged and method == 'GET' and path == target:
                deadline.remaining()
                f.arm.calls.append((method, path))
                return response(503)
            reply = f.arm(method, url, headers, body, deadline)
            if slot == 'E4':
                mutation = method == 'POST' and path == target + '/addPassword'
            elif slot == 'auth-config':
                mutation = method == 'PUT' and path == target
            else:
                mutation = method == 'PATCH' and path == target
            if mutation:
                self.assertIn(reply['status'], (200, 201))
                acknowledged = True
            return reply

        f.f.wire = wire
        source = 'E4' if slot == 'auth-platform-secret' else slot
        f.f.run_action('create', operation_id=source)
        self.assertTrue(acknowledged)
        _, receipts = f.snapshot()
        pending = receipts[slot]
        self.assertTrue(pending['created_by_run'])
        self.assertTrue(pending['write_terminal'])
        self.assertFalse(pending['terminal'])
        f.clock.seconds = (parse(f.config['plan_bindings']['owner_window']['end']) - f.clock.start).total_seconds() + 1
        f.f.wire = f.arm
        before = f.f.run_action('status')
        calls = len(f.arm.calls)
        result = f.f.run_action('reconcile', operation_id=slot)
        self.assertEqual('succeeded', result['status'])
        self.assertTrue(result['terminal'])
        self.assertEqual(before['attempts'], result['attempts'])
        self.assertEqual(before['control_requests_used'] + 1, result['control_requests_used'])
        self.assertEqual([('GET', target)], f.arm.calls[calls:])
        _, recovered = f.snapshot()
        self.assertEqual(pending['object_id'], recovered[slot]['object_id'])
        self.assertEqual(pending['request_digest'], recovered[slot]['request_digest'])
        self.assertTrue(recovered[slot]['readback_verified'])
        self.assertEqual(1, sum(m == 'POST' and p.endswith('/addPassword') for m, p in f.arm.calls))
        if slot == 'E4':
            # A recovered key ACK cannot regenerate or replay its lost secret.
            self.assertNotIn('auth-platform-secret', recovered)
        self.assertNotIn(b'fictional-memory-only-auth-secret', (f.root / 'trial-provision.jsonl').read_bytes())

    def test_cli_expired_e4_ack_reconciles_without_secret_redelivery(self):
        self.check_recovery('E4')

    def test_cli_expired_secret_ack_reconciles_without_callback_replay(self):
        self.check_recovery('auth-platform-secret')

    def test_cli_expired_config_ack_reconciles_get_only(self):
        self.check_recovery('auth-config')

    def test_cli_expired_ingress_ack_reconciles_get_only(self):
        self.check_recovery('auth-ingress')


if __name__ == '__main__':
    unittest.main()
