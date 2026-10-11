"""Resolve a finite approved plan; no caller operation JSON, URLs, or I/O.

Initial resources/core operations never change when runtime policy arrives.
The OWNER controller persists returned binding events before enabling them and
supplies only authenticated journal receipts. Dependencies and request digests
are checked again on every resolution, including after a process restart.
"""
from copy import deepcopy
import hashlib
import json
import re

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import plan as core
from scripts.trial_provision.resources import build_resource_operations, build_runtime_operations, build_guard_main_operation
from scripts.trial_provision.auth import build_auth_operations


RUNTIME_IDS = ('jobRuntime', 'appRuntime')
AUTH_IDS = ('auth-platform-secret', 'auth-config', 'auth-ingress')
SOURCE_IDS = ('E1', 'app', 'webIdentity', 'workerIdentity')
RETAINED_CONTAINERS = ('originals', 'artifacts', 'budget', 'journal')
POLICY_KEYS = {'TRIAL_POLICY_JSON', 'TRIAL_POLICY_SIGNATURE', 'TRIAL_POLICY_PUBLIC_KEY'}
HEX = r'[0-9a-f]{64}'


def _require(value):
    if not value:
        raise Denied('approved_operation_binding')


def _final(op, receipt):
    _require(isinstance(receipt, dict) and receipt.get('operation_id') == op['id']
             and receipt.get('request_digest') == digest(op)
             and receipt.get('state') == 'succeeded'
             and all(receipt.get(k) is True for k in ('terminal', 'write_terminal', 'readback_verified', 'created_by_run')))
    if 'resource_id' in op['expected']:
        _require(receipt.get('object_id') == op['expected']['resource_id'])
    return receipt


def _merge_state(state, update):
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(state.get(key), dict):
            _merge_state(state[key], value)
        else:
            state[key] = deepcopy(value)


def _observable_state(body):
    value = deepcopy(body)
    for entry in value.get('properties', {}).get('configuration', {}).get('secrets', []):
        entry.pop('value', None)
    return value


class ApprovedOperations:
    """Fixed builder dispatcher used as ``Controller.resolve``.

    ``core_plan`` must be the compiler output pinned by the controller's private
    journal, never an untrusted command-line operation document. This class also
    checks its six authority hashes and the nine exact prerequisite operations.
    Optional late binding is deliberately separate from the initial plan hash.
    """
    def __init__(self, core_plan, manifest, authority_bundle, resource_bindings):
        try:
            core._validate_plan(core_plan)
            _require(set(authority_bundle) == set(core_plan['source_sha256']))
            for key, raw in authority_bundle.items():
                _require(isinstance(raw, bytes) and hashlib.sha256(raw).hexdigest() == core_plan['source_sha256'][key])
            _require(json.loads(authority_bundle['manifest']) == manifest)
            resources = build_resource_operations(manifest, authority_bundle, resource_bindings)
            resource_map = {op['id']: op for op in resources}
            _require(len(resources) == len(resource_map) == 9 and len(core_plan['operations']) == 29)
            _require(not set(resource_map) & set(core_plan['operations']))
            for key, op in resource_map.items():
                prerequisite = core_plan['prerequisites'][key]
                _require(prerequisite['request_digest'] == digest(op)
                         and prerequisite['object_id'] == op['expected']['resource_id']
                         and prerequisite['tenant_id'] == manifest['owner']['tenant_id'])
            self._core = deepcopy(core_plan)
            self._manifest, self._authority, self._resources = deepcopy(manifest), deepcopy(authority_bundle), resource_map
            self._resource_bindings = deepcopy(resource_bindings)
            self._runtime_binding = None
            self._runtime_operations = None
            self._database_observation_digest = None
            self._rehearsal_binding = None
            self._cleanup_bindings = {}
            self._resolved = {}
            self._auth_binding = {**deepcopy(core_plan['auth_binding']),
                'environment_id': manifest['existing']['environment'], 'location': manifest['region'],
                'runtime_secret_names': ['trial-web-database']}
            self._auth_deadline = core_plan['windows']['owner_input']['end']
            initial = {'schema': 1, 'core_plan_sha256': core_plan['plan_sha256'],
                'source_sha256': deepcopy(core_plan['source_sha256']), 'windows': deepcopy(core_plan['windows']),
                'resource_bindings': deepcopy(resource_bindings),
                'auth_deadline': self._auth_deadline,
                'operations': {**deepcopy(resource_map), **deepcopy(core_plan['operations'])}}
            self._initial = initial
            self.plan_digest = digest(initial)
            cleanup_sources = tuple(k for k in resource_map if k not in RETAINED_CONTAINERS) + tuple(core_plan['operations']) + AUTH_IDS
            self._cleanup_sources = {'cleanup_' + key.replace('-', '_'): key for key in cleanup_sources}
            self.allowed_ids = tuple(initial['operations']) + RUNTIME_IDS + AUTH_IDS + ('guardRehearsal', 'guardMainConfiguration') + tuple(self._cleanup_sources)
            _require(len(self.allowed_ids) <= 128 and len(set(self.allowed_ids)) == len(self.allowed_ids))
            _require(all(re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', key) for key in self.allowed_ids))
        except (KeyError, TypeError, ValueError, RecursionError):
            raise Denied('approved_operation_binding') from None

    @property
    def initial_plan(self):
        return deepcopy(self._initial)

    @property
    def runtime_binding(self):
        return deepcopy(self._runtime_binding)

    def _unchanged(self):
        _require(digest(self._initial) == self.plan_digest)
        core._validate_plan(self._core)

    def _sources(self, receipts):
        result = {}
        for key in SOURCE_IDS:
            op = self._resources[key] if key in self._resources else core.materialize_operation(self._core, key, receipts)
            _final(op, receipts.get(key))
            result[key] = digest(receipts[key])
        return result

    def make_runtime_binding(self, policy_environment, receipts, *, verify_policy, deadline):
        """Validate and return an event; caller fsyncs it before bind_runtime.

        The verifier is the already-pinned local trial policy verifier. This
        method never signs policy, generates key material or resolves credentials.
        """
        self._unchanged()
        try:
            _require(isinstance(policy_environment, dict) and set(policy_environment) == POLICY_KEYS)
            _require(parse(deadline) <= parse(self._core['windows']['owner_input']['end']))
            policy = json.loads(policy_environment['TRIAL_POLICY_JSON'])
            _require(parse(policy['startsAt']) >= parse(self._core['windows']['owner_input']['start']))
            sources = self._sources(receipts)
            e1 = core.materialize_operation(self._core, 'E1', receipts)
            operations = build_runtime_operations(self._manifest, self._authority, self._resource_bindings,
                receipts, policy_environment, verify_policy=verify_policy, auth_operation=e1, deadline=deadline)
            _require(tuple(op['id'] for op in operations) == RUNTIME_IDS)
            event = {'schema': 1, 'initial_plan_digest': self.plan_digest,
                'source_receipt_digests': sources, 'policy_environment': deepcopy(policy_environment),
                'deadline': deadline, 'operation_digests': {op['id']: digest(op) for op in operations}}
            event['binding_digest'] = digest(event)
            return event
        except (KeyError, TypeError, ValueError, RecursionError):
            raise Denied('runtime_binding') from None

    def bind_runtime(self, event, receipts, *, verify_policy):
        """Install only a journal-persisted immutable event, also on resume."""
        try:
            _require(isinstance(event, dict) and set(event) == {'schema', 'initial_plan_digest',
                'source_receipt_digests', 'policy_environment', 'deadline', 'operation_digests', 'binding_digest'})
            expected = self.make_runtime_binding(event['policy_environment'], receipts,
                                                 verify_policy=verify_policy, deadline=event['deadline'])
            _require(event == expected)
            _require(self._runtime_binding is None or self._runtime_binding == event)
            e1 = core.materialize_operation(self._core, 'E1', receipts)
            operations = build_runtime_operations(self._manifest, self._authority, self._resource_bindings,
                receipts, event['policy_environment'], verify_policy=verify_policy, auth_operation=e1, deadline=event['deadline'])
            self._runtime_binding = deepcopy(event)
            self._runtime_operations = {op['id']: op for op in operations}
            return {'initial_plan_digest': self.plan_digest, 'binding_digest': event['binding_digest']}
        except (KeyError, TypeError, ValueError, RecursionError):
            raise Denied('runtime_binding') from None

    def _runtime(self, key, receipts):
        _require(self._runtime_binding is not None)
        _require(self._sources(receipts) == self._runtime_binding['source_receipt_digests'])
        self._database_observation(receipts)
        op = deepcopy(self._runtime_operations[key])
        _require(digest(op) == self._runtime_binding['operation_digests'][key])
        return op

    def _database_observation(self, receipts):
        """A prepared policy is not permission to dispatch before DB proof.

        Reconcile may prove current database state without claiming a CREATE ACK
        or ownership. This observation is never used as a DB/role deletion proof.
        The trusted journal freezes terminal receipts across process restarts;
        the local digest also rejects a changed receipt in this resolver instance.
        """
        r = receipts.get('trialDatabaseBootstrap', {})
        _require(r.get('operation_id') == 'trialDatabaseBootstrap' and r.get('state') == 'succeeded' and
                 r.get('terminal') is True and r.get('readback_verified') is True and
                 re.fullmatch(HEX, r.get('request_digest', '')) is not None)
        p = r.get('properties', {})
        environment = {'DEPLOYMENT_KIND': 'trial', **self._runtime_binding['policy_environment']}
        policy = json.loads(environment['TRIAL_POLICY_JSON'])
        baseline = p.get('database_baseline_bytes')
        _require(p.get('observation_only') is True and p.get('cleanup_ownership_proof') is False and
            p.get('final_policy_environment_sha256') == digest(environment) and
            type(baseline) is int and baseline >= 0 and type(policy['cost']['databaseBaselineBytes']) is int and
            baseline == policy['cost']['databaseBaselineBytes'] and
            p.get('code_sha') == policy['codeSha'] == self._resource_bindings['code_sha'] and
            p.get('database_binding_sha256') == digest({name: policy['database'][name] for name in
                ('host', 'database', 'ownerRole', 'migratorUser', 'webUser', 'workerUser')}))
        fingerprint = digest(r)
        _require(self._database_observation_digest is None or self._database_observation_digest == fingerprint)
        self._database_observation_digest = fingerprint

    def _auth(self, key, receipts):
        for runtime_id in RUNTIME_IDS:
            _final(self._runtime(runtime_id, receipts), receipts.get(runtime_id))
        e4 = core.materialize_operation(self._core, 'E4', receipts)
        _final(e4, receipts.get('E4'))
        generated = build_auth_operations(self._auth_binding, receipts, self._auth_deadline, 'appRuntime')
        _require(tuple(op['id'] for op in generated) == AUTH_IDS)
        return next(op for op in generated if op['id'] == key)

    def bind_rehearsal(self, event, receipts):
        """Bind only an authenticated normalized result from the fixed adapter.

        The CLI never accepts operation JSON. Its rehearsal adapter registers
        generated operations and their one-send receipts in the same journal;
        this method independently binds the final proof to those journal facts.
        """
        self._unchanged()
        try:
            _require(set(event) == {'initial_plan_digest', 'operation', 'receipt'} and
                     event['initial_plan_digest'] == self.plan_digest)
            op, proof = event['operation'], event['receipt']
            guard = self._resources['guard']
            created = _final(guard, receipts.get('guard'))
            _require(set(op) == set(guard) and op['id'] == 'guardRehearsal' and
                op['provider'] == 'Microsoft.App' and op['kind'] == 'guardRehearsal' and
                op['method'] == 'GET' and op['body'] is None and
                op['depends_on'] == ['guardRehearsalStart', 'guardRehearsalSeed'] and
                op['cleanup'] == {'journal_retained': True, 'live_delete_verified': False})
            expected = op['expected']
            _require(set(expected) == {'resource_id', 'start_request_digest', 'seed_request_digest',
                                      'runtime_digest', 'body_sha256'} and expected['body_sha256'] == digest(None))
            execution = expected['resource_id']
            _require(re.fullmatch(re.escape(guard['expected']['resource_id']) + r'/executions/[A-Za-z0-9][A-Za-z0-9_-]{0,127}', execution) is not None and
                op['url'] == 'https://management.azure.com' + execution + '?api-version=2025-07-01' and
                parse(op['deadline']) == parse(guard['cleanup']['deadline']))
            _final(op, proof)
            _require(receipts.get('guardRehearsal') == proof)
            for ident, digest_key in (('guardRehearsalStart', 'start_request_digest'), ('guardRehearsalSeed', 'seed_request_digest')):
                prior = receipts.get(ident, {})
                _require(prior.get('operation_id') == ident and prior.get('request_digest') == expected[digest_key]
                    and re.fullmatch(HEX, expected[digest_key]) is not None and prior.get('state') == 'succeeded'
                    and all(prior.get(k) is True for k in ('terminal', 'write_terminal', 'readback_verified', 'created_by_run')))
            start, seed = receipts['guardRehearsalStart'], receipts['guardRehearsalSeed']
            runtime = seed['properties']['runtime']
            journal = 'https://' + self._manifest['existing']['storage'].rsplit('/', 1)[1] + '.blob.core.windows.net/' + self._manifest['names']['journal'] + '/rehearsal.json'
            _require(start['object_id'] == execution and seed['object_id'] == journal and
                expected['runtime_digest'] == digest(runtime) and runtime['execution_id'] == execution and
                runtime['principal_id'] == created['properties']['principalId'] and
                runtime['image_digest'] == guard['body']['properties']['template']['containers'][0]['image'].split('@')[1])
            p = proof['properties']
            _require(p['job_resource_id'] == guard['expected']['resource_id'] and
                all(p.get(k) is True for k in ('rehearsal_reads_verified', 'cleanup_verified', 'lease_released_verified', 'journal_retained')) and
                p.get('live_delete_verified') is False and p['execution_status'] == 'Succeeded' and
                p['start_request_digest'] == expected['start_request_digest'] and p['seed_request_digest'] == expected['seed_request_digest'] and
                all(re.fullmatch(HEX, p[k]) is not None for k in ('journal_state_digest', 'journal_etag_digest')) and
                p['job_started_at'] == runtime['job_started_at'] and
                0 < (parse(p['job_ended_at']) - parse(p['job_started_at'])).total_seconds() <= 300 and
                (parse(runtime['job_deadline']) - parse(runtime['job_started_at'])).total_seconds() == 300)
            _require(self._rehearsal_binding is None or self._rehearsal_binding == event)
            self._rehearsal_binding = deepcopy(event)
        except (KeyError, TypeError, ValueError, RecursionError):
            raise Denied('rehearsal_binding') from None

    def _rehearsal(self, key, receipts):
        _require(self._rehearsal_binding is not None)
        self.bind_rehearsal(self._rehearsal_binding, receipts)
        if key == 'guardRehearsal':
            return deepcopy(self._rehearsal_binding['operation'])
        return build_guard_main_operation(self._resources['guard'], receipts['guard'],
            self._rehearsal_binding['operation'], self._rehearsal_binding['receipt'],
            deadline=self._resources['guard']['cleanup']['deadline'])

    def resolve(self, operation_id, receipts):
        self._unchanged()
        _require(isinstance(operation_id, str) and operation_id in self.allowed_ids and isinstance(receipts, dict))
        try:
            if operation_id in self._resources:
                op = deepcopy(self._resources[operation_id])
            elif operation_id in self._core['operations']:
                if operation_id == 'E4':
                    for key in RUNTIME_IDS:
                        _final(self._runtime(key, receipts), receipts.get(key))
                op = core.materialize_operation(self._core, operation_id, receipts)
            elif operation_id in RUNTIME_IDS:
                op = self._runtime(operation_id, receipts)
            elif operation_id in AUTH_IDS:
                op = self._auth(operation_id, receipts)
            elif operation_id in ('guardRehearsal', 'guardMainConfiguration'):
                op = self._rehearsal(operation_id, receipts)
            else:
                op = self._cleanup(operation_id, receipts)
            _require(op['id'] == operation_id)
            fingerprint = digest(op)
            if operation_id in self._resolved:
                _require(self._resolved[operation_id] == fingerprint)
            if operation_id in receipts:
                _require(receipts[operation_id].get('request_digest') == fingerprint)
            self._resolved[operation_id] = fingerprint
            return deepcopy(op)
        except (KeyError, TypeError, ValueError, StopIteration, RecursionError):
            raise Denied('operation_resolution') from None

    def bind_cleanup(self, operation_id, event):
        """Bind controller-authenticated cleanup evidence, never arbitrary ops.

        Its exact schema/deadline is checked by the fixed cleanup builder at
        resolution. The initial immutable source/operation plan is untouched.
        """
        _require(operation_id in self._cleanup_sources and isinstance(event, dict))
        _require(set(event) == {'initial_plan_digest', 'deadline', 'reference_evidence'})
        _require(event['initial_plan_digest'] == self.plan_digest)
        source = self._cleanup_sources[operation_id]
        original = self._resources.get(source) or self._core['operations'].get(source)
        due = original['cleanup'].get('deadline', original['deadline']) if original else self._core['operations']['E1']['cleanup']['deadline']
        _require(parse(event['deadline']) == parse(due))
        _require(isinstance(event['reference_evidence'], dict))
        _require(operation_id not in self._cleanup_bindings or self._cleanup_bindings[operation_id] == event)
        self._cleanup_bindings[operation_id] = deepcopy(event)

    def _resource_chain(self, source, receipts):
        creation = self.resolve(source, receipts)
        _final(creation, receipts.get(source))
        chain = [creation]
        slots = {'app': ('appRuntime', 'auth-platform-secret', 'auth-ingress',
                         'cleanup_auth_ingress', 'cleanup_auth_platform_secret'),
                 'job': ('jobRuntime',), 'guard': ('guardMainConfiguration',)}.get(source, ())
        # A known update attempt, even if its ACK is unknown, prevents deletion
        # using stale pre-update settings. There is no GET adoption of ownership.
        for slot in slots:
            if slot not in receipts:
                continue
            op = self.resolve(slot, receipts)
            _final(op, receipts[slot])
            _require(op['method'] == 'PATCH' and op['url'] == creation['url'] and
                op['expected']['resource_id'] == creation['expected']['resource_id'] and
                op['expected']['update_from'] == {'operation_id': chain[-1]['id'],
                                                  'request_digest': digest(chain[-1])})
            chain.append(op)
        return chain

    def cleanup_creation_id(self, operation_id, receipts):
        """Return the exact latest state whose receipt the controller must use."""
        _require(operation_id in self._cleanup_sources)
        source = self._cleanup_sources[operation_id]
        return self._resource_chain(source, receipts)[-1]['id'] if source in self._resources else source

    def cleanup_reference_evidence(self, operation_id):
        _require(operation_id in self._cleanup_bindings)
        return deepcopy(self._cleanup_bindings[operation_id]['reference_evidence'])

    def _cleanup(self, operation_id, receipts):
        # Imports are intentionally fixed; no caller-supplied URL, callback or
        # operation document can replace these reviewed lifecycle builders.
        from scripts.trial_provision.plan import build_arm_cleanup
        from scripts.trial_provision.resources import build_resource_cleanup
        from scripts.trial_provision.auth import build_auth_cleanup
        event = self._cleanup_bindings.get(operation_id)
        _require(event is not None)
        source = self._cleanup_sources[operation_id]
        creation = self.resolve(source, receipts)
        receipt = _final(creation, receipts.get(source))
        _require(parse(event['deadline']) == parse(creation['cleanup'].get('deadline', creation['deadline'])))
        if source in self._resources:
            op = build_resource_cleanup(creation, receipt, deadline=event['deadline'])
            chain = self._resource_chain(source, receipts)
            if len(chain) > 1:
                combined = {}
                for mutation in chain:
                    _merge_state(combined, _observable_state(mutation['body']))
                op['expected']['properties'] = combined
                op['expected']['receipt_properties'] = chain[-1]['expected'].get('receipt_properties', [])
                op['depends_on'] = [item['id'] for item in chain]
                op['expected'].pop('secret_bindings', None)
        elif creation['provider'] == 'Microsoft.Authorization':
            op = build_arm_cleanup(creation, receipt, event['deadline'])
        else:
            op = build_auth_cleanup(creation, receipt, self._auth_binding, event['deadline'], event['reference_evidence'])
        # All approved builders converge on one public-safe slot name.
        op['id'] = operation_id
        return op


def create_resolver(core_plan, manifest, authority_bundle, resource_bindings):
    return ApprovedOperations(core_plan, manifest, authority_bundle, resource_bindings)
