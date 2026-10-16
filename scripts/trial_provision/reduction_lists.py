"""Fixed complete ARM collections; observations never create ownership.

Host-only. A sealed successor supplies canonical operation/final-receipt pairs.
No paging, fallback GET, mutation, UNKNOWN adoption, or caller-selected URL.
"""
from copy import deepcopy
from datetime import timedelta
import re
from urllib.parse import quote
from scripts.trial_guard.adapters import Deadline, digest
from scripts.trial_guard.lifecycle import Denied, parse
from .attempt import _json, _sha
from .operations import _final
from .providers import _input_matches

ARM = 'https://management.azure.com'
PROFILE = 'complete_fixed_lists_v8r1'
MI = ('webIdentity', 'workerIdentity')
CONTAINERS = ('originals', 'artifacts', 'budget', 'journal')
ROLES = tuple('C' + str(n) for n in range(1, 8))
ASSIGNMENTS = tuple('G' + str(n) for n in range(1, 7))
CARRIED = MI + CONTAINERS + ROLES
MAX_BODY = 1024 * 1024
MAX_ROWS = 1000
GUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def need(value):
    if not value:
        raise Denied('fixed_collection_unconfirmed')


def _owned(facts, slots, provider, kind):
    result = {}
    for slot in slots:
        op, receipt = facts[slot]
        _final(op, receipt)
        need(op['id'] == slot and op['method'] == 'PUT'
             and op['provider'] == provider and op['kind'] == kind
             and receipt['object_id'] == op['expected']['resource_id'])
        result[slot] = {'operation': deepcopy(op), 'receipt': deepcopy(receipt)}
    need(len({v['receipt']['object_id'].lower() for v in result.values()}) == len(slots))
    return result


def _scope(manifest):
    group = manifest['resourceGroupId']
    need(type(group) is str and re.fullmatch('/subscriptions/' + GUID + '/resourceGroups/[A-Za-z0-9_.()-]+', group))
    subscription = group.split('/resourceGroups/', 1)[0]
    return group, subscription


def role_specification(manifest, facts):
    group, subscription = _scope(manifest)
    ai = manifest['existing']['ai']
    # AI is the deepest sealed assignable scope: it sees its RG and subscription
    # ancestors as well as its own C7. An RG-only List would omit C7.
    need(type(ai) is str and ai.startswith(group + '/providers/Microsoft.CognitiveServices/accounts/')
         and re.fullmatch(re.escape(group) + '/providers/Microsoft.CognitiveServices/accounts/[A-Za-z0-9_.-]+', ai))
    owned = _owned(facts, ROLES, 'Microsoft.Authorization', 'roleDefinitions')
    for slot, item in owned.items():
        op = item['operation']; p = op['body']['properties']
        scope = subscription if slot == 'C3' else ai if slot == 'C7' else group
        need(p['assignableScopes'] == [scope] and p['type'] == 'CustomRole'
             and re.fullmatch(re.escape(subscription) + '/providers/Microsoft.Authorization/roleDefinitions/' + GUID, op['expected']['resource_id']))
    return {'kind': 'roles', 'url': ARM + ai + '/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter='
            + quote("type eq 'CustomRole'", safe=''), 'parent': subscription,
            'resource_type': 'Microsoft.Authorization/roleDefinitions', 'owned': owned}


def carry_specifications(manifest, facts):
    group, subscription = _scope(manifest)
    identities = _owned(facts, MI, 'Microsoft.ManagedIdentity', 'userAssignedIdentities')
    storage = manifest['existing']['storage']
    need(type(storage) is str and storage.startswith(subscription + '/resourceGroups/'))
    containers = _owned(facts, CONTAINERS, 'Microsoft.Storage', 'containers')
    mip = group + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/'
    cp = storage + '/blobServices/default/containers/'
    need(all(v['receipt']['object_id'] == mip + manifest['names'][s] for s, v in identities.items()))
    need(all(v['receipt']['object_id'] == cp + manifest['names'][s] for s, v in containers.items()))
    pim = tuple({'kind':'pim','collection':collection,
        'url':ARM+subscription+'/providers/Microsoft.Authorization/'+collection+'?api-version=2020-10-01',
        'parent':subscription,'owned':_owned(facts,ROLES,'Microsoft.Authorization','roleDefinitions')}
        for collection in ('roleEligibilitySchedules','roleEligibilityScheduleInstances'))
    return pim + (
        {'kind': 'identities', 'url': ARM + mip[:-1] + '?api-version=2023-01-31',
         'parent': mip, 'resource_type': 'Microsoft.ManagedIdentity/userAssignedIdentities', 'owned': identities},
        {'kind': 'containers', 'url': ARM + cp[:-1] + '?api-version=2023-05-01',
         'parent': cp, 'resource_type': 'Microsoft.Storage/storageAccounts/blobServices/containers', 'owned': containers},
        role_specification(manifest, facts),
    )


def assignment_specification(manifest, facts):
    _, subscription = _scope(manifest)
    guard, receipt = facts['guard']; _final(guard, receipt)
    principal = receipt['properties']['principalId']
    need(re.fullmatch(GUID, principal) and guard['body']['identity'] == {'type': 'SystemAssigned'})
    owned = _owned(facts, ASSIGNMENTS, 'Microsoft.Authorization', 'roleAssignments')
    for slot, item in owned.items():
        p = item['operation']['body']['properties']
        need(p['principalId'] == (manifest['owner']['principal_id'] if slot == 'G6' else principal)
             and p['principalType'] == ('User' if slot == 'G6' else 'ServicePrincipal'))
    return {'kind': 'assignments', 'url': ARM + subscription + '/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01',
            'parent': subscription, 'resource_type': 'Microsoft.Authorization/roleAssignments',
            'guard_principal': principal, 'guard': {'operation': deepcopy(guard), 'receipt': deepcopy(receipt)}, 'owned': owned}


def _rows(raw):
    value = _json(raw, MAX_BODY)
    # Even an empty nextLink field is not silently accepted as a complete page.
    need(type(value) is dict and set(value) == {'value'} and type(value['value']) is list
         and len(value['value']) <= MAX_ROWS)
    rows = value['value']
    need(all(type(r) is dict and type(r.get('id')) is str and type(r.get('properties')) is dict
             and 'error' not in r and 'error' not in r['properties'] for r in rows))
    need(len({r['id'].lower() for r in rows}) == len(rows))
    return rows


def checked_page(spec, raw):
    rows = _rows(raw); kind = spec['kind']; parent = spec['parent']
    if kind == 'pim':
        from .read_observation import count_collection
        need(spec['collection'] in ('roleEligibilitySchedules','roleEligibilityScheduleInstances')
             and spec['url']==ARM+parent+'/providers/Microsoft.Authorization/'+spec['collection']+'?api-version=2020-10-01'
             and set(spec['owned'])==set(ROLES))
        for item in spec['owned'].values():
            count, _ = count_collection(lambda url:{'status':200,'headers':{},'body':raw},
                spec['url'],item['receipt']['object_id'])
            need(count==0)
        return {}  # An admission observation, never a receipt or cleanup proof.
    by_id = {}
    for row in rows:
        rid = row['id']; name = row.get('name')
        need(row.get('type') == spec['resource_type'] and type(name) is str
             and name == rid.rsplit('/', 1)[1])
        if kind in ('identities', 'containers'):
            need(rid.startswith(parent) and '/' not in rid[len(parent):] and rid[len(parent):])
        else:
            suffix = '/providers/Microsoft.Authorization/' + ('roleDefinitions' if kind == 'roles' else 'roleAssignments') + '/'
            need(rid.startswith(parent + '/') and rid.count(suffix) == 1 and re.fullmatch(GUID, name))
            if kind == 'roles': need(rid == parent + suffix + name)
        by_id[rid] = row
    selected = {}
    expected_ids = {v['receipt']['object_id'] for v in spec['owned'].values()}
    if kind == 'assignments':
        # Preserve the earlier principal-filtered List's rejection of any extra
        # assignment for this guard; unrelated OWNER/other-principal rows remain
        # inert observations, never adopted into the approved role set.
        need(all(type(r['properties'].get('principalId')) is str and re.fullmatch(GUID, r['properties']['principalId'].casefold()) for r in rows))
        actual_guard = {r['id'].casefold() for r in rows if r['properties']['principalId'].casefold() == spec['guard_principal'].casefold()}
        need(actual_guard == {v['receipt']['object_id'].casefold() for s, v in spec['owned'].items() if s != 'G6'})
    for slot, item in spec['owned'].items():
        op, receipt = item['operation'], item['receipt']
        need(receipt['object_id'] in by_id)
        row = by_id[receipt['object_id']]; p = row['properties']
        need(_input_matches(op['body'], row))
        if kind == 'identities':
            need(all(re.fullmatch(GUID, p.get(k, '')) and p[k] == receipt['properties'][k]
                     for k in ('principalId', 'clientId', 'tenantId')))
            need(p.get('provisioningState', 'Succeeded') == 'Succeeded')
            normalized = {'id': row['id'], 'location': row['location'],
                          'properties': {k: p[k] for k in ('principalId', 'clientId', 'tenantId')}}
        elif kind == 'containers':
            need(p['publicAccess'] == 'None' and p.get('deleted', False) is False)
            normalized = {'id': row['id'], 'properties': {'publicAccess': 'None'}}
        elif kind == 'roles':
            keys = set(op['body']['properties'])
            need(set(p) <= keys | {'createdOn', 'createdBy', 'updatedOn', 'updatedBy'}
                 and {k: p.get(k) for k in keys} == op['body']['properties'])
            normalized = {'id': row['id'], 'properties': deepcopy(op['body']['properties'])}
        else:
            marker = '/providers/Microsoft.Authorization/roleAssignments/'
            scope = row['id'].rsplit(marker, 1)[0]
            fields = {'principalId', 'principalType', 'roleDefinitionId', 'scope',
                      'condition', 'conditionVersion', 'delegatedManagedIdentityResourceId'}
            wanted = {k: op['body']['properties'].get(k) for k in fields}; wanted['scope'] = scope
            need(set(p) <= fields | {'createdBy', 'createdOn', 'updatedBy', 'updatedOn', 'description'}
                 and {k: p.get(k) for k in fields} == wanted)
            normalized = {'id': row['id'], 'properties': wanted}
        selected[slot] = normalized
    need(set(v['id'] for v in selected.values()) == expected_ids)
    return selected


def build(spec, raw, request):
    selected = checked_page(spec, raw)
    need(set(request) == {'purpose', 'url_sha256', 'http', 'body_sha256'}
         and request['url_sha256'] == _sha(spec['url'].encode()) and request['http'] == 200
         and request['body_sha256'] == _sha(raw) and request['purpose'] in ('fresh', 'run', 'provision'))
    return {'schema': 1, 'profile': PROFILE, 'spec': deepcopy(spec), 'request': deepcopy(request),
            'response_raw': raw.decode('utf-8'), 'readbacks': selected}


def validate(proof, spec):
    need(type(proof) is dict and set(proof) == {'schema', 'profile', 'spec', 'request', 'response_raw', 'readbacks'})
    need(proof == build(spec, proof['response_raw'].encode('utf-8'), proof['request']))
    return deepcopy(proof['readbacks'])


def collect_carry(manifest, facts, counted, credential, clock, guard):
    """Call only after a durable one-shot foundation-read intent.

    The caller supplies the canonical counted provision transport and pooled
    credential. No raw wire or CLI arguments can choose a target or scope.
    """
    specs = carry_specifications(manifest, facts)
    started, tick = clock.utc(), clock.monotonic()
    deadline = Deadline(60, clock.monotonic)
    def current():
        guard(); deadline.remaining()
        now, mono = clock.utc(), clock.monotonic()
        need(started <= now < started + timedelta(seconds=60) and mono >= tick
             and abs((now-started).total_seconds()-(mono-tick)) < 5)
    current(); token = credential.token(ARM + '/', deadline); current()
    pages = []
    try:
        for spec in specs:
            current()
            response = counted.send_guarded('GET', spec['url'], {'Authorization': 'Bearer ' + token},
                                            None, deadline, before_send=current)
            current()
            need(response['status'] == 200 and type(response['body']) is bytes
                 and not {'location', 'azure-asyncoperation', 'operation-location', 'www-authenticate'} &
                 {str(k).lower() for k in response['headers']})
            request = {'purpose': 'provision', 'url_sha256': _sha(spec['url'].encode()),
                       'http': 200, 'body_sha256': _sha(response['body'])}
            pages.append(build(spec, response['body'], request))
    finally:
        token = None
    return {'schema': 1, 'profile': PROFILE, 'started_at': started.isoformat(),
            'completed_at': clock.utc().isoformat(), 'pages': pages, 'cloud_mutations': 0}


def validate_carry(record, manifest, facts, now, *, require_fresh=True):
    need(set(record) == {'schema', 'profile', 'started_at', 'completed_at', 'pages', 'cloud_mutations'}
         and record['schema'] == 1 and record['profile'] == PROFILE and record['cloud_mutations'] == 0)
    start, end = parse(record['started_at']), parse(record['completed_at'])
    need(start <= end < start + timedelta(seconds=60) and end <= now)
    if require_fresh: need(now < start + timedelta(minutes=10))
    specs = carry_specifications(manifest, facts)
    need(len(record['pages']) == len(specs) == 5)
    selected = {}
    for spec, proof in zip(specs, record['pages']):
        selected.update(validate(proof, spec))
    need(set(selected) == set(CARRIED))
    return digest(record)


def checked_network_list(raw, approved):
    """An exhaustive fixed-parent List proves fixed-child absence.

    Keeps both before/after passes. It never proves deletion or write ownership.
    """
    rows = _rows(raw); server = approved['server_id']; target = approved['rule_id']
    parent = server + '/firewallRules/'; basename = target.removeprefix(parent)
    need(target.startswith(parent) and re.fullmatch('[A-Za-z0-9_-]{1,80}', basename))
    names = set()
    for row in rows:
        rid, name = row['id'], row.get('name')
        need(type(name) is str and re.fullmatch('[A-Za-z0-9_-]{1,80}', name)
             and row.get('type', '').lower() == 'microsoft.dbforpostgresql/flexibleservers/firewallrules'
             and rid == parent + name and name.lower() not in names
             and name.lower() != basename.lower() and rid.lower() != target.lower())
        names.add(name.lower())
    baseline = approved['rules']
    need(type(baseline) is list and len(rows) == len(baseline) <= 200)
    by_id = {row['id']: row for row in rows}
    need(set(by_id) == {r['id'] for r in baseline})
    ordered = [by_id[r['id']] for r in baseline]
    need(ordered == baseline)
    return deepcopy(ordered)


def network_proof(raw, request, approved):
    url = ARM + approved['server_id'] + '/firewallRules?api-version=2024-08-01'
    need(request == {'purpose': 'fresh', 'url_sha256': _sha(url.encode()), 'http': 200, 'body_sha256': _sha(raw)})
    rows = checked_network_list(raw, approved)
    return {'schema': 1, 'profile': PROFILE, 'request': deepcopy(request), 'response_raw': raw.decode(),
            'rule_id': approved['rule_id'], 'rules': rows, 'absence': 'complete_fixed_parent_list'}


def validate_network(proof, approved):
    need(proof == network_proof(proof['response_raw'].encode(), proof['request'], approved))
    return deepcopy(proof['rules'])


def validate_main(record, manifest, canonical_facts=None):
    need(record['profile'] == PROFILE and set(record['lists']) == {'roles', 'assignments'})
    facts = {}
    for proof in record['lists'].values():
        for slot, item in proof['spec']['owned'].items():
            pair = item['operation'], item['receipt']
            if slot in facts: need(facts[slot] == pair)
            facts[slot] = pair
    guard = record['lists']['assignments']['spec']['guard']
    facts['guard'] = guard['operation'], guard['receipt']
    for slot, pair in facts.items():
        need(record['historical_receipts'][slot] == digest(pair[1]))
        if canonical_facts is not None: need(pair == tuple(canonical_facts[slot]))
    specs = {'roles': role_specification(manifest, facts),
             'assignments': assignment_specification(manifest, facts)}
    selected = {}
    for key, spec in specs.items():
        proof = record['lists'][key]
        selected.update(validate(proof, spec))
        need(proof['request']['purpose'] == 'run' and record['request_evidence'].count(proof['request']) == 1)
    need(all(record['readbacks'][slot] == row for slot, row in selected.items()))
    return digest({'readbacks': selected, 'lists': record['lists']})
