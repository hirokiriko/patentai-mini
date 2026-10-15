"""One bounded subscription list verifies the five exact guard assignments.

No paging, fallback GET, credentials or authorization expansion. Existing
unique write intents and final receipts must be supplied by the caller first.
"""
from copy import deepcopy
from urllib.parse import quote
import uuid
from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from .attempt import _json, _sha
from .operations import _final

SLOTS = ('G1', 'G2', 'G3', 'G4', 'G5')
OWNED = ('guard', *SLOTS)
PROFILE = 'guard_assignments_list_v8'


def need(value):
    if not value: raise Denied('guard_assignment_list_unconfirmed')


def specification(facts):
    guard, receipt = facts['guard']; _final(guard, receipt)
    need(guard['body']['identity'] == {'type': 'SystemAssigned'})
    principal = receipt['properties']['principalId']; need(str(uuid.UUID(principal)) == principal)
    subscription = '/subscriptions/' + guard['expected']['resource_id'].split('/')[2]
    need(str(uuid.UUID(subscription.split('/')[2])) == subscription.split('/')[2])
    url = ('https://management.azure.com' + subscription + '/providers/Microsoft.Authorization/roleAssignments'
           + '?api-version=2022-04-01&$filter=' + quote("principalId eq '" + principal + "'", safe=''))
    expected = {}
    for slot in SLOTS:
        op, r = facts[slot]; _final(op, r)
        need(op['kind'] == 'roleAssignments' and op['method'] == 'PUT' and op['provider'] == 'Microsoft.Authorization')
        p = op['body']['properties']
        need(set(p) == {'principalId', 'principalType', 'roleDefinitionId'}
             and p['principalId'] == principal and p['principalType'] == 'ServicePrincipal')
        rid = op['expected']['resource_id']; marker = '/providers/Microsoft.Authorization/roleAssignments/'
        need(rid.startswith(subscription + '/') and rid.count(marker) == 1)
        scope, name = rid.rsplit(marker, 1); need(str(uuid.UUID(name)) == name)
        expected[slot] = {'id': rid, 'name': name, 'type': 'Microsoft.Authorization/roleAssignments', 'properties': {
            **deepcopy(p), 'scope': scope, 'condition': None, 'conditionVersion': None, 'delegatedManagedIdentityResourceId': None}}
    need(len({r['id'] for r in expected.values()}) == 5)
    return url, expected


def checked_page(value, expected):
    need(type(value) is dict and set(value) == {'value'})
    rows = value['value']; need(type(rows) is list and len(rows) == 5)
    need(all(type(row) is dict and type(row.get('id')) is str for row in rows))
    need(len({row['id'].lower() for row in rows}) == 5)
    by_id = {row['id']: row for row in rows}
    need(set(by_id) == {v['id'] for v in expected.values()})
    fields = {'principalId', 'principalType', 'roleDefinitionId', 'scope', 'condition', 'conditionVersion', 'delegatedManagedIdentityResourceId'}
    metadata = {'createdBy', 'createdOn', 'updatedBy', 'updatedOn', 'description'}
    for wanted in expected.values():
        row = by_id[wanted['id']]
        need(set(row) <= {'id', 'name', 'type', 'properties', 'systemData'}
             and all(row.get(k) == wanted[k] for k in ('id', 'name', 'type')))
        props = row.get('properties')
        need(type(props) is dict and set(props) <= fields | metadata
             and {key: props.get(key) for key in fields} == wanted['properties'])
    return deepcopy(expected)


def build(facts, response_raw, request):
    from .journal import no_secret
    url, expected = specification(facts)
    checked_page(_json(response_raw, 1024 * 1024), expected)
    need(request == {'purpose': 'run', 'url_sha256': _sha(url.encode()), 'http': 200, 'body_sha256': _sha(response_raw)})
    value = {'schema': 1, 'profile': PROFILE, 'request': deepcopy(request), 'response_raw': response_raw.decode('utf-8'),
        'owned': {slot: {'operation': deepcopy(facts[slot][0]), 'receipt': deepcopy(facts[slot][1])} for slot in OWNED}}
    no_secret(value)
    return value


def validate(record, canonical_facts=None):
    value = record['assignment_list']
    need(type(value) is dict and set(value) == {'schema', 'profile', 'request', 'response_raw', 'owned'}
         and type(value['schema']) is int and value['schema'] == 1 and value['profile'] == PROFILE
         and set(value['owned']) == set(OWNED) and type(value['response_raw']) is str)
    facts = {}
    for slot in OWNED:
        item = value['owned'][slot]; need(set(item) == {'operation', 'receipt'})
        facts[slot] = item['operation'], item['receipt']
        need(record['historical_receipts'][slot] == digest(item['receipt']))
        if canonical_facts is not None: need(facts[slot] == tuple(canonical_facts[slot]))
    need(build(facts, value['response_raw'].encode('utf-8'), value['request']) == value)
    need(record['request_evidence'].count(value['request']) == 1)
    _, expected = specification(facts)
    for slot, item in expected.items():
        need(record['readbacks'][slot] == {'id': item['id'], 'properties': item['properties']})
    return digest({'readbacks': {k: record['readbacks'][k] for k in (*SLOTS, 'C1', 'C2', 'C3', 'G6', 'C4')},
                   'assignment_list': value})
