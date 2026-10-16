"""Bounded OWNER-only Graph/Easy Auth operations; no default live execution.

The caller supplies the fixed private binding and a durable, single-writer
journal. before_send(op) must fsync a one-attempt intent before returning.
checkpoint(receipt) must durably append progress with immutable request/ID
binding. Neither callback ever receives a token, password or raw response.

Graph POSTs are never retried or searched by display name. A lost response is
UNKNOWN. Known created IDs may be read back or cleaned up using that receipt.
"""
from copy import deepcopy
from datetime import datetime, timezone
import re
import time
import uuid
import json
from urllib.parse import urlsplit

from scripts.trial_guard.adapters import Deadline, digest, encoded, json_body


GRAPH = 'https://graph.microsoft.com/v1.0'
ARM = 'https://management.azure.com'
API_VERSION = '2025-07-01'
OP_KEYS = {'id', 'provider', 'kind', 'method', 'url', 'body', 'deadline',
           'depends_on', 'expected', 'cleanup'}
GRAPH_KINDS = ('applications', 'servicePrincipals', 'appRoleAssignedTo', 'addPassword')
EXPIRY = '2027-01-29T00:00:00Z'


class AuthDenied(RuntimeError):
    """A fixed safe reason; never wrap provider exceptions or response bodies."""


def instant(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise AuthDenied('auth_timestamp')
    try:
        return datetime.fromisoformat(value[:-1] + '+00:00').timestamp()
    except (ValueError, TypeError):
        raise AuthDenied('auth_timestamp') from None


def guid(value):
    try:
        if str(uuid.UUID(value)) != value.lower():
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        raise AuthDenied('auth_identifier') from None


def opaque_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise AuthDenied('auth_identifier')
    return value


def subset(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and subset(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        # Exact count/order; tolerate provider metadata on each object (Graph
        # adds appRole.origin) without admitting an extra role or permission.
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            subset(a, e) for a, e in zip(actual, expected))
    return same(actual, expected)


def same(actual, expected):
    return json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True, allow_nan=False)


def password_matches(actual, expected):
    try:
        return (actual.get('displayName') == expected['displayName']
                and all(instant(actual[k]) == instant(expected[k]) for k in ('startDateTime', 'endDateTime')))
    except (KeyError, AuthDenied):
        return False


def password_credentials(value):
    """Absence needs an explicit complete collection, never a missing default."""
    values = value.get('passwordCredentials')
    if (not isinstance(values, list) or len(values) > 128
            or 'passwordCredentials@odata.nextLink' in value or '@odata.nextLink' in value):
        raise AuthDenied('auth_password_collection')
    ids = [guid(p.get('keyId')) for p in values if isinstance(p, dict)]
    if len(ids) != len(values) or len(ids) != len(set(ids)):
        raise AuthDenied('auth_password_collection')
    return values


def ready(receipt):
    return (isinstance(receipt, dict) and receipt.get('state') == 'succeeded'
            and receipt.get('terminal') is True and receipt.get('readback_verified') is True
            and receipt.get('created_by_run') is True)


def progress(op, object_id=None, properties=None, write_terminal=False):
    return {'operation_id': op['id'], 'request_digest': digest(op),
            'object_id': object_id, 'created_by_run': bool(write_terminal),
            'state': 'pending', 'terminal': False, 'write_terminal': write_terminal,
            'readback_verified': False, 'properties': properties or {}}


def completed(receipt):
    result = deepcopy(receipt)
    result.update(state='succeeded', terminal=True, readback_verified=True)
    return result


class _Bounded:
    def __init__(self, credential, http, clock=time.time, monotonic=time.monotonic):
        self.credential, self.http = credential, http
        if hasattr(clock, 'utc'):
            self.clock, self.monotonic = lambda: clock.utc().timestamp(), clock.monotonic
        else:
            self.clock, self.monotonic = clock, monotonic
        self.attempted = set()
        self.anchor_wall, self.anchor_mono = self.clock(), self.monotonic()

    def _now(self):
        now = max(self.anchor_wall, self.clock(), self.anchor_wall + max(0, self.monotonic() - self.anchor_mono))
        self.anchor_wall, self.anchor_mono = now, self.monotonic()
        return now

    def _deadline(self, op):
        if self._is_cleanup(op):
            return Deadline(30, self.monotonic)
        return Deadline(min(30, instant(op['deadline']) - self._now()), self.monotonic)

    @staticmethod
    def _is_cleanup(op):
        return (op.get('kind', '').startswith('cleanup:')
                or op.get('expected', {}).get('auth_action', '').startswith('cleanup:'))

    def _validate(self, op, provider, kinds, *, readback=False):
        if (not isinstance(op, dict) or set(op) != OP_KEYS or op['provider'] != provider
                or op['kind'] not in kinds or not isinstance(op['id'], str)
                or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', op['id'])
                or not isinstance(op['depends_on'], list) or not isinstance(op['expected'], dict)
                or not isinstance(op['cleanup'], dict)
                or op['expected'].get('body_sha256') != digest(op['body'])):
            raise AuthDenied('auth_operation_binding')
        if instant(op['deadline']) <= self._now() and not self._is_cleanup(op) and not readback:
            raise AuthDenied('auth_deadline')

    def _readback_ack(self, op, receipt, *, lro=False):
        """Trusted journal ACK only; never turn a matching GET into ownership.

        An accepted ARM LRO is checked again by the real provider before polling.
        This gate cannot authorize a write, change the immutable operation or
        assign new cleanup ownership. Unknown initial responses have no ACK.
        """
        if (not isinstance(receipt, dict) or receipt.get('operation_id') != op['id']
                or receipt.get('request_digest') != digest(op)):
            raise AuthDenied('auth_readback_binding')
        if receipt.get('created_by_run') is not True or receipt.get('state') not in ('pending', 'succeeded'):
            return False
        if receipt.get('write_terminal') is True:
            return True
        return (lro and op['provider'] == 'Microsoft.App' and receipt.get('state') == 'pending'
            and receipt.get('write_terminal') is False
            and isinstance(receipt.get('initial_ack_digest'), str)
            and re.fullmatch(r'[0-9a-f]{64}', receipt.get('initial_ack_digest', '')) is not None
            and isinstance(receipt.get('operation_url'), str) and bool(receipt['operation_url'])
            and receipt.get('operation_url_digest') == digest(receipt['operation_url'])
            and receipt.get('poll_kind') in ('status', 'location'))

    def _request(self, method, url, body, op, before_send=None, headers=None, after_intent=None, *, recovery_receipt=None):
        recovery = recovery_receipt is not None
        if recovery and (method != 'GET' or body is not None or not self._readback_ack(op, recovery_receipt)):
            raise AuthDenied('auth_readback_ack_required')
        deadline = Deadline(30, self.monotonic) if recovery else self._deadline(op)
        audience = 'https://graph.microsoft.com/' if url.startswith(GRAPH + '/') else ARM + '/'
        token = self.credential.token(audience, deadline)
        request_headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        if method != 'GET':
            if before_send is None or op['id'] in self.attempted:
                raise AuthDenied('auth_write_already_attempted')
            # Root's persistent intent is authoritative across process restarts.
            before_send(deepcopy(op))
            self.attempted.add(op['id'])
            if after_intent is not None:
                after_intent()
        def final_check():
            deadline.remaining()
            if instant(op['deadline']) <= self._now() and not self._is_cleanup(op) and not recovery:
                raise AuthDenied('auth_deadline')
            if recovery and not self._readback_ack(op, recovery_receipt):
                raise AuthDenied('auth_readback_ack_required')
        arguments = (method, url, request_headers, None if body is None else encoded(body), deadline)
        final_check()
        guarded = getattr(self.http, 'send_guarded', None)
        if callable(guarded):
            return guarded(*arguments, before_send=final_check)
        return self.http(*arguments)

    def _owned(self, op, receipt):
        if (not isinstance(receipt, dict) or receipt.get('operation_id') != op['id']
                or receipt.get('request_digest') != digest(op)
                or receipt.get('created_by_run') is not True or receipt.get('write_terminal') is not True):
            raise AuthDenied('auth_creation_receipt')


class GraphAdapter(_Bounded):
    """One application, SP, OWNER assignment and password; injected normal CLI."""
    def __init__(self, binding, credential, http, clock=time.time, monotonic=time.monotonic):
        super().__init__(credential, http, clock, monotonic)
        self.binding = deepcopy(binding)
        if (getattr(credential, 'mode', None) != 'owner'
                or getattr(credential, 'principal', '').lower() != binding['owner_id'].lower()
                or getattr(credential, 'tenant', '').lower() != binding['tenant_id'].lower()):
            raise AuthDenied('auth_owner_required')
        for key in ('tenant_id', 'owner_id', 'app_role_id'):
            guid(binding[key])
        if instant(binding['credential_expires_at']) != instant(EXPIRY):
            raise AuthDenied('auth_fixed_expiry')
        redirect = binding['redirect_uri']
        if (not isinstance(redirect, str) or not re.fullmatch(
                r'https://[a-z0-9.-]+/\.auth/login/aad/callback', redirect)):
            raise AuthDenied('auth_redirect')
        for key in ('application_display_name', 'credential_display_name'):
            if not isinstance(binding[key], str) or not 1 <= len(binding[key]) <= 100:
                raise AuthDenied('auth_name')

    def _dependency(self, receipts, kind):
        matches = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == kind]
        if len(matches) != 1:
            raise AuthDenied('auth_dependency')
        return matches[0]

    def _validate_create(self, op, receipts):
        self._validate(op, 'Microsoft.Graph', GRAPH_KINDS)
        if op['method'] != 'POST' or op['id'] in receipts:
            raise AuthDenied('auth_one_shot')
        if instant(op['deadline']) > instant(self.binding['credential_expires_at']):
            raise AuthDenied('auth_deadline')
        for dependency in op['depends_on']:
            if not ready(receipts.get(dependency)):
                raise AuthDenied('auth_dependency')
        b, body, kind = self.binding, op['body'], op['kind']
        if kind == 'applications':
            roles = body.get('appRoles', [])
            if (set(body) != {'displayName', 'signInAudience', 'web', 'requiredResourceAccess', 'passwordCredentials', 'appRoles'}
                    or body['displayName'] != b['application_display_name']
                    or body['signInAudience'] != 'AzureADMyOrg'
                    or not same(body['web'], {'redirectUris': [b['redirect_uri']], 'implicitGrantSettings': {
                        'enableIdTokenIssuance': True, 'enableAccessTokenIssuance': False}})
                    or body['requiredResourceAccess'] != [] or body['passwordCredentials'] != []
                    or len(roles) != 1 or set(roles[0]) != {'id', 'displayName', 'description', 'allowedMemberTypes', 'isEnabled', 'value'}
                    or roles[0]['id'] != b['app_role_id'] or roles[0]['allowedMemberTypes'] != ['User']
                    or roles[0]['isEnabled'] is not True or roles[0]['value'] != 'OWNER'):
                raise AuthDenied('auth_application_body')
            url = GRAPH + '/applications'
        elif kind == 'servicePrincipals':
            app = self._dependency(receipts, 'applications')['properties']
            if not same(body, {'appId': app['appId'], 'appRoleAssignmentRequired': True}):
                raise AuthDenied('auth_principal_body')
            url = GRAPH + '/servicePrincipals'
        elif kind == 'appRoleAssignedTo':
            sp = self._dependency(receipts, 'servicePrincipals')['properties']
            if body != {'principalId': b['owner_id'], 'resourceId': sp['servicePrincipalObjectId'], 'appRoleId': b['app_role_id']}:
                raise AuthDenied('auth_assignment_body')
            url = GRAPH + '/servicePrincipals/' + guid(body['resourceId']) + '/appRoleAssignedTo'
        else:
            app = self._dependency(receipts, 'applications')['properties']
            self._dependency(receipts, 'appRoleAssignedTo')
            p = body.get('passwordCredential', {})
            if (set(body) != {'passwordCredential'} or set(p) != {'displayName', 'startDateTime', 'endDateTime'}
                    or p['displayName'] != b['credential_display_name']
                    or instant(p['endDateTime']) != instant(b['credential_expires_at'])
                    or instant(p['startDateTime']) > self._now()
                    or instant(p['startDateTime']) >= instant(p['endDateTime'])):
                raise AuthDenied('auth_password_body')
            url = GRAPH + '/applications/' + guid(app['applicationObjectId']) + '/addPassword'
        if op['url'] != url:
            raise AuthDenied('auth_exact_url')

    def _ack(self, op, value):
        kind, body = op['kind'], op['body']
        props = {'kind': kind}
        if kind == 'applications':
            object_id = guid(value['id'])
            props.update(applicationObjectId=object_id, appId=guid(value['appId']))
        elif kind == 'servicePrincipals':
            object_id = guid(value['id'])
            props.update(servicePrincipalObjectId=object_id, appId=guid(value['appId']))
        elif kind == 'appRoleAssignedTo':
            object_id = opaque_id(value['id'])
            props.update(directoryAssignmentId=object_id, **{k: guid(value[k]) for k in ('principalId', 'resourceId', 'appRoleId')})
        else:
            object_id = guid(value['keyId'])
            props.update(keyId=object_id, startDateTime=value['startDateTime'], endDateTime=value['endDateTime'])
            body = body['passwordCredential']
            if not all(instant(value[k]) == instant(body[k]) for k in ('startDateTime', 'endDateTime')):
                raise AuthDenied('auth_password_dates')
        if not (password_matches(value, body) if kind == 'addPassword' else subset(value, body)):
            raise AuthDenied('auth_creation_response')
        if kind == 'applications' and value.get('keyCredentials', []) != []:
            raise AuthDenied('auth_unapproved_credential')
        return progress(op, object_id, props, True)

    def execute(self, op, receipts, before_send, checkpoint, deliver_secret=None):
        self._validate_create(op, receipts)
        if op['kind'] == 'addPassword' and not callable(deliver_secret):
            raise AuthDenied('auth_secret_delivery_required')
        receipt = progress(op)
        secret = None
        try:
            response = self._request('POST', op['url'], op['body'], op, before_send)
            if response['status'] != (200 if op['kind'] == 'addPassword' else 201):
                # Even denial/timeout responses consume the one attempt; do not
                # guess whether a gateway response proves provider non-creation.
                return receipt
            value = json_body(response)
            receipt = self._ack(op, value)
            if op['kind'] == 'addPassword':
                secret = value.pop('secretText', None)
            # Dispose of provider payload before any durable callback.
            value.clear()
            response['body'] = b''
            checkpoint(deepcopy(receipt))
            receipt = self.readback(op, receipt)
            if not ready(receipt):
                return receipt
            checkpoint(deepcopy(receipt))
            if op['kind'] == 'addPassword':
                if not isinstance(secret, str) or not 16 <= len(secret) <= 256:
                    return receipt  # key is retained, delivery was never started
                # callback owns its distinct durable intent and safe receipt.
                # Its failure never undoes the recorded credential creation.
                deliver_secret(secret, deepcopy(receipt))
            return receipt
        except Exception:
            # No message/body/token/secret from transport or callbacks escapes.
            return receipt
        finally:
            secret = None

    def _read_url(self, op, receipt):
        kind = op['kind']
        if kind in ('applications', 'servicePrincipals'):
            return GRAPH + '/' + kind + '/' + guid(receipt['object_id'])
        if kind == 'appRoleAssignedTo':
            return op['url'] + '/' + opaque_id(receipt['object_id'])
        if kind == 'addPassword':
            return op['url'].removesuffix('/addPassword')
        raise AuthDenied('auth_kind')

    def readback(self, op, receipt):
        """GET-only recovery; no list/search, password regeneration or delivery."""
        self._validate(op, 'Microsoft.Graph', GRAPH_KINDS, readback=True)
        self._owned(op, receipt)
        result = deepcopy(receipt)
        try:
            response = self._request('GET', self._read_url(op, receipt), None, op, recovery_receipt=receipt)
            if response['status'] != 200:
                return result
            value = json_body(response)
            if op['kind'] == 'addPassword':
                app_id = op['url'].split('/')[-2]
                if value.get('id') != app_id:
                    return result
                values = [p for p in password_credentials(value) if p.get('keyId') == receipt['object_id']]
                if len(values) != 1 or not password_matches(values[0], op['body']['passwordCredential']):
                    return result
            elif value.get('id') != receipt['object_id'] or not subset(value, op['body']):
                return result
            elif op['kind'] in ('applications', 'servicePrincipals') and value.get('appId') != receipt['properties']['appId']:
                return result
            if op['kind'] == 'applications' and value.get('keyCredentials', []) != []:
                return result
            return completed(result)
        except Exception:
            return result

    def cleanup(self, creation_op, creation_receipt, op, before_send, checkpoint):
        """Delete only a terminal-created exact object, after caller ref gates.

        An unknown delete is never resent. Root may resume the exact GET using
        its saved write_terminal cleanup progress, but 404 alone cannot prove an
        unknown delete terminal. No directory collection list is performed.
        """
        self._owned(creation_op, creation_receipt)
        self._validate(op, 'Microsoft.Graph', tuple('cleanup:' + k for k in GRAPH_KINDS))
        if op['kind'] != 'cleanup:' + creation_op['kind']:
            raise AuthDenied('auth_cleanup_kind')
        url = self._read_url(creation_op, creation_receipt)
        password = creation_op['kind'] == 'addPassword'
        expected_url = url + '/removePassword' if password else url
        expected_body = {'keyId': creation_receipt['object_id']} if password else None
        if (op['url'] != expected_url or op['body'] != expected_body
                or op['method'] != ('POST' if password else 'DELETE')
                or op['expected'].get('creation_request_digest') != digest(creation_op)
                or (creation_op['kind'] in ('applications', 'servicePrincipals')
                    and op['expected'].get('references_cleared') is not True)):
            raise AuthDenied('auth_cleanup_binding')
        receipt = progress(op, creation_receipt['object_id'])
        try:
            # Exact pre-delete read checks current identity, never grants ownership.
            r = self._request('GET', url, None, op)
            if r['status'] != 200:
                return receipt
            value = json_body(r)
            if password:
                if value.get('id') != url.rsplit('/', 1)[-1] or not any(
                        p.get('keyId') == creation_receipt['object_id'] and password_matches(p, creation_op['body']['passwordCredential'])
                        for p in password_credentials(value)):
                    return receipt
            elif value.get('id') != creation_receipt['object_id'] or not subset(value, creation_op['body']):
                return receipt
            elif creation_op['kind'] in ('applications', 'servicePrincipals') and value.get('appId') != creation_receipt['properties']['appId']:
                return receipt
            if creation_op['kind'] == 'applications' and value.get('keyCredentials', []) != []:
                return receipt
            r = self._request(op['method'], op['url'], op['body'], op, before_send)
            if r['status'] != 204:
                return receipt
            receipt.update(write_terminal=True)
            checkpoint(deepcopy(receipt))
            r = self._request('GET', url, None, op)
            absent = r['status'] == 404
            if password and r['status'] == 200:
                value = json_body(r)
                absent = value.get('id') == url.rsplit('/', 1)[-1] and not any(
                    p.get('keyId') == creation_receipt['object_id'] for p in password_credentials(value))
            if absent:
                receipt.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
                checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt

    def readback_cleanup(self, creation_op, creation_receipt, op, receipt):
        self._owned(creation_op, creation_receipt)
        self._validate(op, 'Microsoft.Graph', tuple('cleanup:' + k for k in GRAPH_KINDS))
        if (receipt.get('operation_id') != op['id'] or receipt.get('request_digest') != digest(op)
                or receipt.get('object_id') != creation_receipt['object_id']):
            raise AuthDenied('auth_cleanup_binding')
        result = deepcopy(receipt)
        if result.get('write_terminal') is not True:
            return result
        try:
            url = self._read_url(creation_op, creation_receipt)
            r = self._request('GET', url, None, op)
            absent = r['status'] == 404
            if creation_op['kind'] == 'addPassword' and r['status'] == 200:
                v = json_body(r)
                absent = v.get('id') == url.rsplit('/', 1)[-1] and not any(
                    x.get('keyId') == creation_receipt['object_id'] for x in password_credentials(v))
            if absent:
                result.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
            return result
        except Exception:
            return result


def auth_configuration(binding, app_id):
    """ACA documented wire shape; one audience and one OWNER, token store off.

    https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/containerapps/authconfigs
    https://learn.microsoft.com/azure/container-apps/authentication-entra
    """
    return {'properties': {
        'platform': {'enabled': True},
        'globalValidation': {'unauthenticatedClientAction': 'Return401', 'excludedPaths': []},
        'httpSettings': {'requireHttps': True},
        'identityProviders': {'azureActiveDirectory': {
            'enabled': True,
            'registration': {'clientId': guid(app_id),
                             'openIdIssuer': 'https://login.microsoftonline.com/' + guid(binding['tenant_id']) + '/v2.0',
                             'clientSecretSettingName': binding['platform_secret_name']},
            'validation': {'allowedAudiences': [app_id], 'defaultAuthorizationPolicy': {
                'allowedPrincipals': {'identities': [guid(binding['owner_id'])], 'groups': []}}}}},
        'login': {'tokenStore': {'enabled': False}},
    }}


def build_auth_operations(binding, receipts, deadline, app_operation_id):
    """Concrete safe metadata operations after Graph IDs exist; no secret value."""
    app = receipts[app_operation_id]
    graph_apps = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'applications']
    passwords = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'addPassword']
    owners = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'appRoleAssignedTo']
    if not ready(app) or len(graph_apps) != 1 or len(passwords) != 1 or len(owners) != 1:
        raise AuthDenied('auth_dependency')
    target = binding['target_app_id']
    if app['object_id'] != target:
        raise AuthDenied('auth_app_target')
    def operation(ident, kind, method, resource, body, dependencies, action):
        return {'id': ident, 'provider': 'Microsoft.App', 'kind': kind, 'method': method,
                'url': ARM + resource + '?api-version=' + API_VERSION, 'body': body,
                'deadline': deadline, 'depends_on': dependencies,
                'expected': {'resource_id': resource, 'api_version': API_VERSION,
                    'body_sha256': digest(body), 'properties': {'properties.environmentId': binding['environment_id']}, 'created_by_run': True,
                    'before_absent': kind == 'authConfigs', 'auth_action': action,
                    'update_from': {'operation_id': app_operation_id, 'request_digest': app['request_digest']}, 'location': binding['location']},
                'cleanup': {'deadline': EXPIRY, 'created_only': True, 'zero_reference_required': True}}
    delivery = operation('auth-platform-secret', 'containerApps', 'PATCH', target,
        {'location': binding['location'], 'properties': {'configuration': {'secrets': [
            {'name': n} for n in binding['runtime_secret_names'] + [binding['platform_secret_name']]]}}},
        [app_operation_id, passwords[0]['operation_id']], 'authPlatformSecret')
    delivery['expected']['credentialOperationId'] = passwords[0]['operation_id']
    config = operation('auth-config', 'authConfigs', 'PUT', target + '/authConfigs/current',
        auth_configuration(binding, graph_apps[0]['properties']['appId']),
        [delivery['id'], owners[0]['operation_id']], 'authConfigs')
    ingress = operation('auth-ingress', 'containerApps', 'PATCH', target,
        {'location': binding['location'], 'properties': {'configuration': {'ingress': {'external': True}}}},
        [config['id'], delivery['id'], owners[0]['operation_id']], 'authIngress')
    ingress['expected']['properties']['properties.configuration.ingress.external'] = True
    ingress['expected']['update_from'] = {'operation_id': delivery['id'], 'request_digest': digest(delivery)}
    return [delivery, config, ingress]


def build_auth_cleanup(creation_op, creation_receipt, binding, deadline, reference_evidence):
    """Materialize only exact receipt-owned cleanup; evidence is journal-trusted.

    Hashes bind but do not authenticate caller JSON. The controller verifies the
    complete reference observations/closed App receipt before invoking this
    builder; it must never manufacture a 'references_cleared' attestation.
    Credential revocation and OWNER assignment removal need no zero-reference
    claim. Application/SP and platform-secret deletion require that claim.
    """
    if (creation_receipt.get('operation_id') != creation_op['id']
            or creation_receipt.get('request_digest') != digest(creation_op)
            or creation_receipt.get('created_by_run') is not True
            or creation_receipt.get('write_terminal') is not True):
        raise AuthDenied('auth_creation_receipt')
    proof = reference_evidence
    if (not isinstance(proof, dict) or proof.get('complete') is not True
            or proof.get('creation_request_digest') != digest(creation_op)
            or proof.get('creation_receipt_digest') != digest(creation_receipt)
            or proof.get('object_id') != creation_receipt['object_id']
            or not isinstance(proof.get('depends_on'), list)
            or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', x) for x in proof['depends_on'])):
        raise AuthDenied('auth_cleanup_evidence')
    instant(deadline)
    op = deepcopy(creation_op)
    op.update(id='cleanup_' + creation_op['id'].replace('-', '_'), deadline=deadline,
              depends_on=list(proof['depends_on']))
    latest_app = proof.get('latest_app_receipt', creation_receipt)
    if creation_op['provider'] == 'Microsoft.App' and creation_op['kind'] == 'containerApps':
        if (not ready(latest_app) or latest_app.get('write_terminal') is not True
                or latest_app.get('object_id') != binding['target_app_id']
                or not re.fullmatch(r'[0-9a-f]{64}', latest_app.get('request_digest', ''))
                or latest_app.get('operation_id') not in proof['depends_on']):
            raise AuthDenied('auth_cleanup_latest_app')
    if creation_op['provider'] == 'Microsoft.Graph':
        kind = creation_op['kind']
        if kind not in GRAPH_KINDS:
            raise AuthDenied('auth_cleanup_kind')
        needs_references = kind in ('applications', 'servicePrincipals')
        if needs_references and proof.get('references_cleared') is not True:
            raise AuthDenied('auth_cleanup_evidence')
        ident = creation_receipt['object_id']
        if kind == 'addPassword':
            op.update(method='POST', url=creation_op['url'].removesuffix('/addPassword') + '/removePassword', body={'keyId': guid(ident)})
        else:
            op.update(method='DELETE', url=creation_op['url'] + '/' + (opaque_id(ident) if kind == 'appRoleAssignedTo' else guid(ident)), body=None)
        op['kind'] = 'cleanup:' + kind
        op['expected'] = {'body_sha256': digest(op['body']), 'creation_request_digest': digest(creation_op),
                          'references_cleared': proof.get('references_cleared') is True}
    elif creation_op['provider'] == 'Microsoft.App' and creation_op['kind'] == 'authConfigs':
        if creation_receipt['object_id'] != binding['target_app_id'] + '/authConfigs/current':
            raise AuthDenied('auth_cleanup_binding')
        needs_references = False
        op['kind'] = 'cleanup:authConfigs'
        op['body']['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
        op['expected'] = {'body_sha256': digest(op['body']), 'creation_request_digest': digest(creation_op),
                          'auth_action': 'cleanup:authConfigs'}
    elif creation_op['provider'] == 'Microsoft.App' and creation_op['expected'].get('auth_action') == 'authIngress':
        if (creation_receipt['object_id'] != binding['target_app_id']
                or latest_app != creation_receipt):
            raise AuthDenied('auth_cleanup_binding')
        needs_references = False
        op['body'] = {'location': binding['location'], 'properties': {'configuration': {'ingress': {'external': False}}}}
        op['expected'].update(auth_action='cleanup:authIngress', body_sha256=digest(op['body']),
            creation_request_digest=digest(creation_op),
            update_from={'operation_id': latest_app['operation_id'], 'request_digest': latest_app['request_digest']})
        op['expected']['properties']['properties.configuration.ingress.external'] = False
    elif creation_op['provider'] == 'Microsoft.App' and creation_op['expected'].get('auth_action') == 'authPlatformSecret':
        if creation_receipt['object_id'] != binding['target_app_id'] or proof.get('references_cleared') is not True:
            raise AuthDenied('auth_cleanup_binding')
        needs_references = True
        op['body']['properties']['configuration']['secrets'] = [{'name': n} for n in binding['runtime_secret_names']]
        op['expected'].update(auth_action='cleanup:authPlatformSecret', body_sha256=digest(op['body']),
            creation_request_digest=digest(creation_op), references_cleared=True,
            update_from={'operation_id': latest_app['operation_id'], 'request_digest': latest_app['request_digest']})
    else:
        raise AuthDenied('auth_cleanup_kind')
    op['cleanup'] = {'created_only': True, 'zero_reference_required': needs_references,
                     'reference_evidence_digest': digest(proof)}
    return op


class EasyAuthAdapter(_Bounded):
    """Fixed new trial App only; memory-only secret handoff, no listSecrets.

    ACA does not document If-Match/CAS for these APIs. Two matching fresh GETs,
    root's sole-writer journal and a strict post-readback detect changes, but do
    not claim atomic exclusion of external writers. Existing opaque values must
    come only from the already-approved fixed private originals callback; this
    adapter neither reads values from ACA nor persists them.
    """
    def __init__(self, binding, credential, http, preserved_runtime_secrets,
                 clock=time.time, monotonic=time.monotonic, arm_provider=None):
        super().__init__(credential, http, clock, monotonic)
        self.binding = deepcopy(binding)
        if (getattr(credential, 'mode', None) != 'owner'
                or getattr(credential, 'principal', '').lower() != binding['owner_id'].lower()
                or getattr(credential, 'tenant', '').lower() != binding['tenant_id'].lower()):
            raise AuthDenied('auth_owner_required')
        self.preserved_runtime_secrets = preserved_runtime_secrets
        self.arm_provider = arm_provider
        target = binding['target_app_id']
        if not re.fullmatch(r'/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_.()-]+/providers/Microsoft\.App/containerApps/[a-z0-9-]+', target):
            raise AuthDenied('auth_app_target')
        self.app_url = ARM + target + '?api-version=' + API_VERSION
        self.auth_url = ARM + target + '/authConfigs/current?api-version=' + API_VERSION
        self.auth_id = target + '/authConfigs/current'
        names = binding['runtime_secret_names']
        if (not isinstance(names, list) or len(set(names)) != len(names)
                or binding['platform_secret_name'] in names
                or any(not re.fullmatch(r'[a-z0-9-]{1,253}', n) for n in names + [binding['platform_secret_name']])):
            raise AuthDenied('auth_secret_names')
        for k in ('tenant_id', 'owner_id'):
            guid(binding[k])

    def _app(self, op, expected_names, external=False, *, recovery_receipt=None):
        r = self._request('GET', self.app_url, None, op, recovery_receipt=recovery_receipt)
        value = json_body(r)
        if r['status'] != 200 or value.get('id') != self.binding['target_app_id']:
            raise AuthDenied('auth_app_readback')
        p = value.get('properties', {})
        cfg = p.get('configuration', {})
        if (p.get('provisioningState') != 'Succeeded'
                or cfg.get('ingress', {}).get('external') is not external
                or not isinstance(value.get('location'), str)
                or value['location'].lower().replace(' ', '') != self.binding['location']
                or p.get('environmentId') != self.binding['environment_id']):
            raise AuthDenied('auth_closed_app_required')
        secrets = cfg.get('secrets')
        if (not isinstance(secrets, list) or len(secrets) != len(expected_names)
                or {s.get('name') for s in secrets} != set(expected_names)
                or any(set(s) - {'name'} for s in secrets)):
            raise AuthDenied('auth_unknown_secret')
        template = p.get('template', {})
        secret_name = self.binding['platform_secret_name']
        for volume in template.get('volumes', []):
            if volume.get('storageType') == 'Secret':
                entries = volume.get('secrets')
                if not entries or any(x.get('secretRef') == secret_name for x in entries):
                    raise AuthDenied('auth_secret_mount')
        for container in template.get('containers', []) + template.get('initContainers', []):
            if any(e.get('secretRef') == secret_name for e in container.get('env', [])):
                raise AuthDenied('auth_secret_application_exposure')
        if any(reg.get('passwordSecretRef') == secret_name for reg in cfg.get('registries', [])):
            raise AuthDenied('auth_secret_application_exposure')
        def exposed(value):
            if isinstance(value, dict):
                return any((k in ('secretRef', 'passwordSecretRef') and v == secret_name) or exposed(v)
                           for k, v in value.items())
            return isinstance(value, list) and any(exposed(v) for v in value)
        if exposed(template) or exposed(cfg):
            raise AuthDenied('auth_secret_application_exposure')
        return value, r.get('headers', {})

    def _stable_app(self, op, names, external=False):
        first, _ = self._app(op, names, external=external)
        second, headers = self._app(op, names, external=external)
        if digest(first) != digest(second):
            raise AuthDenied('auth_concurrent_change')
        return second, headers

    def _runtime_values(self):
        values = self.preserved_runtime_secrets()
        if (not isinstance(values, dict) or set(values) != set(self.binding['runtime_secret_names'])
                or any(not isinstance(v, str) or not 1 <= len(v) <= 65536 for v in values.values())):
            raise AuthDenied('auth_runtime_secret_binding')
        return [{'name': n, 'value': values[n]} for n in self.binding['runtime_secret_names']]

    def _platform_validation(self, op, cleanup=False):
        self._validate(op, 'Microsoft.App', ('containerApps',))
        names = self.binding['runtime_secret_names'] + ([] if cleanup else [self.binding['platform_secret_name']])
        expected_body = {'location': self.binding['location'], 'properties': {'configuration': {
            'secrets': [{'name': n} for n in names]}}}
        if (op['method'] != 'PATCH' or op['url'] != self.app_url
                or op['body'] != expected_body
                or op['expected'].get('auth_action') != ('cleanup:authPlatformSecret' if cleanup else 'authPlatformSecret')):
            raise AuthDenied('auth_platform_operation')

    def _write_ack(self, op, response, receipt):
        """Normalize accepted LRO without retaining wire payload or secret text."""
        if self.arm_provider is None:
            if (response['status'] != 200 or json_body(response).get('id') != self.binding['target_app_id']
                    or json_body(response).get('properties', {}).get('provisioningState') != 'Succeeded'):
                return receipt
            result = deepcopy(receipt)
            result.update(write_terminal=True, created_by_run=True)
            return result
        provider_receipt = self.arm_provider.normalize_write(op, response)
        result = deepcopy(provider_receipt)
        if (result.get('operation_id') != op['id'] or result.get('request_digest') != digest(op)
                or result.get('object_id') not in (None, self.binding['target_app_id'])):
            raise AuthDenied('auth_ack_binding')
        result['object_id'] = self.binding['target_app_id']
        result['properties'] = deepcopy(receipt['properties'])
        if result.get('state') != 'failed':
            result.update(state='pending', terminal=False, readback_verified=False)
        return result

    def readback(self, op, receipt):
        """Finite GET-only continuation, including accepted PATCH LROs.

        A timeout with no acknowledged operation URL stays UNKNOWN even when
        the desired secret name is visible. No callback can regenerate/deliver.
        """
        if op['kind'] == 'cleanup:authConfigs':
            return self.readback_cleanup_auth(op, receipt)
        if op['expected'].get('auth_action') == 'cleanup:authIngress':
            return self.readback_cleanup_ingress(op, receipt)
        self._validate(op, 'Microsoft.App', ('containerApps',), readback=True)
        if (receipt.get('operation_id') != op['id'] or receipt.get('request_digest') != digest(op)
                or receipt.get('object_id') != self.binding['target_app_id']):
            raise AuthDenied('auth_readback_binding')
        result = deepcopy(receipt)
        if not self._readback_ack(op, result, lro=True):
            return result
        try:
            if not result.get('write_terminal'):
                if self.arm_provider is None:
                    return result
                previous_properties = deepcopy(result['properties'])
                result = self.arm_provider.poll(op, result)
                result['properties'] = previous_properties
                if (result.get('operation_id') != op['id'] or result.get('request_digest') != digest(op)
                        or result.get('object_id') != self.binding['target_app_id']):
                    raise AuthDenied('auth_poll_binding')
                if result.get('state') != 'failed':
                    result.update(state='pending', terminal=False, readback_verified=False)
            if result.get('write_terminal') is not True:
                return result
            action = op['expected'].get('auth_action')
            names = self.binding['runtime_secret_names'] + ([] if action == 'cleanup:authPlatformSecret' else [self.binding['platform_secret_name']])
            after, _ = self._app(op, names, recovery_receipt=result)
            retained = deepcopy(after['properties']['configuration'])
            retained.pop('secrets', None)
            props = result['properties']
            if (digest(retained) != props['retainedConfigurationDigest']
                    or digest(after['properties'].get('template')) != props['retainedTemplateDigest']):
                return result
            result = completed(result)
            if action == 'cleanup:authPlatformSecret':
                result['absent'] = True
            return result
        except Exception:
            return result

    def deliver(self, op, secret, credential_receipt, before_send, checkpoint, app_receipt):
        """Called synchronously from GraphAdapter's addPassword callback."""
        self._platform_validation(op)
        if (not ready(credential_receipt) or credential_receipt['properties'].get('kind') != 'addPassword'
                or op['expected'].get('credentialOperationId') != credential_receipt['operation_id']
                or not ready(app_receipt) or app_receipt['object_id'] != self.binding['target_app_id']
                or not isinstance(secret, str) or not 16 <= len(secret) <= 256):
            raise AuthDenied('auth_platform_dependency')
        receipt = progress(op)
        wire_body = None
        try:
            names = self.binding['runtime_secret_names']
            current, headers = self._stable_app(op, names)
            retained = deepcopy(current['properties']['configuration'])
            retained.pop('secrets', None)
            receipt = progress(op, self.binding['target_app_id'], {
                'kind': 'authPlatformSecret', 'secretName': self.binding['platform_secret_name'],
                'credentialOperationId': credential_receipt['operation_id'],
                'retainedConfigurationDigest': digest(retained),
                'retainedTemplateDigest': digest(current['properties'].get('template'))})
            values = self._runtime_values() + [{'name': self.binding['platform_secret_name'], 'value': secret}]
            wire_body = {'location': current['location'], 'properties': {'configuration': {'secrets': values}}}
            r = self._request('PATCH', self.app_url, wire_body, op, before_send,
                              {'If-Match': headers['etag']} if headers.get('etag') else {},
                              after_intent=lambda: checkpoint(deepcopy(receipt)))
            receipt = self._write_ack(op, r, receipt)
            checkpoint(deepcopy(receipt))
            if receipt.get('write_terminal') is not True:
                return receipt
            after, _ = self._app(op, names + [self.binding['platform_secret_name']])
            before_without = deepcopy(current)
            after_without = deepcopy(after)
            # Provider timestamps/revision metadata may change; compare the
            # configuration and template which this PATCH must preserve.
            before_cfg = before_without['properties']['configuration']
            after_cfg = after_without['properties']['configuration']
            before_cfg.pop('secrets', None); after_cfg.pop('secrets', None)
            if before_cfg != after_cfg or current['properties'].get('template') != after['properties'].get('template'):
                return receipt
            receipt = completed(receipt)
            checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt
        finally:
            if wire_body:
                for entry in wire_body['properties']['configuration']['secrets']:
                    entry.pop('value', None)
            secret = None

    def execute(self, op, receipts, before_send, checkpoint):
        self._validate(op, 'Microsoft.App', ('authConfigs',))
        if op['method'] != 'PUT' or op['url'] != self.auth_url:
            raise AuthDenied('auth_config_operation')
        for dependency in op['depends_on']:
            if not ready(receipts.get(dependency)):
                raise AuthDenied('auth_dependency')
        apps = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'applications']
        secrets = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'authPlatformSecret'
                   and r.get('object_id') == self.binding['target_app_id']]
        owners = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == 'appRoleAssignedTo'
                  and r['properties'].get('principalId') == self.binding['owner_id']]
        if len(apps) != 1 or len(secrets) != 1 or len(owners) != 1:
            raise AuthDenied('auth_config_dependency')
        expected = auth_configuration(self.binding, apps[0]['properties']['appId'])
        if not same(op['body'], expected):
            raise AuthDenied('auth_config_body')
        receipt = progress(op)
        try:
            self._stable_app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']])
            existing = self._request('GET', self.auth_url, None, op)
            prior = json_body(existing) if existing['status'] == 200 else {}
            disabled_default = (existing['status'] == 200 and prior.get('id') == self.auth_id
                and prior.get('properties', {}).get('platform', {}).get('enabled') is False
                and not prior.get('properties', {}).get('identityProviders'))
            if existing['status'] != 404 and not disabled_default:
                raise AuthDenied('auth_config_already_exists')
            r = self._request('PUT', self.auth_url, op['body'], op, before_send)
            if r['status'] not in (200, 201):
                return receipt
            value = json_body(r)
            if value.get('id') != self.auth_id or not self._config_matches(value, expected):
                return receipt
            receipt = progress(op, self.auth_id, {'kind': 'authConfigs', 'appId': apps[0]['properties']['appId'],
                               'secretName': self.binding['platform_secret_name']}, True)
            checkpoint(deepcopy(receipt))
            r = self._request('GET', self.auth_url, None, op)
            if r['status'] == 200 and json_body(r).get('id') == self.auth_id and self._config_matches(json_body(r), expected):
                receipt = completed(receipt)
                checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt

    def readback_config(self, op, receipt):
        self._validate(op, 'Microsoft.App', ('authConfigs',), readback=True)
        self._owned(op, receipt)
        if op['url'] != self.auth_url or receipt['object_id'] != self.auth_id:
            raise AuthDenied('auth_config_operation')
        try:
            r = self._request('GET', self.auth_url, None, op, recovery_receipt=receipt)
            value = json_body(r)
            if r['status'] == 200 and value.get('id') == self.auth_id and self._config_matches(value, op['body']):
                return completed(receipt)
        except Exception:
            pass
        return deepcopy(receipt)

    def enable_ingress(self, op, receipts, before_send, checkpoint):
        """Open only this App after fresh OWNER-only auth/Graph readbacks."""
        self._validate(op, 'Microsoft.App', ('containerApps',))
        if (op['method'] != 'PATCH' or op['url'] != self.app_url
                or op['expected'].get('auth_action') != 'authIngress'
                or op['body'] != {'location': self.binding['location'], 'properties': {'configuration': {'ingress': {'external': True}}}}):
            raise AuthDenied('auth_ingress_operation')
        for dependency in op['depends_on']:
            if not ready(receipts.get(dependency)):
                raise AuthDenied('auth_dependency')
        def only(kind):
            items = [r for r in receipts.values() if ready(r) and r.get('properties', {}).get('kind') == kind]
            if len(items) != 1:
                raise AuthDenied('auth_dependency')
            return items[0]
        config, sp, assignment = only('authConfigs'), only('servicePrincipals'), only('appRoleAssignedTo')
        if config['object_id'] != self.auth_id or assignment['properties'].get('principalId') != self.binding['owner_id']:
            raise AuthDenied('auth_dependency')
        receipt = progress(op)
        try:
            current, headers = self._stable_app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']])
            r = self._request('GET', self.auth_url, None, op)
            if r['status'] != 200 or json_body(r).get('id') != self.auth_id or not self._config_matches(json_body(r), auth_configuration(self.binding, config['properties']['appId'])):
                return receipt
            sp_id = guid(sp['properties']['servicePrincipalObjectId'])
            r = self._request('GET', GRAPH + '/servicePrincipals/' + sp_id, None, op)
            if r['status'] != 200 or not subset(json_body(r), {'id': sp_id, 'appId': config['properties']['appId'], 'appRoleAssignmentRequired': True}):
                return receipt
            assignment_id = opaque_id(assignment['properties']['directoryAssignmentId'])
            r = self._request('GET', GRAPH + '/servicePrincipals/' + sp_id + '/appRoleAssignedTo/' + assignment_id, None, op)
            if r['status'] != 200 or not subset(json_body(r), {'id': assignment_id, 'principalId': self.binding['owner_id'], 'resourceId': sp_id, 'appRoleId': self.binding['app_role_id']}):
                return receipt
            from scripts.trial_provision.resources import public_trial_origin
            expected_origin = public_trial_origin({'names': {'app': self.binding['target_app_id'].rsplit('/', 1)[-1]},
                'region': self.binding['location']}, current['properties']['configuration']['ingress'].get('fqdn'))
            if expected_origin + '/.auth/login/aad/callback' != self.binding['redirect_uri']:
                return receipt
            retained = deepcopy(current['properties']['configuration'])
            retained['ingress']['external'] = True
            retained['ingress']['fqdn'] = urlsplit(expected_origin).hostname
            receipt = progress(op, self.binding['target_app_id'], {'kind': 'authIngress',
                'retainedConfigurationDigest': digest(retained), 'retainedTemplateDigest': digest(current['properties'].get('template'))})
            r = self._request('PATCH', self.app_url, op['body'], op, before_send,
                              {'If-Match': headers['etag']} if headers.get('etag') else {},
                              after_intent=lambda: checkpoint(deepcopy(receipt)))
            receipt = self._write_ack(op, r, receipt)
            checkpoint(deepcopy(receipt))
            return self.readback_ingress(op, receipt)
        except Exception:
            return receipt

    def readback_ingress(self, op, receipt):
        self._validate(op, 'Microsoft.App', ('containerApps',), readback=True)
        if (op['url'] != self.app_url or receipt.get('operation_id') != op['id']
                or receipt.get('request_digest') != digest(op) or op['expected'].get('auth_action') != 'authIngress'
                or receipt.get('object_id') != self.binding['target_app_id']):
            raise AuthDenied('auth_ingress_operation')
        result = deepcopy(receipt)
        if not self._readback_ack(op, result, lro=True):
            return result
        try:
            if not result.get('write_terminal'):
                if self.arm_provider is None:
                    return result
                props = deepcopy(result['properties'])
                result = self.arm_provider.poll(op, result)
                result['properties'] = props
                if (result.get('operation_id') != op['id'] or result.get('request_digest') != digest(op)
                        or result.get('object_id') != self.binding['target_app_id']):
                    raise AuthDenied('auth_poll_binding')
            if result.get('write_terminal') is not True:
                return result
            after, _ = self._app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']], external=True, recovery_receipt=result)
            fqdn = after['properties']['configuration']['ingress'].get('fqdn')
            if fqdn != urlsplit(self.binding['redirect_uri']).hostname:
                return result
            if (digest(after['properties']['configuration']) == result['properties']['retainedConfigurationDigest']
                    and digest(after['properties'].get('template')) == result['properties']['retainedTemplateDigest']):
                result['properties']['defaultDomain'] = fqdn
                return completed(result)
            return result
        except Exception:
            return result

    def cleanup_ingress(self, creation_op, creation_receipt, op, before_send, checkpoint):
        """Close only the exact ingress opened by this run; never renew it.

        A known E7 receipt and its unchanged current configuration bind the
        reverse PATCH. After the original deadline this remains bounded cleanup.
        An unknown PATCH is never repeated, including after process restart.
        """
        self._owned(creation_op, creation_receipt)
        self._validate(op, 'Microsoft.App', ('containerApps',))
        if (creation_op['expected'].get('auth_action') != 'authIngress'
                or creation_receipt.get('object_id') != self.binding['target_app_id']
                or not ready(creation_receipt)
                or op['method'] != 'PATCH' or op['url'] != self.app_url
                or op['expected'].get('auth_action') != 'cleanup:authIngress'
                or op['expected'].get('creation_request_digest') != digest(creation_op)
                or op['expected'].get('update_from') != {'operation_id': creation_op['id'], 'request_digest': digest(creation_op)}
                or op['body'] != {'location': self.binding['location'], 'properties': {'configuration': {'ingress': {'external': False}}}}):
            raise AuthDenied('auth_cleanup_binding')
        receipt = progress(op, self.binding['target_app_id'])
        try:
            names = self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']]
            current, headers = self._stable_app(op, names, external=True)
            properties = creation_receipt['properties']
            cfg = current['properties']['configuration']
            public_host = urlsplit(self.binding['redirect_uri']).hostname
            if (cfg['ingress'].get('fqdn') != public_host
                    or digest(cfg) != properties['retainedConfigurationDigest']
                    or digest(current['properties'].get('template')) != properties['retainedTemplateDigest']):
                return receipt
            app_name, suffix = public_host.split('.', 1)
            internal_host = app_name + '.internal.' + suffix
            retained = deepcopy(cfg)
            retained['ingress'].update(external=False, fqdn=internal_host)
            receipt['properties'] = {'kind': 'cleanup:authIngress',
                'retainedConfigurationDigest': digest(retained),
                'retainedTemplateDigest': properties['retainedTemplateDigest'],
                'expectedInternalDomain': internal_host}
            r = self._request('PATCH', self.app_url, op['body'], op, before_send,
                {'If-Match': headers['etag']} if headers.get('etag') else {},
                after_intent=lambda: checkpoint(deepcopy(receipt)))
            receipt = self._write_ack(op, r, receipt)
            checkpoint(deepcopy(receipt))
            result = self.readback_cleanup_ingress(op, receipt)
            if result != receipt:
                checkpoint(deepcopy(result))
            return result
        except Exception:
            return receipt

    def readback_cleanup_ingress(self, op, receipt):
        self._validate(op, 'Microsoft.App', ('containerApps',))
        if (op['url'] != self.app_url or op['method'] != 'PATCH'
                or op['expected'].get('auth_action') != 'cleanup:authIngress'
                or receipt.get('operation_id') != op['id'] or receipt.get('request_digest') != digest(op)
                or receipt.get('object_id') != self.binding['target_app_id']):
            raise AuthDenied('auth_cleanup_binding')
        result = deepcopy(receipt)
        try:
            if result.get('write_terminal') is not True:
                if self.arm_provider is None:
                    return result
                props = deepcopy(result['properties'])
                result = self.arm_provider.poll(op, result)
                result['properties'] = props
                if (result.get('operation_id') != op['id'] or result.get('request_digest') != digest(op)
                        or result.get('object_id') != self.binding['target_app_id']):
                    raise AuthDenied('auth_poll_binding')
            if result.get('write_terminal') is not True:
                return result
            result.update(state='pending', terminal=False, readback_verified=False)
            current, _ = self._app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']])
            cfg = current['properties']['configuration']
            if (cfg['ingress'].get('fqdn') == result['properties']['expectedInternalDomain']
                    and digest(cfg) == result['properties']['retainedConfigurationDigest']
                    and digest(current['properties'].get('template')) == result['properties']['retainedTemplateDigest']):
                result['properties']['defaultDomain'] = cfg['ingress']['fqdn']
                result.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
            return result
        except Exception:
            return result

    def _config_matches(self, value, expected):
        p = value.get('properties', {})
        # Reject security widening via fields the approved template omits.
        providers = p.get('identityProviders', {})
        if any(v.get('enabled') is not False for k, v in providers.items() if k != 'azureActiveDirectory'):
            return False
        aad = providers.get('azureActiveDirectory', {})
        registration = aad.get('registration', {})
        if any(v not in (None, '', [], {}) for k, v in registration.items()
               if k not in ('clientId', 'openIdIssuer', 'clientSecretSettingName')):
            return False
        validation = aad.get('validation', {})
        principals = validation.get('defaultAuthorizationPolicy', {}).get('allowedPrincipals', {})
        if principals.get('groups', []) != []:
            return False
        if p.get('login', {}).get('allowedExternalRedirectUrls', []) != []:
            return False
        normalized = deepcopy(value)
        np = normalized.setdefault('properties', {})
        np.setdefault('login', {}).setdefault('tokenStore', {}).setdefault('enabled', False)
        np.setdefault('globalValidation', {}).setdefault('excludedPaths', [])
        np.setdefault('identityProviders', {}).setdefault('azureActiveDirectory', {}).setdefault(
            'validation', {}).setdefault('defaultAuthorizationPolicy', {}).setdefault('allowedPrincipals', {}).setdefault('groups', [])
        return subset(normalized, expected)

    def cleanup_secret(self, creation_op, creation_receipt, op, before_send, checkpoint):
        self._owned(creation_op, creation_receipt)
        self._platform_validation(op, cleanup=True)
        if (creation_receipt['object_id'] != self.binding['target_app_id']
                or op['expected'].get('creation_request_digest') != digest(creation_op)
                or op['expected'].get('references_cleared') is not True):
            raise AuthDenied('auth_cleanup_binding')
        receipt = progress(op, self.binding['target_app_id'])
        wire_body = None
        try:
            names = self.binding['runtime_secret_names']
            current, headers = self._stable_app(op, names + [self.binding['platform_secret_name']])
            retained = deepcopy(current['properties']['configuration'])
            retained.pop('secrets', None)
            receipt['properties'] = {'kind': 'cleanup:authPlatformSecret',
                'retainedConfigurationDigest': digest(retained),
                'retainedTemplateDigest': digest(current['properties'].get('template'))}
            auth = self._request('GET', self.auth_url, None, op)
            if auth['status'] != 200 or json_body(auth).get('id') != self.auth_id:
                return receipt
            registration = json_body(auth).get('properties', {}).get('identityProviders', {}).get('azureActiveDirectory', {}).get('registration', {})
            if registration.get('clientSecretSettingName'):
                return receipt
            wire_body = {'location': current['location'], 'properties': {'configuration': {'secrets': self._runtime_values()}}}
            r = self._request('PATCH', self.app_url, wire_body, op, before_send,
                              {'If-Match': headers['etag']} if headers.get('etag') else {},
                              after_intent=lambda: checkpoint(deepcopy(receipt)))
            receipt = self._write_ack(op, r, receipt)
            checkpoint(deepcopy(receipt))
            if receipt.get('write_terminal') is not True:
                return receipt
            after, _ = self._app(op, names)
            before_cfg = deepcopy(current['properties']['configuration'])
            after_cfg = deepcopy(after['properties']['configuration'])
            before_cfg.pop('secrets', None); after_cfg.pop('secrets', None)
            if before_cfg == after_cfg and current['properties'].get('template') == after['properties'].get('template'):
                receipt.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
                checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt
        finally:
            if wire_body:
                for entry in wire_body['properties']['configuration']['secrets']:
                    entry.pop('value', None)

    def cleanup_auth(self, creation_op, creation_receipt, op, before_send, checkpoint):
        """Keep authentication enforced; remove only our reference, while closed."""
        self._owned(creation_op, creation_receipt)
        self._validate(op, 'Microsoft.App', ('cleanup:authConfigs',))
        expected = deepcopy(creation_op['body'])
        expected['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
        if (creation_receipt['object_id'] != self.auth_id or op['url'] != self.auth_url
                or op['method'] != 'PUT' or op['body'] != expected
                or op['expected'].get('creation_request_digest') != digest(creation_op)):
            raise AuthDenied('auth_cleanup_binding')
        receipt = progress(op, self.auth_id)
        try:
            self._stable_app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']])
            r = self._request('GET', self.auth_url, None, op)
            value = json_body(r)
            if r['status'] != 200 or value.get('id') != self.auth_id or not self._config_matches(value, creation_op['body']):
                return receipt
            # Preserve optional runtime/provider fields received from this exact
            # auth config, never remove the entire config and expose anonymous.
            actual = {'properties': deepcopy(value['properties'])}
            actual['properties']['identityProviders']['azureActiveDirectory']['registration'].pop('clientSecretSettingName')
            receipt['properties'] = {'retainedAuthDigest': digest(actual['properties'])}
            r = self._request('PUT', self.auth_url, actual, op, before_send,
                after_intent=lambda: checkpoint(deepcopy(receipt)))
            if r['status'] not in (200, 201) or json_body(r).get('id') != self.auth_id:
                return receipt
            receipt['write_terminal'] = True
            checkpoint(deepcopy(receipt))
            r = self._request('GET', self.auth_url, None, op)
            after = json_body(r)
            registration = after.get('properties', {}).get('identityProviders', {}).get('azureActiveDirectory', {}).get('registration', {})
            if r['status'] == 200 and after.get('id') == self.auth_id and not registration.get('clientSecretSettingName') and subset(after, actual):
                receipt.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
                checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt

    def readback_cleanup_auth(self, op, receipt):
        self._validate(op, 'Microsoft.App', ('cleanup:authConfigs',))
        if (op['url'] != self.auth_url or receipt.get('operation_id') != op['id']
                or receipt.get('request_digest') != digest(op) or receipt.get('object_id') != self.auth_id):
            raise AuthDenied('auth_cleanup_binding')
        result = deepcopy(receipt)
        if result.get('write_terminal') is not True:
            return result
        try:
            r = self._request('GET', self.auth_url, None, op)
            value = json_body(r)
            registration = value.get('properties', {}).get('identityProviders', {}).get('azureActiveDirectory', {}).get('registration', {})
            if (r['status'] == 200 and value.get('id') == self.auth_id
                    and not registration.get('clientSecretSettingName')
                    and subset(value, op['body'])
                    and digest(value.get('properties')) == result['properties']['retainedAuthDigest']):
                result.update(state='succeeded', terminal=True, readback_verified=True, absent=True)
            return result
        except Exception:
            return result
