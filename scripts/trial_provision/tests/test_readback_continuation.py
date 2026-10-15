"""Fictional V7 readback continuation; no credentials or live evidence."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import attempt as a, readback_continuation as target
from scripts.trial_provision import observed_identity_succession as prior
from scripts.trial_provision import publication_bridge as bridge, registry_publish as publication
from scripts.trial_provision.journal import Journal, replay_control_budget
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.private_io import create_owner_file, verify_owner_file
from scripts.trial_provision.tests import test_observed_identity_succession as old_fixture
from scripts.trial_provision.tests.test_attempt import chain, stamp
from scripts.trial_provision.tests.test_attempt_succession import seal
from scripts.trial_provision.tests.test_private_io import create_owner_directory
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal


def fixture():
    data = old_fixture.fixture()
    old_ready = a._json(data['new']['artifacts']['local_ready'])
    old_ready['metadata_basis'] = {'path':str(Path.cwd()/'fictional-metadata.json'),'sha256':'d'*64}
    data['new']['artifacts']['local_ready'] = encoded(old_ready); seal(data['new'])
    previous = old_fixture.verify(data)
    old = data['new']; config = old['config']; public_raw = encoded({k:v for k,v in config.items() if k != 'authority_bundle'})
    journal = MemoryJournal([('binding', a.journal_descriptor(config, previous)[1])])
    prep = publication.prepare_publication({**config, 'verified_attempt': previous}, old['manifest'], a._sha(public_raw), journal)
    journal.rows += [('image_reuse_readback_intent', publication._reuse_intent(prep))]
    journal.rows += [('clock_observation', {'at': stamp(40010+i)}) for i in range(6)]
    readback = old_fixture.readback(prep, data['images'], stamp(40020))
    readback['checks']['guardian']['observed_at'] = stamp(40013)
    journal.rows += [('image_reuse_readback', readback)]
    child_raw, tail = chain(journal.rows)
    rows = data['counter_rows'] + [('attempt_transition', prior.transition_value(previous))]
    rows += [('request', {'kind': 'owner_arm', 'attempt': previous.binding_digest, 'phase': p, 'purpose': q})
             for p, q in [('fresh_read', 'owner_token')] + [('fresh_read', 'http')]*5 + [('publication', 'http')]*6]
    counter_raw = chain(rows)[0]
    fresh = {'schema': 1, 'head': old['authority']['head'], 'attempt_binding_digest': previous.binding_digest,
        'status': 'fixed_metadata_verified', 'cloud_mutations': 0, 'automatic_retry': False, 'ip_checked': True,
        'ip_sources': [{'source': 'fictional-a'}, {'source': 'fictional-b'}],
        'counts_before': old['authority']['counts_before'], 'counts_after': {**target.COUNTS, 'owner_arm': 324},
        'requests': [{'alias': alias, 'http': 200} for alias in ('registry', 'environment', 'ai', 'normal', 'fast')],
        'started_at': stamp(40001), 'completed_at': stamp(40005)}
    state = replay_control_budget(counter_raw, binding=config['control_budget']['binding'], seed=a.SEED,
        directory=config['control_budget']['directory'], verified=previous)
    caps, reserve, delta = target.allocation(state['plan'], state['used'], state['counts'])
    stopped = {'status': 'STOPPED_V7_LOCAL_BRIDGE_BEFORE_RESOURCE_WRITES', 'head': old['authority']['head'],
        'counts': target.COUNTS, 'counter_rows': 212, 'child_rows': 10, 'child_tail': tail,
        'new_resource_write_intents': 0, 'bridge_intent_created': False, 'core_plan_created': False,
        'old_unknown_preserved': True, 'reserves_released': False, 'automatic_retry': False,
        'operator_closed': True, 'owner_token_pool_closed': True, 'recorded_at': stamp(50000),
        'remaining_owner_arm': caps['owner_arm'],
        'evidence': {k: {'sha256': a._sha(v)} for k,v in {'counter': counter_raw, 'child': child_raw,
            'authority': encoded(old['authority']), 'fresh_result': encoded(fresh)}.items()}}
    new = deepcopy(old); authority = new['authority']; c = new['config']; head = 'e'*40
    c.update(frozen_head=head, code_sources={'scripts/trial_provision/readback_continuation.py': 'e'*64})
    proof = {'schema': 7, 'previous_authority_raw': encoded(old['authority']).decode(),
        'previous_activation_raw': encoded(old['activation']).decode(), 'previous_publication_raw': public_raw.decode(),
        'previous_child_raw': child_raw.decode(), 'previous_artifacts': {k:v.decode() for k,v in old['artifacts'].items()},
        'stopped_raw': encoded(stopped).decode(), 'counter_prefix_raw': counter_raw.decode(),
        'fresh_result_raw': encoded(fresh).decode(),
        'fresh_intent_raw': encoded({k:v for k,v in {**fresh, 'status':'unconfirmed', 'maximum_owner_arm_debits':6,
            'metadata_basis':old_ready['metadata_basis'],
            'requests':[], 'metadata':{}, 'ip_checked':False}.items() if k not in ('counts_after','completed_at','ip_sources')}).decode(),
        'image_compatibility': {**data['proof']['image_compatibility'], 'local_head': head}}
    authority.update(schema=8, approval='ISSUE148_LINKED_ATTEMPT_V8', head=head, attempt_id='fictional-v7-continuation',
        code_sources_sha256=digest(c['code_sources']), approved_at=stamp(59000), publish_from=stamp(60000),
        counts_before=target.COUNTS, phase_caps=caps, unallocated=reserve,
        succession={'schema': 7, 'kind': target.KIND, 'proof_sha256': digest(proof),
            'child_name': target.CHILD_NAME, 'phase_reallocation': delta})
    new['artifacts']['local_ready'] = encoded({'head': head, 'design_sha256': a.DESIGN_SHA256,
        'code_sources_sha256': authority['code_sources_sha256'], 'succession_proof': proof})
    new['artifacts']['limits'] = encoded({'schema': 1, 'head': head, 'counts_before': target.COUNTS,
        'phase_caps': caps, 'unallocated': reserve, 'purpose_caps': a.purpose_caps(authority),
        'limits': a._authority_limits(authority), 'limit_amendment': authority['limit_amendment']})
    new['activation'].update(attempt_id=authority['attempt_id'], issued_at=stamp(59000),
        windows={k: {'start': stamp(60000+s), 'end': stamp(60000+e)} for k,(s,e) in a.window_offsets(authority).items()})
    c['publication']['publish_until'] = new['activation']['windows']['publication']['end']; seal(new)
    return {'new': new, 'old': previous, 'proof': proof, 'counter_rows': rows, 'counter_raw': counter_raw,
        'child_raw': child_raw, 'images': data['images'], 'v7': data}


def verify(data):
    n = data['new']; parent = chain(n['parent_rows'])[0]; original = a.verify_attempt
    with patch.object(a, 'verify_attempt', return_value=data['old']) as historical:
        result = original(n['config'], n['manifest'], authority_raw=encoded(n['authority']),
            activation_raw=encoded(n['activation']), parent_journal_raw=parent, parent_final_raw=encoded(n['parent_final']),
            artifacts=n['artifacts'], trusted_authority_sha256=a._sha(encoded(n['authority'])), now=stamp(59000))
        historical.assert_called_once()
        assert historical.call_args.kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return result


def reseal(data):
    n = data['new']; ready = a._json(n['artifacts']['local_ready']); ready['succession_proof'] = data['proof']
    n['artifacts']['local_ready'] = encoded(ready); n['authority']['succession']['proof_sha256'] = digest(data['proof']); seal(n)


class ReadbackContinuationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.source = fixture()

    def setUp(self): self.data = deepcopy(self.source, {id(self.source['old']): self.source['old'], id(self.source['v7']['old']): self.source['v7']['old']})

    def replay(self, rows, verified):
        c = self.data['new']['config']
        return replay_control_budget(chain(rows)[0], binding=c['control_budget']['binding'], seed=a.SEED,
                                    directory=c['control_budget']['directory'], verified=verified)

    def test_remaining_caps_and_history_keep_631_and_protected_cleanup(self):
        verified = verify(self.data); prefix = self.data['counter_rows'] + [('attempt_transition', target.transition_value(verified))]
        self.assertEqual(self.replay(prefix, verified)['counts'], target.COUNTS)
        rows = prefix[:]
        for phase, http, tokens in (('fresh_read',16,2), ('publication',0,0), ('provision',135,4), ('run',21,3), ('cleanup',119,1)):
            rows += [('request', {'kind':'owner_arm', 'attempt':verified.binding_digest, 'phase':phase, 'purpose':purpose})
                     for purpose, count in (('http',http), ('owner_token',tokens)) for _ in range(count)]
        self.assertEqual(self.replay(rows, verified)['counts']['owner_arm'], 631)
        for bad in (prefix+[prefix[-1]], rows+[rows[-1]], prefix+[('request', {
                'kind':'owner_arm', 'attempt':self.data['old'].binding_digest, 'phase':'provision', 'purpose':'http'})]):
            with self.assertRaises(Denied): self.replay(bad, verified)

    def test_no_initial_metadata_or_publication_allowance_is_reissued(self):
        verified = verify(self.data); prefix = self.data['counter_rows'] + [('attempt_transition', target.transition_value(verified))]
        for phase, purpose, count in (('publication','http',1), ('publication','owner_token',1),
                                     ('fresh_read','http',17), ('fresh_read','owner_token',3)):
            rows = prefix + [('request', {'kind':'owner_arm', 'attempt':verified.binding_digest,
                     'phase':phase, 'purpose':purpose})]*count
            with self.subTest(phase=phase, purpose=purpose), self.assertRaises(Denied): self.replay(rows, verified)

    def test_changed_or_resource_writing_parent_is_rejected(self):
        for field in ('previous_child_raw','counter_prefix_raw','fresh_result_raw','stopped_raw'):
            case = deepcopy(self.data, {id(self.data['old']):self.data['old'], id(self.data['v7']['old']):self.data['v7']['old']})
            if field.endswith('child_raw'):
                old = [a._json(line) for line in case['proof'][field].encode().splitlines()]
                case['proof'][field] = chain([(r['event'],r['value']) for r in old]+[('intent',{'operation_id':'webIdentity'})])[0].decode()
            elif field=='counter_prefix_raw': case['proof'][field] += '\n'
            else:
                value = json.loads(case['proof'][field]); value['status'] = 'unconfirmed'; case['proof'][field] = encoded(value).decode()
            reseal(case)
            with self.subTest(field=field), self.assertRaises(Denied): verify(case)

    def test_same_resource_and_unknown_holds_cannot_change(self):
        for key in ('identity_disposition','origin_manifest_sha256','image_build_head'):
            case = deepcopy(self.data, {id(self.data['old']):self.data['old'], id(self.data['v7']['old']):self.data['v7']['old']})
            if key=='identity_disposition': case['new']['authority'][key]['reserves_released'] = True
            else: case['new']['authority'][key] = '0'*len(case['new']['authority'][key])
            reseal(case)
            with self.subTest(key=key), self.assertRaises(Denied): verify(case)

    def test_real_v7_and_continuation_bridge_output_feeds_resource_plan(self):
        for data, verified, expected_name, observed_at in ((self.data['v7'], self.data['old'], 'provision-successor-v7-config.json',40020),
                (self.data, verify(self.data), 'provision-continuation-v7r1-config.json',60020)):
            n = data['new']
            with self.subTest(schema=verified.authority['schema']), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve() / 'owner'; create_owner_directory(directory)
                def write(name, value):
                    raw = value if isinstance(value, bytes) else encoded(value); path = directory/name
                    with os.fdopen(create_owner_file(path), 'wb') as stream: stream.write(raw)
                    return {'path':str(path),'sha256':a._sha(raw)}
                node = write('node.exe' if os.name=='nt' else 'node', b'fixture-never-executed')
                c = deepcopy(n['config']); c.update(schema=1, ci={'path':str(directory/'absent-ci.json'),'sha256':'a'*64},
                    recovery={'directory':str(directory),'directory_digest':digest(str(directory))},
                    attempt_evidence={'authority':write('authority.json',encoded(n['authority'])),
                        'parent_final':write('parent-final.json',encoded(n['parent_final'])),
                        'artifacts':{k:write('artifact-'+k+'.json',v) for k,v in n['artifacts'].items()}})
                c['sources'] = {k:{'path':str(directory/('source-'+k+'.json')),'sha256':a._sha(v)} for k,v in c['authority_bundle'].items()}
                public_raw = encoded({k:v for k,v in c.items() if k!='authority_bundle'})
                loaded = {**c,'manifest':n['manifest'],'verified_attempt':verified,'config_sha256':a._sha(public_raw)}
                name,binding = a.journal_descriptor(loaded,verified); w = verified.activation['windows']
                inputs = {'schema':1,'publication_config_sha256':loaded['config_sha256'],
                    'plan_bindings':{'guardian_window':w['guardian'],'owner_window':w['owner_input']},
                    'deadline':w['owner_input']['end'],'policy_verifier_node':node['path'],
                    'secret_sources':{'trial-web-database':{'path':str(directory/'absent-web.secret'),'sha256':'c'*64},
                                      'trial-worker-database':{'path':str(directory/'absent-worker.secret'),'sha256':'d'*64}}}
                input_ref = write('bridge-input.json',inputs)
                with Journal(str(directory),digest(str(directory)),binding,name=name) as journal:
                    prep = publication.prepare_publication(loaded,n['manifest'],loaded['config_sha256'],journal)
                    if verified.authority['schema']==7:
                        journal.append('image_reuse_readback_intent',publication._reuse_intent(prep))
                        journal.append('image_reuse_readback',old_fixture.readback(prep,data['images'],stamp(observed_at)))
                    frozen = bridge.prepare_bridge(loaded,journal,input_ref,now=parse(stamp(observed_at+580)))
                    output = directory/expected_name; self.assertEqual(frozen['output']['path'],str(output)); verify_owner_file(output)
                    raw = output.read_bytes(); self.assertEqual(a._sha(raw),frozen['output']['sha256']); config=json.loads(raw)
                    self.assertEqual(config['frozen_head'],verified.authority['head'])
                    self.assertEqual(config['resource_bindings']['code_sha'],verified.authority['image_build_head'])
                    resolver = create_resolver(journal.values('core_plan')[0],n['manifest'],c['authority_bundle'],config['resource_bindings'])
                    journal.fix_plan(resolver.initial_plan)
                    publication.bind_publication(journal,resolver,config['resource_bindings'],verified_attempt=verified)
                    op = resolver.resolve('webIdentity',journal.receipts())
                    self.assertEqual(op['expected']['resource_id'],n['manifest']['ids']['webIdentity']); self.assertTrue(op['expected']['before_absent'])
                    for event in ('provision_bridge_intent','provision_bridge_output','core_plan','plan','publication_import'):
                        self.assertEqual(len(journal.values(event)),1,event)
                    self.assertEqual(journal.values('intent'),[])
                    if verified.authority['schema']==8:
                        self.assertEqual(journal.values('image_reuse_readback'),[])
                        self.assertEqual(journal.values('image_reuse_readback_intent'),[])
                        self.assertEqual(journal.values('publication_import')[0]['image_reuse_readback_digest'],a._proof(verified)['succession']['inherited_readback_sha256'])
                    self.assertFalse((directory/'absent-web.secret').exists())

    def test_publication_cli_to_real_normal_prepare_and_fixed_foundation_plan(self):
        from contextlib import ExitStack
        from scripts.trial_provision import cli, registry_publish_cli as publisher, publication_configuration
        from scripts.trial_provision.configuration import SOURCE_FILES
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, 'cwd', return_value=Path(temporary).resolve()): data = fixture()
            verified = verify(data); n = data['new']; c = deepcopy(n['config'])
            directory = Path(c['recovery']['directory']); create_owner_directory(directory)
            def write(name, value):
                raw = value if isinstance(value,bytes) else encoded(value); path=directory/name
                with os.fdopen(create_owner_file(path),'wb') as stream: stream.write(raw)
                return {'path':str(path),'sha256':a._sha(raw)}
            write('trial-provision.jsonl',chain(n['parent_rows'])[0])
            write('trial-control-budget.jsonl',data['counter_raw'])
            write('trial-provision-successor-v7.jsonl',data['child_raw'])
            write('trial-control-budget.lock',b'')
            write('trial-provision-successor-v7.lock',b'')
            c['sources']={k:write(SOURCE_FILES[k],v) for k,v in c.pop('authority_bundle').items()}
            c.update(schema=1,live=True,ci=write('ci.json',{'head_sha':n['authority']['head'],
                'status':'completed','conclusion':'success','required_checks':[{'name':name,'status':'completed','conclusion':'success'}
                    for name in ('ci','isolated-pg16')],'source_url':'https://github.com/hirokiriko/patentai-mini/actions/runs/123',
                'checked_at':stamp(59000)}))
            c['attempt']=write('activation.json',n['activation'])
            c['attempt_evidence']={'authority':write('authority.json',n['authority']),
                'parent_final':write('parent-final.json',n['parent_final']),
                'artifacts':{k:write('artifact-'+k+'.json',v) for k,v in n['artifacts'].items()}}
            for slot in ('guardian','runtime'): c['publication']['slots'][slot]['build_receipt']=c['attempt_evidence']['artifacts'][slot+'_build']
            reference=write('publication.json',c); w=verified.activation['windows']
            inputs={'schema':1,'publication_config_sha256':reference['sha256'],
                'plan_bindings':{'guardian_window':w['guardian'],'owner_window':w['owner_input']},
                'deadline':w['owner_input']['end'],'policy_verifier_node':write('node.exe',b'never executed')['path'],
                'secret_sources':{'trial-web-database':{'path':str(directory/'absent-web.secret'),'sha256':'c'*64},
                                  'trial-worker-database':{'path':str(directory/'absent-worker.secret'),'sha256':'d'*64}}}
            bridge_ref=write('bridge-input.json',inputs); clock=Mock();clock.utc.return_value=parse(stamp(60000));clock.monotonic.return_value=1
            original=a.verify_attempt
            def historical(*args,**kwargs):
                if kwargs['authority_raw']==data['proof']['previous_authority_raw'].encode():return data['old']
                return original(*args,**kwargs)
            with ExitStack() as stack:
                stack.enter_context(patch.object(a,'verify_attempt',side_effect=historical))
                # Only Git/source/Docker observations and external transport are seams.
                stack.enter_context(patch.object(publication_configuration,'_executable'))
                for module in (cli,publisher):
                    stack.enter_context(patch.object(module,'git',return_value=(n['authority']['head']+'\n').encode()))
                    stack.enter_context(patch.object(module,'local_sources',return_value=c['code_sources']))
                    stack.enter_context(patch.object(module,'AzureCredential',side_effect=AssertionError('credential')))
                    stack.enter_context(patch.object(module,'BoundedHttp',side_effect=AssertionError('http')))
                def run(action,**extra):
                    return publisher.run_command({'config':reference['path'],'action':action,**extra},clock=clock,
                        wire=Mock(side_effect=AssertionError('wire')),trusted_attempt_authority=c['attempt_evidence']['authority']['sha256'])
                counter_before=(directory/'trial-control-budget.jsonl').read_bytes()
                child=directory/(target.CHILD_NAME+'.jsonl')
                for action in ('verify-reused-images','publish','cleanup-publication'):
                    with self.assertRaises(Denied):run(action,**({'slot':'guardian'} if action=='publish' else {}))
                    self.assertFalse(child.exists());self.assertEqual(counter_before,(directory/'trial-control-budget.jsonl').read_bytes())
                self.assertEqual(run('prepare')['control_requests_used'],330)
                result=run('bind-provision',provision=bridge_ref)
                self.assertEqual(result['status'],'provision_prepared');self.assertEqual(result['cloud_calls'],0)
                self.assertEqual(result['config_file'],'provision-continuation-v7r1-config.json')
                normal=cli.run_command({'config':str(directory/result['config_file']),'action':'status'},clock=clock,
                    wire=Mock(side_effect=AssertionError('wire')),trusted_attempt_authority=c['attempt_evidence']['authority']['sha256'])
                self.assertEqual(normal['control_requests_used'],330);self.assertEqual(normal['unresolved'],0)
                rows=[json.loads(line) for line in child.read_bytes().splitlines()]
                self.assertEqual(sum(row['event']=='provision_bridge_prepared' for row in rows),1)
                plan=next(row['value'] for row in rows if row['event']=='plan')
                self.assertEqual(plan['operations']['webIdentity']['expected']['resource_id'],n['manifest']['ids']['webIdentity'])
                self.assertTrue(plan['operations']['webIdentity']['expected']['before_absent'])
                self.assertFalse(any(row['event']=='intent' for row in rows))
                self.assertTrue((directory/'trial-control-budget.jsonl').read_bytes().startswith(counter_before))


if __name__ == '__main__': unittest.main()
