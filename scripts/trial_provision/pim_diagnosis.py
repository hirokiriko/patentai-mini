"""One separately authorized PIM diagnostic; no retry or restart capability.

The preceding diagnostic remains sealed. This grant spends one fresh-read
token and two fixed GETs from the current plan, never the cleanup reserve.
Raw failure bodies stay in memory or an OWNER-only Windows DPAPI envelope;
only finite classifications and bounded hashes leave this module.
"""
from copy import deepcopy
from datetime import timedelta
import base64
import ctypes
import json
import os
from pathlib import Path
import re

from scripts.trial_guard.adapters import Deadline, digest
from scripts.trial_guard.lifecycle import Denied
from .attempt import _json, _journal
from . import stopped_reads as prior
from .private_io import verify_owner_directory
from .read_observation import summary, response_value
from .read_http import ReadFailure
from .unknown_observation import _save, timestamp

KIND = 'STOPPED_PIM_CAUSE_READ_ONCE_V1'
MARKER = 'trial-v8-pim-diagnosis-intent.json'
RESULT = 'trial-v8-pim-diagnosis-result.json'
CHILD = prior.CHILD
PHASE = 'fresh_read'
SEQUENCE = ('owner_token', 'http', 'http')
_KEY = object()
sha = prior.sha


def need(value):
    if not value: raise Denied('pim_diagnosis_binding')


class PimGrant:
    __slots__ = ('__proof', '__checksum')
    def __init__(self, proof, checksum, key):
        need(key is _KEY)
        object.__setattr__(self, '_PimGrant__proof', deepcopy(proof))
        object.__setattr__(self, '_PimGrant__checksum', checksum)
    def __setattr__(self, *_): raise Denied('pim_diagnosis_immutable')
    @property
    def proof(self): return deepcopy(self.__proof)
    @property
    def checksum(self): return self.__checksum


def verify_prior(evidence):
    """Historical verification grants no capability to repeat the old batch."""
    keys = {'counter', 'child', 'authority', 'manifest', 'stop_guard', 'stop_cleanup',
            'prior_grant', 'prior_request', 'prior_result', 'prior_marker', 'direct_request'}
    need(set(evidence) == keys)
    old = _json(evidence['prior_grant'])
    old_evidence = {k: evidence[k] for k in ('child', 'authority', 'manifest', 'stop_guard', 'stop_cleanup')}
    old_evidence['counter'] = b''.join(evidence['counter'].splitlines(keepends=True)[:261])
    old_evidence['direct_request'] = evidence['prior_request']
    verified = prior.verify_grant(evidence['prior_grant'], trusted_sha256=sha(evidence['prior_grant']),
        evidence=old_evidence, source_digests=old['source_digests'], now=timestamp(old['start']))
    prior.validate_counter(verified, evidence['counter'], list(('owner_token',)+('http',)*4))
    result, marker = _json(evidence['prior_result']), _json(evidence['prior_marker'])
    need(result['grant_sha256'] == marker['grant_sha256'] == verified.checksum
         and result['requests'] == 5 and result['counter_rows'] == 266
         and result['counts'] == {'owner_arm': 382, 'owner_control_blob': 32, 'heartbeat_blob': 0}
         and result['counter_sha256'] == sha(evidence['counter'])
         and result['child_sha256'] == sha(evidence['child'])
         and result['old_unknown_preserved'] is True
         and all(result[k] is False for k in ('adoption_authorized', 'deletion_authorized', 'restart_authorized', 'automatic_retry')))
    need(marker['attempt'] == old['attempt'] and marker['targets_sha256'] == digest(old['targets'])
         and marker['counter_prefix_sha256'] == sha(old_evidence['counter']))
    observations = result['observations']
    need(len(observations) == 4 and all(observations[i]['http'] == 400 for i in (2, 3))
         and observations[2]['body_sha256'] == observations[3]['body_sha256'])
    return old, result


def verify_grant(raw, *, trusted_sha256, evidence, source_digests, now):
    need(type(raw) is bytes and sha(raw) == trusted_sha256)
    g = _json(raw)
    need(set(g) == {'schema', 'kind', 'start', 'end', 'owner', 'targets', 'source_digests',
        'evidence_sha256', 'counter_binding', 'seed', 'directory', 'child_binding', 'attempt',
        'counter_rows', 'counts', 'maximum', 'direct_request_sha256', 'phase'})
    need(g['schema'] == 1 and g['kind'] == KIND and g['phase'] == PHASE
         and g['maximum'] == {'http': 2, 'owner_token': 1})
    start, end = timestamp(g['start']), timestamp(g['end'])
    need(start <= now < end and timedelta(0) < end-start <= timedelta(minutes=10))
    need(bool(source_digests) and g['source_digests'] == source_digests
         and g['evidence_sha256'] == {k: sha(v) for k, v in evidence.items()}
         and g['direct_request_sha256'] == sha(evidence['direct_request']))
    old, result = verify_prior(evidence)
    need(g['targets'] == old['targets'][2:] and g['counts'] == result['counts']
         and g['counter_rows'] == result['counter_rows'])
    for key in ('owner', 'counter_binding', 'seed', 'directory', 'child_binding', 'attempt'):
        need(g[key] == old[key])
    from .journal import replay_control_budget
    state = replay_control_budget(evidence['counter'], binding=g['counter_binding'], seed=g['seed'], directory=g['directory'])
    need(state['counts'] == g['counts'] and state['rows'] == 266 and len(state['transitions']) == 8
         and state['plan']['attempt'] == g['attempt'] and state['plan']['limits']['owner_arm'] == 631
         and state['plan']['phase_caps']['owner_arm']['cleanup'] - state['used']['owner_arm']['cleanup'] == 117
         and state['plan']['phase_caps']['owner_arm'][PHASE] - state['used']['owner_arm'][PHASE] >= 3)
    for purpose, number in (('owner_token', 1), ('http', 2)):
        need(state['plan']['purpose_caps'][PHASE][purpose] - state['purpose_used']['owner_arm'][PHASE][purpose] >= number)
    return PimGrant(g, trusted_sha256, _KEY)


def validate_counter(grant, raw, consumed):
    need(type(grant) is PimGrant and type(consumed) is list and len(consumed) <= 3
         and consumed == list(SEQUENCE[:len(consumed)]))
    g = grant.proof; lines = raw.splitlines(keepends=True)
    need(len(lines) == g['counter_rows'] + len(consumed)
         and sha(b''.join(lines[:g['counter_rows']])) == g['evidence_sha256']['counter'])
    rows, _ = _journal(raw, {'binding': g['counter_binding'], 'seed': g['seed'],
        'limits': {'owner_arm': 600, 'owner_control_blob': 3000, 'heartbeat_blob': 5250}})
    for row, purpose in zip(rows[g['counter_rows']:], consumed):
        need(row['event'] == 'request' and row['value'] == {'kind': 'owner_arm', 'attempt': g['attempt'],
            'phase': PHASE, 'purpose': purpose})


def classify(response, owner_id=None):
    """Finite error vocabulary: never expose arbitrary provider text or IDs."""
    out = {'cause': 'unclassified', 'cause_basis': 'none'}
    try:
        value = response_value(response)
        error = value['error']; need(type(error) is dict)
        code, message = error.get('code'), error.get('message')
        need(type(code) is str and type(message) is str and len(code) <= 256 and len(message) <= 32768)
        out['error_code_sha256'] = sha(code.encode('utf-8'))
        known = {
            'InvalidFilter': 'invalid_filter', 'InvalidScope': 'invalid_scope',
            'InvalidResourceType': 'invalid_resource_type',
            'AadPremiumLicenseRequired': 'license_requirement',
            'AzureADP2LicenseRequired': 'license_requirement',
            'AuthorizationFailed': 'permission_denied', 'Authorization_RequestDenied': 'permission_denied',
            'InsufficientPermissions': 'permission_denied',
            'SubscriptionNotRegistered': 'subscription_registration',
            'MissingSubscriptionRegistration': 'provider_registration',
            'InvalidSubscriptionState': 'subscription_state', 'SubscriptionNotFound': 'subscription_not_found',
            'ExpiredAuthenticationToken': 'authentication_expired',
            'InvalidAuthenticationToken': 'authentication_invalid',
        }
        if code in known:
            out.update(cause=known[code], cause_basis='known_code', error_code=code)
            return out
        license_messages = {
            'The tenant needs to have Microsoft Entra ID P2 or Microsoft Entra ID Governance license.',
            'The tenant needs to have Azure AD Premium P2 or EMS E5 license.',
        }
        if message in license_messages:
            out.update(cause='license_requirement', cause_basis='fixed_message_pattern')
        elif (type(owner_id) is str and re.fullmatch(r'[a-fA-F0-9-]{36}', owner_id)
                and message == 'The requestor '+owner_id+' does not have permissions for this request. '
                'Please use $filter=asTarget() to filter on the requestor\'s assignments.'):
            out.update(cause='permission_denied', cause_basis='fixed_owner_message_pattern')
    except Exception:
        pass
    return out


def protect_failure_body(raw, *, decrypt=False):
    """Current Windows user only, no prompt; callers never print the result."""
    need(os.name == 'nt' and type(raw) is bytes and 0 < len(raw) <= 128*1024)
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    def blob(value):
        storage = ctypes.create_string_buffer(value)
        return Blob(len(value), ctypes.cast(storage, ctypes.POINTER(ctypes.c_ubyte))), storage
    source, storage = blob(raw); entropy, entropy_storage = blob(b'issue148-v8r1-pim-cause-v1')
    target = Blob(); dll = ctypes.WinDLL('crypt32', use_last_error=True)
    fn = dll.CryptUnprotectData if decrypt else dll.CryptProtectData
    fn.restype = wintypes.BOOL
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p,
                  ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    need(bool(fn(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(target))))
    try:
        need(0 < target.size <= 128*1024)
        return ctypes.string_at(target.data, target.size)
    finally:
        if decrypt and target.data and target.size:
            ctypes.memset(target.data, 0, target.size)
        free = ctypes.WinDLL('kernel32').LocalFree
        free.argtypes = [ctypes.c_void_p]; free.restype = ctypes.c_void_p
        free(target.data)
        ctypes.memset(storage, 0, len(raw))


def observe_once(grant, *, clock, credential, wire, current_sources, protector=protect_failure_body):
    from .journal import ControlBudget, Journal
    need(type(grant) is PimGrant)
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
        guard(); return Deadline(min(30, (timestamp(g['end'])-clock.utc()).total_seconds()), clock.monotonic)
    guard()
    with ControlBudget(directory, digest(str(directory)), g['counter_binding'], seed=g['seed'], require_existing=True) as budget:
        with Journal(directory, digest(str(directory)), g['child_binding'], name=CHILD, require_existing=True) as child:
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            validate_counter(grant, budget.journal.path.read_bytes(), [])
            need(not os.path.lexists(directory/RESULT))
            for index in range(2): need(not os.path.lexists(directory/f'trial-v8-pim-failure-{index}.dpapi.json'))
            _save(directory/MARKER, {'kind': KIND, 'grant_sha256': grant.checksum, 'attempt': g['attempt'],
                'counter_prefix_sha256': g['evidence_sha256']['counter'], 'targets_sha256': digest(g['targets'])})
            scope = budget.begin_pim_diagnosis(grant, guard=guard)
            observations, token = [], None
            try:
                guard(); scope.consume_owner_token(); guard()
                token = credential.token('https://management.azure.com/', deadline())
                for index, target in enumerate(g['targets']):
                    guard(); scope.consume('owner_arm', 600); guard()
                    record = {'slot': target['slot'], 'validation': 'unverified'}
                    try:
                        reply = wire('GET', target['url'], {'Authorization': 'Bearer '+token}, None, deadline())
                        guard(); record.update(summary(reply)); record.update(classify(reply, g['owner']['principal_id']))
                        if reply['status'] != 200 and type(reply.get('body')) is bytes and 0 < len(reply['body']) <= 65536:
                            protected = protector(reply['body'])
                            need(type(protected) is bytes and 0 < len(protected) <= 128*1024)
                            _save(directory/f'trial-v8-pim-failure-{index}.dpapi.json', {
                                'schema': 1, 'kind': 'CURRENT_WINDOWS_OWNER_DPAPI_FAILURE_BODY',
                                'grant_sha256': grant.checksum, 'slot': target['slot'],
                                'body_sha256': sha(reply['body']), 'ciphertext': base64.b64encode(protected).decode('ascii')})
                            record['encrypted_owner_envelope_saved'] = True
                        if reply['status'] == 200:
                            value = response_value(reply)
                            if type(value) is dict and 'error' not in value and type(value.get('value')) is list:
                                record.update(validation='diagnostic_first_page_only', items=len(value['value']),
                                              next_link=value.get('nextLink') not in (None, ''))
                    except ReadFailure as error:
                        record.update(error.observation)
                    except Exception:
                        record['diagnostic_processing_complete'] = False
                    observations.append(record)
                    # A failed collection cannot be repaired by probing another
                    # endpoint. Preserve the remaining debit and stop here.
                    if (record.get('validation') != 'diagnostic_first_page_only'
                            or record.get('diagnostic_processing_complete') is False):
                        break
            except Exception:
                observations.append({'slot': 'batch', 'validation': 'stopped'})
            finally:
                token = None
            need(sha(child.path.read_bytes()) == g['evidence_sha256']['child'])
            raw = budget.journal.path.read_bytes()
            consumed = list(SEQUENCE[:len(raw.splitlines())-g['counter_rows']])
            validate_counter(grant, raw, consumed)
            result = {'schema': 1, 'kind': KIND, 'grant_sha256': grant.checksum, 'observed_at': clock.utc().isoformat(),
                'observations': observations, 'requests': len(consumed), 'counts': budget.counts(),
                'counter_sha256': sha(raw), 'counter_rows': len(raw.splitlines()), 'child_sha256': g['evidence_sha256']['child'],
                'old_unknown_preserved': True, 'adoption_authorized': False, 'deletion_authorized': False,
                'restart_authorized': False, 'automatic_retry': False}
            _save(directory/RESULT, result)
            return result
