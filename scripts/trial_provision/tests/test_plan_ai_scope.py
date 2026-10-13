"""Cross-resource-group C7 regression; fictional metadata and memory only."""
from contextlib import ExitStack
from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import attempt, cli, plan, publication_bridge
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.resources import build_resource_operations
from scripts.trial_provision.tests import test_acknowledged_image_succession as succession
from scripts.trial_provision.tests.test_operations import fixture as operations_fixture, receipt
from scripts.trial_provision.tests.test_plan import guid
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal


def full_seed(base):
    """Add the existing complete compiler fixture before historical seals exist."""
    base = deepcopy(base)
    _, manifest, sources, _ = operations_fixture()
    manifest = json.loads(encoded(manifest).replace(b'fictional-test-only', b'fictional'))
    sources = {key: raw.replace(b'fictional-test-only', b'fictional') for key, raw in sources.items()}
    network = json.loads(sources['network_approval'])
    network['networkOriginalBindingSha256'] = hashlib.sha256(sources['network_binding']).hexdigest()
    sources['network_approval'] = encoded(network)
    previous = base['manifest']
    manifest['existing']['registry'] = previous['existing']['registry']
    manifest['registry']['id'] = previous['existing']['registry']
    for key in ('imageRepository', 'cleanupImageRepository', 'imageTag', 'cleanupImageTag'):
        manifest[key] = previous[key]
    subscription = manifest['resourceGroupId'].split('/resourceGroups/')[0]
    manifest['existing']['ai'] = (subscription + '/resourceGroups/fictional-ai-eastus'
        '/providers/Microsoft.CognitiveServices/accounts/fictional-ai-fixed')
    sources['manifest'] = encoded(manifest)
    mh = hashlib.sha256(sources['manifest']).hexdigest()
    annex, approval, latest = (json.loads(sources[key]) for key in ('annex', 'approval', 'latest'))
    annex['acr']['fixedRegistryResourceId'] = manifest['existing']['registry']
    annex['fixedManifestSha256'] = mh
    sources['annex'] = encoded(annex)
    ah = hashlib.sha256(sources['annex']).hexdigest()
    approval.update(boundProposalSha256=ah, fixedManifestSha256=mh)
    sources['approval'] = encoded(approval)
    latest['acr']['registryResourceId'] = manifest['existing']['registry']
    latest.update(fixedManifestSha256=mh, originalProposalSha256=ah,
        priorApprovalSha256=hashlib.sha256(sources['approval']).hexdigest())
    sources['latest'] = encoded(latest)
    base['manifest'] = manifest
    config = base['config']
    config['authority_bundle'] = sources
    config['sources'] = {key: {'path': '/fictional/'+key+'.json',
        'sha256': hashlib.sha256(raw).hexdigest()} for key, raw in sources.items()}
    config['control_budget']['binding']['manifest_sha256'] = mh
    base['authority']['manifest_sha256'] = mh
    binding = base['parent_rows'][0][1]
    binding['manifest_sha256'] = mh
    prep = next(value for event, value in base['parent_rows'] if event == 'publication_preparation')
    prep.update(manifest_sha256=mh, run_binding_digest=digest(binding))
    for event, value in base['parent_rows']:
        if event.endswith('_image_namespace'):
            value.update(publication_preparation_digest=digest(prep), run_binding_digest=digest(binding))
    for slot in ('guardian', 'runtime'):
        build = json.loads(base['artifacts'][slot+'_build'])
        build['manifest_sha256'] = mh
        base['artifacts'][slot+'_build'] = encoded(build)
        config['publication']['slots'][slot]['build_receipt']['sha256'] = hashlib.sha256(encoded(build)).hexdigest()
    return base


class AiScopeTests(unittest.TestCase):
    def setUp(self):
        with patch.object(succession, '_identity_seed', side_effect=full_seed):
            self.data = succession.fixture()
        self.verified = succession.verify(self.data)
        self.manifest = self.data['new']['manifest']
        self.sources = self.data['new']['config']['authority_bundle']
        self.windows = self.verified.activation['windows']
        self.resource = {'deadline': self.windows['owner_input']['end'],
            'guardian_deadline': self.windows['guardian']['end'],
            **self.data['images'], 'code_sha': self.verified.authority['image_build_head'],
            'db_secret_digests': {'web': 'c'*64, 'worker': 'd'*64}}
        resources = build_resource_operations(self.manifest, self.sources, self.resource)
        self.bindings = {'guardian_window': self.windows['guardian'], 'owner_window': self.windows['owner_input'],
            'prerequisite_digests': {op['id']: digest(op) for op in resources},
            'allocated_ids': {slot: guid(1000+n) for n, slot in enumerate(
                ['C5', 'C6', 'C7', 'OWNER_APP_ROLE']+['R'+str(n) for n in range(1, 11)])}}
        self.now = self.windows['publication']['start']
        self.allocate = Mock(side_effect=AssertionError('new allocation'))

    def build(self, verified):
        return plan.build_plan(self.manifest, self.sources, self.bindings, self.now,
            self.allocate, verified_attempt=verified)

    def test_canonical_v6_compiler_resolver_and_r6_r7_use_exact_fixed_ai(self):
        before = (self.data['proof']['previous_child_raw'], self.data['counter_raw'])
        core = self.build(self.verified)
        resolver = create_resolver(core, self.manifest, self.sources, self.resource)
        c7 = resolver.resolve('C7', {})
        props = c7['body']['properties']
        ai = self.manifest['existing']['ai']
        self.assertFalse(ai.startswith(self.manifest['resourceGroupId']+'/'))
        self.assertEqual([ai], props['assignableScopes'])
        self.assertEqual([ai], c7['expected']['properties']['properties.assignableScopes'])
        self.assertEqual(digest(c7['body']), c7['expected']['body_sha256'])
        self.assertEqual([{'actions': [], 'notActions': [],
            'dataActions': ['Microsoft.CognitiveServices/accounts/OpenAI/responses/write'],
            'notDataActions': []}], props['permissions'])
        self.assertTrue(c7['expected']['resource_id'].startswith(
            self.manifest['resourceGroupId'].split('/resourceGroups/')[0]+'/providers/Microsoft.Authorization/roleDefinitions/'))
        receipts = {'C7': receipt(c7)}
        for n, role in enumerate(('webIdentity', 'workerIdentity')):
            op = resolver.resolve(role, {})
            receipts[role] = receipt(op, {'principalId': guid(900+n),
                'tenantId': self.manifest['owner']['tenant_id'], 'clientId': guid(910+n)})
        for slot in ('R6', 'R7'):
            assignment = resolver.resolve(slot, receipts)
            self.assertTrue(assignment['expected']['resource_id'].startswith(ai+'/providers/Microsoft.Authorization/roleAssignments/'))
            self.assertEqual(c7['expected']['resource_id'], assignment['body']['properties']['roleDefinitionId'])
        legacy = self.build(None)
        changed = {slot for slot in core['operations'] if core['operations'][slot] != legacy['operations'][slot]}
        self.assertEqual({'C7'}, changed)
        self.assertEqual(29, len(core['operations']))
        self.assertEqual(before, (self.data['proof']['previous_child_raw'], self.data['counter_raw']))
        self.assertEqual('unknown', attempt._proof(self.verified)['succession']['unknown_identity_receipt']['state'])

    def test_legacy_v5_seal_retains_exact_original_plan_bytes(self):
        self.assertEqual(plan.canonical_json(self.build(None)), plan.canonical_json(self.build(self.data['old'])))

    def test_unsealed_or_different_manifest_stops_before_allocation(self):
        for bad in ({'schema': 6}, SimpleNamespace(authority={'schema': 6}), True):
            with self.subTest(bad=type(bad)), self.assertRaises(Denied):
                self.build(bad)
        other = succession.verify(succession.fixture())
        with self.assertRaisesRegex(plan.PlanError, 'attempt_manifest_binding'):
            self.build(other)
        self.allocate.assert_not_called()

    def test_bridge_compiles_same_sealed_plan_with_fixed_scope(self):
        publication = {'manifest': self.manifest, 'authority_bundle': self.sources,
            'verified_attempt': self.verified}
        config = {'plan_bindings': {k: self.bindings[k] for k in ('guardian_window', 'owner_window')},
            'resource_bindings': self.resource}
        core = publication_bridge._core_plan(publication, config, self.now,
            lambda slot: self.bindings['allocated_ids'][slot])
        self.assertEqual(self.build(self.verified), core)

    def test_normal_prepare_dispatch_passes_same_seal_to_real_compiler(self):
        config = {**self.data['new']['config'], 'verified_attempt': self.verified,
            'plan_bindings': {k: self.bindings[k] for k in ('guardian_window', 'owner_window')},
            'resource_bindings': self.resource, 'policy_verifier_node': '/fictional/node.exe'}
        journal = MemoryJournal([])
        journal.allocate_id = lambda slot: self.bindings['allocated_ids'][slot]
        journal.fix_plan = lambda value: journal.append('plan', value)
        journal.receipts = lambda: {}
        budget = Mock()
        budget.count.return_value = 302
        path = Mock()
        path.is_absolute.return_value = True
        path.is_symlink.return_value = False
        path.read_bytes.return_value = encoded({'sources': config['sources']})
        with ExitStack() as stack:
            for name, value in (('Path', path), ('git', config['frozen_head'].encode()),
                ('private_bytes', encoded(self.manifest)), ('load_configuration', config),
                ('local_sources', config['code_sources']), ('policy_verifier', Mock())):
                stack.enter_context(patch.object(cli, name, return_value=value))
            stack.enter_context(patch.object(cli, 'verify_owner_file'))
            stack.enter_context(patch.object(cli, 'Journal')).return_value.__enter__.return_value = journal
            stack.enter_context(patch.object(cli, 'ControlBudget')).return_value.__enter__.return_value = budget
            stack.enter_context(patch.object(cli, 'AzureCredential', side_effect=AssertionError('auth')))
            stack.enter_context(patch.object(cli, 'BoundedHttp', side_effect=AssertionError('network')))
            result = cli.run_command({'config': '/fictional/config.json', 'action': 'prepare'},
                clock=SimpleNamespace(utc=lambda: parse(self.now)))
        self.assertEqual('prepared', result['status'])
        self.assertEqual(0, result['cloud_calls'])
        self.assertEqual(self.build(self.verified), journal.values('core_plan')[0])
        budget.begin_attempt.assert_called_once_with(self.verified, initialize=True)


if __name__ == '__main__':
    unittest.main()
