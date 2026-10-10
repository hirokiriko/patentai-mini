"""Fixed-target ARM and private Blob adapters; no credentials or targets in source.

HTTP requests run in a killable child so DNS, TLS and response-body stalls share
one absolute deadline. Terminating a request never establishes its outcome.
No write retry, redirect, account key, SAS, or implicit live execution is used.
"""
import base64
import contextlib
import hashlib
import http.client
import ipaddress
import json
import multiprocessing
import os
import subprocess
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit, parse_qs, urlencode
from .lifecycle import Conflict, Denied, parse


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


class Deadline:
    def __init__(self, seconds, monotonic=time.monotonic):
        if not 0 < seconds <= 60:
            raise ValueError('invalid_total_timeout')
        self.monotonic, self.end = monotonic, monotonic() + seconds

    def remaining(self):
        value = self.end - self.monotonic()
        if value <= 0:
            raise TimeoutError('total_deadline')
        return value


def _http_child(pipe, request):
    """Only in-memory arguments/pipe; never stdout or raw exception text."""
    connection = None
    try:
        method, url, headers, body, seconds, limit = request
        u = urlsplit(url)
        cls = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
        connection = cls(u.hostname, u.port, timeout=seconds)
        connection.request(method, u.path + ('?' + u.query if u.query else ''), body=body, headers=headers)
        response = connection.getresponse()
        content = response.read(limit+1)
        if len(content) > limit:
            raise ValueError('response_limit')
        pipe.send((response.status, {k.lower(): v for k, v in response.getheaders()}, content))
    except Exception:
        pipe.send(None)
    finally:
        if connection:
            connection.close()
        pipe.close()


class BoundedHttp:
    def __call__(self, method, url, headers, body, deadline):
        u = urlsplit(url)
        if u.username or u.password or u.fragment or (u.scheme != 'https' and not
                (u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost', '::1') and u.path == '/msi/token')):
            raise Denied('http_target')
        ctx = multiprocessing.get_context('spawn')
        parent, child = ctx.Pipe(duplex=False)
        limit=65536 if u.hostname.endswith('.blob.core.windows.net') else 1048576
        process = ctx.Process(target=_http_child, args=(child, (method, url, headers, body, deadline.remaining(),limit)), daemon=True)
        try:
            process.start(); child.close()
            if not parent.poll(deadline.remaining()):
                raise TimeoutError('http_outcome_unknown')
            value = parent.recv()
            deadline.remaining()
            if value is None:
                raise OSError('http_outcome_unknown')
            status, response_headers, content = value
            return {'status': status, 'headers': response_headers, 'body': content}
        finally:
            if process.pid:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=1)
                if process.is_alive():
                    process.kill(); process.join(timeout=1)
            parent.close(); child.close()


def json_body(response):
    if not response['body']:
        return {}
    try:
        return json.loads(response['body'])
    except (ValueError, TypeError):
        raise OSError('invalid_response') from None


class AzureCredential:
    """Normal existing CLI chain or ACA-injected MI; no credential creation."""
    def __init__(self, mode, principal_id, tenant_id, http, environment=None):
        if mode not in ('owner', 'guardian'):
            raise ValueError('credential_mode')
        self.mode, self.principal, self.tenant = mode, principal_id.lower(), tenant_id.lower()
        self.http, self.env = http, os.environ if environment is None else environment

    def token(self, audience, deadline):
        if audience not in ('https://management.azure.com/', 'https://storage.azure.com/'):
            raise Denied('token_audience')
        if self.mode == 'owner':
            result = subprocess.run(['az.cmd' if os.name == 'nt' else 'az', 'account', 'get-access-token',
                '--resource', audience, '--output', 'json', '--only-show-errors'], capture_output=True,
                timeout=deadline.remaining(), check=True, creationflags=0x08000000 if os.name == 'nt' else 0)
            value = json.loads(result.stdout)
            token = value.get('accessToken', '')
        else:
            endpoint = self.env.get('IDENTITY_ENDPOINT', '')
            u = urlsplit(endpoint)
            header = self.env.get('IDENTITY_HEADER', '')
            if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1') or u.path != '/msi/token' or u.query or u.fragment or u.username or not 0 < len(header) <= 32768:
                raise Denied('identity_endpoint')
            r = self.http('GET', endpoint + '?' + urlencode({'api-version': '2019-08-01', 'resource': audience}),
                {'X-IDENTITY-HEADER': header}, None, deadline)
            value = json_body(r)
            if r['status'] != 200 or value.get('resource') != audience or value.get('token_type') != 'Bearer':
                raise Denied('identity_response')
            token = value.get('access_token', '')
        try:
            claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
            if claims['oid'].lower() != self.principal or claims['tid'].lower() != self.tenant or claims['aud'].rstrip('/') != audience.rstrip('/') or claims['exp'] <= time.time() + deadline.remaining():
                raise ValueError()
        except Exception:
            raise Denied('identity_binding') from None
        deadline.remaining()
        return token


class ArmTransport:
    version = '2024-08-01'
    lro_actions = ('Microsoft.DBforPostgreSQL/locations/azureAsyncOperation/read',
                   'Microsoft.DBforPostgreSQL/locations/operationResults/read')
    def __init__(self, binding, credential, http, clock, assert_send_lease):
        self.binding = deepcopy(binding)
        self.credential, self.http, self.clock, self.assert_send_lease = credential, http, clock, assert_send_lease
        self.server, self.rule = binding['server_id'], binding['rule_id']
        parts = self.server.split('/')
        if len(parts) != 9 or parts[1] != 'subscriptions' or parts[3] != 'resourceGroups' or parts[5:8] != ['providers', 'Microsoft.DBforPostgreSQL', 'flexibleServers']:
            raise ValueError('server_binding')
        if not self.rule.startswith(self.server + '/firewallRules/') or '/' in self.rule[len(self.server + '/firewallRules/'):]:
            raise ValueError('exact_child_required')
        uuid.UUID(parts[2])
        if ipaddress.ip_address(binding['ipv4']).version != 4 or binding['mode'] not in ('owner', 'guardian'):
            raise ValueError('binding')
        self.subscription = parts[2]
        self.high,self.anchor,self.mono=clock.utc(),clock.utc(),clock.monotonic()

    def observe(self, at):
        self.high=max(self.high,at,self.clock.utc(),self.anchor+timedelta(seconds=max(0,self.clock.monotonic()-self.mono)))
        self.anchor,self.mono=self.high,self.clock.monotonic()
        return self.high

    def _bound(self, operation, rule_id):
        if rule_id != self.rule or operation['method'] not in ('PUT', 'DELETE'):
            raise Denied('operation_binding')
        uuid.UUID(operation['request_id'])
        return {'request_id': operation['request_id'], 'rule_id': self.rule, 'method': operation['method']}

    def _request(self, method, url, deadline, body=None, request_id=None, write=False, authorize=None):
        if authorize:authorize(deadline)
        token = self.credential.token('https://management.azure.com/', deadline)
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if request_id:
            headers['x-ms-client-request-id'] = request_id
            headers['x-ms-return-client-request-id'] = 'true'
        if write:
            self.assert_send_lease(deadline.remaining())
        if authorize:authorize(deadline)
        deadline.remaining()
        return self.http(method, url, headers, encoded(body) if body is not None else None, deadline)

    def _resource_url(self, rid):
        return 'https://management.azure.com' + rid + '?api-version=' + self.version

    def _lro_url(self, url):
        u = urlsplit(url)
        prefix = f'/subscriptions/{self.subscription}/providers/Microsoft.DBforPostgreSQL/locations/'
        # The provider uses subscription/locations URLs; only the approved
        # region and known operation-status families may be polled.
        expected = prefix + self.binding['region'] + '/'
        tail = u.path[len(expected):] if u.path.startswith(expected) else ''
        parts = tail.split('/')
        if (u.scheme != 'https' or u.netloc != 'management.azure.com' or u.fragment or len(parts) != 2 or parts[0] not in ('azureAsyncOperation', 'operationResults') or not parts[1] or
                any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in parts[1]) or parse_qs(u.query) != {'api-version': [self.version]}):
            raise Denied('lro_target')
        return url

    def _terminal_response(self, method, response):
        if response['status'] not in (200, 201, 204):
            return None
        value = json_body(response)
        states = [s for s in (value.get('status'), value.get('properties', {}).get('provisioningState')) if s is not None]
        if 'Failed' in states:
            return 'failed'
        if 'Canceled' in states:
            return 'canceled'
        if any(s != 'Succeeded' for s in states):
            return None
        if method == 'DELETE':
            # An empty 204 is terminal by contract. A 200 body with no explicit
            # terminal state remains unknown, even if the next GET is absent.
            return 'succeeded' if states or (response['status'] == 204 and not response['body'].strip()) else None
        if value.get('id', '').lower() == self.rule.lower() and value.get('properties', {}).get('startIpAddress') == self.binding['ipv4'] and value.get('properties', {}).get('endIpAddress') == self.binding['ipv4']:
            return 'succeeded'
        return None

    def send(self, *, operation, rule_id, timeout):
        bound = self._bound(operation, rule_id)
        if operation['method'] == 'PUT' and self.binding['mode'] != 'owner':
            raise Denied('guardian_put_forbidden')
        body = {'properties': {'startIpAddress': self.binding['ipv4'], 'endIpAddress': self.binding['ipv4']}} if operation['method'] == 'PUT' else None
        r = self._request(operation['method'], self._resource_url(self.rule), Deadline(timeout, self.clock.monotonic), body, operation['request_id'], True)
        result = {**bound, 'http': r['status'], 'terminal': None}
        if r['status'] in (200, 201, 202, 204) and (r['headers'].get('location') or r['headers'].get('azure-asyncoperation')):
            try:
                result['operation_url'] = self._lro_url(r['headers'].get('azure-asyncoperation') or r['headers']['location'])
            except Denied:
                # The write WAS sent. Invalid proof is unknown, never local_not_sent.
                raise OSError('write_proof_unconfirmed') from None
            result['operation_receipt'] = {**bound, 'url': result['operation_url'],
                'kind': 'status' if r['headers'].get('azure-asyncoperation') else 'result'}
        elif r['status'] in (200, 201, 204):
            terminal = self._terminal_response(operation['method'], r)
            if terminal:
                result.update(terminal=terminal, proof='write_response')
        elif r['status'] in (400, 409, 422):
            result.update(terminal='failed', proof='write_response', error_code=json_body(r).get('error', {}).get('code'))
        return result

    def _authorize_lro(self, deadline):
        # An operation URL is evidence of a request, never authorization. Only
        # the locally reviewed exact two-action subscription grant may enable it.
        approval=self.binding.get('lro_authorization') or {}
        if (approval.get('approved') is not True or approval.get('readback_verified') is not True or
                approval.get('scope') != '/subscriptions/'+self.subscription or
                sorted(approval.get('actions',[])) != sorted(self.lro_actions) or
                not isinstance(approval.get('evidence_sha256'),str) or len(approval['evidence_sha256'])!=64 or
                any(c not in '0123456789abcdef' for c in approval['evidence_sha256']) or
                not approval.get('principal_id') or not approval.get('assignment_id') or
                not approval.get('ends_at') or self.observe(self.clock.utc())+timedelta(seconds=deadline.remaining())>=parse(approval['ends_at'])):
            raise OSError('lro_authorization_unconfirmed')
        if getattr(self.credential,'principal',approval['principal_id']).lower()!=approval['principal_id'].lower():
            raise OSError('lro_principal_unconfirmed')
    def poll(self, *, operation, rule_id, timeout):
        bound = self._bound(operation, rule_id)
        url = self._lro_url(operation['operation_url'])
        receipt = operation.get('operation_receipt') or {}
        if any(receipt.get(k) != v for k, v in bound.items()) or receipt.get('url') != url or receipt.get('kind') not in ('status', 'result'):
            raise OSError('operation_receipt_mismatch')
        r = self._request('GET', url, Deadline(timeout, self.clock.monotonic),authorize=self._authorize_lro)
        result = {**bound, 'http': r['status'], 'terminal': None}
        value = json_body(r)
        status = value.get('status') if r['status'] == 200 else None
        terminal = None
        if receipt['kind'] == 'status':
            if status in ('Succeeded', 'Failed', 'Canceled') and value.get('properties', {}).get('provisioningState') in (None, status):
                terminal = status.lower()
        else:
            terminal = self._terminal_response(operation['method'], r)
        if terminal:
            result.update(terminal=terminal, proof='operation_status', error_code=value.get('error', {}).get('code'))
        return result

    def recover(self, *, operation, rule_id, timeout):
        # No Activity Log permission is implied. A missing operation URL stays
        # unknown and is handed to the accepted recovery actor, never resent.
        return {**self._bound(operation, rule_id), 'http': 0, 'terminal': None}

    def inspect(self, *, rule_id, lifecycle_id, timeout):
        if rule_id != self.rule or lifecycle_id != self.binding['lifecycle_id']:
            raise Denied('inspect_binding')
        deadline = Deadline(timeout, self.clock.monotonic)
        server = self._request('GET', self._resource_url(self.server), deadline)
        exact = self._request('GET', self._resource_url(self.rule), deadline)
        listed = self._request('GET', self._resource_url(self.server + '/firewallRules'), deadline)
        denied = next((r['status'] for r in (server, exact, listed) if r['status'] in (401, 403)), None)
        if denied:
            return {'http': denied}
        s, e, page = map(json_body, (server, exact, listed))
        rows = page.get('value')
        # Partial enumeration is a stop condition; no arbitrary nextLink follow.
        row_valid = lambda v: (isinstance(v, dict) and isinstance(v.get('id'), str) and
            v['id'].lower().startswith((self.server + '/firewallRules/').lower()) and '/' not in v['id'][len(self.server + '/firewallRules/'):] and
            isinstance(v.get('properties'), dict) and set(('startIpAddress', 'endIpAddress')) <= v['properties'].keys())
        complete = (listed['status'] == 200 and isinstance(rows, list) and not page.get('nextLink') and len(rows) <= 1000 and
            all(row_valid(v) for v in rows) and len({v['id'].lower() for v in rows}) == len(rows))
        rows = rows if isinstance(rows, list) and all(row_valid(v) for v in rows) else []
        if s.get('id', '').lower() != self.server.lower():
            complete = False
        owned = exact['status'] == 200 and e.get('id', '').lower() == self.rule.lower() and e.get('properties', {}).get('startIpAddress') == self.binding['ipv4'] and e.get('properties', {}).get('endIpAddress') == self.binding['ipv4']
        names = lambda values: sorted([{'id': v.get('id', '').lower(), 'properties': v.get('properties')} for v in values], key=lambda v: v['id'])
        others = [v for v in rows if v.get('id', '').lower() != self.rule.lower()]
        matching = [v for v in rows if v.get('id', '').lower() == self.rule.lower()]
        if (exact['status'] == 404 and matching) or (exact['status'] == 200 and (len(matching) != 1 or matching[0].get('properties') != e.get('properties'))):
            complete = False
        return {'http': 200 if server['status'] == 200 and exact['status'] in (200, 404) and listed['status'] == 200 else 0,
            'exact_http': exact['status'], 'rule': 'owned' if owned else 'absent' if exact['status'] == 404 else 'foreign',
            'rule_id': self.rule, 'lifecycle_id': lifecycle_id, 'at': self.clock.utc().isoformat(),
            'server_ready': s.get('properties', {}).get('state') == 'Ready',
            'complete_list': complete, 'listed_absent': not any(v.get('id', '').lower() == self.rule.lower() for v in rows),
            'existing_rules_unchanged': complete and names(others) == names(self.binding['baseline_rules']),
            'network_unchanged': s.get('properties', {}).get('network') == self.binding['baseline_network']}


class BlobJournal:
    """Single fixed state blob with finite lease, ETag and version fencing."""
    def __init__(self, url, binding_digest, credential, http, clock, *, immutable):
        u = urlsplit(url)
        if u.scheme != 'https' or not u.hostname or not u.hostname.endswith('.blob.core.windows.net') or u.query or u.fragment or u.username or u.port or u.path.split('/')[-1] not in ('state.json', 'rehearsal.json') or len(u.path.split('/')) != 3:
            raise ValueError('journal_target')
        self.url, self.binding_digest, self.credential, self.http, self.clock = url, binding_digest, credential, http, clock
        self.immutable = deepcopy(immutable)
        self.lease, self.etag, self.state, self.lease_until = None, None, None, 0

    def _valid_binding(self, value):
        return value.get('binding_digest') == self.binding_digest and all(value.get(k) == v for k, v in self.immutable.items())

    def _request(self, method, deadline, body=None, headers=None, lease=False):
        payload=encoded(body) if body is not None else None
        if payload is not None and len(payload)>65536:
            raise Conflict('journal_size_limit')
        token = self.credential.token('https://storage.azure.com/', deadline)
        h = {'Authorization': 'Bearer ' + token, 'x-ms-version': '2023-11-03', 'x-ms-date': datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')}
        h.update(headers or {})
        if self.lease:
            h['x-ms-lease-id'] = self.lease
        deadline.remaining()
        response=self.http(method, self.url + ('?comp=lease' if lease else ''), h, payload, deadline)
        if len(response['body'])>65536:
            raise Conflict('journal_size_limit')
        return response

    def initialize(self, state):
        if not self._valid_binding(state):
            raise Conflict('immutable_binding')
        r = self._request('PUT', Deadline(20, self.clock.monotonic), state, {'If-None-Match': '*', 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json'})
        if r['status'] != 201:
            raise Conflict('initial_commit_unconfirmed')

    @contextlib.contextmanager
    def locked(self):
        if self.lease:
            raise Conflict('nested_lease')
        proposed = str(uuid.uuid4())
        r = self._request('PUT', Deadline(10, self.clock.monotonic), headers={'x-ms-lease-action': 'acquire', 'x-ms-lease-duration': '60', 'x-ms-proposed-lease-id': proposed}, lease=True)
        if r['status'] != 201 or r['headers'].get('x-ms-lease-id') != proposed:
            raise Conflict('lease_unavailable')
        self.lease, self.lease_until = proposed, self.clock.monotonic() + 50
        try:
            yield self
        finally:
            try:
                r = self._request('PUT', Deadline(5, self.clock.monotonic), headers={'x-ms-lease-action': 'release'}, lease=True)
                if r['status'] not in (200, 409, 412):
                    raise Conflict('lease_release_unconfirmed')
            finally:
                self.lease = None; self.etag = None; self.state = None; self.lease_until = 0

    def assert_send_lease(self, timeout):
        if not self.lease or self.clock.monotonic() + timeout + 5 >= self.lease_until:
            raise Denied('lease_margin')
        # Positive finite lease renew immediately before ARM, not just a local flag.
        r = self._request('PUT', Deadline(min(timeout, 5), self.clock.monotonic), headers={'x-ms-lease-action': 'renew'}, lease=True)
        if r['status'] != 200:
            raise Denied('lease_lost')
        self.lease_until = self.clock.monotonic() + 50

    def load(self):
        if not self.lease:
            raise Conflict('lease_required')
        r = self._request('GET', Deadline(10, self.clock.monotonic))
        value = json_body(r)
        if r['status'] != 200 or not r['headers'].get('etag') or not self._valid_binding(value):
            raise Conflict('journal_binding')
        if 'last_now' in value and hasattr(self.http, 'observe'):
            self.http.observe(parse(value['last_now']))
        self.etag, self.state = r['headers']['etag'], value
        return deepcopy(value)

    def save(self, candidate, expected_version):
        if not self.lease or not self.etag or self.state is None or self.state['version'] != expected_version or candidate['version'] != expected_version + 1 or not self._valid_binding(candidate):
            raise Conflict('journal_version')
        for key in ('put', 'delete'):
            old, new = self.state.get(key), candidate.get(key)
            if old and new and old['request_id'] == new['request_id']:
                if any(old.get(k) != new.get(k) for k in ('method', 'intent_at')) or (old.get('operation_receipt') and old.get('operation_receipt') != new.get('operation_receipt')):
                    raise Conflict('operation_binding_changed')
        if self.clock.monotonic() + 15 >= self.lease_until:
            raise Conflict('journal_lease_expiring')
        previous = deepcopy(self.state)
        try:
            r = self._request('PUT', Deadline(10, self.clock.monotonic), candidate, {'If-Match': self.etag, 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json'})
            if r['status'] in (401, 403, 409, 412):
                raise Conflict('journal_write_denied')
            if r['status'] != 201 or not r['headers'].get('etag'):
                raise OSError('journal_commit_unknown')
            self.etag, self.state = r['headers']['etag'], deepcopy(candidate)
        except (OSError, TimeoutError):
            observed = self.load()
            if observed != candidate or self.clock.monotonic() + 5 >= self.lease_until:
                self.state = previous
                raise Conflict('journal_commit_unknown') from None


class Handoff:
    """Receipt means an approved successor acquired the lease and ran recovery.
    A pending request or heartbeat alone is never accepted as a transfer."""
    def __init__(self, journal, clock, actor_id):
        self.journal, self.clock, self.actor_id = journal, clock, actor_id
        self.anchor_wall, self.anchor_mono = clock.utc(), clock.monotonic()

    def request(self):
        with self.journal.locked():
            s = self.journal.load()
            if s.get('handoff'):
                return s['handoff']
            if s.get('writer_actor') not in (None, self.actor_id):
                raise Denied('writer_fenced')
            value = {'nonce': str(uuid.uuid4()), 'from': self.actor_id, 'to': s['successor_id'],
                'deadline': s['deadline'], 'requested_at': self.clock.utc().isoformat(), 'accepted': False, 'requested_tick': s['tick_count']}
            s.update(version=s['version'] + 1, close_requested=True, usage_allowed=False, handoff=value, writer_actor=self.actor_id)
            self.journal.save(s, expected_version=s['version'] - 1)
            return value

    def offer_after_sender_deadline(self):
        """Fixed successor can recover even if the sender died before its offer."""
        with self.journal.locked():
            s=self.journal.load()
            now=max(self.clock.utc(),parse(s['last_now']),self.anchor_wall+timedelta(seconds=max(0,self.clock.monotonic()-self.anchor_mono)))
            self.anchor_wall,self.anchor_mono=now,self.clock.monotonic()
            guard=s['cloud_guard'];sender=guard['principal_id']+':'+guard['execution_id']
            if s['successor_id'] != self.actor_id or s.get('writer_actor') not in (None,sender):
                raise Denied('takeover_binding')
            if now < parse(guard['job_deadline']):
                return None
            if s.get('handoff'):
                return s['handoff']
            value={'nonce':str(uuid.uuid4()),'from':sender,'to':self.actor_id,'deadline':s['deadline'],
                'requested_at':now.isoformat(),'accepted':False,'requested_tick':s['tick_count'],'reason':'fixed_sender_deadline'}
            # Existing requests/receipts are copied untouched. Claim and the
            # first cleanup tick still go through accept's epoch checks.
            s.update(version=s['version']+1,close_requested=True,usage_allowed=False,handoff=value,writer_actor=sender,last_now=now.isoformat())
            self.journal.save(s,expected_version=s['version']-1)
            return value

    def accept(self, controller):
        # The successor performs a real bounded reconciliation step before its
        # acceptance receipt; this can remain unknown but cannot permit reuse.
        if controller.actor_id != self.actor_id:
            raise Denied('handoff_actor')
        with self.journal.locked():
            s = self.journal.load(); h = s.get('handoff')
            if not h or h['to'] != self.actor_id or h['deadline'] != s['deadline'] or h['accepted']:
                raise Denied('handoff_target')
            nonce = h['nonce']
            claim = str(uuid.uuid4())
            claim_tick = s['tick_count']
            h['claim_at'] = self.clock.utc().isoformat()
            h['claim_token'] = claim
            s.update(version=s['version'] + 1, writer_actor=self.actor_id, handoff=h)
            self.journal.save(s, expected_version=s['version'] - 1)
        recovery = controller.tick()
        with self.journal.locked():
            s = self.journal.load(); h = s['handoff']
            if (h['nonce'] != nonce or h['to'] != self.actor_id or h.get('claim_token') != claim or
                    s.get('writer_actor') != self.actor_id or not h.get('claim_at') or
                    not 0 <= (self.clock.utc() - parse(h['claim_at'])).total_seconds() < 30 or
                    not isinstance(recovery, dict) or recovery.get('writer_actor') != self.actor_id or
                    recovery.get('tick_count', 0) <= claim_tick or s['tick_count'] != recovery['tick_count'] or
                    s['version'] != recovery.get('version') or (recovery.get('handoff') or {}).get('claim_token') != claim or s.get('blocked')):
                raise Conflict('handoff_changed')
            h.update(accepted=True, accepted_at=self.clock.utc().isoformat(), first_recovery_tick=s['tick_count'], actor=self.actor_id)
            s.update(version=s['version'] + 1, handoff=h, writer_actor=self.actor_id)
            self.journal.save(s, expected_version=s['version'] - 1)

    def reclaim_stale_claim(self):
        with self.journal.locked():
            s = self.journal.load(); h = s.get('handoff') or {}
            if (h.get('from') != self.actor_id or h.get('accepted') or not h.get('claim_at') or
                    (self.clock.utc() - parse(h['claim_at'])).total_seconds() < 30):
                return False
            # Lease acquisition fences the prior holder. Its durable in-flight
            # ARM intent is retained and must be reconciled, never retransmitted.
            h.pop('claim_at', None)
            h.pop('claim_token', None)
            s.update(version=s['version'] + 1, writer_actor=self.actor_id, handoff=h)
            self.journal.save(s, expected_version=s['version'] - 1)
            return True

    def accepted(self):
        with self.journal.locked():
            s = self.journal.load(); h = s.get('handoff') or {}
            age = (self.clock.utc() - parse(h['accepted_at'])).total_seconds() if h.get('accepted_at') else float('inf')
            return h.get('accepted') is True and h.get('from') == self.actor_id and h.get('to') == s['successor_id'] and h.get('actor') == s['successor_id'] and h.get('deadline') == s['deadline'] and h.get('first_recovery_tick', 0) > h.get('requested_tick', 0) and s.get('writer_actor') == s['successor_id'] and 0 <= age <= 15
