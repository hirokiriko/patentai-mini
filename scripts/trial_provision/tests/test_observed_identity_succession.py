"""Fictional V6 observation followed by real V7 proof/compiler/accounting.

Only recursive historical authority verification is a sealed fixture seam.
No live file, token, wire, adoption, deletion or approval is performed.
"""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a, registry_publish as publication
from scripts.trial_provision import acknowledged_image_succession as prior
from scripts.trial_provision import observed_identity_succession as target
from scripts.trial_provision import unknown_observation as observation
from scripts.trial_provision.journal import replay_control_budget
from scripts.trial_provision.tests import test_acknowledged_image_succession as previous_fixture
from scripts.trial_provision.tests.test_attempt import chain, stamp
from scripts.trial_provision.tests.test_attempt_succession import seal
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal
from scripts.trial_provision.tests.test_operations import fixture as operations_fixture


def full_seed(base, original):
    base = deepcopy(base)
    _, manifest, bundle, _ = operations_fixture(region='fictional')
    old_group = base['manifest']['existing']['registry'].split('/providers/')[0]
    original_group = manifest['resourceGroupId']
    manifest = json.loads(json.dumps(manifest).replace(original_group, old_group))
    bundle = {k:json.loads(v.decode().replace(original_group, old_group)) for k,v in bundle.items()}
    manifest = {**base['manifest'], **manifest}
    manifest['names']['webIdentity'] = 'trial-web'
    manifest['ids']['webIdentity'] = old_group+'/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trial-web'
    bundle['manifest'] = manifest
    mh = a._sha(encoded(manifest)); bundle['annex']['fixedManifestSha256'] = mh
    ah = a._sha(encoded(bundle['annex']))
    bundle['approval'].update(fixedManifestSha256=mh,boundProposalSha256=ah)
    bundle['latest'].update(fixedManifestSha256=mh,originalProposalSha256=ah,
        priorApprovalSha256=a._sha(encoded(bundle['approval'])))
    bundle['latest']['acr']['web']['identityResourceId'] = manifest['ids']['webIdentity']
    bundle['network_approval']['networkOriginalBindingSha256'] = a._sha(encoded(bundle['network_binding']))
    base['manifest'] = manifest
    base['config']['authority_bundle'] = {k:encoded(v) for k,v in bundle.items()}
    base['config']['sources'] = {k:{'sha256':a._sha(v)} for k,v in base['config']['authority_bundle'].items()}
    return original(base)


def readback(prep, images, at):
    checks = {}
    for slot in ('guardian','runtime'):
        fixed = prep['slots'][slot]; checksum = images[slot+'_image'].rsplit('@',1)[1]
        checks[slot] = {'slot':slot,'url':'https://'+prep['login_server']+'/v2/'+fixed['repository']+
            '/manifests/'+checksum+'?api-version='+publication.VERSION,'http':200,'manifest_digest':checksum,
            'response_sha256':checksum[7:],'image_id':fixed['local_image_id'],'manifest_bytes':100,
            'compressed_content_bytes':1000,'layer_count':1,'observed_at':at}
    return {**publication._reuse_intent(prep),'checks':checks}


def fixture():
    original = previous_fixture._identity_seed
    with patch.object(previous_fixture,'_identity_seed',side_effect=lambda base:full_seed(base,original)):
        data = previous_fixture.fixture()
    previous = previous_fixture.verify(data); old = data['new']; config = old['config']
    public_raw = encoded({k:v for k,v in config.items() if k!='authority_bundle'})
    _, binding = a.journal_descriptor(config,previous)
    journal = MemoryJournal([('binding',binding)])
    prep = publication.prepare_publication({**config,'verified_attempt':previous},old['manifest'],a._sha(public_raw),journal)
    journal.rows.append(('image_reuse_readback_intent',publication._reuse_intent(prep)))
    journal.rows += [('clock_observation',{'at':stamp(25010+i)}) for i in range(6)]
    journal.rows.append(('image_reuse_readback',readback(prep,data['images'],stamp(25020))))
    for event in target.EVENTS[10:32]:journal.rows.append((event,{'fictional':event}))
    rid = old['manifest']['ids']['webIdentity']; url = 'https://management.azure.com'+rid+'?api-version=2023-01-31'
    intent = {'operation_id':'webIdentity','method':'PUT','url':url,'request_digest':'b'*64}
    receipt = {'operation_id':'webIdentity','request_digest':'b'*64,'object_id':rid,'state':'unknown','http':201,
        'ack_rejection':'unsupported_lro_headers','terminal':False,'write_terminal':False,'readback_verified':False}
    journal.rows += [('intent',intent),('progress',receipt)]
    child_raw, tail = chain(journal.rows)
    rows = deepcopy(data['counter_rows'])+[('attempt_transition',prior.transition_value(previous))]
    requests = [('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*6+[('provision','http')]*2
    rows += [('request',{'kind':'owner_arm','attempt':previous.binding_digest,'phase':p,'purpose':q}) for p,q in requests]
    counter_before = chain(rows)[0]
    stopped = {'status':'STOPPED_UNKNOWN_MANAGED_IDENTITY_ACK_V6','authority':{'sha256':a._sha(encoded(old['authority']))},
        'counter':{'sha256':a._sha(counter_before)},'child':{'sha256':a._sha(child_raw)},
        'counts':{'owner_arm':316,'owner_control_blob':32,'heartbeat_blob':0},'counter_rows':197,'child_rows':34,
        'child_tail':tail,'historical_unknowns_preserved':True,'unknown_receipt_promoted':False,
        'unknown_receipt':receipt,'new_write_intents':[intent]}
    evidence = {'counter':counter_before,'child':child_raw,'authority':encoded(old['authority']),
        'manifest':config['authority_bundle']['manifest'],'stopped':encoded(stopped)}
    grant = {'schema':1,'kind':observation.KIND,'start':stamp(28000),'end':stamp(28600),'owner':old['manifest']['owner'],
        'target':{'resource_id':rid,'url':url,'request_digest':'b'*64},'source_digests':{'fictional_observer.py':'a'*64},
        'evidence_sha256':{k:a._sha(v) for k,v in evidence.items()},'counter_binding':config['control_budget']['binding'],
        'seed':a.SEED,'directory':config['control_budget']['directory'],'child_binding':binding,'attempt':previous.binding_digest,
        'counter_rows':197,'counts':stopped['counts'],'maximum':{'http':1,'owner_token':1}}
    rows += [('request',{'kind':'owner_arm','attempt':previous.binding_digest,'phase':'provision','purpose':q})
             for q in ('owner_token','http')]
    counter, counter_tail = chain(rows); gs = a._sha(encoded(grant))
    identity = {'principalId':'00000000-0000-4000-8000-000000000004',
        'clientId':'00000000-0000-4000-8000-000000000005','tenantId':grant['owner']['tenant_id']}
    marker = {'schema':1,'kind':observation.KIND,'grant_sha256':gs,'target_digest':digest(grant['target']),
        'old_attempt':previous.binding_digest,'counter_prefix_sha256':a._sha(counter_before),'at':stamp(28001)}
    result = {'schema':1,'kind':observation.KIND,'grant_sha256':gs,'source_digests':grant['source_digests'],
        'evidence_sha256':grant['evidence_sha256'],'target_digest':digest(grant['target']),'counter_sha256':a._sha(counter),
        'counter_rows':199,'counter_tail':counter_tail,'counts':target.COUNTS,'requests':2,'automatic_retry':False,
        'old_unknown_preserved':True,'adoption_authorized':False,'deletion_authorized':False,'status':'current_exists',
        'http':200,'identity':identity,'identity_digest':digest(identity),'observed_at':stamp(28010)}
    new = deepcopy(old); authority = new['authority']; nc = new['config']; head = 'f'*40
    new['manifest']['names']['webIdentity'] += '-v7'
    new['manifest']['ids']['webIdentity'] += '-v7'
    nc['authority_bundle']['manifest'] = encoded(new['manifest'])
    nc['sources']['manifest']['sha256'] = a._sha(nc['authority_bundle']['manifest'])
    nc['frozen_head'] = head; nc['code_sources'] = {'scripts/trial_provision/observed_identity_succession.py':'f'*64}
    state = replay_control_budget(counter,binding=config['control_budget']['binding'],seed=a.SEED,
        directory=config['control_budget']['directory'],verified=previous)
    caps,reserve,delta = target.allocation(state['plan'],state['used'],state['counts'])
    proof = {'schema':6,'previous_authority_raw':encoded(old['authority']).decode(),
        'previous_activation_raw':encoded(old['activation']).decode(),'previous_publication_raw':public_raw.decode(),
        'previous_manifest_raw':evidence['manifest'].decode(),'previous_child_raw':child_raw.decode(),
        'previous_artifacts':{k:v.decode() for k,v in old['artifacts'].items()},'stopped_raw':encoded(stopped).decode(),
        'counter_prefix_raw':counter.decode(),'observation_grant_raw':encoded(grant).decode(),
        'observation_marker_raw':encoded(marker).decode(),'observation_result_raw':encoded(result).decode(),
        'image_compatibility':{'schema':1,'local_head':head,'image_build_head':previous.authority['image_build_head'],
            'runtime_tree_sha256':'c'*64,'guardian_tree_sha256':'d'*64,'review_sha256':'e'*64,
            'runtime_unchanged':True,'guardian_unchanged':True}}
    authority.update(schema=7,approval='ISSUE148_LINKED_ATTEMPT_V7',head=head,attempt_id='fictional-observed-successor',
        manifest_sha256=nc['sources']['manifest']['sha256'],origin_manifest_sha256=old['authority']['manifest_sha256'],
        code_sources_sha256=digest(nc['code_sources']),approved_at=stamp(39000),publish_from=stamp(40000),
        counts_before=target.COUNTS,phase_caps=caps,unallocated=reserve,
        identity_disposition={'kind':'retain_unknown_replace_web_identity','old_resource_id':rid,
            'new_name':new['manifest']['names']['webIdentity'],'new_resource_id':new['manifest']['ids']['webIdentity'],
            'observed_identity_digest':digest(identity),'old_unknown_preserved':True,'old_mutations_authorized':False,
            'reserves_released':False},
        succession={'schema':6,'kind':target.KIND,'proof_sha256':digest(proof),'child_name':target.CHILD_NAME,'phase_reallocation':delta})
    new['artifacts']['local_ready'] = encoded({'head':head,'design_sha256':a.DESIGN_SHA256,
        'code_sources_sha256':authority['code_sources_sha256'],'succession_proof':proof})
    new['artifacts']['limits'] = encoded({'schema':1,'head':head,'counts_before':target.COUNTS,'phase_caps':caps,
        'unallocated':reserve,'purpose_caps':a.REUSED_IMAGE_PURPOSE_CAPS,'limits':a._authority_limits(authority),
        'limit_amendment':authority['limit_amendment']})
    new['activation'].update(attempt_id=authority['attempt_id'],issued_at=stamp(39000),
        windows={k:{'start':stamp(40000+s),'end':stamp(40000+e)} for k,(s,e) in a.window_offsets(authority).items()})
    nc['publication']['publish_until'] = new['activation']['windows']['publication']['end']; seal(new)
    return {'new':new,'old':previous,'proof':proof,'counter_rows':rows,'counter_raw':counter,'child_raw':child_raw,
        'images':data['images']}


def verify(data):
    new = data['new']; parent,_ = chain(new['parent_rows']); original = a.verify_attempt
    with patch.object(a,'verify_attempt',return_value=data['old']) as historical:
        result = original(new['config'],new['manifest'],authority_raw=encoded(new['authority']),
            activation_raw=encoded(new['activation']),parent_journal_raw=parent,parent_final_raw=encoded(new['parent_final']),
            artifacts=new['artifacts'],trusted_authority_sha256=a._sha(encoded(new['authority'])),now=stamp(39000))
        historical.assert_called_once()
        assert historical.call_args.kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return result


def reseal(data):
    new = data['new']; ready = a._json(new['artifacts']['local_ready']); ready['succession_proof'] = data['proof']
    new['artifacts']['local_ready'] = encoded(ready); new['authority']['succession']['proof_sha256'] = digest(data['proof'])
    seal(new)


class ObservedIdentitySuccessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.source = fixture()

    def setUp(self):self.data = deepcopy(self.source,{id(self.source['old']):self.source['old']})

    def replay(self, rows, verified):
        c = self.data['new']['config']
        return replay_control_budget(chain(rows)[0],binding=c['control_budget']['binding'],seed=a.SEED,
            directory=c['control_budget']['directory'],verified=verified)

    def test_verified_v7_keeps_old_unknown_images_and_origin_manifest(self):
        before = self.data['counter_raw'],self.data['child_raw']
        with patch('builtins.open',side_effect=AssertionError('file')),patch('socket.create_connection',side_effect=AssertionError('wire')):
            verified = verify(self.data)
        p = a._proof(verified); self.assertEqual(p['succession']['acknowledged_images'],self.data['images'])
        self.assertEqual(p['succession']['unknown_identity_receipt']['state'],'unknown')
        self.assertNotEqual(a.origin_manifest_hash(verified.authority),verified.authority['manifest_sha256'])
        self.assertEqual(before,(self.data['counter_raw'],self.data['child_raw']))
        self.assertEqual(a.window_offsets({'schema':7}),a.window_offsets({'schema':6}))

    def test_exact_313_remaining_and_120_cleanup_no_reset_or_retry(self):
        verified = verify(self.data); prefix = self.data['counter_rows']+[('attempt_transition',target.transition_value(verified))]
        rows = deepcopy(prefix)
        for phase,http,tokens in (('fresh_read',7,1),('publication',6,2),('provision',135,10),('run',24,8),('cleanup',120,0)):
            rows += [('request',{'kind':'owner_arm','attempt':verified.binding_digest,'phase':phase,'purpose':purpose})
                for purpose,count in (('http',http),('owner_token',tokens)) for _ in range(count)]
        state = self.replay(rows,verified)
        self.assertEqual(state['counts']['owner_arm'],631); self.assertEqual(len(state['transitions']),6)
        self.assertEqual(state['used']['owner_arm']['cleanup'],120)
        for changed in (prefix+[prefix[-1]],rows+[rows[-1]],prefix+[('request',{'kind':'owner_arm',
                'attempt':self.data['old'].binding_digest,'phase':'provision','purpose':'http'})]):
            with self.assertRaises(Denied):self.replay(changed,verified)

    def test_single_target_change_and_no_old_resource_adoption(self):
        for mutation in ('same','worker','cap','retain','delete','reserve','digest'):
            with self.subTest(mutation=mutation):
                data = deepcopy(self.data,{id(self.data['old']):self.data['old']}); n = data['new']; d = n['authority']['identity_disposition']
                if mutation=='same':
                    d['new_resource_id'] = d['old_resource_id']; d['new_name'] = d['old_resource_id'].rsplit('/',1)[1]
                    n['manifest']['ids']['webIdentity'] = d['new_resource_id']; n['manifest']['names']['webIdentity'] = d['new_name']
                elif mutation=='worker':n['manifest']['ids']['workerIdentity'] += '-changed'
                elif mutation=='cap':n['authority']['phase_caps']['owner_arm']['fresh_read'] += 1
                elif mutation=='retain':d['old_unknown_preserved'] = False
                elif mutation=='delete':d['old_mutations_authorized'] = True
                elif mutation=='reserve':d['reserves_released'] = True
                else:d['observed_identity_digest'] = '0'*64
                raw = encoded(n['manifest']); n['config']['authority_bundle']['manifest'] = raw
                n['authority']['manifest_sha256'] = n['config']['sources']['manifest']['sha256'] = a._sha(raw); reseal(data)
                with self.assertRaises(Denied):verify(data)

    def test_observation_and_prefix_cannot_be_promoted_or_rewritten(self):
        for field,value in (('status','current_absent'),('http',404),('requests',1),('automatic_retry',True),
                ('old_unknown_preserved',False),('adoption_authorized',True),('identity_digest','0'*64),
                ('counter_sha256','0'*64),('observed_at',stamp(39001))):
            data = deepcopy(self.data,{id(self.data['old']):self.data['old']})
            result = json.loads(data['proof']['observation_result_raw']); result[field] = value
            data['proof']['observation_result_raw'] = encoded(result).decode(); reseal(data)
            with self.subTest(field=field),self.assertRaises(Denied):verify(data)
        self.data['proof']['counter_prefix_raw'] += '\n'; reseal(self.data)
        with self.assertRaises(Denied):verify(self.data)

    def test_old_image_ack_new_reuse_readback_and_real_resource_compiler(self):
        from scripts.trial_provision.resources import build_resource_operations
        from scripts.trial_provision.plan import build_plan
        from scripts.trial_provision.operations import create_resolver
        from scripts.trial_provision.tests.test_plan import guid
        verified = verify(self.data); n = self.data['new']; c = n['config']; manifest = n['manifest']
        journal = MemoryJournal([('binding',a.journal_descriptor(c,verified)[1])])
        prep = publication.prepare_publication({**c,'verified_attempt':verified},manifest,'1'*64,journal)
        self.assertEqual(prep['schema'],2)
        self.assertEqual(prep['origin_source_sha256']['manifest'],a.origin_manifest_hash(verified.authority))
        self.assertEqual(prep['source_sha256']['manifest'],verified.authority['manifest_sha256'])
        journal.rows += [('image_reuse_readback_intent',publication._reuse_intent(prep)),
            ('image_reuse_readback',readback(prep,self.data['images'],stamp(40020)))]
        self.assertEqual(publication.verified_publication_images(journal,verified_attempt=verified),self.data['images'])
        rb = {**self.data['images'],'code_sha':verified.authority['image_build_head'],
            'deadline':verified.activation['windows']['owner_input']['end'],
            'guardian_deadline':verified.activation['windows']['guardian']['end'],
            'db_secret_digests':{'web':'c'*64,'worker':'d'*64}}
        resources = build_resource_operations(manifest,c['authority_bundle'],rb)
        bindings = {'owner_window':verified.activation['windows']['owner_input'],'guardian_window':verified.activation['windows']['guardian'],
            'prerequisite_digests':{op['id']:digest(op) for op in resources}}
        allocated = {}; allocate = lambda key:allocated.setdefault(key,guid(1000+len(allocated)))
        core = build_plan(manifest,c['authority_bundle'],bindings,stamp(40600),allocate,verified_attempt=verified)
        resolver = create_resolver(core,manifest,c['authority_bundle'],rb)
        op = resolver.resolve('webIdentity',{})
        self.assertEqual(op['expected']['resource_id'],manifest['ids']['webIdentity'])
        self.assertTrue(op['expected']['before_absent'])
        self.assertEqual(core['source_sha256']['manifest'],verified.authority['manifest_sha256'])
        self.assertNotEqual(op['expected']['resource_id'],verified.authority['identity_disposition']['old_resource_id'])
        imported = publication._reused_import(journal,resolver,rb,verified)
        journal.rows.append(('publication_import',imported))
        self.assertEqual(publication.verify_reused_import(journal,resolver,rb,verified),imported)


if __name__ == '__main__':unittest.main()
