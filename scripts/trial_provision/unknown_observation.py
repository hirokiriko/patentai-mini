"""One separately authorized current-state GET after a stopped V6 UNKNOWN.

This does not reconcile the old write, issue a trial, adopt or delete a resource.
The fixed marker survives every failure, including a crash before the first
debit. A new grant, clock window or output path cannot authorize a second GET.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re

from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied
from .attempt import _journal, _json
from .private_io import create_owner_file, verify_owner_file, verify_owner_directory
from .providers import RESOURCE

KIND = 'STOPPED_V6_UNKNOWN_IDENTITY_READ_ONCE'
MARKER = 'trial-v6-unknown-identity-observation.json'
RESULT = 'trial-v6-unknown-identity-observation-result.json'
_KEY = object()
GUID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')


def need(value, reason='unknown_observation_binding'):
    if not value:
        raise Denied(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def timestamp(value):
    need(type(value) is str)
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        need(result.utcoffset() is not None)
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise Denied('unknown_observation_time') from None


class ObservationGrant:
    __slots__ = ('__proof', '__digest')

    def __init__(self, proof, checksum, key):
        need(key is _KEY)
        object.__setattr__(self, '_ObservationGrant__proof', deepcopy(proof))
        object.__setattr__(self, '_ObservationGrant__digest', checksum)

    def __setattr__(self, *_):
        raise Denied('unknown_observation_immutable')

    @property
    def checksum(self):
        return self.__digest

    @property
    def proof(self):
        return deepcopy(self.__proof)


def verify_grant(raw, *, trusted_sha256, evidence, source_digests, now):
    """Pure verifier. The trusted hash is supplied by the OWNER local issuer.

    Evidence is already read through OWNER-only file validation. No credentials,
    locks, ledger append or network operation occur here.
    """
    need(type(raw) is bytes and sha(raw) == trusted_sha256)
    g = _json(raw)
    need(type(g) is dict and set(g) == {'schema', 'kind', 'start', 'end', 'owner',
        'target', 'source_digests', 'evidence_sha256', 'counter_binding', 'seed',
        'directory', 'child_binding', 'attempt', 'counter_rows', 'counts', 'maximum'})
    need(type(g['schema']) is int and g['schema'] == 1 and g['kind'] == KIND)
    start, end = timestamp(g['start']), timestamp(g['end'])
    need(0 < (end-start).total_seconds() <= 600 and start <= now < end,
         'unknown_observation_window')
    need(g['maximum'] == {'http': 1, 'owner_token': 1}
        and all(type(v) is int for v in g['maximum'].values())
        and type(g['counter_rows']) is int and g['counter_rows'] == 197
        and all(type(v) is int for v in g['counts'].values())
        and g['counts'] == {'owner_arm': 316, 'owner_control_blob': 32, 'heartbeat_blob': 0})
    need(type(g['source_digests']) is dict and g['source_digests'] == source_digests
        and bool(source_digests), 'unknown_observation_source')
    need(set(evidence) == {'counter', 'child', 'stopped', 'authority', 'manifest'})
    need(g['evidence_sha256'] == {k: sha(v) for k, v in evidence.items()})
    authority, stopped = _json(evidence['authority']), _json(evidence['stopped'])
    need(authority['schema'] == 6 and stopped['status'] == 'STOPPED_UNKNOWN_MANAGED_IDENTITY_ACK_V6')
    manifest = _json(evidence['manifest'])
    need(authority['manifest_sha256'] == sha(evidence['manifest'])
        and g['owner'] == manifest['owner'] and g['owner']['principal_id'] == authority['owner_id'])
    need(all(type(v) is str and GUID.fullmatch(v) for v in g['owner'].values()))
    need(stopped['authority']['sha256'] == sha(evidence['authority'])
        and stopped['counter']['sha256'] == sha(evidence['counter'])
        and stopped['child']['sha256'] == sha(evidence['child'])
        and stopped['counts'] == g['counts'] and stopped['counter_rows'] == 197
        and stopped['child_rows'] == 34 and stopped['historical_unknowns_preserved'] is True
        and stopped['unknown_receipt_promoted'] is False)
    child, tail = _journal(evidence['child'], g['child_binding'])
    need(len(child) == 34 and tail == stopped['child_tail'])
    intents = [r['value'] for r in child if r['event'] == 'intent']
    progress = [r['value'] for r in child if r['event'] == 'progress']
    need(len(intents) == len(progress) == 1)
    intent, receipt = intents[0], progress[0]
    need(receipt == stopped['unknown_receipt'] and [intent] == stopped['new_write_intents'])
    need(intent['operation_id'] == receipt['operation_id'] == 'webIdentity'
        and intent['method'] == 'PUT' and receipt['state'] == 'unknown'
        and receipt['http'] == 201 and receipt['ack_rejection'] == 'unsupported_lro_headers'
        and all(receipt.get(k) is False for k in ('terminal', 'write_terminal', 'readback_verified'))
        and not receipt.get('operation_url') and intent['request_digest'] == receipt['request_digest'])
    rid = receipt['object_id']
    need(type(rid) is str and re.fullmatch(RESOURCE['userAssignedIdentities'], rid))
    need(manifest['ids']['webIdentity'] == rid)
    url = 'https://management.azure.com' + rid + '?api-version=2023-01-31'
    need(g['target'] == {'resource_id': rid, 'url': url, 'request_digest': intent['request_digest']}
        and intent['url'] == url)
    from .journal import replay_control_budget
    state = replay_control_budget(evidence['counter'], binding=g['counter_binding'],
        seed=g['seed'], directory=g['directory'])
    need(state['counts'] == g['counts'] and state['rows'] == 197
        and len(state['transitions']) == 5 and state['plan']['attempt'] == g['attempt']
        and state['plan']['limits']['owner_arm'] == 631
        and state['plan']['phase_caps']['owner_arm']['cleanup'] == 120)
    for purpose in ('owner_token', 'http'):
        need(state['plan']['purpose_caps']['provision'][purpose]
            - state['purpose_used']['owner_arm']['provision'][purpose] >= 1)
    need(state['plan']['phase_caps']['owner_arm']['provision']
        - state['used']['owner_arm']['provision'] >= 2)
    return ObservationGrant(g, trusted_sha256, _KEY)


def validate_counter(grant, raw, *, consumed):
    """Exact old prefix plus only this observation's ordered durable debits."""
    need(type(grant) is ObservationGrant and consumed in ([], ['owner_token'], ['owner_token', 'http']))
    g = grant.proof
    lines = raw.splitlines(keepends=True)
    need(len(lines) == g['counter_rows'] + len(consumed)
        and sha(b''.join(lines[:g['counter_rows']])) == g['evidence_sha256']['counter'],
        'unknown_observation_counter_changed')
    rows, _ = _journal(raw, {'binding': g['counter_binding'], 'limits':
        {'owner_arm': 600, 'owner_control_blob': 3000, 'heartbeat_blob': 5250}, 'seed': g['seed']})
    for row, purpose in zip(rows[g['counter_rows']:], consumed):
        need(row['event'] == 'request' and row['value'] == {'kind': 'owner_arm',
            'attempt': g['attempt'], 'phase': 'provision', 'purpose': purpose},
            'unknown_observation_counter_changed')


def _save(path, value):
    # Exclusive creation happens before any network or debit. An empty or
    # partially written file is intentionally never treated as a fresh run.
    fd = create_owner_file(path)
    with os.fdopen(fd, 'wb') as stream:
        raw = encoded(value) + b'\n'
        need(stream.write(raw) == len(raw))
        stream.flush(); os.fsync(stream.fileno())
    verify_owner_file(path)
    need(path.read_bytes() == raw)


def classify(response, grant):
    """Allowlisted current-state metadata only; never persist a raw response."""
    result = {'status': 'unconfirmed', 'http': None, 'old_unknown_preserved': True,
              'adoption_authorized': False, 'deletion_authorized': False}
    need(type(response) is dict and type(response.get('status')) is int)
    status = response['status']; result['http'] = status
    headers = response.get('headers')
    need(type(headers) is dict and not {'location', 'azure-asyncoperation', 'operation-location'}
         .intersection(k.lower() for k in headers))
    if status == 404:
        body = _json(response['body'])
        need(set(body) == {'error'} and type(body['error']) is dict
            and body['error'].get('code') == 'ResourceNotFound')
        result['status'] = 'current_absent'
    elif status == 200:
        body = _json(response['body']); target = grant.proof['target']['resource_id']
        need(type(body) is dict and 'error' not in body and type(body.get('id')) is str
            and body['id'].isascii() and body['id'].lower() == target.lower()
            and str(body.get('type', '')).lower() == 'microsoft.managedidentity/userassignedidentities'
            and body.get('name') == target.rsplit('/', 1)[-1] and type(body.get('properties')) is dict)
        properties = body['properties']; ids = {k: properties.get(k) for k in ('principalId', 'tenantId', 'clientId')}
        need('error' not in properties and all(holder.get('provisioningState', 'Succeeded') == 'Succeeded'
            and holder.get('status', 'Succeeded') == 'Succeeded' for holder in (body, properties)))
        need(all(type(v) is str and GUID.fullmatch(v) for v in ids.values())
            and ids['tenantId'].lower() == grant.proof['owner']['tenant_id'].lower())
        result.update(status='current_exists', identity={k: v.lower() for k, v in ids.items()},
            identity_digest=digest({k: v.lower() for k, v in ids.items()}), body_sha256=sha(response['body']))
    return result


def observe_once(grant, *, clock, credential, wire, current_sources):
    """One fixed GET, one token read, new grant window, canonical old accounting.

    The token stays in process memory. Historical child bytes stay untouched.
    Tests inject a fake credential/wire; the production issuer pins both sources.
    """
    from .journal import ControlBudget, Journal
    need(type(grant) is ObservationGrant)
    g = grant.proof; directory = Path(g['directory'])
    verify_owner_directory(directory)
    need(credential.mode == 'owner' and credential.principal == g['owner']['principal_id'].lower()
        and credential.tenant == g['owner']['tenant_id'].lower())
    wall, mono = clock.utc(), clock.monotonic()
    deadline = Deadline(min(60, (timestamp(g['end'])-wall).total_seconds()), clock.monotonic)
    last = [wall, mono]
    def guard():
        now, tick = clock.utc(), clock.monotonic()
        need(timestamp(g['start']) <= now < timestamp(g['end']) and now >= last[0]
            and tick >= last[1] and abs((now-wall).total_seconds()-(tick-mono)) < 5,
            'unknown_observation_window')
        need(current_sources() == g['source_digests'], 'unknown_observation_source')
        last[:] = [now, tick]; deadline.remaining()
    guard()
    with ControlBudget(directory, digest(str(directory)), g['counter_binding'], seed=g['seed'],
                       require_existing=True) as budget:
        with Journal(directory, digest(str(directory)), g['child_binding'],
                     name='trial-provision-successor-v6', require_existing=True) as child:
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            validate_counter(grant, budget.journal.path.read_bytes(), consumed=[])
            need(not os.path.lexists(directory / RESULT), 'unknown_observation_already_attempted')
            _save(directory / MARKER, {'schema': 1, 'kind': KIND, 'grant_sha256': grant.checksum,
                'target_digest': digest(g['target']), 'old_attempt': g['attempt'],
                'counter_prefix_sha256': g['evidence_sha256']['counter'], 'at': clock.utc().isoformat()})
            scope = budget.begin_unknown_observation(grant, guard=guard)
            result = {'status': 'unconfirmed', 'http': None, 'old_unknown_preserved': True,
                'adoption_authorized': False, 'deletion_authorized': False}
            token = None
            try:
                guard(); scope.consume_owner_token(); guard()
                token = credential.token('https://management.azure.com/', deadline)
                guard(); scope.consume('owner_arm', 600); guard()
                response = wire('GET', g['target']['url'], {'Authorization': 'Bearer ' + token}, None, deadline)
                guard(); result = classify(response, grant)
            except Exception as error:
                result['error_class'] = type(error).__name__
            finally:
                token = None
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            raw = budget.journal.path.read_bytes()
            consumed = ['owner_token', 'http'][:len(raw.splitlines())-g['counter_rows']]
            validate_counter(grant, raw, consumed=consumed)
            result.update(schema=1, kind=KIND, grant_sha256=grant.checksum,
                observed_at=clock.utc().isoformat(), target_digest=digest(g['target']),
                counter_sha256=sha(raw), counter_rows=len(raw.splitlines()), counts=budget.counts(),
                counter_tail=budget.journal.previous, evidence_sha256=g['evidence_sha256'],
                source_digests=g['source_digests'], requests=len(consumed), automatic_retry=False)
            _save(directory / RESULT, result)
            return result
