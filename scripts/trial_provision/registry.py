"""Exact guardian manifest cleanup, with injected OWNER credentials and transport.

No CLI, credential store, image push, registry enumeration, new grant or retry.
Live wiring must use CountedControlHttp and BoundedHttp (no redirects/retries).
Every HTTP attempt, including the two OAuth exchanges, spends the common budget.
The controller authenticates supplied evidence against its private journal;
digests here bind evidence, they do not authenticate arbitrary caller JSON.

Contracts (Microsoft primary sources):
https://github.com/Azure/acr/blob/main/docs/AAD-OAuth.md
https://github.com/Azure/azure-rest-api-specs/blob/main/specification/containerregistry/data-plane/Registry/stable/2021-07-01/containerregistry.json
https://learn.microsoft.com/azure/container-registry/container-registry-delete

DELETE 202 is acceptance, not completion. Only its persisted acknowledgement
plus authenticated exact-digest HEAD absence completes cleanup. An unknown
DELETE is never resent or promoted by a subsequent 404. HEAD uses Registry V2;
an unsupported HEAD or missing registry header leaves verification unknown.
"""
import base64
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
import json
import re
from urllib.parse import urlencode

from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse


ARM_AUDIENCE = 'https://management.azure.com/'
API_VERSION = '2021-07-01'
MAX_BODY = 2 * 1024 * 1024
HEX = r'[0-9a-f]{64}'
GUID = r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
NAME = r'[A-Za-z0-9][A-Za-z0-9_.-]{0,89}'
RG = r'/subscriptions/' + GUID + r'/resourceGroups/' + NAME
RESOURCE = RG + r'/providers/Microsoft.App/(?:containerApps|jobs)/[a-z][a-z0-9-]{0,30}[a-z0-9]'
REPOSITORY = r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*'
OP_KEYS = {'id', 'provider', 'kind', 'method', 'url', 'body', 'deadline',
           'depends_on', 'expected', 'cleanup'}
ACCEPT = ', '.join(('application/vnd.oci.image.manifest.v1+json',
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.docker.distribution.manifest.list.v2+json'))


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _json(value):
    # Enforce JSON types and finite numbers before hashing or credential work.
    return json.dumps(value, sort_keys=True, allow_nan=False)


def _binding(value):
    try:
        if not isinstance(value, dict) or set(value) != {
            'registry_id', 'login_server', 'repository', 'tenant_id',
            'authorized_resource_ids', 'exclusivity_evidence_digest'}:
            raise ValueError()
        if not _matches(RG + r'/providers/Microsoft.ContainerRegistry/registries/[a-z0-9]{5,50}', value['registry_id']):
            raise ValueError()
        if not _matches(r'[a-z0-9]{5,50}\.azurecr\.io', value['login_server']):
            raise ValueError()
        if value['registry_id'].rsplit('/', 1)[1] + '.azurecr.io' != value['login_server']:
            raise ValueError()
        if not _matches(REPOSITORY, value['repository']) or len(value['repository']) > 200:
            raise ValueError()
        if not _matches(GUID, value['tenant_id']) or not _matches(HEX, value['exclusivity_evidence_digest']):
            raise ValueError()
        resources = value['authorized_resource_ids']
        if not isinstance(resources, list) or not 1 <= len(resources) <= 32:
            raise ValueError()
        if any(not _matches(RESOURCE, r) for r in resources) or len(set(resources)) != len(resources):
            raise ValueError()
        if any(r.split('/')[2] != value['registry_id'].split('/')[2] for r in resources):
            raise ValueError()
        _json(value)
        return deepcopy(value)
    except (TypeError, ValueError, KeyError):
        raise Denied('registry_binding') from None


class BoundedRegistryProvider:
    """Only the controller's fixed manifest and journal-authenticated proofs.

    binding pins the approved registry/repository and *complete* closed consumer
    set. exclusivity_evidence_digest binds the approved resource inventory and
    created-only, new dedicated repository evidence from the controller. It is
    not a request for unapproved subscription-wide or external discovery.
    A merely convenient list, incomplete inventory or known foreign consumer
    is insufficient; the controller must not assert this proof for those cases.
    before_send(operation) must atomically reject any earlier intent for this
    operation. checkpoint(receipt) must fsync its flat private journal record.

    Reference proof shape is validated by validate_zero_references below:
    complete, foreign_references_excluded, repository_exclusive, writers_fenced,
    exclusivity_evidence_digest, observed_at, push_receipt_digest, object_id,
    observations:[{resource_id, observed_at, complete, pages_complete,
      coverage:'all_revisions'|'template_and_all_executions', images:[...]}].
    images includes every main/init container image, including retained
    revisions/executions; an authenticated absent resource has images: [].
    """
    def __init__(self, credential, http, clock, *, binding, before_send, checkpoint):
        self.binding = _binding(binding)
        if getattr(credential, 'mode', None) != 'owner':
            raise Denied('registry_owner_required')
        if not callable(before_send) or not callable(checkpoint):
            raise Denied('registry_journal_required')
        self.credential, self.http, self.clock = credential, http, clock
        self.before_send, self.checkpoint = before_send, checkpoint
        self.anchor, self.mono = clock.utc(), clock.monotonic()
        self._access, self._expires = None, 0
        self._attempted = set()
        self._owned_removal_digest = None

    def _now(self):
        mono = self.clock.monotonic()
        value = max(self.clock.utc(), self.anchor + timedelta(seconds=max(0, mono-self.mono)))
        self.anchor, self.mono = value, mono
        return value

    def _operation(self, operation):
        try:
            if not isinstance(operation, dict) or set(operation) != OP_KEYS:
                raise ValueError()
            op = deepcopy(operation)
            if not _matches(r'[A-Za-z][A-Za-z0-9_.-]{0,95}', op['id']):
                raise ValueError()
            if (op['provider'], op['kind'], op['method'], op['body']) != ('AzureContainerRegistry', 'manifest', 'DELETE', None):
                raise ValueError()
            e = op['expected']
            if not isinstance(e, dict) or set(e) != {'binding_digest', 'manifest_digest', 'push_request_digest', 'push_receipt_digest'}:
                raise ValueError()
            if e['binding_digest'] != digest(self.binding) or not _matches('sha256:' + HEX, e['manifest_digest']):
                raise ValueError()
            if not all(_matches(HEX, e[k]) for k in ('push_request_digest', 'push_receipt_digest')):
                raise ValueError()
            url = 'https://' + self.binding['login_server'] + '/v2/' + self.binding['repository'] + '/manifests/' + e['manifest_digest'] + '?api-version=' + API_VERSION
            if op['url'] != url or op['cleanup'] != {'created_only': True, 'zero_reference_required': True, 'purpose': 'guardian'}:
                raise ValueError()
            # Avoid Python True == 1 allowing a malformed authority flag.
            if any(op['cleanup'][k] is not True for k in ('created_only', 'zero_reference_required')):
                raise ValueError()
            if not isinstance(op['depends_on'], list) or len(op['depends_on']) > 64 or any(not _matches(r'[A-Za-z][A-Za-z0-9_.-]{0,95}', x) for x in op['depends_on']):
                raise ValueError()
            parse(op['deadline'])
            if len(_json(op).encode()) > 65536:
                raise ValueError()
            return op
        except (KeyError, TypeError, ValueError, OverflowError, Denied):
            raise Denied('invalid_fixed_registry_operation') from None

    def _deadline(self, op):
        # The approved cleanup deadline is removal_due, not permission to
        # abandon a known owned object. Owned cleanup/known-ACK verification
        # retain that exact due value and use fresh bounded OWNER requests.
        if self._owned_removal_digest == digest(op):
            return Deadline(30, self.clock.monotonic)
        seconds = (parse(op['deadline']) - self._now()).total_seconds()
        if seconds <= 0:
            raise Denied('registry_deadline')
        return Deadline(min(30, seconds), self.clock.monotonic)

    @contextmanager
    def _removal_window(self, op, enabled=True):
        previous = self._owned_removal_digest
        if enabled: self._owned_removal_digest = digest(op)
        try:
            yield
        finally:
            self._owned_removal_digest = previous

    def _fresh(self, evidence):
        try:
            age = (self._now() - parse(evidence['observed_at'])).total_seconds()
            if not 0 <= age <= 30:
                raise ValueError()
        except (KeyError, TypeError, ValueError, Denied):
            raise Denied('registry_stale_evidence') from None

    def _base(self, op, state, status=0):
        return {'operation_id': op['id'], 'request_digest': digest(op),
            'object_id': op['url'], 'state': state, 'terminal': False,
            'created_by_run': True, 'readback_verified': False,
            'properties': {}, 'http': status, 'observed_at': self._now().isoformat(),
            'write_terminal': False, 'delete_acknowledged': False, 'delete_status': 0}

    def _receipt(self, op, receipt):
        if not isinstance(receipt, dict) or any(receipt.get(k) != v for k, v in {
            'operation_id': op['id'], 'request_digest': digest(op),
            'object_id': op['url']}.items()) or receipt.get('created_by_run') is not True:
            raise Denied('registry_receipt_binding')

    def _push(self, op, receipt):
        if not isinstance(receipt, dict) or digest(receipt) != op['expected']['push_receipt_digest']:
            raise Denied('registry_push_receipt')
        expected = {'registry_id': self.binding['registry_id'], 'login_server': self.binding['login_server'],
            'repository': self.binding['repository'], 'manifest_digest': op['expected']['manifest_digest'], 'purpose': 'guardian'}
        if (receipt.get('state') != 'succeeded' or receipt.get('request_digest') != op['expected']['push_request_digest']
            or receipt.get('properties') != expected or any(receipt.get(k) is not True for k in
            ('terminal', 'created_by_run', 'readback_verified'))):
            raise Denied('registry_push_receipt')

    def validate_zero_references(self, operation, push_receipt, evidence):
        """Validate complete authenticated evidence; perform no discovery or I/O."""
        op = self._operation(operation)
        self._push(op, push_receipt)
        try:
            fields = {'complete', 'foreign_references_excluded', 'repository_exclusive', 'writers_fenced',
                'exclusivity_evidence_digest', 'observed_at', 'push_receipt_digest', 'object_id', 'observations'}
            if not isinstance(evidence, dict) or set(evidence) != fields:
                raise ValueError()
            if any(evidence[k] is not True for k in ('complete', 'foreign_references_excluded', 'repository_exclusive', 'writers_fenced')):
                raise ValueError()
            if (evidence['exclusivity_evidence_digest'] != self.binding['exclusivity_evidence_digest']
                or evidence['push_receipt_digest'] != op['expected']['push_receipt_digest'] or evidence['object_id'] != op['url']):
                raise ValueError()
            self._fresh(evidence)
            rows = evidence['observations']
            if not isinstance(rows, list) or len(rows) != len(self.binding['authorized_resource_ids']):
                raise ValueError()
            seen = set()
            target = self.binding['login_server'] + '/' + self.binding['repository']
            image = target + '@' + op['expected']['manifest_digest']
            for row in rows:
                if not isinstance(row, dict) or set(row) != {'resource_id', 'observed_at', 'complete', 'pages_complete', 'coverage', 'images'}:
                    raise ValueError()
                rid = row['resource_id']
                if rid not in self.binding['authorized_resource_ids'] or rid in seen:
                    raise ValueError()
                seen.add(rid)
                if row['complete'] is not True or row['pages_complete'] is not True:
                    raise ValueError()
                if row['coverage'] != ('all_revisions' if '/containerApps/' in rid else 'template_and_all_executions'):
                    raise ValueError()
                self._fresh(row)
                if not isinstance(row['images'], list) or len(row['images']) > 4096:
                    raise ValueError()
                for ref in row['images']:
                    if not isinstance(ref, str) or not 1 <= len(ref) <= 1024 or any(c.isspace() for c in ref) or '%' in ref or '://' in ref:
                        raise ValueError()
                    authority = ref.split('/', 1)[0]
                    if authority.split(':', 1)[0].lower().rstrip('.') == self.binding['login_server'] and authority != self.binding['login_server']:
                        raise ValueError()
                    # A tag, implicit latest or noncanonical spelling for this
                    # repository cannot prove it resolves to a different digest.
                    if ref.lower() == target or ref.lower().startswith(target + ':'):
                        raise ValueError()
                    if ref.lower().startswith(target + '@'):
                        if not ref.startswith(target + '@sha256:') or not _matches('sha256:' + HEX, ref.split('@', 1)[1]) or ref == image:
                            raise ValueError()
            _json(evidence)
            if len(encoded(evidence)) > MAX_BODY:
                raise ValueError()
        except (TypeError, KeyError, ValueError, OverflowError, Denied):
            raise Denied('registry_zero_references_unproven') from None
        return digest(evidence)

    def _wire(self, op, method, url, headers, body, deadline, send_guard=None):
        base = 'https://' + self.binding['login_server']
        if not ((method == 'POST' and url in (base + '/oauth2/exchange', base + '/oauth2/token'))
                or (method in ('HEAD', 'DELETE') and url == op['url'])):
            raise Denied('registry_http_target')
        deadline.remaining()
        self._deadline(op)
        if send_guard is not None:
            send_guard()
        deadline.remaining()
        self._deadline(op)
        response = self.http(method, url, headers, body, deadline)
        deadline.remaining()
        self._deadline(op)
        if (not isinstance(response, dict) or type(response.get('status')) is not int
            or not isinstance(response.get('headers'), dict) or not isinstance(response.get('body'), bytes)
            or len(response['body']) > MAX_BODY):
            raise Denied('registry_response')
        clean_headers = {}
        for key, value in response['headers'].items():
            if not isinstance(key, str) or not isinstance(value, str) or key.lower() in clean_headers:
                raise Denied('registry_response')
            clean_headers[key.lower()] = value
        if len(encoded(clean_headers)) > 32768 or 300 <= response['status'] < 400 or any(k in clean_headers for k in ('location', 'azure-asyncoperation')):
            raise Denied('registry_redirect_or_response')
        return {'status': response['status'], 'headers': clean_headers, 'body': response['body']}

    def _claims(self, token, deadline, *, refresh):
        try:
            if not isinstance(token, str) or not 1 <= len(token) <= 32768 or any(c.isspace() for c in token):
                raise ValueError()
            parts = token.split('.')
            if len(parts) != 3:
                raise ValueError()
            value = json.loads(base64.urlsafe_b64decode(parts[1] + '==='))
            now = self._now().timestamp()
            if value.get('aud') != self.binding['login_server'] or type(value.get('exp')) not in (int, float) or value['exp'] <= now + deadline.remaining():
                raise ValueError()
            if type(value.get('nbf')) not in (int, float) or value['nbf'] > now:
                raise ValueError()
            _json(value)
            if refresh:
                if value.get('tenant') != self.binding['tenant_id'] or value.get('grant_type') != 'refresh_token':
                    raise ValueError()
            else:
                access = value.get('access')
                if not isinstance(access, list) or len(access) != 1 or not isinstance(access[0], dict):
                    raise ValueError()
                if access[0].get('type') != 'repository' or access[0].get('name') != self.binding['repository']:
                    raise ValueError()
                actions = access[0].get('actions')
                if not isinstance(actions, list) or len(actions) != 2 or set(actions) != {'pull', 'delete'}:
                    raise ValueError()
            return value['exp']
        except (KeyError, TypeError, ValueError, OverflowError):
            raise Denied('registry_token_binding') from None

    def _bearer(self, op, deadline):
        if self._access is not None and self._expires > self._now().timestamp() + deadline.remaining():
            return self._access
        self._access, self._expires = None, 0
        aad = self.credential.token(ARM_AUDIENCE, deadline)
        if not isinstance(aad, str) or not 1 <= len(aad) <= 32768 or any(c.isspace() for c in aad):
            raise Denied('registry_owner_token')
        base = 'https://' + self.binding['login_server']
        headers = {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'}
        body = urlencode({'grant_type': 'access_token', 'service': self.binding['login_server'],
            'tenant': self.binding['tenant_id'], 'access_token': aad}).encode()
        response = self._wire(op, 'POST', base + '/oauth2/exchange', headers, body, deadline)
        if response['status'] != 200:
            raise Denied('registry_exchange_failed')
        refresh = json.loads(response['body']).get('refresh_token')
        self._claims(refresh, deadline, refresh=True)
        body = urlencode({'grant_type': 'refresh_token', 'service': self.binding['login_server'],
            'scope': 'repository:' + self.binding['repository'] + ':pull,delete', 'refresh_token': refresh}).encode()
        response = self._wire(op, 'POST', base + '/oauth2/token', headers, body, deadline)
        if response['status'] != 200:
            raise Denied('registry_exchange_failed')
        access = json.loads(response['body']).get('access_token')
        expires = self._claims(access, deadline, refresh=False)
        self._access, self._expires = access, expires
        return access

    def _request(self, op, method, send_guard=None):
        deadline = self._deadline(op)
        token = self._bearer(op, deadline)
        return self._wire(op, method, op['url'], {'Authorization': 'Bearer ' + token, 'Accept': ACCEPT}, None, deadline, send_guard)

    def readback(self, operation, receipt=None):
        op = self._operation(operation)
        if receipt is not None:
            self._receipt(op, receipt)
            if receipt.get('terminal') is True:
                raise Denied('registry_terminal_receipt')
        result = self._base(op, 'unknown')
        known = (receipt is not None and receipt.get('state') in ('pending', 'unknown')
            and receipt.get('delete_acknowledged') is True and receipt.get('delete_status') == 202
            and receipt.get('write_terminal') is False
            and receipt.get('ack_digest') == digest({'request_digest': digest(op), 'http': 202}))
        try:
            with self._removal_window(op, known):
                response = self._request(op, 'HEAD')
            status, headers = response['status'], response['headers']
            result['http'] = status
            if response['body'] or headers.get('docker-distribution-api-version') != 'registry/2.0' or 'www-authenticate' in headers:
                raise Denied('registry_head_response')
            if status == 200 and headers.get('docker-content-digest') == op['expected']['manifest_digest']:
                result['state'] = 'matching'
                result['properties'] = {'manifest_digest': op['expected']['manifest_digest']}
            elif status == 404 and 'docker-content-digest' not in headers:
                result['state'] = 'absent'
            if receipt is not None:
                if known and result['state'] == 'absent':
                    result.update(state='succeeded', terminal=True, readback_verified=True,
                        write_terminal=True, delete_acknowledged=True, delete_status=202, ack_digest=receipt['ack_digest'])
                elif known and result['state'] == 'matching':
                    result = deepcopy(receipt)
                    result['observed_at'] = self._now().isoformat()
                else:
                    result['state'] = 'unknown'
        except Exception:
            result = self._base(op, 'unknown')
        if known:
            # A failed read loses no saved DELETE acknowledgement. Retrying a
            # read is allowed; retrying an unknown DELETE remains impossible.
            result.update(delete_acknowledged=True, delete_status=202, ack_digest=receipt['ack_digest'])
        if receipt is not None:
            self.checkpoint(deepcopy(result))
        return result

    def cleanup(self, operation, push_receipt, zero_reference_evidence):
        op = self._operation(operation)
        self.validate_zero_references(op, push_receipt, zero_reference_evidence)
        with self._removal_window(op):
            return self._cleanup_owned(op, push_receipt, zero_reference_evidence)

    def _cleanup_owned(self, operation, push_receipt, zero_reference_evidence):
        op = self._operation(operation)
        evidence_digest = self.validate_zero_references(op, push_receipt, zero_reference_evidence)
        if op['id'] in self._attempted:
            raise Denied('registry_delete_already_attempted')
        # The present digest proof is obtained by this adapter, not a caller.
        present = self.readback(op)
        if present['state'] != 'matching':
            raise Denied('registry_present_digest_unproven')
        self.validate_zero_references(op, push_receipt, zero_reference_evidence)
        self._deadline(op)
        self.before_send(deepcopy(op))
        self._attempted.add(op['id'])
        result = self._base(op, 'unknown')
        try:
            # Durable intent writing may take time. Recheck both gates at send.
            self.validate_zero_references(op, push_receipt, zero_reference_evidence)
            # A refreshed bearer may require two exchanges. The proof must
            # still be fresh after those calls, immediately before DELETE.
            response = self._request(op, 'DELETE', lambda: self.validate_zero_references(
                op, push_receipt, zero_reference_evidence))
            result['http'] = response['status']
            if response['status'] == 202 and not response['body']:
                result.update(state='pending', delete_acknowledged=True, delete_status=202,
                    ack_digest=digest({'request_digest': digest(op), 'http': 202}),
                    properties={'zero_reference_evidence_digest': evidence_digest})
            elif response['status'] in (400, 401, 403, 404, 405, 409, 412, 422, 429):
                result.update(state='failed', terminal=True)
        except Exception:
            # Never retain raw exceptions, response bodies or token headers.
            result = self._base(op, 'unknown')
        self.checkpoint(deepcopy(result))
        return result
