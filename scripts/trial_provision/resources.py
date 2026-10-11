"""Pure builders for the nine fixed trial resources and two runtime updates.

The controller verifies the complete authority chain before sending anything.
This module does not acquire credentials, read secret values, or call Azure.
Initial App/Job environments deliberately lack policy and DB references, so
the trial runtime rejects work until receipt-bound configuration is installed.

REST contracts: Microsoft Learn Container Apps/Jobs create-or-update and update
(2025-07-01), ManagedIdentity userAssignedIdentities (2023-01-31), and Storage
blobServices/containers (2023-05-01). Configuration is omitted from runtime
PATCH bodies so installing policy does not replace the auth secret array.
"""
from copy import deepcopy
import base64
import json
import re
import uuid

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse


ARM = 'https://management.azure.com'
FORMAL_END = '2026-10-31T00:00:00Z'
RETENTION_END = '2027-01-29T00:00:00Z'
SLOTS = ('webIdentity', 'workerIdentity', 'originals', 'artifacts', 'budget',
         'journal', 'guard', 'job', 'app')
GUID = r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'
RG = r'/subscriptions/' + GUID + r'/resourceGroups/[A-Za-z0-9_.()-]{1,90}'
HEX = r'[a-f0-9]{64}'
SOURCE = {'web': 'trial-web-database', 'worker': 'trial-worker-database'}
POLICY_ENV = ('TRIAL_POLICY_JSON', 'TRIAL_POLICY_SIGNATURE', 'TRIAL_POLICY_PUBLIC_KEY')


def _require(ok):
    if not ok:
        raise Denied('resource_plan_binding')


def _time(value):
    _require(isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', value)))
    return parse(value)


def _manifest(manifest, authority):
    _require(isinstance(authority, dict) and isinstance(authority.get('manifest'), bytes))
    _require(json.loads(authority['manifest']) == manifest)
    ids, names, existing = manifest['ids'], manifest['names'], manifest['existing']
    _require(set(ids) == set(SLOTS) and set(names) == set(SLOTS))
    rg = manifest['resourceGroupId']
    _require(bool(re.fullmatch(RG, rg)))
    _require(bool(re.fullmatch(r'[a-z0-9]{1,40}', manifest['region'])))
    for slot in SLOTS:
        name = names[slot]
        _require(isinstance(name, str) and bool(re.fullmatch(r'[a-z][a-z0-9-]{1,61}[a-z0-9]', name)) and '--' not in name)
        if slot in ('originals', 'artifacts', 'budget', 'journal'):
            wanted = existing['storage'] + '/blobServices/default/containers/' + name
        elif slot.endswith('Identity'):
            wanted = rg + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + name
        else:
            _require(len(name) <= 32)
            wanted = rg + '/providers/Microsoft.App/' + ('containerApps' if slot == 'app' else 'jobs') + '/' + name
        _require(ids[slot] == wanted)
    _require(len({v.lower() for v in ids.values()}) == 9)
    _require(not {v.lower() for v in ids.values()} & {v.lower() for v in existing.values() if isinstance(v, str)})
    for key, provider, kind in (('storage', 'Microsoft.Storage', 'storageAccounts'),
                                ('registry', 'Microsoft.ContainerRegistry', 'registries'),
                                ('environment', 'Microsoft.App', 'managedEnvironments')):
        _require(bool(re.fullmatch(re.escape(rg) + '/providers/' + re.escape(provider) + '/' + kind + r'/[A-Za-z0-9-]+', existing[key])))
    _require(manifest['registry']['id'] == existing['registry'])
    _require(bool(re.fullmatch(r'[a-z0-9]+\.azurecr\.io', manifest['registry']['loginServer'])))
    _require(manifest['registry'].get('anonymousPullEnabled') is False)
    for field in ('principal_id', 'tenant_id'):
        uuid.UUID(manifest['owner'][field])
    return ids


def _bindings(manifest, bindings):
    _require(set(bindings) == {'deadline', 'guardian_deadline', 'runtime_image', 'guardian_image', 'db_secret_digests', 'code_sha'})
    deadline, guard_end = _time(bindings['deadline']), _time(bindings['guardian_deadline'])
    _require(deadline <= guard_end <= _time(FORMAL_END))
    _require((guard_end - deadline).total_seconds() <= 28800)
    _require(bool(re.fullmatch(r'[a-f0-9]{40}', bindings['code_sha'])))
    for field, repository in (('runtime_image', 'imageRepository'), ('guardian_image', 'cleanupImageRepository')):
        repo = manifest[repository]
        _require(bool(re.fullmatch(r'[a-z0-9][a-z0-9/_.-]*', repo)) and '..' not in repo)
        _require(bool(re.fullmatch(re.escape(manifest['registry']['loginServer'] + '/' + repo + '@sha256:') + HEX, bindings[field])))
    _require(set(bindings['db_secret_digests']) == {'web', 'worker'})
    _require(all(isinstance(x, str) and re.fullmatch(HEX, x) for x in bindings['db_secret_digests'].values()))


def _secret(role, bindings):
    return {'name': SOURCE[role], 'value': {'$secretBinding': SOURCE[role],
            'sha256': bindings['db_secret_digests'][role]}}


def _container(manifest, bindings, slot):
    role = 'web' if slot == 'app' else 'worker'
    if slot == 'guard':
        return {'name': manifest['names'][slot], 'image': bindings['guardian_image'],
                'command': ['python', '-m', 'trial_guard'], 'args': [],
                'resources': {'cpu': 0.25, 'memory': '0.5Gi'}, 'env': []}
    result = {'name': manifest['names'][slot], 'image': bindings['runtime_image'],
              'resources': {'cpu': 0.5 if slot == 'app' else 2, 'memory': '1Gi' if slot == 'app' else '4Gi'},
              'env': [{'name': 'DEPLOYMENT_KIND', 'value': 'trial'},
                      {'name': 'TRIAL_RUNTIME_ROLE', 'value': role},
                      {'name': 'AI_PROVIDER', 'value': 'azure'}]}
    if slot == 'job':
        result.update(command=['node', '.koho-ops/managed/scripts/trial-watch-worker.js'], args=[])
    return result


def _operation(slot, provider, kind, rid, version, body, deadline, depends, properties, **expected):
    return {'id': slot, 'provider': provider, 'kind': kind, 'method': 'PUT',
            'url': ARM + rid + '?api-version=' + version, 'body': body,
            'deadline': deadline, 'depends_on': depends,
            'expected': {'resource_id': rid, 'api_version': version, 'body_sha256': digest(body),
                         'properties': properties, 'created_by_run': True, 'before_absent': True, **expected},
            'cleanup': {'created_only': True, 'zero_reference_required': kind == 'userAssignedIdentities'}}


def build_resource_operations(manifest, authority_bundle, bindings):
    """Return metadata-only plans; authority verification remains a send gate.

    ``bindings`` fixes creation/guardian deadlines, two immutable image strings,
    and SHA256 of the two existing DB credentials' UTF-8 bytes. It accepts no
    secret value, arbitrary resource body, environment, scale or command.
    """
    try:
        ids = _manifest(manifest, authority_bundle)
        _bindings(manifest, bindings)
        result = []
        for slot in SLOTS:
            if slot.endswith('Identity'):
                body = {'location': manifest['region']}
                op = _operation(slot, 'Microsoft.ManagedIdentity', 'userAssignedIdentities', ids[slot],
                    '2023-01-31', body, bindings['deadline'], [], {'location': body['location']},
                    receipt_properties=['principalId', 'tenantId', 'clientId'])
            elif slot in ('originals', 'artifacts', 'budget', 'journal'):
                body = {'properties': {'publicAccess': 'None'}}
                op = _operation(slot, 'Microsoft.Storage', 'containers', ids[slot], '2023-05-01', body,
                    bindings['deadline'], [], {'properties.publicAccess': 'None'})
            else:
                guard, app = slot == 'guard', slot == 'app'
                role = 'web' if app else 'worker'
                identity = 'system' if guard else ids[role + 'Identity']
                configuration = {'registries': [{'server': manifest['registry']['loginServer'], 'identity': identity}],
                                 'secrets': [] if guard else [_secret(role, bindings)]}
                template = {'containers': [_container(manifest, bindings, slot)], 'initContainers': []}
                if app:
                    configuration.update(activeRevisionsMode='Single', ingress={'external': False,
                        'targetPort': 3000, 'transport': 'auto', 'allowInsecure': False,
                        'traffic': [{'latestRevision': True, 'weight': 100}]})
                    template['scale'] = {'minReplicas': 0, 'maxReplicas': 1}
                else:
                    configuration.update(triggerType='Manual', replicaTimeout=300 if guard else 1800, replicaRetryLimit=0,
                        manualTriggerConfig={'replicaCompletionCount': 1, 'parallelism': 1})
                body = {'location': manifest['region'],
                        'identity': {'type': 'SystemAssigned'} if guard else {'type': 'UserAssigned', 'userAssignedIdentities': {identity: {}}},
                        'properties': {'environmentId': manifest['existing']['environment'],
                            'workloadProfileName': 'Consumption', 'configuration': configuration, 'template': template}}
                props = {'properties.environmentId': manifest['existing']['environment'],
                         'identity.type': body['identity']['type'],
                         'properties.workloadProfileName': 'Consumption',
                         'properties.template': deepcopy(template),
                         'properties.configuration.registries': deepcopy(configuration['registries'])}
                for key in ('activeRevisionsMode', 'ingress') if app else ('triggerType', 'replicaTimeout', 'replicaRetryLimit', 'manualTriggerConfig'):
                    props['properties.configuration.' + key] = deepcopy(configuration[key])
                if not guard:
                    props['identity.userAssignedIdentities'] = {identity: {}}
                op = _operation(slot, 'Microsoft.App', 'containerApps' if app else 'jobs', ids[slot],
                    '2025-07-01', body, bindings['deadline'], [] if guard else [role + 'Identity', 'R8' if app else 'R9'],
                    props, location=manifest['region'])
                if app:
                    op['expected']['receipt_properties'] = ['defaultDomain']
                elif guard:
                    op['expected']['receipt_properties'] = ['principalId', 'tenantId']
                    op['cleanup']['deadline'] = bindings['guardian_deadline']
                if not guard:
                    op['expected']['secret_bindings'] = [{'source': SOURCE[role], 'sha256': bindings['db_secret_digests'][role]}]
            if slot in ('job', 'workerIdentity'):
                op['cleanup']['deadline'] = FORMAL_END
            elif slot in ('app', 'webIdentity'):
                op['cleanup']['deadline'] = RETENTION_END
            result.append(op)
        return result
    except (KeyError, TypeError, ValueError, OverflowError):
        raise Denied('resource_plan_binding') from None


def _receipt(op, receipts):
    receipt = receipts.get(op['id'], {})
    for key, wanted in {'operation_id': op['id'], 'request_digest': digest(op),
                        'object_id': op['expected']['resource_id'], 'state': 'succeeded',
                        'created_by_run': True, 'write_terminal': True, 'terminal': True, 'readback_verified': True}.items():
        _require(type(receipt.get(key)) is type(wanted) and receipt.get(key) == wanted)
    _require(isinstance(receipt.get('properties'), dict))
    return receipt['properties']


def public_trial_origin(manifest, observed_fqdn):
    """Derive only this App's external hostname from its actual ingress FQDN.

    Microsoft Learn /azure/container-apps/connect-apps documents the optional
    ``internal`` label. No custom domain, other region or different App passes.
    External enablement must later read back exactly this derived hostname.
    """
    name, region = manifest['names']['app'], manifest['region']
    pattern = re.escape(name) + r'\.(?:internal\.)?([a-z0-9][a-z0-9-]*\.' + re.escape(region) + r'\.azurecontainerapps\.io)'
    _require(isinstance(observed_fqdn, str))
    matched = re.fullmatch(pattern, observed_fqdn)
    _require(matched is not None)
    return 'https://' + name + '.' + matched.group(1)


def build_runtime_operations(manifest, authority_bundle, bindings, receipts, policy_environment, *, verify_policy, auth_operation, deadline):
    """Install a verified signed policy without replacing either secret array.

    ``verify_policy`` must be the pinned existing trial verifier, not an HTTP
    assertion. Root supplies journal-authenticated receipts; this builder checks
    their exact request hashes. It neither creates nor signs a policy or key.
    """
    try:
        original = {op['id']: op for op in build_resource_operations(manifest, authority_bundle, bindings)}
        _require(set(policy_environment) == set(POLICY_ENV) and callable(verify_policy))
        _require(all(isinstance(x, str) and 0 < len(x.encode('utf-8')) <= 32768 for x in policy_environment.values()))
        signature = policy_environment['TRIAL_POLICY_SIGNATURE']
        _require(bool(re.fullmatch(r'[A-Za-z0-9+/]{86}==', signature)) and len(base64.b64decode(signature, validate=True)) == 64)
        public_key = policy_environment['TRIAL_POLICY_PUBLIC_KEY']
        public_match = re.fullmatch(r'-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----\r?\n?', public_key)
        _require(public_match is not None)
        der = base64.b64decode(''.join(public_match.group(1).split()), validate=True)
        _require(len(der) == 44 and der[:12] == bytes.fromhex('302a300506032b6570032100'))
        try:
            verified = verify_policy({'DEPLOYMENT_KIND': 'trial', **policy_environment})
        except Exception:
            raise Denied('resource_policy_unverified') from None
        policy = json.loads(policy_environment['TRIAL_POLICY_JSON'])
        _require(verified == policy and policy['schema'] == 1 and policy['approval'] == 'LIGHTWEIGHT_GROUP_TRIAL_V3')
        end = _time(deadline)
        _require(end <= _time(policy['endsAt']) <= _time(FORMAL_END) and _time(policy['startsAt']) < _time(policy['endsAt']))
        _require(policy['phase'] in ('initial', 'trial'))
        if policy['phase'] == 'initial':
            _require((_time(policy['endsAt']) - _time(policy['startsAt'])).total_seconds() <= 1800)
        else:
            _require(policy['startsAt'] == '2026-10-17T00:00:00Z' and policy['endsAt'] == FORMAL_END)
        _require(policy['retentionReviewAt'] == RETENTION_END and policy['image'] == bindings['runtime_image'])
        _require(policy['codeSha'] == bindings['code_sha'])
        _require(policy['jobResourceId'] == manifest['ids']['job'] and policy['environmentResourceId'] == manifest['existing']['environment'])
        web, worker = _receipt(original['webIdentity'], receipts), _receipt(original['workerIdentity'], receipts)
        app = _receipt(original['app'], receipts)
        _receipt(original['job'], receipts)
        _require(web['tenantId'] == worker['tenantId'] == manifest['owner']['tenant_id'])
        _require(policy['identity'] == {'webClientId': web['clientId'], 'workerClientId': worker['clientId']})
        _require(web['clientId'] != worker['clientId'] and web['principalId'] != worker['principalId'])
        auth = receipts['E1']
        _require(auth_operation.get('id') == 'E1' and auth.get('operation_id') == 'E1' and auth.get('request_digest') == digest(auth_operation))
        _require(all(auth.get(k) is True for k in ('terminal', 'write_terminal', 'created_by_run', 'readback_verified')) and auth.get('state') == 'succeeded')
        _require(policy['auth'] == {'tenantId': manifest['owner']['tenant_id'], 'ownerId': manifest['owner']['principal_id'],
                                  'clientId': auth['properties']['appId'], 'origin': public_trial_origin(manifest, app['defaultDomain'])})
        db = manifest['db']
        _require(policy['database']['database'] == db['name'] and policy['database']['webUser'] == db['web'] and policy['database']['workerUser'] == db['worker'])
        _require(policy['database']['host'] == manifest['existing']['db'].rsplit('/', 1)[-1] + '.postgres.database.azure.com' and policy['database']['port'] == 5432)
        _require(policy['storage'] == {'account': manifest['existing']['storage'].rsplit('/', 1)[-1],
            **{k: manifest['names'][k] for k in ('originals', 'artifacts', 'budget')}})
        _require(policy['ai']['resourceName'] == manifest['existing']['ai'].rsplit('/', 1)[-1])
        result = []
        for slot, role in (('job', 'worker'), ('app', 'web')):
            prior = original[slot]
            template = deepcopy(prior['body']['properties']['template'])
            env = template['containers'][0]['env']
            env.extend({'name': name, 'value': policy_environment[name]} for name in POLICY_ENV)
            env.append({'name': 'DATABASE_URL', 'secretRef': SOURCE[role]})
            op = deepcopy(prior)
            op.update(id=slot + 'Runtime', method='PATCH', body={'properties': {'template': template}}, deadline=deadline,
                      depends_on=[slot, 'webIdentity', 'workerIdentity', 'E1', 'trialDatabaseBootstrap'])
            op['expected'].update(before_absent=False,
                update_from={'operation_id': prior['id'], 'request_digest': digest(prior)},
                body_sha256=digest(op['body']))
            op['expected'].pop('secret_bindings', None)
            op['expected']['properties']['properties.template'] = template
            result.append(op)
        return result
    except (KeyError, TypeError, ValueError, OverflowError):
        raise Denied('resource_runtime_binding') from None


def build_guard_main_operation(create_operation, create_receipt, rehearsal_operation, rehearsal_receipt, *, deadline):
    """Raise the same Manual Job timeout only after a proved 300-second rehearsal.

    Root normalizes the existing wrapper's terminal execution and cleanup proofs
    into the exact journal-bound ``guardRehearsal`` receipt. This never starts a
    Job, creates a successor, or equates a timeout with successful rehearsal.
    """
    try:
        _require(create_operation['id'] == 'guard' and create_operation['kind'] == 'jobs')
        _require(create_operation['body']['properties']['configuration']['replicaTimeout'] == 300)
        _receipt(create_operation, {'guard': create_receipt})
        _require(rehearsal_operation['id'] == 'guardRehearsal')
        proof = _receipt(rehearsal_operation, {'guardRehearsal': rehearsal_receipt})
        rid = create_operation['expected']['resource_id']
        _require(proof.get('job_resource_id') == rid and proof.get('rehearsal_reads_verified') is True and proof.get('cleanup_verified') is True)
        _require(rehearsal_operation['expected']['resource_id'].startswith(rid + '/executions/'))
        _require(_time(deadline) <= _time(create_operation['cleanup']['deadline']))
        op = deepcopy(create_operation)
        configuration = {'triggerType': 'Manual', 'replicaTimeout': 1800, 'replicaRetryLimit': 0,
                         'manualTriggerConfig': {'replicaCompletionCount': 1, 'parallelism': 1}}
        op.update(id='guardMainConfiguration', method='PATCH', deadline=deadline,
            depends_on=['guard', 'guardRehearsal'], body={'properties': {'configuration': configuration}})
        op['expected'].update(before_absent=False,
            update_from={'operation_id': 'guard', 'request_digest': digest(create_operation)}, body_sha256=digest(op['body']))
        op['expected']['properties']['properties.configuration.replicaTimeout'] = 1800
        return op
    except (KeyError, TypeError, ValueError, OverflowError):
        raise Denied('guardian_rehearsal_binding') from None


def build_resource_cleanup(create_operation, receipt, *, deadline, current_operation=None, current_receipt=None):
    """Exact created-only DELETE; retention/reference proof is controller-owned.

    Never call this to infer permission for retained App/data deletion. A caller
    must already possess the specific approved cleanup phase and reference proof.
    """
    _require(create_operation.get('id') in SLOTS and create_operation.get('method') == 'PUT')
    _receipt(create_operation, {create_operation['id']: receipt})
    state_operation = create_operation
    if current_operation is not None or current_receipt is not None:
        _require(isinstance(current_operation, dict) and isinstance(current_receipt, dict))
        _require(current_operation.get('method') == 'PATCH' and
            current_operation.get('url') == create_operation['url'] and
            current_operation.get('expected', {}).get('update_from') == {
                'operation_id': create_operation['id'], 'request_digest': digest(create_operation)})
        _receipt(current_operation, {current_operation['id']: current_receipt})
        state_operation = current_operation
    # Data and audit containers are retained; this lifecycle does not delete
    # them merely because the trial or a guardian window has ended.
    _require(create_operation['id'] not in ('originals', 'artifacts', 'budget', 'journal'))
    _require(_time(deadline) == _time(create_operation['cleanup']['deadline']))
    op = deepcopy(state_operation)
    op.update(id=create_operation['id'] + 'Cleanup', method='DELETE', body=None,
              deadline=deadline, depends_on=list(dict.fromkeys([create_operation['id'], state_operation['id']])))
    op['expected']['body_sha256'] = digest(None)
    op['expected'].pop('secret_bindings', None)
    return op
