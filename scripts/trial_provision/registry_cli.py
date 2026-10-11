"""Fixed guardian image cleanup bridge. No publisher, broad scan or new grant.

The root verifies OWNER-private bundle bytes/hash and holds the existing Journal
and ControlBudget locks. Only manifest app/job/guard metadata is read. A caller
boolean cannot create repository ownership: the same private journal must hold
the publisher's before-absence event, one fixed-tag PUT intent, known terminal
push/readback receipt and import binding from publication preparation to the
later plan. This module never manufactures or imports those records.
The proof covers this approved three-resource inventory and the newly owned
repository namespace; it makes no assertion about every Azure tenant or an
unapproved subscription-wide consumer search.

Publisher contract (not implemented here): guardian_image_namespace is recorded
after an authenticated exact /acr/v1/<repository> GET returned NAME_UNKNOWN 404,
before guardianImagePush's durable PUT intent. Store the bounded raw response's
digest, not its body. The intent binds the approved tag; only the positive push
ACK supplies the receipt's digest URL. Unknown pushes cannot be adopted or used
for cleanup, and local Docker config/image IDs are never manifest digests.

Microsoft REST contracts:
https://learn.microsoft.com/rest/api/resource-manager/containerapps/container-apps-revisions/list-revisions?view=rest-resource-manager-containerapps-2025-07-01
https://learn.microsoft.com/rest/api/resource-manager/containerapps/jobs-executions/list?view=rest-resource-manager-containerapps-2025-07-01
"""
from copy import deepcopy
import json
import re
from urllib.parse import urlsplit, parse_qsl

from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from .journal import CountedControlHttp
from .registry import BoundedRegistryProvider, _binding, HEX, MAX_BODY
from .rehearsal_cli import _Clock

ARM = 'https://management.azure.com'
VERSION = '2025-07-01'
IDENT = 'guardianImageCleanup'
PUSH = 'guardianImagePush'
MAX_PAGES = 8
MAX_ROWS = 512
MAX_IMAGES = 4096


def require(value):
    if not value:
        raise Denied('registry_cli_unconfirmed')


def _sha(value): return isinstance(value, str) and re.fullmatch(HEX, value) is not None


def _successful(receipt):
    return isinstance(receipt, dict) and receipt.get('state') == 'succeeded' and all(
        receipt.get(k) is True for k in ('terminal', 'write_terminal', 'created_by_run', 'readback_verified'))


def _publication(manifest, resources, journal, resolver, run_digest):
    prepared, imported = journal.values('publication_preparation'), journal.values('publication_import')
    require(len(prepared) == 1 and len(imported) == 1)
    preparation, imported = prepared[0], imported[0]
    require(set(preparation) == {'schema', 'configuration_sha256', 'manifest_sha256', 'source_sha256', 'code_sha', 'run_binding_digest',
        'registry_id', 'login_server', 'tenant_id', 'owner_id', 'slots', 'publish_until'}
        and type(preparation['schema']) is int and preparation['schema'] == 1
        and _sha(preparation['configuration_sha256'])
        and preparation['source_sha256'] == resolver.initial_plan['source_sha256']
        and set(preparation['source_sha256']) == {'manifest', 'annex', 'approval', 'latest', 'network_binding', 'network_approval'}
        and all(_sha(v) for v in preparation['source_sha256'].values())
        and preparation['manifest_sha256'] == preparation['source_sha256']['manifest']
        and preparation['code_sha'] == resources['code_sha']
        and preparation['run_binding_digest'] == run_digest
        and preparation['registry_id'] == manifest['registry']['id'] == manifest['existing']['registry']
        and preparation['login_server'] == manifest['registry']['loginServer']
        and preparation['tenant_id'] == manifest['owner']['tenant_id']
        and preparation['owner_id'] == manifest['owner']['principal_id']
        and isinstance(preparation['slots'], dict) and set(preparation['slots']) == {'guardian', 'runtime'}
        and parse(preparation['publish_until']) <= parse(resources['guardian_deadline'])
        and parse(preparation['publish_until']) <= parse(resolver.initial_plan['windows']['owner_input']['end']))
    require(set(imported) == {'schema', 'initial_plan_digest', 'publication_preparation_digest', 'run_binding_digest', 'push_receipt_digests'}
        and type(imported['schema']) is int and imported['schema'] == 1
        and imported['initial_plan_digest'] == resolver.plan_digest
        and imported['publication_preparation_digest'] == digest(preparation)
        and imported['run_binding_digest'] == run_digest
        and isinstance(imported['push_receipt_digests'], dict) and set(imported['push_receipt_digests']) == {'guardian', 'runtime'})
    for slot in ('guardian', 'runtime'):
        source = preparation['slots'][slot]
        repository_key, tag_key = ('cleanupImageRepository', 'cleanupImageTag') if slot == 'guardian' else ('imageRepository', 'imageTag')
        require(isinstance(source, dict) and set(source) == {'repository', 'tag', 'local_image_id', 'docker_sha256',
            'docker_path_sha256', 'docker_host', 'build_receipt_sha256'}
            and source['repository'] == manifest[repository_key] and source['tag'] == manifest[tag_key]
            and isinstance(source['local_image_id'], str) and re.fullmatch('sha256:' + HEX, source['local_image_id'])
            and all(_sha(source[k]) for k in ('docker_sha256', 'docker_path_sha256', 'build_receipt_sha256'))
            and source['docker_host'] in ('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine'))
        receipt = journal.latest(slot + 'ImagePush')
        image = resources[slot + '_image']
        repository, tag = source['repository'], source['tag']
        require(isinstance(tag, str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag))
        prefix = preparation['login_server'] + '/' + repository + '@'
        require(isinstance(image, str) and image.startswith(prefix))
        image_digest = image[len(prefix):]
        require(re.fullmatch('sha256:' + HEX, image_digest))
        base = 'https://' + preparation['login_server'] + '/v2/' + repository + '/manifests/'
        require(_successful(receipt) and imported['push_receipt_digests'][slot] == digest(receipt)
            and receipt.get('operation_id') == slot + 'ImagePush' and _sha(receipt.get('request_digest'))
            and receipt.get('object_id') == base + image_digest + '?api-version=2021-07-01'
            and receipt['properties'] == {'registry_id': preparation['registry_id'], 'login_server': preparation['login_server'],
                'repository': repository, 'manifest_digest': image_digest, 'purpose': slot})
        intents = [v for v in journal.values('intent') if v['operation_id'] == slot + 'ImagePush']
        require(len(intents) == 1 and intents[0]['request_digest'] == receipt['request_digest']
            and intents[0]['method'] == 'PUT' and intents[0]['url'] == base + tag + '?api-version=2021-07-01'
            and parse(intents[0]['at']) < parse(preparation['publish_until'])
            and parse(intents[0]['deadline']) <= parse(preparation['publish_until'])
            and parse(receipt['observed_at']) >= parse(intents[0]['at']))
    return preparation


def _prepare(bundle, manifest, resources, journal, resolver, credential):
    require(isinstance(bundle, dict) and set(bundle) == {'binding', 'push_receipt', 'scope_proof'})
    binding, push, proof = _binding(bundle['binding']), bundle['push_receipt'], bundle['scope_proof']
    ids = [manifest['ids'][k] for k in ('app', 'job', 'guard')]
    require(binding['authorized_resource_ids'] == ids
        and binding['registry_id'] == manifest['existing']['registry'] == manifest['registry']['id']
        and binding['login_server'] == manifest['registry']['loginServer']
        and binding['repository'] == manifest['cleanupImageRepository']
        and binding['repository'] != manifest['imageRepository']
        and binding['tenant_id'] == manifest['owner']['tenant_id']
        and getattr(credential, 'mode', None) == 'owner'
        and getattr(credential, 'principal', None) == manifest['owner']['principal_id']
        and getattr(credential, 'tenant', None) == binding['tenant_id'])
    image = resources['guardian_image']
    prefix = binding['login_server'] + '/' + binding['repository'] + '@'
    require(isinstance(image, str) and image.startswith(prefix))
    image_digest = image[len(prefix):]
    require(re.fullmatch('sha256:' + HEX, image_digest) is not None)
    run = journal.values('binding')
    require(len(run) == 1)
    run_digest = digest(run[0])
    preparation = _publication(manifest, resources, journal, resolver, run_digest)
    require(isinstance(proof, dict) and set(proof) == {'schema', 'initial_plan_digest', 'run_binding_digest',
        'authorized_resource_ids', 'namespace_receipt_digest'}
        and type(proof['schema']) is int and proof['schema'] == 1
        and proof['initial_plan_digest'] == resolver.plan_digest
        and proof['run_binding_digest'] == run_digest
        and proof['authorized_resource_ids'] == ids
        and digest(proof) == binding['exclusivity_evidence_digest'])
    namespaces = journal.values('guardian_image_namespace')
    require(len(namespaces) == 1 and digest(namespaces[0]) == proof['namespace_receipt_digest'])
    namespace = namespaces[0]
    require(set(namespace) == {'publication_preparation_digest', 'run_binding_digest', 'registry_id', 'login_server',
        'repository', 'method', 'url', 'http', 'error_code', 'authenticated', 'response_sha256',
        'observed_at', 'push_operation_id', 'push_request_digest'}
        and namespace['publication_preparation_digest'] == digest(preparation)
        and namespace['run_binding_digest'] == run_digest
        and all(namespace[k] == binding[k] for k in ('registry_id', 'login_server', 'repository'))
        and namespace['method'] == 'GET'
        and namespace['url'] == 'https://' + binding['login_server'] + '/acr/v1/' + binding['repository'] + '?api-version=2021-07-01'
        and type(namespace['http']) is int and namespace['http'] == 404
        and namespace['error_code'] == 'NAME_UNKNOWN' and namespace['authenticated'] is True
        and _sha(namespace['response_sha256']) and namespace['push_operation_id'] == PUSH
        and _sha(namespace['push_request_digest']))
    url = 'https://' + binding['login_server'] + '/v2/' + binding['repository'] + '/manifests/' + image_digest + '?api-version=2021-07-01'
    require(_successful(push) and push == journal.latest(PUSH) and push['operation_id'] == PUSH
        and push['request_digest'] == namespace['push_request_digest'] and push.get('object_id') == url
        and push['properties'] == {'registry_id': binding['registry_id'], 'login_server': binding['login_server'],
            'repository': binding['repository'], 'manifest_digest': image_digest, 'purpose': 'guardian'})
    intents = [v for v in journal.values('intent') if v['operation_id'] == PUSH]
    require(len(intents) == 1 and intents[0]['request_digest'] == push['request_digest']
        and intents[0]['method'] == 'PUT' and intents[0]['url'] == 'https://' + binding['login_server'] + '/v2/'
            + binding['repository'] + '/manifests/' + preparation['slots']['guardian']['tag'] + '?api-version=2021-07-01'
        and 0 <= (parse(intents[0]['at']) - parse(namespace['observed_at'])).total_seconds() <= 30)
    # A known terminal publisher ACK/readback is needed, not a local image ID.
    require(parse(push['observed_at']) >= parse(intents[0]['at']))
    deadline = resources['guardian_deadline']
    guard = resolver.resolve('guard', journal.receipts())
    require(parse(guard['cleanup']['deadline']) == parse(deadline))
    operation = {'id': IDENT, 'provider': 'AzureContainerRegistry', 'kind': 'manifest', 'method': 'DELETE',
        'url': url, 'body': None, 'deadline': deadline, 'depends_on': [PUSH],
        'expected': {'binding_digest': digest(binding), 'manifest_digest': image_digest,
            'push_request_digest': push['request_digest'], 'push_receipt_digest': digest(push)},
        'cleanup': {'created_only': True, 'zero_reference_required': True, 'purpose': 'guardian'}}
    return binding, operation


class _Inventory:
    """Read exact parents and complete unfiltered child collections, never ARM scope lists."""
    def __init__(self, binding, op, credential, http, clock, journal):
        self.binding, self.op = binding, op
        self.credential, self.http, self.clock, self.journal = credential, http, clock, journal
        self.paths = set()
        for rid in binding['authorized_resource_ids']:
            self.paths.add(rid)
            self.paths.add(rid + ('/revisions' if '/containerApps/' in rid else '/executions'))

    def _route(self, url, path, *, continuation=False):
        require(isinstance(url, str) and len(url) <= 4096)
        parsed = urlsplit(url)
        require(path in self.paths and parsed.scheme == 'https' and parsed.netloc == 'management.azure.com'
            and not parsed.fragment and parsed.path == path)
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        require(len({k for k, _ in pairs}) == len(pairs))
        query = dict(pairs)
        require(query.get('api-version') == VERSION)
        if continuation:
            token_keys = {'$skipToken', '$skiptoken', 'skipToken'} & set(query)
            require(len(token_keys) == 1 and set(query) == {'api-version'} | token_keys
                and all(0 < len(query[k]) <= 2048 and not any(ord(c) < 32 for c in query[k]) for k in token_keys))
        else:
            require(parsed.query == 'api-version=' + VERSION)
        return url

    def _get(self, url, path, *, continuation=False):
        self._route(url, path, continuation=continuation)
        # _prepare proved known ownership. The original deadline is removal_due;
        # exact cleanup observations remain bounded after it, without renewal.
        deadline = Deadline(30, self.clock.monotonic)
        token = self.credential.token(ARM + '/', deadline)
        deadline.remaining()
        self.clock.utc()
        self.journal.append('clock_observation', {'at': self.clock.utc().isoformat()})
        response = self.http('GET', url, {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}, None, deadline)
        deadline.remaining()
        now = self.clock.utc()
        self.journal.append('clock_observation', {'at': now.isoformat()})
        require(isinstance(response, dict) and type(response.get('status')) is int
            and isinstance(response.get('body'), bytes) and len(response['body']) <= MAX_BODY
            and isinstance(response.get('headers'), dict))
        headers = response['headers']
        require(all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items())
            and len({k.lower() for k in headers}) == len(headers) and len(encoded(headers)) <= 32768
            and not {'location', 'azure-asyncoperation'} & {k.lower() for k in headers}
            and not 300 <= response['status'] < 400)
        value = json.loads(response['body'])
        require(isinstance(value, dict))
        return response['status'], value

    @staticmethod
    def _images(value):
        require(isinstance(value, dict) and isinstance(value.get('properties'), dict))
        template = value['properties'].get('template')
        require(isinstance(template, dict))
        main, init = template.get('containers'), template.get('initContainers', [])
        require(isinstance(main, list) and 1 <= len(main) <= 64 and isinstance(init, list) and len(init) <= 64)
        images = []
        for row in main + init:
            require(isinstance(row, dict) and isinstance(row.get('image'), str) and 0 < len(row['image']) <= 1024)
            images.append(row['image'])
        return images

    def _collection(self, rid, images):
        kind = 'revisions' if '/containerApps/' in rid else 'executions'
        path = rid + '/' + kind
        url = ARM + path + '?api-version=' + VERSION
        seen_urls, seen_rows, count = set(), set(), 0
        for page in range(MAX_PAGES):
            require(url not in seen_urls)
            seen_urls.add(url)
            status, result = self._get(url, path, continuation=page > 0)
            require(status == 200 and isinstance(result.get('value'), list)
                and set(result) <= {'value', 'nextLink'})
            for row in result['value']:
                require(isinstance(row, dict))
                name = row.get('name')
                child = row.get('id')
                if name is None and isinstance(child, str): name = child.rsplit('/', 1)[-1]
                require(isinstance(name, str) and re.fullmatch('[a-z0-9-]{1,150}', name)
                    and name.startswith(rid.rsplit('/', 1)[1] + '-')
                    and (child is None or child == path + '/' + name) and name not in seen_rows)
                seen_rows.add(name)
                count += 1
                require(count <= MAX_ROWS)
                images.extend(self._images(row))
                require(len(images) <= MAX_IMAGES)
            following = result.get('nextLink')
            if following is None or following == '': return
            url = self._route(following, path, continuation=True)
        raise Denied('registry_inventory_page_limit')

    def collect(self, push):
        started, rows = self.clock.utc(), []
        for rid in self.binding['authorized_resource_ids']:
            observed = self.clock.utc()
            status, value = self._get(ARM + rid + '?api-version=' + VERSION, rid)
            images = []
            if status == 404:
                require(isinstance(value.get('error'), dict) and value['error'].get('code') == 'ResourceNotFound')
            else:
                require(status == 200 and value.get('id') == rid
                    and value.get('properties', {}).get('provisioningState') == 'Succeeded')
                images.extend(self._images(value))
                self._collection(rid, images)
            rows.append({'resource_id': rid, 'observed_at': observed.isoformat(), 'complete': True,
                'pages_complete': True, 'coverage': 'all_revisions' if '/containerApps/' in rid else 'template_and_all_executions',
                'images': images})
        return {'complete': True, 'foreign_references_excluded': True, 'repository_exclusive': True,
            'writers_fenced': True, 'exclusivity_evidence_digest': self.binding['exclusivity_evidence_digest'],
            'observed_at': started.isoformat(), 'push_receipt_digest': digest(push), 'object_id': self.op['url'], 'observations': rows}


def _summary(receipt):
    return {'status': receipt.get('state', 'unknown'), 'terminal': receipt.get('terminal') is True,
        'cleanup_verified': receipt.get('state') == 'succeeded' and receipt.get('readback_verified') is True,
        'manifest_only': True}


def run_registry_cleanup(bundle, manifest, resource_bindings, journal, resolver, credential, raw_wire, budget, clock):
    """One fixed action: initial DELETE, or known-ACK HEAD recovery only.

    A failed preflight has no DELETE intent and may collect fresh read evidence.
    An existing DELETE intent is permanent: absent ACK never permits resend or
    absence adoption. The original guardian removal_due stays unchanged; known
    owned cleanup and ACK verification use fresh 30-second OWNER requests after
    it too. This creates no grant and never uses an expired guardian identity.
    """
    bundle = deepcopy(bundle)
    binding, op = _prepare(bundle, manifest, resource_bindings, journal, resolver, credential)
    saved = journal.values('registry_cleanup_binding')
    fixed = {'bundle_digest': digest(bundle), 'operation': op}
    require(not saved or saved == [fixed])
    fenced = _Clock(journal, clock)
    reference_proof = None

    def final_wire(method, url, headers, body, deadline):
        # Debit/fsync and token refresh may take time. Fence at the final socket
        # boundary too, after the shared budget has spent its nonrefundable slot.
        deadline.remaining()
        fenced.utc()
        if method == 'DELETE':
            require(url == op['url'] and not fenced.unsafe and reference_proof is not None)
            provider.validate_zero_references(op, bundle['push_receipt'], reference_proof)
        return raw_wire(method, url, headers, body, deadline)

    counted = CountedControlHttp(final_wire, budget, registry_host=binding['login_server'])

    def before_send(operation):
        fenced.utc()
        require(operation == op and not fenced.unsafe)
        for intent in journal.values('intent'):
            require((journal.latest(intent['operation_id']) or {}).get('terminal') is True)
        journal.append('clock_observation', {'at': fenced.utc().isoformat()})
        journal.intent(op, fenced.utc().isoformat())

    def checkpoint(receipt): journal.checkpoint(op, receipt)

    provider = BoundedRegistryProvider(credential, counted, fenced, binding=binding,
        before_send=before_send, checkpoint=checkpoint)
    provider._operation(op)
    provider._push(op, bundle['push_receipt'])
    if not saved: journal.append('registry_cleanup_binding', fixed)
    attempted = [v for v in journal.values('intent') if v['operation_id'] == IDENT]
    if attempted:
        require(len(attempted) == 1 and attempted[0]['request_digest'] == digest(op))
        receipt = journal.latest(IDENT)
        if receipt is None:
            receipt = provider._base(op, 'unknown')
            checkpoint(receipt)
        if receipt.get('terminal') is True or receipt.get('delete_acknowledged') is not True:
            return _summary(receipt)
        return _summary(provider.readback(op, receipt))
    fenced.utc()
    require(not fenced.unsafe)
    # The same exclusive journal lock fences this run's producer/writer. A
    # pending write cannot race the complete approved inventory snapshot.
    for intent in journal.values('intent'):
        require((journal.latest(intent['operation_id']) or {}).get('terminal') is True)
    inventory = _Inventory(binding, op, credential, counted, fenced, journal)
    proof = inventory.collect(bundle['push_receipt'])
    reference_proof = proof
    proof_digest = provider.validate_zero_references(op, bundle['push_receipt'], proof)
    journal.append('registry_reference_observation', {'request_digest': digest(op), 'proof_digest': proof_digest, 'proof': proof})
    return _summary(provider.cleanup(op, bundle['push_receipt'], proof))
