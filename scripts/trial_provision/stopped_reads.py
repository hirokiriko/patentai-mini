"""One diagnostic batch for the stopped partial foundation, never a restart.

Exactly one token acquisition and four fixed first-page GETs are permitted.
The old child is locked and unchanged, and each debit uses its existing plan.
No pagination, mutation, retry, cleanup proof or UNKNOWN promotion is possible.
"""
from copy import deepcopy
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path

from scripts.trial_guard.adapters import Deadline, digest
from scripts.trial_guard.lifecycle import Denied
from .attempt import _journal, _json
from .unknown_observation import _save, timestamp
from .private_io import verify_owner_directory, verify_owner_file
from .read_observation import COLLECTIONS, summary, response_value, job_absence, count_collection
from .read_http import ReadFailure

KIND = 'STOPPED_PARTIAL_FOUNDATION_READ_ONCE'
MARKER = 'trial-v8-stopped-read-intent.json'
RESULT = 'trial-v8-stopped-read-result.json'
CHILD = 'trial-provision-successor-v8'
SLOTS = ('webIdentity', 'workerIdentity', 'originals', 'artifacts', 'budget', 'journal') + tuple('C' + str(i) for i in range(1, 8))
_KEY = object()


def need(value):
    if not value: raise Denied('stopped_read_binding')


def sha(value): return hashlib.sha256(value).hexdigest()


class ReadGrant:
    __slots__ = ('__proof', '__checksum')
    def __init__(self, proof, checksum, key):
        need(key is _KEY)
        object.__setattr__(self, '_ReadGrant__proof', deepcopy(proof))
        object.__setattr__(self, '_ReadGrant__checksum', checksum)
    def __setattr__(self, *_): raise Denied('stopped_read_immutable')
    @property
    def proof(self): return deepcopy(self.__proof)
    @property
    def checksum(self): return self.__checksum


def verify_grant(raw, *, trusted_sha256, evidence, source_digests, now):
    need(type(raw) is bytes and sha(raw) == trusted_sha256)
    g = _json(raw)
    need(set(g) == {'schema', 'kind', 'start', 'end', 'owner', 'targets', 'source_digests',
        'evidence_sha256', 'counter_binding', 'seed', 'directory', 'child_binding', 'attempt',
        'counter_rows', 'counts', 'maximum', 'direct_request_sha256'})
    need(g['schema'] == 1 and g['kind'] == KIND and g['maximum'] == {'http': 4, 'owner_token': 1})
    start, end = timestamp(g['start']), timestamp(g['end'])
    need(start <= now < end and timedelta(0) < end - start <= timedelta(minutes=10))
    need(g['source_digests'] == source_digests and bool(source_digests))
    need(set(evidence) == {'counter', 'child', 'authority', 'manifest', 'stop_guard', 'stop_cleanup', 'direct_request'})
    need(g['evidence_sha256'] == {k: sha(v) for k, v in evidence.items()}
         and g['direct_request_sha256'] == sha(evidence['direct_request']))
    manifest, authority = _json(evidence['manifest']), _json(evidence['authority'])
    need(authority['schema'] == 9 and authority['manifest_sha256'] == sha(evidence['manifest'])
         and g['owner'] == manifest['owner'] and g['owner']['principal_id'] == authority['owner_id'])
    stopped = _json(evidence['stop_cleanup']); guard_stop = _json(evidence['stop_guard'])
    need(stopped['status'] == 'STOPPED_V8_CLEANUP_REFERENCE_LIST_UNCONFIRMED'
         and guard_stop['status'] == 'STOPPED_V8_GUARD_ABSENCE_UNCONFIRMED'
         and stopped['authority_sha256'] == guard_stop['authority_sha256'] == sha(evidence['authority'])
         and stopped['delete_sent'] is False and stopped['cleanup_binding_written'] is False
         and guard_stop['guard_new_mutation_sent'] is False and stopped['old_unknown_reservations_retained'] is True
         and stopped['all_token_pools_closed'] is True)
    need(g['counts'] == stopped['counts'] == {'owner_arm': 377, 'owner_control_blob': 32, 'heartbeat_blob': 0}
         and g['counter_rows'] == stopped['counter']['rows'] == 261
         and stopped['counter']['sha256'] == sha(evidence['counter'])
         and stopped['child']['sha256'] == sha(evidence['child']) and stopped['child']['rows'] == 87)
    rows, _ = _journal(evidence['child'], g['child_binding']); need(len(rows) == 87)
    plans = [r['value'] for r in rows if r['event'] == 'plan']; need(len(plans) == 1)
    operations = plans[0]['operations']; need(type(operations) is dict)
    cores = [r['value'] for r in rows if r['event'] == 'core_plan']; need(len(cores) == 1)
    intents = [r['value'] for r in rows if r['event'] == 'intent']
    progress = [r['value'] for r in rows if r['event'] == 'progress']
    need(len(intents) == 13 and {v['operation_id'] for v in intents} == set(SLOTS) and len(progress) == 26)
    need(not any(r['event'] == 'cleanup_binding' for r in rows))
    from .operations import _final
    from .plan import materialize_operation
    final_receipts = {v['operation_id']: v for v in progress}
    for ident in SLOTS:
        op = materialize_operation(cores[0], ident, final_receipts) if ident.startswith('C') else operations[ident]
        intent = next(v for v in intents if v['operation_id'] == ident)
        receipts = [v for v in progress if v['operation_id'] == ident]
        need(intent['request_digest'] == digest(op) and intent['url'] == op['url']
             and intent['method'] == 'PUT' and len(receipts) == 2 and receipts[0]['state'] == 'pending')
        _final(op, receipts[-1])
    scope = manifest['resourceGroupId'].split('/resourceGroups/', 1)[0]
    targets = [{'slot': 'guard', 'url': operations['guard']['url'], 'resource_id': manifest['ids']['guard']}]
    for collection, version in COLLECTIONS:
        targets.append({'slot': collection, 'url': 'https://management.azure.com' + scope +
            '/providers/Microsoft.Authorization/' + collection + '?api-version=' + version,
            'role_id': materialize_operation(cores[0], 'C1', final_receipts)['expected']['resource_id']})
    binding = g['child_binding']
    need(g['targets'] == targets and binding['attempt']['binding_digest'] == g['attempt']
         and binding['attempt']['authority_sha256'] == sha(evidence['authority'])
         and binding['attempt']['id'] == authority['attempt_id']
         and binding['manifest_sha256'] == authority['manifest_sha256']
         and binding['owner_id'] == authority['owner_id'] and binding['task_id'] == authority['task_id'])
    from .journal import replay_control_budget
    state = replay_control_budget(evidence['counter'], binding=g['counter_binding'], seed=g['seed'], directory=g['directory'])
    need(state['counts'] == g['counts'] and state['rows'] == 261 and len(state['transitions']) == 8
         and state['plan']['attempt'] == g['attempt'] and state['plan']['limits']['owner_arm'] == 631
         and state['plan']['phase_caps']['owner_arm']['cleanup'] - state['used']['owner_arm']['cleanup'] == 117)
    need(state['plan']['phase_caps']['owner_arm']['provision'] - state['used']['owner_arm']['provision'] >= 5)
    for purpose, number in (('owner_token', 1), ('http', 4)):
        need(state['plan']['purpose_caps']['provision'][purpose] - state['purpose_used']['owner_arm']['provision'][purpose] >= number)
    return ReadGrant(g, trusted_sha256, _KEY)


def validate_counter(grant, raw, consumed):
    need(type(grant) is ReadGrant and type(consumed) is list and len(consumed) <= 5
         and consumed == (['owner_token'] + ['http'] * 4)[:len(consumed)])
    g = grant.proof; lines = raw.splitlines(keepends=True)
    need(len(lines) == g['counter_rows'] + len(consumed)
         and sha(b''.join(lines[:g['counter_rows']])) == g['evidence_sha256']['counter'])
    rows, _ = _journal(raw, {'binding': g['counter_binding'], 'seed': g['seed'],
        'limits': {'owner_arm': 600, 'owner_control_blob': 3000, 'heartbeat_blob': 5250}})
    for row, purpose in zip(rows[g['counter_rows']:], consumed):
        need(row['event'] == 'request' and row['value'] == {'kind': 'owner_arm', 'attempt': g['attempt'],
            'phase': 'provision', 'purpose': purpose})


def observe_once(grant, *, clock, credential, wire, current_sources):
    from .journal import ControlBudget, Journal
    need(type(grant) is ReadGrant)
    g = grant.proof; directory = Path(g['directory']); verify_owner_directory(directory)
    need(credential.mode == 'owner' and credential.principal == g['owner']['principal_id'].lower()
         and credential.tenant == g['owner']['tenant_id'].lower())
    wall, mono = clock.utc(), clock.monotonic(); last = [wall, mono]
    def guard():
        now, tick = clock.utc(), clock.monotonic()
        need(timestamp(g['start']) <= now < timestamp(g['end']) and now >= last[0] and tick >= last[1]
             and abs((now-wall).total_seconds()-(tick-mono)) < 5 and current_sources() == g['source_digests'])
        last[:] = [now, tick]
    def deadline():
        guard()
        return Deadline(min(30, (timestamp(g['end'])-clock.utc()).total_seconds()), clock.monotonic)
    guard()
    with ControlBudget(directory, digest(str(directory)), g['counter_binding'], seed=g['seed'], require_existing=True) as budget:
        with Journal(directory, digest(str(directory)), g['child_binding'], name=CHILD, require_existing=True) as child:
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            validate_counter(grant, budget.journal.path.read_bytes(), [])
            need(not os.path.lexists(directory / RESULT))
            _save(directory / MARKER, {'kind': KIND, 'grant_sha256': grant.checksum, 'attempt': g['attempt'],
                'counter_prefix_sha256': g['evidence_sha256']['counter'], 'targets_sha256': digest(g['targets'])})
            scope = budget.begin_stopped_reads(grant, guard=guard)
            observations, token = [], None
            try:
                guard(); scope.consume_owner_token(); guard()
                token = credential.token('https://management.azure.com/', deadline())
                for target in g['targets']:
                    guard(); scope.consume('owner_arm', 600); guard()
                    record = {'slot': target['slot'], 'validation': 'unverified'}
                    try:
                        reply = wire('GET', target['url'], {'Authorization': 'Bearer ' + token}, None, deadline())
                        guard(); record.update(summary(reply))
                        if target['slot'] == 'guard':
                            record['validation'] = 'absent_verified' if job_absence(reply, target['resource_id']) else 'http_200_unverified' if reply['status'] == 200 else 'unverified'
                        else:
                            # First-page diagnostics deliberately never become a deletion proof.
                            value = response_value(reply)
                            if reply['status'] == 200 and type(value) is dict and 'error' not in value and type(value.get('value')) is list:
                                record.update(validation='first_page_only', items=len(value['value']), next_link=value.get('nextLink') not in (None, ''))
                    except ReadFailure as error:
                        record.update(error.observation)
                    except Exception:
                        pass
                    observations.append(record)
            except Exception:
                observations.append({'slot': 'batch', 'validation': 'stopped'})
            finally:
                token = None
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            raw = budget.journal.path.read_bytes()
            consumed = (['owner_token'] + ['http'] * 4)[:len(raw.splitlines()) - g['counter_rows']]
            validate_counter(grant, raw, consumed)
            result = {'schema': 1, 'kind': KIND, 'grant_sha256': grant.checksum, 'observed_at': clock.utc().isoformat(),
                'observations': observations, 'requests': len(consumed), 'counts': budget.counts(),
                'counter_sha256': sha(raw), 'counter_rows': len(raw.splitlines()), 'child_sha256': g['evidence_sha256']['child'],
                'old_unknown_preserved': True, 'adoption_authorized': False, 'deletion_authorized': False,
                'restart_authorized': False, 'automatic_retry': False}
            _save(directory / RESULT, result)
            return result
