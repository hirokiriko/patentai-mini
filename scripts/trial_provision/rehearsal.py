"""One 300-second guardian rehearsal; no firewall write or Blob deletion.

The root supplies its authenticated creation receipt, immutable private configs,
normal OWNER credential, shared counted transport and durable journal hooks.
This module acquires no credential on import and has no live/default CLI.

Call start(), optionally poll_start(), initialize(), then verify(). Each method
is bounded; callers schedule subsequent GETs without launching another Job.
before_send(op) must reject any earlier durable intent, across restarts. The
root resolves/registers each returned/generated operation before checkpointing.
verify() returns (operation, receipt) for resources.build_guard_main_operation.
Only terminal execution + bound journal CAS + released lease prove success.
The retained rehearsal.json is not deleted. live_delete_verified stays false.

Microsoft contracts:
https://learn.microsoft.com/rest/api/resource-manager/containerapps/jobs/start?view=rest-resource-manager-containerapps-2025-07-01
https://learn.microsoft.com/rest/api/storageservices/get-blob
"""
from copy import deepcopy
from datetime import timedelta
import json
import re
from urllib.parse import urlsplit

from scripts.trial_guard.__main__ import FIXED
from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_guard.owner import OwnerSession
from .providers import _input_matches, RESOURCE, GUID


ARM = 'https://management.azure.com'
VERSION = '2025-07-01'
MAX_BODY = 2 * 1024 * 1024


def require(value):
    if not value:
        raise Denied('rehearsal_binding')


def successful(receipt):
    return (isinstance(receipt, dict) and receipt.get('state') == 'succeeded'
        and all(receipt.get(k) is True for k in ('terminal', 'write_terminal', 'created_by_run', 'readback_verified')))


class GuardianRehearsalAdapter:
    """Finite adapter around the existing OWNER journal/lease/CAS implementation.

    session_factory is a test seam; production defaults to OwnerSession. Its
    transport is constrained to this one rehearsal Blob, and only seed PUT,
    GET and lease acquire/release are allowed. No caller cleanup assertion can
    substitute for the final authenticated Blob GET and lease-state headers.
    Operation bodies/configs and object IDs are private; nothing is printed.
    """
    def __init__(self, create_operation, create_receipt, owner_config, guardian_config,
                 credential, http, clock, *, before_send, checkpoint, session_factory=OwnerSession):
        self.create, self.created = deepcopy(create_operation), deepcopy(create_receipt)
        self.owner, self.guardian = deepcopy(owner_config), deepcopy(guardian_config)
        self.credential, self.http, self.clock = credential, http, clock
        self.before_send, self.checkpoint, self.session_factory = before_send, checkpoint, session_factory
        self.wall, self.mono = clock.utc(), clock.monotonic()
        self.unsafe, self.attempted = False, set()
        self.operations = {}
        self._initial_send = None
        self._initial_until = None
        try:
            require(callable(before_send) and callable(checkpoint))
            require(self.create['id'] == 'guard' and self.create['provider'] == 'Microsoft.App'
                and self.create['kind'] == 'jobs' and self.create['method'] == 'PUT')
            self.job = self.create['expected']['resource_id']
            require(re.fullmatch(RESOURCE['jobs'], self.job) is not None)
            require(self.create['url'] == ARM + self.job + '?api-version=' + VERSION)
            require(self.created['operation_id'] == 'guard' and self.created['request_digest'] == digest(self.create)
                and self.created['object_id'] == self.job and successful(self.created))
            self.principal = self.created['properties']['principalId']
            require(re.fullmatch(GUID, self.principal) is not None)
            require(getattr(credential, 'mode', None) == 'owner'
                and getattr(credential, 'principal', None) == self.owner['owner_id']
                and getattr(credential, 'tenant', None) == self.owner['tenant_id'])
            require(self.created['properties']['tenantId'] == self.owner['tenant_id'])
            self.until = min(parse(self.owner['owner_permissions_until']), parse(self.create['cleanup']['deadline']))
            self.prearm = parse(self.owner['prearm_until'])
            self.since = parse(self.owner['seed_not_before'])
            require(self.since < self.prearm <= self.until and self.prearm - self.since <= timedelta(seconds=300))
            require(self.owner['live_enabled'] is True and self.owner['cleanup_strategy'] == 'rehearsal')
            self.blob = self.owner['journal_url']
            access = self.owner['owner_access']
            require(access.get('approved') is True and access.get('readback_verified') is True
                and access.get('principal_id') == self.owner['owner_id'] and access.get('journal_url') == self.blob
                and access.get('ends_at') == self.owner['owner_permissions_until'] and access.get('assignment_id')
                and re.fullmatch(r'[0-9a-f]{64}', access.get('evidence_sha256', ''))
                and parse(access['starts_at']) <= self.since
                and timedelta(0) < parse(access['ends_at']) - parse(access['starts_at']) <= timedelta(hours=8))
            u = urlsplit(self.blob)
            require(u.scheme == 'https' and re.fullmatch(r'[a-z0-9]{3,24}\.blob\.core\.windows\.net', u.netloc)
                and re.fullmatch(r'/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]/rehearsal\.json', u.path)
                and not u.query and not u.fragment)
            b, g = self.owner['binding'], self.guardian
            require(b['mode'] == 'guardian' and g['binding'] == b)
            require(g['live_enabled'] is True and g['mode'] == 'rehearsal' and g['journal_url'] == self.blob
                and g['tenant_id'] == self.owner['tenant_id'] and g['job_name'] == self.job.rsplit('/', 1)[1]
                and g['prearm_until'] == self.owner['prearm_until'] and g['seed_not_before'] == self.owner['seed_not_before'])
            fixed = g['immutable']
            require(set(fixed) == FIXED and fixed['cleanup_strategy'] == 'rehearsal'
                and fixed['lifecycle_id'] == b['lifecycle_id'] and fixed['rule_id'] == b['rule_id']
                and fixed['owner_access'] == self.owner['owner_access']
                and fixed['cleanup_targets_digest'] == self.owner['cleanup_targets_digest'])
            require(all(fixed[k] == '$CURRENT' for k in ('prepared_at', 'cleanup_at', 'deadline', 'ready_until')))
            require(all(fixed[k] is None for k in ('successor_id', 'successor_nonce', 'successor_runtime')))
            guard = fixed['cloud_guard']
            require(set(guard) == {'execution_id', 'replica_name', 'image_digest', 'principal_id', 'nonce', 'job_started_at', 'job_deadline'})
            require(guard['execution_id'] == self.job + '/executions/$CURRENT' and guard['replica_name'] == '$CURRENT'
                and guard['job_started_at'] == '$CURRENT' and guard['job_deadline'] == '$CURRENT'
                and guard['principal_id'] == self.principal and isinstance(guard['nonce'], str) and 16 <= len(guard['nonce']) <= 128)
            require(re.fullmatch(r'sha256:[0-9a-f]{64}', guard['image_digest']) is not None)
            configuration = self.create['body']['properties']['configuration']
            require(configuration['triggerType'] == 'Manual' and type(configuration['replicaTimeout']) is int
                and configuration['replicaTimeout'] == 300 and type(configuration['replicaRetryLimit']) is int
                and configuration['replicaRetryLimit'] == 0 and configuration['manualTriggerConfig'] == {'parallelism': 1, 'replicaCompletionCount': 1})
            self.template = deepcopy(self.create['body']['properties']['template'])
            require(len(self.template['containers']) == 1 and self.template.get('initContainers', []) == [])
            container = self.template['containers'][0]
            require(container['image'].endswith('@' + guard['image_digest'])
                and container['command'] == ['python', '-m', 'trial_guard'] and container.get('args', []) == []
                and container.get('env', []) == [] and container['resources'] == {'cpu': 0.25, 'memory': '0.5Gi'})
            require(len(encoded(g)) <= 65536)
            container['env'] = [{'name': 'TRIAL_GUARD_CONFIG_JSON', 'value': encoded(g).decode()}]
            # This unique marker comes from the immutable, run-bound nonce.
            container['env'].append({'name': 'TRIAL_GUARD_REQUEST_ID', 'value': guard['nonce']})
            self.start_op = self._operation('guardRehearsalStart', 'Microsoft.App', 'jobStart', 'POST',
                ARM + self.job + '/start?api-version=' + VERSION, self.template, self.prearm,
                ['guard'], {'resource_id': self.job, 'creation_request_digest': digest(self.create),
                'creation_receipt_digest': digest(self.created), 'config_digest': digest(self.guardian)})
        except (KeyError, TypeError, ValueError, OverflowError):
            raise Denied('rehearsal_configuration') from None

    def _now(self):
        now, mono = self.clock.utc(), self.clock.monotonic()
        if now < self.wall or mono < self.mono:
            self.unsafe = True
        self.wall = max(now, self.wall + timedelta(seconds=max(0, mono - self.mono)))
        self.mono = mono
        return self.wall

    def _restore(self, receipt):
        prior = parse(receipt['observed_at'])
        if prior > self._now():
            self.unsafe = True
            self.wall = prior
            self.mono = self.clock.monotonic()

    def _operation(self, ident, provider, kind, method, url, body, end, depends, expected):
        op = {'id': ident, 'provider': provider, 'kind': kind, 'method': method, 'url': url,
            'body': deepcopy(body), 'deadline': end.isoformat(), 'depends_on': depends,
            'expected': {**expected, 'body_sha256': digest(body)},
            'cleanup': {'journal_retained': True, 'live_delete_verified': False}}
        self.operations[ident] = deepcopy(op)
        return op

    def _base(self, op, object_id=None):
        return {'operation_id': op['id'], 'request_digest': digest(op), 'object_id': object_id,
            'state': 'unknown', 'terminal': False, 'write_terminal': False, 'created_by_run': False,
            'readback_verified': False, 'properties': {}, 'observed_at': self._now().isoformat()}

    def _bound(self, op, receipt, *, ack=False):
        require(isinstance(receipt, dict) and receipt.get('operation_id') == op['id']
            and receipt.get('request_digest') == digest(op))
        self._restore(receipt)
        if ack:
            require(receipt.get('created_by_run') is True and receipt.get('write_terminal') is True)

    def _intent(self, op):
        now = self._now()
        require(op['id'] not in self.attempted and not self.unsafe and now < parse(op['deadline']))
        self.before_send(deepcopy(op))
        self.attempted.add(op['id'])
        now = self._now()
        require(not self.unsafe and now < parse(op['deadline']))

    def _wire(self, method, url, headers, body, deadline):
        # OwnerSession may only create/read this Blob and acquire/release its
        # finite lease. Firewall transports are never allowed through this gate.
        if url == self.blob + '?comp=lease':
            require(method == 'PUT' and headers.get('x-ms-lease-action') in ('acquire', 'release'))
        elif url == self.blob:
            now = self._now()
            require(method == 'GET' or (method == 'PUT' and isinstance(body, bytes)
                and self._initial_send == digest(body.hex()) and not self.unsafe
                and self._initial_until is not None and now + timedelta(seconds=deadline.remaining()) < self._initial_until
                and headers.get('If-None-Match') == '*'))
        else:
            require(url.startswith(ARM + self.job) or self._lro_url(url) == url)
            path = urlsplit(url).path
            require(urlsplit(url).query == 'api-version=' + VERSION)
            require((method == 'GET' and (path == self.job or self._execution(path)
                or (path.endswith('/replicas') and self._execution(path.removesuffix('/replicas')))
                or self._is_lro(url))) or (method == 'POST' and url == self.start_op['url']))
        require(self._now() + timedelta(seconds=deadline.remaining()) < self.until)
        response = self.http(method, url, headers, body, deadline)
        deadline.remaining()
        require(self._now() < self.until)
        require(isinstance(response, dict) and type(response.get('status')) is int
            and isinstance(response.get('body'), bytes) and len(response['body']) <= MAX_BODY
            and isinstance(response.get('headers'), dict))
        hs = response['headers']
        require(all(isinstance(k, str) and isinstance(v, str) for k, v in hs.items())
            and len({k.lower() for k in hs}) == len(hs) and len(encoded(hs)) <= 32768)
        require(not 300 <= response['status'] < 400)
        return {**response, 'headers': {k.lower(): v for k, v in hs.items()}}

    def _request(self, method, url, *, op=None, body=None):
        end = min(self.until, parse(op['deadline']) if op else self.until)
        remaining = (end - self._now()).total_seconds()
        require(remaining > 0)
        d = Deadline(min(10, remaining / 2), self.clock.monotonic)
        audience = 'https://storage.azure.com/' if url == self.blob else ARM + '/'
        token = self.credential.token(audience, d)
        d.remaining()
        if method == 'POST':
            self._intent(op)
        require(self._now() < end)
        h = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if url == self.blob:
            h['x-ms-version'] = '2023-11-03'
        r = self._wire(method, url, h, None if body is None else encoded(body), d)
        require(self._now() < end)
        if method == 'GET':
            require(not any(k in r['headers'] for k in ('location', 'azure-asyncoperation')))
        return r

    @staticmethod
    def _value(response):
        value = json.loads(response['body']) if response['body'] else {}
        require(isinstance(value, dict))
        return value

    def _execution(self, value):
        return (isinstance(value, str) and value.startswith(self.job + '/executions/' + self.job.rsplit('/', 1)[1] + '-')
            and re.fullmatch(r'[a-z0-9-]{1,100}', value.rsplit('/', 1)[1]) is not None)

    def _lro_url(self, url):
        require(isinstance(url, str) and len(url) <= 4096)
        u = urlsplit(url)
        sub, name = self.job.split('/')[2], self.job.rsplit('/', 1)[1]
        region = self.create['expected']['location']
        resource = re.escape('/subscriptions/' + sub + '/providers/Microsoft.App/jobs/' + name + '/operationResults/') + GUID
        regional = re.escape('/subscriptions/' + sub + '/providers/Microsoft.App/locations/' + region + '/') + r'containerappsjobOperation(?:Statuses|Results)/' + GUID
        require(u.scheme == 'https' and u.netloc == 'management.azure.com' and not u.fragment
            and u.query == 'api-version=' + VERSION and (re.fullmatch(resource, u.path) or re.fullmatch(regional, u.path)))
        return url

    def _is_lro(self, url):
        try:
            return self._lro_url(url) == url
        except Denied:
            return False

    def _start_ack(self, response, result):
        hs = response['headers']
        value = self._value(response)
        if response['status'] == 200 and self._execution(value.get('id')) and not any(k in hs for k in ('location', 'azure-asyncoperation')):
            result.update(object_id=value['id'], state='pending', write_terminal=True, created_by_run=True)
            result['properties'] = {'job_resource_id': self.job, 'template_digest': digest(self.template)}
        elif response['status'] == 202 and hs.get('location') and not hs.get('azure-asyncoperation'):
            url = self._lro_url(hs['location'])
            retry = hs.get('retry-after', '1')
            require(re.fullmatch(r'[0-9]{1,3}', retry) is not None)
            result.update(state='pending', operation_url=url, operation_url_digest=digest(url),
                initial_ack_digest=digest({'http': 202, 'url': url}),
                not_before=(self._now() + timedelta(seconds=max(1, int(retry)))).isoformat())
        return result

    def start(self):
        """One POST only, after exact owned Job and absent seed readbacks."""
        require(self.start_op['id'] not in self.attempted and self.since <= self._now() < self.prearm and not self.unsafe)
        r = self._request('GET', self.create['url'], op=self.start_op)
        job = self._value(r)
        require(r['status'] == 200 and job.get('id') == self.job and _input_matches(self.create['body'], job)
            and job.get('properties', {}).get('provisioningState') == 'Succeeded'
            and job.get('identity', {}).get('principalId') == self.principal
            and job.get('identity', {}).get('tenantId') == self.owner['tenant_id'])
        r = self._request('GET', self.blob, op=self.start_op)
        require(r['status'] == 404 and r['headers'].get('x-ms-error-code') == 'BlobNotFound')
        result = self._base(self.start_op)
        try:
            result = self._start_ack(self._request('POST', self.start_op['url'], op=self.start_op, body=self.template), result)
        except Exception:
            pass  # No raw provider response, exception, URL or token is exposed.
        if self.start_op['id'] in self.attempted:
            self.checkpoint(deepcopy(result))
        return deepcopy(self.start_op), result

    def poll_start(self, receipt):
        """Only a persisted known 202 Location is pollable; no execution list."""
        self._bound(self.start_op, receipt)
        require(receipt.get('state') == 'pending' and receipt.get('write_terminal') is False
            and receipt.get('initial_ack_digest') == digest({'http': 202, 'url': receipt.get('operation_url')}))
        url = self._lro_url(receipt['operation_url'])
        require(receipt.get('operation_url_digest') == digest(url) and self._now() >= parse(receipt['not_before']))
        result = deepcopy(receipt)
        try:
            r = self._request('GET', url, op=self.start_op)
            require(not any(k in r['headers'] for k in ('location', 'azure-asyncoperation')))
            if r['status'] == 200 and self._execution(self._value(r).get('id')):
                result = self._start_ack(r, result)
            elif r['status'] == 202:
                retry = r['headers'].get('retry-after', '1')
                require(re.fullmatch(r'[0-9]{1,3}', retry) is not None)
                result['not_before'] = (self._now() + timedelta(seconds=max(1, int(retry)))).isoformat()
        except Exception:
            result['poll_observation_unknown'] = True
        result['observed_at'] = self._now().isoformat()
        self.checkpoint(deepcopy(result))
        return result

    def _execution_read(self, receipt):
        self._bound(self.start_op, receipt, ack=True)
        rid = receipt['object_id']
        require(self._execution(rid) and receipt['properties'].get('template_digest') == digest(self.template))
        r = self._request('GET', ARM + rid + '?api-version=' + VERSION)
        value = self._value(r)
        require(r['status'] == 200 and value.get('id') == rid
            and _input_matches(self.template, value.get('properties', {}).get('template')))
        p = value['properties']
        at = parse(p['startTime'])
        require(self.since <= at < self.prearm and at <= self._now()
            and p.get('status') in ('Running', 'Succeeded', 'Failed', 'Stopped'))
        return p

    def _session(self, runtime, status, *, recovery):
        readback = {**runtime, 'status': status, 'at': self._now().isoformat()}
        config = {**self.owner, 'cloud_guard': runtime, 'runtime_readback': readback}
        # Effective high-water clock also fences credential and lease awaits.
        outer = self
        class EffectiveClock:
            def utc(self): return outer._now()
            def monotonic(self): return outer.clock.monotonic()
        return self.session_factory(config, http=self._wire, clock=EffectiveClock(),
            require_fresh=True, recovery_only=recovery)

    def initialize(self, start_receipt):
        """Exactly one If-None-Match seed PUT, using actual runtime readbacks."""
        p = self._execution_read(start_receipt)
        require(p['status'] == 'Running' and self._now() < parse(p['startTime']) + timedelta(seconds=300)
            and self._now() < self.prearm and not self.unsafe)
        rid = start_receipt['object_id']
        r = self._request('GET', ARM + rid + '/replicas?api-version=' + VERSION, op=self.start_op)
        values = self._value(r)
        require(r['status'] == 200 and not values.get('nextLink') and isinstance(values.get('value'), list) and len(values['value']) == 1)
        replica = values['value'][0].get('name')
        require(isinstance(replica, str) and replica.startswith(rid.rsplit('/', 1)[1] + '-') and re.fullmatch(r'[a-z0-9-]{1,150}', replica))
        at = parse(p['startTime'])
        runtime = {**deepcopy(self.guardian['immutable']['cloud_guard']), 'execution_id': rid,
            'replica_name': replica, 'job_started_at': at.isoformat(), 'job_deadline': (at + timedelta(seconds=300)).isoformat()}
        # The start operation is now complete: its actual execution and replica
        # were read back. This does not claim the rehearsal itself succeeded.
        if not successful(start_receipt):
            started = deepcopy(start_receipt)
            started.update(state='succeeded', terminal=True, readback_verified=True)
            started['observed_at'] = self._now().isoformat()
            self.checkpoint(started)
        session = self._session(runtime, 'Running', recovery=False)
        require(session.strategy == 'rehearsal')
        initial = session.initial
        op = self._operation('guardRehearsalSeed', 'AzureStorageBlob', 'rehearsalSeed', 'PUT', self.blob,
            None, min(self.prearm, at + timedelta(seconds=300)), ['guardRehearsalStart'],
            {'resource_id': self.blob, 'start_request_digest': digest(self.start_op), 'runtime_digest': digest(runtime),
             'initial_state_digest': digest(initial), 'binding_digest': initial['binding_digest']})
        result = self._base(op, self.blob)
        result['properties'] = {'runtime': runtime, 'binding_digest': initial['binding_digest'],
            'initial_state_digest': digest(initial)}
        self._intent(op)
        try:
            self._initial_send = digest(encoded(initial).hex())
            self._initial_until = parse(op['deadline'])
            initialized = session.action('initialize')
            require(initialized.get('status') == 'initialized' and initialized.get('snapshot') == initial)
            result.update(state='pending', write_terminal=True, created_by_run=True)
        except Exception:
            pass
        finally:
            self._initial_send = None
            self._initial_until = None
        self.checkpoint(deepcopy(result))
        return op, result

    def verify(self, start_receipt, seed_operation, seed_receipt):
        """Fresh exact terminal read + bound journal read + released finite lease.

        A failed/timed-out execution, missing CAS, unknown start/seed or leased
        Blob cannot produce a successful normalized receipt. Repeated calls are
        reads and finite lease operations only, never start/initialize retries.
        """
        self._bound(seed_operation, seed_receipt, ack=True)
        require(seed_operation['id'] == 'guardRehearsalSeed' and seed_operation['url'] == self.blob
            and seed_operation['expected']['start_request_digest'] == digest(self.start_op)
            and seed_receipt['object_id'] == self.blob
            and seed_operation['expected']['initial_state_digest'] == seed_receipt['properties']['initial_state_digest'])
        runtime = seed_receipt['properties']['runtime']
        require(digest(runtime) == seed_operation['expected']['runtime_digest']
            and runtime['execution_id'] == start_receipt['object_id']
            and runtime['principal_id'] == self.principal
            and runtime['image_digest'] == self.guardian['immutable']['cloud_guard']['image_digest']
            and runtime['nonce'] == self.guardian['immutable']['cloud_guard']['nonce'])
        rid = runtime['execution_id']
        op = self._operation('guardRehearsal', 'Microsoft.App', 'guardRehearsal', 'GET',
            ARM + rid + '?api-version=' + VERSION, None, self.until, ['guardRehearsalStart', 'guardRehearsalSeed'],
            {'resource_id': rid, 'start_request_digest': digest(self.start_op),
             'seed_request_digest': digest(seed_operation), 'runtime_digest': digest(runtime)})
        result = self._base(op, rid)
        try:
            p = self._execution_read(start_receipt)
            at, end = parse(p['startTime']), parse(p['endTime'])
            require(p['status'] == 'Succeeded' and at.isoformat() == runtime['job_started_at']
                and at < end <= at + timedelta(seconds=300) and end <= self._now()
                and runtime['job_deadline'] == (at + timedelta(seconds=300)).isoformat())
            session = self._session(runtime, p['status'], recovery=True)
            require(session.strategy == 'rehearsal' and session.initial['binding_digest'] == seed_operation['expected']['binding_digest'])
            status = session.action('status')
            state = status['snapshot']
            proof = state.get('rehearsal') or {}
            require(state['binding_digest'] == seed_operation['expected']['binding_digest']
                and state['cleanup_strategy'] == 'rehearsal' and state['cloud_guard'] == runtime
                and state['put'] is None and state['delete'] is None and state['usage_allowed'] is False
                and state['close_requested'] is True and type(state['version']) is int and state['version'] >= 1
                and proof.get('reads_and_cas') is True and proof.get('delete_measured') is False
                and at <= parse(proof['at']) <= end)
            # The status action has left its context and released its lease.
            # Read that exact state again without acquiring another lease.
            r = self._request('GET', self.blob)
            require(r['status'] == 200 and len(r['body']) <= 65536 and self._value(r) == state
                and r['headers'].get('etag') and r['headers'].get('x-ms-lease-status') == 'unlocked'
                and r['headers'].get('x-ms-lease-state') == 'available'
                and not any(k in r['headers'] for k in ('location', 'azure-asyncoperation')))
            result.update(state='succeeded', terminal=True, write_terminal=True, created_by_run=True, readback_verified=True,
                properties={'job_resource_id': self.job, 'rehearsal_reads_verified': True, 'cleanup_verified': True,
                    'lease_released_verified': True, 'live_delete_verified': False, 'journal_retained': True,
                    'start_request_digest': digest(self.start_op), 'seed_request_digest': digest(seed_operation),
                    'journal_state_digest': digest(state), 'journal_etag_digest': digest(r['headers']['etag']),
                    'execution_status': 'Succeeded', 'job_started_at': runtime['job_started_at'], 'job_ended_at': end.isoformat()})
            if not successful(seed_receipt):
                seeded = deepcopy(seed_receipt)
                seeded.update(state='succeeded', terminal=True, readback_verified=True)
                seeded['observed_at'] = self._now().isoformat()
                self.checkpoint(seeded)
        except Exception:
            result = self._base(op, rid)
        result['observed_at'] = self._now().isoformat()
        # A verification intent is a local durable observation, not a cloud
        # mutation. Root records it once with the supplied exact operation.
        return op, result
