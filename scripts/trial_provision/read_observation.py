"""Local-only ARM GET classification; no authority, write, retry or adoption.

Raw messages, header values and response objects never enter observations.
The caller still owns the fixed target, durable debit and absolute deadline.
This module is deliberately outside both published image closures.
"""
import hashlib
import json
import re
from urllib.parse import parse_qsl, urlsplit

from scripts.trial_guard.lifecycle import Denied

LIMIT = 4 * 1024 * 1024
GUID = r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'
CONTROLS = frozenset(('location', 'azure-asyncoperation', 'operation-location', 'www-authenticate'))
ERROR_CODES = frozenset(('ResourceNotFound', 'ResourceGroupNotFound', 'ParentResourceNotFound',
    'NotFound', 'AuthorizationFailed', 'Authorization_RequestDenied', 'InvalidAuthenticationToken',
    'ExpiredAuthenticationToken', 'SubscriptionNotFound', 'SubscriptionNotRegistered',
    'MissingSubscriptionRegistration', 'InvalidResourceType', 'NoRegisteredProviderFound',
    'FeatureNotSupported', 'NotSupported', 'BadRequest', 'InvalidRequest', 'Forbidden',
    'TooManyRequests', 'InternalServerError', 'ServiceUnavailable'))
COLLECTIONS = (('roleAssignments', '2022-04-01'), ('roleEligibilitySchedules', '2020-10-01'),
               ('roleEligibilityScheduleInstances', '2020-10-01'))


def need(value, stage):
    if not value:
        raise Denied(stage)


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'duplicate_json_key')
            value[key] = item
        return value
    def constant(_):
        raise ValueError('nonfinite_json')
    need(type(raw) is bytes and 0 < len(raw) <= LIMIT, 'body_shape')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def summary(response):
    """Bounded, allowlisted metadata, including on malformed HTTP responses."""
    result = {'http': 0, 'body_bytes': 0, 'body_sha256': None,
              'error_code': 'none', 'control_headers': [], 'validation': 'unverified'}
    if type(response) is not dict:
        return result
    status, raw, headers = response.get('status'), response.get('body'), response.get('headers')
    if type(status) is int and 100 <= status <= 599:
        result['http'] = status
    if type(raw) is bytes:
        result['body_bytes'] = len(raw)
        if len(raw) <= LIMIT:
            result['body_sha256'] = hashlib.sha256(raw).hexdigest()
    if type(headers) is dict and all(type(k) is str for k in headers):
        result['control_headers'] = sorted(CONTROLS.intersection(k.lower() for k in headers))
    try:
        value = strict_json(raw)
        if type(value) is dict and 'error' in value:
            error = value['error']
            code = error.get('code') if type(error) is dict else None
            result['error_code'] = code if type(code) is str and code in ERROR_CODES else 'other'
    except Exception:
        pass
    return result


def response_value(response):
    need(type(response) is dict and type(response.get('status')) is int
         and type(response.get('headers')) is dict
         and all(type(k) is str and type(v) is str for k, v in response['headers'].items()), 'response_shape')
    need(not CONTROLS.intersection(k.lower() for k in response['headers']), 'control_header')
    return strict_json(response['body'])


def job_absence(response, resource_id):
    """A fixed Job GET is absent only for a scoped ResourceNotFound error.

    Parent/RG errors, HTML/empty 404s and mismatched targets remain unverified.
    This is a read observation, never a terminal write or ownership receipt.
    """
    try:
        body = response_value(response)
        need(response['status'] == 404 and type(body) is dict and set(body) == {'error'}, 'absence_shape')
        error = body['error']
        need(type(error) is dict and error.get('code') == 'ResourceNotFound', 'absence_code')
        if 'target' in error:
            target = error['target']
            need(type(target) is str and target.isascii() and target.lower() == resource_id.lower(), 'absence_target')
        need(not error.get('details') and not error.get('innererror'), 'absence_nested_error')
        return True
    except Exception:
        return False


def next_page(url, initial):
    need(type(url) is str and type(initial) is str and len(url) <= 16384
         and url.isascii() and not any(ord(c) <= 32 or ord(c) == 127 for c in url), 'pagination_target')
    a, b = urlsplit(url), urlsplit(initial)
    need(a.scheme == b.scheme == 'https' and a.netloc == b.netloc == 'management.azure.com'
         and not a.fragment and a.path.lower() == b.path.lower(), 'pagination_target')
    match = re.fullmatch('/subscriptions/' + GUID + r'/providers/Microsoft\.Authorization/(' +
                        '|'.join(x[0] for x in COLLECTIONS) + ')', b.path)
    need(match is not None, 'collection_target')
    expected = dict(COLLECTIONS)[match[1]]
    need(b.query == 'api-version=' + expected, 'collection_version')
    pairs = parse_qsl(a.query, keep_blank_values=True)
    q = {k.lower(): v for k, v in pairs}
    need(len(q) == len(pairs) and set(q) <= {'api-version', '$skiptoken'}
         and q.get('api-version') == expected and all(0 < len(v) <= 8192 for v in q.values()), 'pagination_query')
    return url


def count_collection(fetch, initial, role_id, *, observe=lambda _: None):
    """Return a zero proof only after every bounded page succeeds.

    The observer receives each page *before* any later failure. A failed page
    carries no zero-reference assertion. Pagination is never silently truncated.
    """
    need(type(role_id) is str and re.fullmatch(r'(?:/subscriptions/' + GUID +
         r'(?:/resourceGroups/[A-Za-z0-9_.-]+)?)?/providers/Microsoft\.Authorization/roleDefinitions/' + GUID,
         role_id, re.I), 'role_target')
    url, seen, total, proof = initial, set(), 0, []
    for page in range(3):
        record = {'page': page + 1, 'validation': 'unverified'}
        try:
            need(url not in seen, 'pagination_cycle')
            seen.add(url); next_page(url, initial)
            response = fetch(url)
            record.update(summary(response))
            record['validation'] = 'http_status'
            need(response['status'] == 200, 'collection_http')
            record['validation'] = 'body_shape'
            body = response_value(response)
            need(type(body) is dict and 'error' not in body and type(body.get('value')) is list
                 and len(body['value']) <= 10000, 'collection_body')
            record['validation'] = 'entry_shape'
            references = 0
            for entry in body['value']:
                need(type(entry) is dict and 'error' not in entry and type(entry.get('properties')) is dict
                     and 'error' not in entry['properties'], 'collection_entry')
                rid = entry['properties'].get('roleDefinitionId')
                need(type(rid) is str and re.fullmatch(r'(?:/subscriptions/' + GUID +
                     r')?/providers/Microsoft\.Authorization/roleDefinitions/' + GUID, rid, re.I), 'collection_role_id')
                if rid.rsplit('/', 1)[-1].lower() == role_id.rsplit('/', 1)[-1].lower():
                    references += 1
            following = body.get('nextLink')
            record.update(items=len(body['value']), target_references=references,
                          next_link=following not in (None, ''))
            record['validation'] = 'pagination'
            if following not in (None, ''):
                next_page(following, initial)
                need(following not in seen and page < 2, 'pagination_incomplete')
            record['validation'] = 'page_valid'
            proof.append({'body_sha256': record['body_sha256'], 'http': 200, 'items': len(body['value'])})
            total += references
        except Exception as error:
            from .read_http import ReadFailure
            if isinstance(error, ReadFailure):
                record.update(error.observation)
            observe(record)
            raise Denied('reference_list_unverified') from None
        observe(record)
        if following in (None, ''):
            return total, proof
        url = following
    raise Denied('reference_list_unverified')
