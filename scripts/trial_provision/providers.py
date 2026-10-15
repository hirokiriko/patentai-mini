"""Bounded, fixed-plan ARM provisioning. No CLI entry point or implicit execution.

The controller persists a one-send intent and charges *each* invocation before
calling this module. It owns the approved plan, exclusive writer lock, dependency
proofs and durable receipts. Receipts below are private journal data, never logs.
One method performs at most one HTTP request. A GET cannot resolve an unknown
write; a terminal write acknowledgement AND an exact readback are required.

Contracts: Microsoft Authorization 2022-04-01; ManagedIdentity 2023-01-31;
Storage blob containers 2023-05-01; ContainerApps 2025-07-01. Primary specs:
https://github.com/Azure/azure-rest-api-specs/tree/main/specification/authorization/resource-manager
https://github.com/Azure/azure-rest-api-specs/tree/main/specification/msi/resource-manager
https://github.com/Azure/azure-rest-api-specs/tree/main/specification/storage/resource-manager
https://github.com/Azure/azure-rest-api-specs/tree/main/specification/app/resource-manager
ACA's documented operationResults URL is accepted only from the initial ACK.
An undocumented URL family stops as unknown; it never enables a generic GET.
"""
from copy import deepcopy
from datetime import timedelta
import json
import hashlib
import re
import uuid
from urllib.parse import urlsplit

from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse


ARM = 'https://management.azure.com'
KEYS = {'id', 'provider', 'kind', 'method', 'url', 'body', 'deadline',
        'depends_on', 'expected', 'cleanup'}
CONTRACTS = {
    ('Microsoft.Authorization', 'roleDefinitions'): ('2022-04-01', (201,)),
    ('Microsoft.Authorization', 'roleAssignments'): ('2022-04-01', (200, 201)),
    ('Microsoft.ManagedIdentity', 'userAssignedIdentities'): ('2023-01-31', (200, 201)),
    ('Microsoft.Storage', 'containers'): ('2023-05-01', (200, 201)),
    ('Microsoft.App', 'containerApps'): ('2025-07-01', (200, 201)),
    ('Microsoft.App', 'jobs'): ('2025-07-01', (200, 201)),
}
GUID = r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}'
NAME = r'[A-Za-z0-9][A-Za-z0-9_.-]{0,89}'
SUB = r'/subscriptions/' + GUID
RG = SUB + r'/resourceGroups/' + NAME
SCOPE = SUB + r'(?:/resourceGroups/' + NAME + r')?(?:/providers/[A-Za-z][A-Za-z0-9.]+(?:/' + NAME + r'/' + NAME + r')+)?'
RESOURCE = {
    'roleDefinitions': SCOPE + r'/providers/Microsoft.Authorization/roleDefinitions/' + GUID,
    'roleAssignments': SCOPE + r'/providers/Microsoft.Authorization/roleAssignments/' + GUID,
    'userAssignedIdentities': RG + r'/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + NAME,
    'containers': RG + r'/providers/Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}/blobServices/default/containers/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',
    'containerApps': RG + r'/providers/Microsoft.App/containerApps/[a-z][a-z0-9-]{0,30}[a-z0-9]',
    'jobs': RG + r'/providers/Microsoft.App/jobs/[a-z][a-z0-9-]{0,30}[a-z0-9]',
}
PROJECTION = {
    'userAssignedIdentities': {'principalId': 'properties.principalId', 'tenantId': 'properties.tenantId', 'clientId': 'properties.clientId'},
    'containerApps': {'defaultDomain': 'properties.configuration.ingress.fqdn'},
    'jobs': {'principalId': 'identity.principalId', 'tenantId': 'identity.tenantId'},
}


def _resource_id_matches(op, actual):
    expected = op['expected']['resource_id']
    # MSI's documented 201 example returns /resourcegroups/; ARM resource
    # names are case-insensitive. Normalize only this response comparison,
    # never the sealed request, receipt identity, scope or transport URL.
    # https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules
    if op['provider'] == 'Microsoft.ManagedIdentity' and op['kind'] == 'userAssignedIdentities':
        return type(actual) is str and actual.isascii() and actual.lower() == expected.lower()
    return actual == expected


def _identity_properties_digest(value):
    # Called only after _match validates all three canonical-form UUIDs.
    return digest({key: value['properties'][key].lower()
                   for key in ('principalId', 'tenantId', 'clientId')})


def _secret_sources(op):
    """Return only declared metadata placeholders; raw secret values forbidden."""
    declarations = op['expected'].get('secret_bindings', [])
    if not isinstance(declarations, list) or len(declarations) > 16:
        raise Denied('secret_binding')
    allowed = {}
    for entry in declarations:
        if not isinstance(entry, dict) or set(entry) != {'source', 'sha256'} or entry['source'] not in ('trial-web-database', 'trial-worker-database') or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']) or entry['source'] in allowed:
            raise Denied('secret_binding')
        allowed[entry['source']] = entry['sha256']
    if op['method'] == 'DELETE':
        return {}
    found = {}
    def visit(value, path=''):
        if isinstance(value, dict):
            if '$secretBinding' in value:
                if op['provider'] != 'Microsoft.App' or path != 'properties.configuration.secrets[].value' or set(value) != {'$secretBinding', 'sha256'} or allowed.get(value['$secretBinding']) != value['sha256']:
                    raise Denied('secret_binding')
                found[value['$secretBinding']] = value['sha256']
                return
            for key, child in value.items():
                here = path + '.' + key if path else key
                if key == 'secrets' and here != 'properties.configuration.secrets':
                    raise Denied('secret_binding')
                if path == 'properties.configuration.secrets[]' and key == 'value' and (not isinstance(child, dict) or set(child) != {'$secretBinding', 'sha256'}):
                    raise Denied('raw_secret_forbidden')
                visit(child, here)
        elif isinstance(value, list):
            for child in value: visit(child, path + '[]')
    visit(op['body'])
    if found != allowed:
        raise Denied('secret_binding')
    return allowed


def _get(value, path):
    for key in path.split('.'):
        if not isinstance(value, dict) or key not in value:
            raise Denied('resource_binding')
        value = value[key]
    return value


def _same(left, right):
    # bool must not compare equal to integer; reject NaN/Infinity too.
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def _property_tree(properties):
    result = {}
    for path, value in sorted(properties.items(), key=lambda item: item[0].count('.')):
        target = result
        names = path.split('.')
        for name in names[:-1]:
            child = target.setdefault(name, {})
            if not isinstance(child, dict):
                raise Denied('cleanup_binding')
            target = child
        target[names[-1]] = deepcopy(value)
    return result


def _input_matches(expected, actual, path=''):
    """Check every supplied writable field while tolerating service defaults.

    ACA GET masks secret values. Only that exact field is unobservable; secret
    names/refs and all environment/identity/image/template fields remain bound.
    Secret installation verification belongs to the dedicated auth/secret flow.
    """
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        if path == 'identity.userAssignedIdentities' and set(expected) != set(actual):
            return False
        for key, value in expected.items():
            here = path + '.' + key if path else key
            if path == 'properties.configuration.secrets[]' and key == 'value':
                continue
            if key not in actual or not _input_matches(value, actual[key], here):
                return False
        return True
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(
            _input_matches(e, a, path + '[]') for e, a in zip(expected, actual))
    return _same(expected, actual)


def _validate(op):
    try:
        if not isinstance(op, dict) or set(op) != KEYS or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,95}', op['id']):
            raise ValueError()
        version, _ = CONTRACTS[(op['provider'], op['kind'])]
        e = op['expected']
        required = {'resource_id', 'api_version', 'body_sha256', 'properties', 'created_by_run', 'before_absent'}
        auth_fields = {'auth_action', 'credentialOperationId', 'creation_request_digest', 'references_cleared'}
        if not required <= set(e) or set(e) - required - {'receipt_properties', 'location', 'secret_bindings', 'update_from'} - auth_fields:
            raise ValueError()
        if set(e) & auth_fields:
            if op['provider'] != 'Microsoft.App' or op['kind'] != 'containerApps' or op['method'] not in ('PATCH', 'DELETE'):
                raise ValueError()
            if e.get('auth_action') not in ('authPlatformSecret', 'authIngress', 'cleanup:authPlatformSecret', 'cleanup:authIngress'):
                raise ValueError()
            if 'credentialOperationId' in e and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,95}', e['credentialOperationId']):
                raise ValueError()
            if 'creation_request_digest' in e and not re.fullmatch(r'[0-9a-f]{64}', e['creation_request_digest']):
                raise ValueError()
            if 'references_cleared' in e and type(e['references_cleared']) is not bool:
                raise ValueError()
            if e['auth_action'].startswith('cleanup:') and not re.fullmatch(r'[0-9a-f]{64}', e.get('creation_request_digest', '')):
                raise ValueError()
        rid = e['resource_id']
        if not isinstance(rid, str) or not re.fullmatch(RESOURCE[op['kind']], rid):
            raise ValueError()
        if op['method'] not in ('PUT', 'PATCH', 'DELETE') or e['api_version'] != version or op['url'] != ARM + rid + '?api-version=' + version:
            raise ValueError()
        if e['created_by_run'] is not True or type(e['before_absent']) is not bool:
            raise ValueError()
        if op['method'] == 'PATCH':
            prior = e.get('update_from')
            if op['provider'] != 'Microsoft.App' or e['before_absent'] is not False or not isinstance(prior, dict) or set(prior) != {'operation_id', 'request_digest'} or not isinstance(prior['operation_id'], str) or not re.fullmatch(r'[0-9a-f]{64}', prior['request_digest']):
                raise ValueError()
        elif op['method'] == 'PUT' and (e['before_absent'] is not True or 'update_from' in e):
            raise ValueError()
        if not isinstance(e['properties'], dict) or not e['properties'] or len(e['properties']) > 32:
            raise ValueError()
        for path in e['properties']:
            if not isinstance(path, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*', path):
                raise ValueError()
            if any(s.lower() in ('secrets', 'password', 'token', 'value', 'connectionstring') for s in path.split('.')):
                raise ValueError()
        projection = e.get('receipt_properties', [])
        if not isinstance(projection, list) or len(set(projection)) != len(projection) or not set(projection) <= set(PROJECTION.get(op['kind'], {})):
            raise ValueError()
        if not isinstance(op['depends_on'], list) or len(op['depends_on']) > 64 or not all(isinstance(x, str) for x in op['depends_on']):
            raise ValueError()
        parse(op['deadline'])
        if not isinstance(op['cleanup'], dict) or op['cleanup'].get('created_only') is not True or type(op['cleanup'].get('zero_reference_required')) is not bool:
            raise ValueError()
        if op['kind'] in ('roleDefinitions', 'userAssignedIdentities') and not op['cleanup']['zero_reference_required']:
            raise ValueError()
        if e['body_sha256'] != digest(op['body']) or len(encoded(op)) > 262144:
            raise ValueError()
        # Validate the JSON domain before any credential work.
        json.dumps(op, allow_nan=False)
        if op['method'] == 'DELETE':
            if op['body'] is not None:
                raise ValueError()
        else:
            body = op['body']
            if not isinstance(body, dict):
                raise ValueError()
            if op['kind'] in ('roleDefinitions', 'roleAssignments'):
                if set(body) != {'properties'} or not isinstance(body['properties'], dict):
                    raise ValueError()
                p = body['properties']
                fields = {'roleName', 'type', 'permissions', 'assignableScopes'} if op['kind'] == 'roleDefinitions' else {'principalId', 'roleDefinitionId', 'principalType'}
                if not fields <= set(p):
                    raise ValueError()
                for key in fields | (set(p) & {'condition', 'conditionVersion'}):
                    if not _same(e['properties'].get('properties.' + key), p[key]):
                        raise ValueError()
                if op['kind'] == 'roleDefinitions' and p['type'] != 'CustomRole':
                    raise ValueError()
                if op['kind'] == 'roleAssignments':
                    uuid.UUID(p['principalId'])
                    if not re.fullmatch(RESOURCE['roleDefinitions'], p['roleDefinitionId']) or p['principalType'] not in ('User', 'ServicePrincipal'):
                        raise ValueError()
            elif op['kind'] == 'containers':
                if set(body) != {'properties'} or body['properties'].get('publicAccess') != 'None' or e['properties'].get('properties.publicAccess') != 'None':
                    raise ValueError()
            elif op['kind'] == 'userAssignedIdentities':
                if set(body) - {'location', 'tags'} or not body.get('location') or e['properties'].get('location') != body['location']:
                    raise ValueError()
            else:
                if set(body) - {'location', 'tags', 'identity', 'properties'} or (op['method'] == 'PUT' and not body.get('location')):
                    raise ValueError()
                if not isinstance(e.get('location'), str) or not re.fullmatch(r'[a-z0-9]{1,40}', e['location']) or ('location' in body and body['location'].lower().replace(' ', '') != e['location']):
                    raise ValueError()
                p = body['properties']
                environment = e['properties'].get('properties.environmentId')
                if not isinstance(environment, str) or not re.fullmatch(RG + r'/providers/Microsoft.App/managedEnvironments/' + NAME, environment) or ('environmentId' in p and environment != p['environmentId']):
                    raise ValueError()
                if op['kind'] == 'jobs':
                    trigger = p.get('configuration', {}).get('triggerType')
                    if (op['method'] == 'PUT' and trigger != 'Manual') or (trigger is not None and trigger != 'Manual'):
                        raise ValueError()
                    if op['method'] == 'PATCH' and e['properties'].get('properties.configuration.triggerType') != 'Manual':
                        raise ValueError()
        _secret_sources(op)
        return deepcopy(op)
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError, Denied):
        raise Denied('invalid_fixed_arm_operation') from None


class BoundedArmProvider:
    """Use the existing OWNER AzureCredential and BoundedHttp in live wiring.

    Dependencies are injected so offline tests never acquire a token. This is
    not an authorization issuer: only the approved controller supplies plans and
    journal-authenticated evidence; hashes alone are not signatures.
    """
    def __init__(self, credential, http, clock, private_secret_resolver=None):
        if getattr(credential, 'mode', 'owner') != 'owner':
            raise Denied('owner_credential_required')
        self.credential, self.http, self.clock = credential, http, clock
        self.private_secret_resolver = private_secret_resolver
        self.anchor, self.mono = clock.utc(), clock.monotonic()
        self.high = self.anchor

    def _wire_body(self, op):
        allowed = _secret_sources(op)
        wire = deepcopy(op['body'])
        if allowed:
            if not callable(self.private_secret_resolver):
                raise Denied('private_secret_unavailable')
            try:
                values = {}
                for source, expected in allowed.items():
                    value = self.private_secret_resolver(source)
                    if not isinstance(value, str) or not 0 < len(value.encode('utf-8')) <= 65536 or hashlib.sha256(value.encode('utf-8')).hexdigest() != expected:
                        raise ValueError()
                    values[source] = value
                for secret in wire['properties']['configuration']['secrets']:
                    binding = secret.get('value')
                    if isinstance(binding, dict):
                        secret['value'] = values[binding['$secretBinding']]
                if len(encoded(wire)) > 262144:
                    raise ValueError()
            except Exception:
                raise Denied('private_secret_binding') from None
        return wire

    def validate(self, operation):
        """Controller pre-intent check; resolves secrets without token or HTTP.

        Send repeats the digest check so a changed resolver cannot alter a
        previously validated plan. No secret/cache/body is returned or persisted.
        """
        op = _validate(operation)
        self._deadline(op)
        self._wire_body(op)
        return {'operation_id': op['id'], 'request_digest': digest(op), 'valid': True}

    def _now(self):
        self.high = max(self.high, self.clock.utc(), self.anchor + timedelta(seconds=max(0, self.clock.monotonic() - self.mono)))
        return self.high

    def _deadline(self, op, cleanup=False, recovery=False):
        if cleanup or recovery or self._removal(op):
            # Removal due is immutable, not a permission to abandon an expired
            # grant. Each exact cleanup/verification request still has 30s total.
            return Deadline(30, self.clock.monotonic)
        seconds = (parse(op['deadline']) - self._now()).total_seconds()
        if seconds <= 0:
            raise Denied('operation_deadline')
        return Deadline(min(30, seconds), self.clock.monotonic)

    def _removal(self, op):
        return op['method'] == 'DELETE' or (op['provider'] == 'Microsoft.App' and
            op['kind'] == 'containerApps' and op['method'] == 'PATCH' and
            op['expected'].get('auth_action') in ('cleanup:authIngress', 'cleanup:authPlatformSecret'))

    def _base(self, op, state, http=0):
        result = {'operation_id': op['id'], 'request_digest': digest(op),
                'object_id': op['expected']['resource_id'], 'state': state,
                'terminal': False, 'created_by_run': True, 'properties': {},
                'http': http, 'observed_at': self._now().isoformat(),
                'readback_verified': False, 'write_terminal': False}
        if self._removal(op):
            result['cleanup_overdue'] = self._now() >= parse(op['deadline'])
        return result

    def _bound_receipt(self, op, receipt):
        if not isinstance(receipt, dict) or any(receipt.get(k) != v for k, v in {
            'operation_id': op['id'], 'request_digest': digest(op),
            'object_id': op['expected']['resource_id'], 'created_by_run': True}.items()):
            raise Denied('receipt_binding')

    def _fresh(self, evidence):
        try:
            age = (self._now() - parse(evidence['observed_at'])).total_seconds()
            if not 0 <= age <= 30:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise Denied('stale_readback') from None

    def _request(self, op, method, url, body=None, cleanup=False, send_guard=None, recovery=False):
        if recovery and (method != 'GET' or body is not None):
            raise Denied('recovery_read_only')
        removing = cleanup or self._removal(op)
        bounded_read = recovery and method == 'GET'
        deadline = self._deadline(op, removing, recovery=bounded_read)
        token = self.credential.token(ARM + '/', deadline)
        deadline.remaining()
        # Credential acquisition can consume the absolute operation deadline.
        if not (removing or bounded_read) and self._now() >= parse(op['deadline']):
            raise Denied('operation_deadline')
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, digest(op)))
        def before_send():
            deadline.remaining()
            if not (removing or bounded_read) and self._now() >= parse(op['deadline']):
                raise Denied('operation_deadline')
            if send_guard is not None:
                send_guard()
            deadline.remaining()

        arguments = (method, url, {'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json', 'x-ms-client-request-id': request_id,
            'x-ms-return-client-request-id': 'true'}, encoded(body) if body is not None else None, deadline)
        guarded = getattr(self.http, 'send_guarded', None)
        if callable(guarded):
            response = guarded(*arguments, before_send=before_send)
        else:
            before_send()
            response = self.http(*arguments)
        deadline.remaining()
        if not (removing or bounded_read) and self._now() >= parse(op['deadline']):
            raise TimeoutError('operation_outcome_unknown')
        if not isinstance(response, dict) or type(response.get('status')) is not int or not isinstance(response.get('body'), bytes) or len(response['body']) > 1048576 or not isinstance(response.get('headers'), dict):
            raise ValueError('invalid_response')
        return response

    def _value(self, response):
        value = json.loads(response['body']) if response['body'] else {}
        if not isinstance(value, dict):
            raise ValueError('invalid_response')
        return value

    def _match(self, op, value):
        if not _resource_id_matches(op, value.get('id')):
            raise Denied('resource_binding')
        if op['provider'] == 'Microsoft.ManagedIdentity':
            properties = value.get('properties')
            if not isinstance(properties, dict):
                raise Denied('identity_response_binding')
            # A synchronous Identity response must be complete and terminal,
            # even when none of these IDs are selected for receipt projection.
            for container in (value, properties):
                if 'error' in container or any(container[key] != 'Succeeded'
                        for key in ('status', 'provisioningState') if key in container):
                    raise Denied('identity_response_binding')
            for key in ('principalId', 'tenantId', 'clientId'):
                item = properties.get(key)
                if not isinstance(item, str) or not re.fullmatch(GUID, item):
                    raise Denied('identity_response_binding')
        for path, expected in op['expected']['properties'].items():
            if not _input_matches(expected, _get(value, path), path):
                raise Denied('resource_binding')
        if op['method'] in ('PUT', 'PATCH') and not _input_matches(op['body'], value):
            raise Denied('resource_body_binding')
        if op['provider'] == 'Microsoft.App' and value.get('properties', {}).get('provisioningState') != 'Succeeded':
            raise Denied('resource_not_ready')
        projection = {}
        for key in op['expected'].get('receipt_properties', []):
            item = _get(value, PROJECTION[op['kind']][key])
            if key in ('principalId', 'tenantId', 'clientId'):
                uuid.UUID(item)
            elif not isinstance(item, str) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,251}\.azurecontainerapps\.io', item):
                raise Denied('resource_binding')
            projection[key] = item
        return projection

    def _lro_url(self, op, url):
        # Resource-specific examples and regional families documented at:
        # https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute
        # No generic locations/operationStatuses family: select App vs Job.
        if op['provider'] != 'Microsoft.App' or not isinstance(url, str) or len(url) > 4096:
            raise Denied('lro_binding')
        rid = op['expected']['resource_id']
        subscription, name = rid.split('/')[2], rid.split('/')[-1]
        u = urlsplit(url)
        prefix = f'/subscriptions/{subscription}/providers/Microsoft.App/{op["kind"]}/{name}/operationResults/'
        tail = u.path[len(prefix):] if u.path.startswith(prefix) else ''
        family = 'containerapp' if op['kind'] == 'containerApps' else 'containerappsjob'
        region = op['expected']['location']
        regional = re.fullmatch(re.escape(f'/subscriptions/{subscription}/providers/Microsoft.App/locations/{region}/') + family + r'Operation(?:Statuses|Results)/' + GUID, u.path)
        if u.scheme != 'https' or u.netloc != 'management.azure.com' or u.fragment or not (re.fullmatch(GUID, tail) or regional) or u.query != 'api-version=' + op['expected']['api_version']:
            raise Denied('lro_binding')
        return url

    def _identity_created_ack(self, op, response, headers, result):
        # MSI 2023-01-31 defines a synchronous 201 Identity, not an LRO.
        # RFC 9110 permits Location to identify that newly created resource.
        # Compare raw strings to a finite set; never parse, resolve or follow it.
        controls = ('location', 'azure-asyncoperation', 'operation-location')
        names = [key.lower() for key in response['headers']]
        duplicate = any(names.count(key) > 1 for key in controls)
        location = headers.get('location')
        location_kind = ('absent' if 'location' not in headers else
            'fixed_resource' if isinstance(location, str) and location in
            (op['url'], ARM + op['expected']['resource_id']) else 'unsupported')
        result['ack_header_evidence'] = {
            'location': location_kind,
            'azure_asyncoperation_present': 'azure-asyncoperation' in headers,
            'operation_location_present': 'operation-location' in headers,
            'duplicate_control_headers': duplicate,
        }
        if (duplicate or 'azure-asyncoperation' in headers or 'operation-location' in headers
                or location_kind == 'unsupported'):
            result['ack_rejection'] = 'unsupported_lro_headers'
            return result
        try:
            value = self._value(response)
            if not _resource_id_matches(op, value.get('id')):
                result['ack_rejection'] = 'resource_id_mismatch'
                return result
            self._match(op, value)
        except Exception:
            result['ack_rejection'] = 'identity_response_mismatch'
            return result
        result.update(state='pending', write_terminal=True,
                      identity_properties_digest=_identity_properties_digest(value))
        return result

    def _ack(self, op, response):
        code = response['status']
        result = self._base(op, 'unknown', code)
        headers = {k.lower(): v for k, v in response['headers'].items()}
        async_url = headers.get('azure-asyncoperation')
        location = headers.get('location')
        # Capture no raw bodies, errors, arbitrary headers or credentials.
        result['initial_ack_digest'] = digest({'status': code, 'body_digest': digest(response['body'].hex()),
                                              'async_url': async_url, 'location': location})
        if op['method'] == 'PUT' and code == 200:
            return result
        if op['provider'] == 'Microsoft.ManagedIdentity':
            if op['method'] == 'PUT' and code == 201:
                return self._identity_created_ack(op, response, headers, result)
            if any(key in headers for key in ('location', 'azure-asyncoperation', 'operation-location')):
                result['ack_rejection'] = 'unsupported_lro_headers'
                return result
        if op['provider'] != 'Microsoft.App' and (async_url or location):
            if op['provider'] == 'Microsoft.ManagedIdentity':
                result['ack_rejection'] = 'unsupported_lro_headers'
            return result
        if op['provider'] == 'Microsoft.App' and (async_url or location):
            if code not in ((200, 201) if op['method'] == 'PUT' else (200, 202)):
                return result
            url = self._lro_url(op, async_url or location)
            # If both are present, both must stay in the supported family.
            if async_url and location:
                self._lro_url(op, location)
            retry = headers.get('retry-after', '1')
            if not isinstance(retry, str) or not re.fullmatch(r'[0-9]{1,5}', retry):
                return result
            result.update(state='pending', operation_url=url,
                          operation_url_digest=digest(url), poll_kind='status' if async_url else 'location',
                          not_before=(self._now() + timedelta(seconds=max(1, int(retry)))).isoformat())
            return result
        if op['method'] == 'DELETE' and code in (200, 204):
            value = self._value(response)
            if code == 204 and response['body']:
                return result
            if response['body']:
                states = ([value['status']] if 'status' in value else [])
                properties = value.get('properties', {})
                if not isinstance(properties, dict):
                    return result
                if 'provisioningState' in properties:
                    states.append(properties['provisioningState'])
                if (not states or any(state != 'Succeeded' for state in states)
                    or 'error' in value or ('id' in value and value['id'] != op['expected']['resource_id'])):
                    return result
            result.update(state='pending', write_terminal=True)
        elif (op['method'] == 'PUT' and code in CONTRACTS[(op['provider'], op['kind'])][1]) or (op['method'] == 'PATCH' and code == 200):
            # 200 denotes an update/no-change/existing object for these create
            # endpoints. Even a preceding 404 cannot rule out an outside writer.
            if op['method'] == 'PUT' and code == 200:
                return result
            value = self._value(response)
            if 'error' in value:
                raise Denied('lro_terminal_conflict')
            if not _resource_id_matches(op, value.get('id')):
                if op['provider'] == 'Microsoft.ManagedIdentity':
                    result['ack_rejection'] = 'resource_id_mismatch'
                return result
            if op['provider'] == 'Microsoft.App' and value.get('properties', {}).get('provisioningState') != 'Succeeded':
                return result
            result.update(state='pending', write_terminal=True)
        elif code in (400, 401, 403, 404, 405, 409, 412, 422, 429):
            result.update(state='failed', terminal=True)
        return result

    def normalize_write(self, operation, response):
        """Parse a single already-sent ACK, e.g. the dedicated auth writer.

        This performs no HTTP and proves no final configuration. The caller
        must bind the safe plan to its ephemeral wire body before sending and
        perform its own exact final readback for auth-owned secret/config fields.
        """
        op = _validate(operation)
        try:
            return self._ack(op, response)
        except Exception:
            return self._base(op, 'unknown')

    def send(self, operation, precondition):
        op = _validate(operation)
        if op['method'] != 'PUT':
            raise Denied('cleanup_entry_required')
        self._bound_receipt(op, precondition)
        self._fresh(precondition)
        if precondition.get('state') != 'absent' or precondition.get('http') != 404:
            raise Denied('preexisting_resource')
        wire = self._wire_body(op)
        try:
            return self._ack(op, self._request(op, 'PUT', op['url'], wire,
                send_guard=lambda: self._fresh(precondition)))
        except Exception:
            # Failure can happen after bytes reached the service. Never resend.
            return self._base(op, 'unknown')

    def update(self, operation, prior_operation, prior_receipt, current_evidence):
        op, prior = _validate(operation), _validate(prior_operation)
        self._known_owned(prior, prior_receipt, current_evidence)
        if op['method'] != 'PATCH' or any(op[k] != prior[k] for k in ('provider', 'kind', 'url')) or op['expected']['update_from'] != {
            'operation_id': prior['id'], 'request_digest': digest(prior)}:
            raise Denied('update_binding')
        if op['expected']['location'] != prior['expected']['location'] or op['expected']['properties'].get('properties.environmentId') != prior['expected']['properties'].get('properties.environmentId'):
            raise Denied('update_binding')
        wire = self._wire_body(op)
        try:
            return self._ack(op, self._request(op, 'PATCH', op['url'], wire,
                send_guard=lambda: self._known_owned(prior, prior_receipt, current_evidence)))
        except Exception:
            return self._base(op, 'unknown')

    def poll(self, operation, receipt):
        op = _validate(operation)
        self._bound_receipt(op, receipt)
        if receipt.get('state') != 'pending' or receipt.get('write_terminal') is not False or not re.fullmatch(r'[0-9a-f]{64}', receipt.get('initial_ack_digest', '')):
            raise Denied('pending_ack_required')
        url = self._lro_url(op, receipt.get('operation_url'))
        if receipt.get('operation_url_digest') != digest(url) or receipt.get('poll_kind') not in ('status', 'location'):
            raise Denied('lro_binding')
        if self._now() < parse(receipt['not_before']):
            raise Denied('retry_after')
        result = deepcopy(receipt)
        try:
            response = self._request(op, 'GET', url, recovery=True)
            result.update(http=response['status'], observed_at=self._now().isoformat())
            if any(k.lower() in ('location', 'azure-asyncoperation') for k in response['headers']):
                raise Denied('lro_redirect')
            value = self._value(response)
            # Location may return the final resource, whose ID is the target
            # resource rather than the distinct operation-status URL.
            if (receipt['poll_kind'] == 'location' and op['method'] in ('PUT', 'PATCH')
                and response['status'] in (200, 201) and 'status' not in value):
                if 'error' in value:
                    raise Denied('lro_terminal_conflict')
                self._match(op, value)
                result['write_terminal'] = True
                return result
            if 'id' in value and value['id'] != urlsplit(url).path:
                raise Denied('lro_response_binding')
            state = value.get('status')
            properties = value.get('properties', {})
            if not isinstance(properties, dict) or (state == 'Succeeded' and
                ('error' in value or properties.get('provisioningState', 'Succeeded') != 'Succeeded')):
                raise Denied('lro_terminal_conflict')
            if response['status'] == 200 and state == 'Succeeded':
                result['write_terminal'] = True
            elif response['status'] == 200 and state in ('Failed', 'Canceled', 'Cancelled'):
                result.update(state='failed', terminal=True)
            elif receipt['poll_kind'] == 'location' and op['method'] == 'DELETE' and response['status'] in (200, 204) and not response['body']:
                result['write_terminal'] = True
            elif response['status'] in (200, 202) and (state in ('InProgress', 'Running', 'Accepted', 'Creating', 'Updating', 'Deleting') or response['status'] == 202):
                retry = response['headers'].get('retry-after', '1')
                if not isinstance(retry, str) or not re.fullmatch(r'[0-9]{1,5}', retry):
                    raise ValueError()
                result['not_before'] = (self._now() + timedelta(seconds=max(1, int(retry)))).isoformat()
            else:
                result.update(poll_observation_unknown=True, write_terminal=False)
        except Exception:
            # The initial ACK remains known. An inconclusive GET does not erase
            # it; the controller may charge another bounded GET after expiry.
            # This never applies to an unknown initial write or resends a write.
            result.update(poll_observation_unknown=True, write_terminal=False)
        return result

    def readback(self, operation, receipt=None):
        op = _validate(operation)
        if receipt is not None:
            self._bound_receipt(op, receipt)
        # Only an exact known ACK can outlive the original create window.
        # An unknown write/precondition never gains a recovery transport.
        recovery = (receipt is not None and receipt.get('state') == 'pending'
            and receipt.get('write_terminal') is True
            and re.fullmatch(r'[0-9a-f]{64}', receipt.get('initial_ack_digest', '')) is not None)
        return self._readback(op, receipt, recovery=recovery)

    def inspect_cleanup(self, operation, creation_receipt, cleanup_operation=None):
        """Expired create window cannot prevent checking its known-owned target."""
        op = _validate(operation)
        self._bound_receipt(op, creation_receipt)
        if op['method'] not in ('PUT', 'PATCH') or creation_receipt.get('state') != 'succeeded' or any(
                creation_receipt.get(k) is not True for k in ('terminal', 'write_terminal', 'readback_verified')):
            raise Denied('known_creation_required')
        deleting = None if cleanup_operation is None else _validate(cleanup_operation)
        if deleting is not None:
            self._cleanup_binding(deleting, op)
        return self._readback(op, None, cleanup=True, cleanup_operation=deleting)

    def _readback(self, op, receipt, cleanup=False, cleanup_operation=None, recovery=False):
        try:
            response = self._request(op, 'GET', op['url'], cleanup=cleanup, recovery=recovery)
            result = self._base(op, 'mismatch', response['status'])
            if response['status'] == 404:
                result['state'] = 'absent'
            elif response['status'] == 200:
                value = self._value(response)
                result['properties'] = self._match(op, value)
                if op['provider'] == 'Microsoft.ManagedIdentity':
                    result['identity_properties_digest'] = _identity_properties_digest(value)
                if cleanup_operation is not None:
                    self._match(cleanup_operation, value)
                    result['cleanup_binding_digest'] = digest(cleanup_operation)
                result.update(state='matching', binding_digest=digest(op['expected']['properties']))
            else:
                result['state'] = 'unknown'
            return self._readback_result(op, result, receipt)
        except Exception:
            return self._readback_result(op, self._base(op, 'unknown'), receipt)

    def _readback_result(self, op, observation, receipt):
        if receipt is None:
            return observation
        known = receipt.get('state') == 'pending' and receipt.get('write_terminal') is True
        agrees = observation['state'] == ('matching' if op['method'] in ('PUT', 'PATCH') else 'absent')
        if (known and agrees and op['provider'] == 'Microsoft.ManagedIdentity'
                and op['method'] == 'PUT'
                and (not re.fullmatch(r'[0-9a-f]{64}', receipt.get('identity_properties_digest', ''))
                     or receipt['identity_properties_digest'] != observation.get('identity_properties_digest'))):
            agrees = False
            observation['state'] = 'identity_mismatch'
        if known and agrees:
            observation.update(state='succeeded', terminal=True, write_terminal=True, readback_verified=True)
            return observation
        if receipt.get('state') == 'pending':
            # Preserve the ACK, URL and creation binding through eventual
            # consistency or an unavailable readback. No new success is inferred.
            result = deepcopy(receipt)
            result.update(readback_verified=False, terminal=False,
                          readback_state=observation['state'], readback_http=observation['http'])
            return result
        observation.update(state='unknown', terminal=False, write_terminal=False, readback_verified=False)
        return observation

    def cleanup(self, operation, created_operation, created_receipt, current_evidence, zero_ref_evidence=None):
        """Delete only a known-created, unchanged object; no automatic adoption.

        Evidence comes from the controller's authenticated journal. Reference
        proofs cover *all* assignable scopes/eligible assignments for roles, or
        all App/Job identity references for UAMI. This module never lists them.
        Providers do not promise ETag/CAS here: the exclusive writer lock and
        fresh readback are necessary, and a concurrent external edit is a hold.
        """
        op, created = _validate(operation), _validate(created_operation)
        self._known_owned(created, created_receipt, current_evidence)
        strengthened = self._cleanup_binding(op, created)
        if strengthened and current_evidence.get('cleanup_binding_digest') != digest(op):
            raise Denied('cleanup_binding')
        if op['cleanup']['zero_reference_required']:
            self._zero_refs(created, created_receipt, zero_ref_evidence)
        def before_send():
            self._known_owned(created, created_receipt, current_evidence)
            if op['cleanup']['zero_reference_required']:
                self._zero_refs(created, created_receipt, zero_ref_evidence)
        try:
            return self._ack(op, self._request(op, 'DELETE', op['url'], send_guard=before_send))
        except Exception:
            return self._base(op, 'unknown')

    def _cleanup_binding(self, op, created):
        if op['method'] != 'DELETE' or any(op[k] != created[k] for k in ('provider', 'kind', 'url')):
            raise Denied('cleanup_binding')
        exact = _same(op['expected']['properties'], created['expected']['properties']) and op['cleanup'] == created['cleanup']
        if exact:
            return False
        # A fixed resolver may combine all known App/Job mutation receipts into
        # stronger deletion expectations. Never drop any last-write binding.
        if op['provider'] != 'Microsoft.App':
            raise Denied('cleanup_binding')
        combined = _property_tree(op['expected']['properties'])
        if not _input_matches(_property_tree(created['expected']['properties']), combined) or not _input_matches(created['body'], combined):
            raise Denied('cleanup_binding')
        return True

    def _known_owned(self, prior, receipt, evidence):
        self._bound_receipt(prior, receipt)
        self._bound_receipt(prior, evidence)
        self._fresh(evidence)
        if prior['method'] not in ('PUT', 'PATCH') or any(receipt.get(k) is not v for k, v in {'terminal': True, 'readback_verified': True, 'write_terminal': True}.items()) or receipt.get('state') != 'succeeded':
            raise Denied('known_creation_required')
        properties = receipt.get('properties')
        if not isinstance(properties, dict):
            raise Denied('changed_resource')
        projection = {key: properties.get(key) for key in prior['expected'].get('receipt_properties', [])}
        if evidence.get('state') != 'matching' or evidence.get('http') != 200 or evidence.get('binding_digest') != digest(prior['expected']['properties']) or evidence.get('properties') != projection:
            raise Denied('changed_resource')
        if ('identity_properties_digest' in receipt
                and receipt['identity_properties_digest'] != evidence.get('identity_properties_digest')):
            raise Denied('changed_resource')

    def _zero_refs(self, created, receipt, evidence):
        if not isinstance(evidence, dict):
            raise Denied('zero_reference_required')
        self._fresh(evidence)
        if evidence.get('object_id') != receipt['object_id'] or evidence.get('creation_request_digest') != receipt['request_digest'] or evidence.get('complete') is not True or type(evidence.get('references')) is not int or evidence['references'] != 0:
            raise Denied('zero_reference_required')
        if created['kind'] == 'roleDefinitions':
            if evidence.get('eligible_references') != 0 or type(evidence.get('eligible_references')) is not int or not _same(evidence.get('assignable_scopes'), created['body']['properties']['assignableScopes']):
                raise Denied('zero_reference_required')
        elif created['kind'] == 'userAssignedIdentities' and evidence.get('all_trial_apps_and_jobs') is not True:
            raise Denied('zero_reference_required')
