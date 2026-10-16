"""Fictional V4 UNKNOWN snapshots. No file, credential, Docker or Cloud I/O."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a, input_succession, unknown_publication_succession as target
from scripts.trial_provision.journal import ControlBudget, replay_control_budget, _SCOPE_KEY
from scripts.trial_provision.registry_publish import prepare_publication
from scripts.trial_provision.tests.test_attempt import chain, stamp
from scripts.trial_provision.tests.test_attempt_succession import seal
from scripts.trial_provision.tests.test_input_succession import fixture as prior_fixture
from scripts.trial_provision.tests.test_published_succession import published_fixture
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal


def fixture():
    directory = Path.cwd()/'fictional-unknown-publication'
    old, _, config, old_prefix, _, _ = prior_fixture(directory)
    # Prior V4 canonical verification is an explicit seam: this test uses the
    # existing sealed dispatcher fixture. Production always recursively calls
    # verify_attempt with every immutable V4 artifact and never accepts a bool.
    old_proof = a._proof(old)
    old_proof['succession']['retained_published_runtime'] = 'fictional.azurecr.io/trial/runtime@sha256:'+'e'*64
    old = a.VerifiedAttempt(old_proof,a._SEAL)
    base = published_fixture(directory)['new']
    config = deepcopy(config); config['frozen_head'] = old.authority['head']
    config['attempt']['sha256'] = a._proof(old)['activation_sha256']
    public_raw = encoded({k:v for k,v in config.items() if k != 'authority_bundle'})
    name, binding = a.journal_descriptor(config,old)
    journal = MemoryJournal([('binding',binding)])
    prep = prepare_publication({**config,'verified_attempt':old},base['manifest'],a._sha(public_raw),journal)
    fixed = prep['slots']['guardian']; host = prep['login_server']; repo = fixed['repository']; tag = host+'/'+repo+':'+fixed['tag']
    op = {'id':'guardianImagePush','provider':'AzureContainerRegistry','kind':'dockerImagePush','method':'PUT',
        'url':'https://'+host+'/v2/'+repo+'/manifests/'+fixed['tag']+'?api-version=2021-07-01',
        'body':{'fixed_tag':tag,'local_image_id':fixed['local_image_id']},'deadline':prep['publish_until'],'depends_on':[],
        'expected':{'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),
            'docker_sha256':fixed['docker_sha256'],'docker_host':fixed['docker_host']},
        'cleanup':{'created_only':True,'purpose':'guardian','retained':False}}
    rd = digest(op)
    probe_path = str(directory/('trial-guardian-docker-probe-'+digest(binding)[:16]))
    config_path = str(directory/('trial-guardian-docker-'+digest(binding)[:16]))
    rows = journal.rows + [
        ('guardian_docker_probe_directory',{'identity':[1,2],'path_digest':digest(probe_path)}),
        ('guardian_docker_probe_config',{'identity':[1,3]}),
        ('guardian_docker_probe_config_absent',{'absent':True,'path_digest':digest(probe_path)}),
        ('guardian_docker_probe_result',{'schema':1,'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),
            'docker_sha256':fixed['docker_sha256'],'docker_host':fixed['docker_host'],'tag_sha256':a._sha(tag.encode()),
            'local_image_id':fixed['local_image_id'],'empty_config_sha256':a._sha(encoded({'auths':{}})),
            'checked_at':stamp(10801),'status':'verified','temporary_config_absent':True,'new_owner_token_calls':0,
            'new_http_requests':0,'automatic_retry':False}),
        ('clock_observation',{'at':stamp(10802)}),('clock_observation',{'at':stamp(10803)}),
        ('guardian_docker_directory',{'identity':[1,4],'path_digest':digest(config_path)}),
        ('guardian_docker_config',{'identity':[1,5]}),('clock_observation',{'at':stamp(10804)}),
        ('guardian_image_namespace',{'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),
            'registry_id':prep['registry_id'],'login_server':host,'repository':repo,'authenticated':True,'method':'GET',
            'url':'https://'+host+'/acr/v1/'+repo+'?api-version=2021-07-01','http':404,'error_code':'NAME_UNKNOWN',
            'response_sha256':'e'*64,'observed_at':stamp(10805),'push_operation_id':'guardianImagePush','push_request_digest':rd}),
        ('allocation',{'slot':'request_guardianImagePush','id':'12345678-1234-4234-8234-123456789abc'}),
        ('intent',{'operation_id':'guardianImagePush','request_digest':rd,'request_id':'12345678-1234-4234-8234-123456789abc',
            'method':'PUT','url':op['url'],'deadline':op['deadline'],'at':stamp(10806)}),
        ('progress',{'operation_id':'guardianImagePush','request_digest':rd,'object_id':None,'state':'unknown','terminal':False,
            'write_terminal':False,'created_by_run':True,'readback_verified':False,'observed_at':stamp(10807),'properties':{}}),
        ('guardian_docker_config_absent',{'absent':True,'path_digest':digest(config_path)})]
    child_raw, tail = chain(rows)
    counter_rows = [(r['event'],r['value']) for r in map(a._json,old_prefix.splitlines())]
    counter_rows.append(('attempt_transition',input_succession.transition_value(old)))
    requests = [('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*3
    counter_rows += [('request',{'kind':'owner_arm','attempt':old.binding_digest,'phase':p,'purpose':q}) for p,q in requests]
    counter_raw, _ = chain(counter_rows)
    state = replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory,verified=old)
    proof = {'schema':4,'previous_authority_raw':encoded(old.authority).decode(),'previous_activation_raw':encoded(old.activation).decode(),
        'previous_publication_raw':public_raw.decode(),'previous_child_raw':child_raw.decode(),'counter_prefix_raw':counter_raw.decode(),
        'previous_artifacts':{k:v.decode() for k,v in base['artifacts'].items()}}
    new = deepcopy(base); authority = deepcopy(old.authority); new['authority'] = authority
    new['config'] = deepcopy(config); new['activation'] = old.activation
    head = 'f'*40; new['config']['frozen_head'] = head
    new['config']['code_sources'] = {'scripts/trial_provision/unknown_publication_succession.py':'f'*64}
    caps, reserve = target.allocation(state['plan'],state['used'],state['counts'])
    authority.update(schema=5,approval='ISSUE148_LINKED_ATTEMPT_V5',head=head,attempt_id='fictional-unknown-successor',
        code_sources_sha256=digest(new['config']['code_sources']),approved_at=stamp(13000),publish_from=stamp(14000),
        counts_before=target.COUNTS,phase_caps=caps,unallocated=reserve,
        succession={'schema':4,'kind':target.KIND,'child_name':target.CHILD_NAME,'proof_sha256':digest(proof),
            'phase_reallocation':deepcopy(target.REALLOCATION)})
    new['artifacts']['local_ready'] = encoded({'head':head,'design_sha256':a.DESIGN_SHA256,
        'code_sources_sha256':authority['code_sources_sha256'],'succession_proof':proof})
    new['artifacts']['limits'] = encoded({'schema':1,'head':head,'counts_before':target.COUNTS,'phase_caps':caps,'unallocated':reserve,
        'purpose_caps':a.PURPOSE_CAPS,'limits':a._authority_limits(authority),'limit_amendment':authority['limit_amendment']})
    for slot in ('guardian','runtime'):
        build = a._json(new['artifacts'][slot+'_build']); tag = a._slot(new['manifest'],head,slot)['tag']
        authority['tags'][slot] = tag
        build.update(source_head=head,managed_build_sha=head,image_ref=build['image_ref'].rsplit(':',1)[0]+':'+tag)
        new['artifacts'][slot+'_build'] = encoded(build)
        new['config']['publication']['slots'][slot]['build_receipt']['sha256'] = a._sha(encoded(build))
    new['activation'].update(attempt_id=authority['attempt_id'],issued_at=stamp(13000),
        windows={k:{'start':stamp(14000+s),'end':stamp(14000+e)} for k,(s,e) in a.WINDOW_OFFSETS.items()})
    new['config']['publication']['publish_until'] = stamp(15800); seal(new)
    return {'new':new,'old':old,'old_config':config,'proof':proof,'child_rows':rows,'child_raw':child_raw,
        'counter_rows':counter_rows,'counter_raw':counter_raw,'state':state,'old_prefix':old_prefix}


def verify(data):
    new = data['new']; parent, _ = chain(new['parent_rows'])
    original = a.verify_attempt
    # Only the already tested historical V4 verifier is replaced, never the
    # V5 verifier or its child, chain, allocation, approval and artifact gates.
    with patch.object(a,'verify_attempt',return_value=data['old']) as previous:
        result = original(new['config'],new['manifest'],authority_raw=encoded(new['authority']),
            activation_raw=encoded(new['activation']),parent_journal_raw=parent,parent_final_raw=encoded(new['parent_final']),
            artifacts=new['artifacts'],trusted_authority_sha256=a._sha(encoded(new['authority'])),now=stamp(13000))
        previous.assert_called_once()
        assert previous.call_args.kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return result


def reseal(data):
    ready = a._json(data['new']['artifacts']['local_ready']); ready['succession_proof'] = data['proof']
    data['new']['artifacts']['local_ready'] = encoded(ready)
    data['new']['authority']['succession']['proof_sha256'] = digest(data['proof']); seal(data['new'])


class UnknownPublicationTests(unittest.TestCase):
    def setUp(self): self.data = fixture()
    def clone(self): return deepcopy(self.data,{id(self.data['old']):self.data['old']})
    def replay(self,raw,verified=None):
        config = self.data['old_config']
        return replay_control_budget(raw,binding=config['control_budget']['binding'],seed=a.SEED,
            directory=config['control_budget']['directory'],verified=verified)

    def test_verified_successor_preserves_unknown_and_every_debit_without_io(self):
        before = self.data['counter_raw'],self.data['child_raw']
        with (patch('builtins.open',side_effect=AssertionError('file')),patch('subprocess.run',side_effect=AssertionError('process')),
                patch('socket.create_connection',side_effect=AssertionError('network'))):
            current = verify(self.data)
        self.assertEqual(a.journal_descriptor(self.data['new']['config'],current)[0],target.CHILD_NAME)
        self.assertEqual(current.authority['phase_caps']['owner_arm'],dict(zip(a.PHASES,(24,19,147,42,120))))
        self.assertEqual(a.effective_limits(current)['owner_arm'],631)
        transition = target.transition_value(current)
        raw, _ = chain(self.data['counter_rows']+[('attempt_transition',transition)])
        state = self.replay(raw,current)
        self.assertTrue(raw.startswith(before[0])); self.assertEqual(state['rows'],159)
        self.assertEqual(state['counts'],target.COUNTS); self.assertEqual(len(state['transitions']),4)
        self.assertEqual(before,(self.data['counter_raw'],self.data['child_raw']))
        self.assertEqual(self.data['child_rows'][14][1]['state'],'unknown')

    def test_child_unknown_not_ack_or_portal_or_runtime(self):
        mutations = [('ack',14,'ack_kind','docker_exit0_digest'),('success',14,'state','succeeded'),
            ('write',14,'write_terminal',True),('manifest',14,'object_id','sha256:'+'f'*64),
            ('properties',14,'properties',{'manifest_digest':'sha256:'+'f'*64}),('namespace',11,'http',200),
            ('namespace-auth',11,'authenticated',False),('probe',5,'status','timeout'),
            ('retry',5,'automatic_retry',True),('clock',10,'at',stamp(10000)),('dirty',15,'absent',False)]
        for label,index,key,value in mutations:
            d = self.clone(); rows = deepcopy(d['child_rows']); rows[index][1][key] = value
            d['proof']['previous_child_raw'] = chain(rows)[0].decode(); reseal(d)
            with self.subTest(label=label),self.assertRaises(Denied): verify(d)
        for event in ('runtime_image_namespace','core_plan','clock_revoked','portal_absence'):
            d = self.clone(); rows = deepcopy(d['child_rows']); rows.append((event,{}))
            d['proof']['previous_child_raw'] = chain(rows)[0].decode(); reseal(d)
            with self.subTest(event=event),self.assertRaises(Denied): verify(d)

    def test_allocation_amendment_and_scope_cannot_be_reset(self):
        for mutate in ('fresh','cleanup','amount','amendment','head','tag','schema','approval','pending','before-expiry'):
            d = self.clone(); authority = d['new']['authority']
            if mutate == 'fresh': authority['phase_caps']['owner_arm']['fresh_read'] += 1
            elif mutate == 'cleanup': authority['phase_caps']['owner_arm'].update(cleanup=119,provision=148)
            elif mutate == 'amount': authority['succession']['phase_reallocation']['requests'] = 7
            elif mutate == 'amendment': authority['limit_amendment']['approval_sha256'] = '0'*64
            elif mutate == 'head': authority['head'] = d['old'].authority['head']
            elif mutate == 'tag': authority['tags']['guardian'] = d['old'].authority['tags']['guardian']
            elif mutate == 'schema': authority['succession']['schema'] = True
            elif mutate == 'approval': authority['approval'] = 'ISSUE148_LINKED_ATTEMPT_V4'
            elif mutate == 'pending': authority['decision'] = 'PENDING'
            else: authority['approved_at'] = stamp(12000)
            seal(d['new'])
            with self.subTest(mutate=mutate),self.assertRaises(Denied): verify(d)

    def test_counter_changed_requests_old_transitions_and_repeated_transition_rejected(self):
        current = verify(self.data); transition = target.transition_value(current)
        for mutation in ('spent','purpose','first','second','third','fourth','repeat','delta','prefix','amendment'):
            rows = deepcopy(self.data['counter_rows'])+[('attempt_transition',deepcopy(transition))]
            if mutation == 'spent': rows.pop(155)
            elif mutation == 'purpose': rows[149][1]['purpose'] = 'http'
            elif mutation in ('first','second','third','fourth'):
                rows[{'first':71,'second':116,'third':148,'fourth':158}[mutation]][1]['proof_sha256'] = '0'*64
            elif mutation == 'repeat': rows.append(deepcopy(rows[-1]))
            elif mutation == 'delta': rows[-1][1]['phase_reallocation']['from_phase'] = 'cleanup'
            elif mutation == 'prefix': rows[-1][1]['prefix_rows'] = 157
            else: rows[-1][1]['limit_amendment']['approval_sha256'] = '0'*64
            with self.subTest(mutation=mutation),self.assertRaises(Denied): self.replay(chain(rows)[0],current)
        rows = deepcopy(self.data['counter_rows'])+[('attempt_transition',transition),
            ('request',{'kind':'owner_arm','attempt':self.data['old'].binding_digest,'phase':'publication','purpose':'http'})]
        with self.assertRaises(Denied): self.replay(chain(rows)[0],current)

    def test_full_remaining_caps_reserve_cleanup_and_nominal_limit(self):
        current = verify(self.data)
        rows = deepcopy(self.data['counter_rows'])+[('attempt_transition',target.transition_value(current))]
        for phase,count in (('fresh_read',24),('publication',19),('provision',147),('run',42),('cleanup',120)):
            rows += [('request',{'kind':'owner_arm','attempt':current.binding_digest,'phase':phase,
                'purpose':'owner_token' if phase == 'provision' and i < 10 else 'http'}) for i in range(count)]
        state = self.replay(chain(rows)[0],current); self.assertEqual(state['counts']['owner_arm'],631)
        rows.append(('request',{'kind':'owner_arm','attempt':current.binding_digest,'phase':'cleanup','purpose':'http'}))
        with self.assertRaises(Denied): self.replay(chain(rows)[0],current)

    def test_explicit_initialization_single_append_prior_lock_and_old_scope(self):
        current = verify(self.data); config = self.data['old_config']; store = {'raw':self.data['counter_raw'],'locked':False,'appends':0}
        records, _ = a._journal(store['raw'],{'binding':config['control_budget']['binding'],'limits':a.LIMITS,'seed':a.SEED})
        budget = object.__new__(ControlBudget); budget.mutex = threading.RLock(); budget.seed = deepcopy(a.SEED)
        budget.binding = deepcopy(config['control_budget']['binding']); budget._binding_digest = digest(budget.binding)
        budget._seed_digest = digest(budget.seed); budget._closed = budget._poisoned = False; budget._verified = self.data['old']
        def append(event,value):
            self.assertTrue(store['locked']); self.assertEqual(event,'attempt_transition'); store['appends'] += 1
            rows = [(r['event'],r['value']) for r in budget.journal.records]+[(event,value)]
            store['raw'] = chain(rows)[0]
            budget.journal.records = a._journal(store['raw'],{'binding':budget.binding,'limits':a.LIMITS,'seed':a.SEED})[0]
        path = SimpleNamespace(parent=Path(config['control_budget']['directory']),read_bytes=lambda:store['raw'])
        budget.journal = SimpleNamespace(path=path,mutex=threading.RLock(),records=records,append=append)
        budget._replay(self.data['old']); oldscope = budget._new_scope('publication',_SCOPE_KEY)
        with self.assertRaises(Denied): budget.begin_attempt(current)
        self.assertEqual(store['appends'],0)
        class PriorLock:
            def __init__(inner,*args,**kwargs):
                self.assertEqual(kwargs['name'],'trial-provision-successor-v4'); self.assertIs(kwargs['require_existing'],True)
                self.assertEqual(args[2],a._proof(current)['succession']['child_binding'])
                inner.path = SimpleNamespace(read_bytes=lambda:self.data['child_raw'])
                inner.previous = a._proof(current)['succession']['child_tail']
            def __enter__(inner): store['locked'] = True; return inner
            def __exit__(inner,*_): store['locked'] = False
        with patch('scripts.trial_provision.journal.Journal',PriorLock),patch('os.path.lexists',return_value=True):
            with self.assertRaises(Denied): budget.begin_attempt(current,initialize=True)
        self.assertEqual(store['appends'],0); self.assertFalse(store['locked'])
        self.assertEqual(store['raw'],self.data['counter_raw'])
        with patch('scripts.trial_provision.journal.Journal',PriorLock),patch('os.path.lexists',return_value=False):
            budget.begin_attempt(current,initialize=True)
            once = store['raw']; budget.begin_attempt(current,initialize=True)
        self.assertEqual(store['appends'],1); self.assertEqual(store['raw'],once)
        self.assertTrue(once.startswith(self.data['counter_raw'])); self.assertEqual(budget.counts(),target.COUNTS)
        with self.assertRaises(Denied): oldscope.consume('owner_arm',600)
        with self.assertRaises(Denied): budget.begin_attempt(self.data['old'],initialize=True)
        with self.assertRaises(Denied): budget._new_scope('publication',_SCOPE_KEY).consume('owner_arm',631)
        self.assertEqual(store['raw'],once)

    def test_tag_prefix_collision_and_old_mutable_proof_rejected(self):
        d = self.clone(); head = d['old'].authority['head'][:12]+'0'*28; d['new']['authority']['head'] = head
        new = d['new']; new['config']['frozen_head'] = head
        for name in ('local_ready','limits'):
            artifact = a._json(new['artifacts'][name]); artifact['head'] = head; new['artifacts'][name] = encoded(artifact)
        for slot in ('guardian','runtime'):
            tag = a._slot(new['manifest'],head,slot)['tag']; new['authority']['tags'][slot] = tag
            build = a._json(new['artifacts'][slot+'_build'])
            build.update(source_head=head,managed_build_sha=head,image_ref=build['image_ref'].rsplit(':',1)[0]+':'+tag)
            new['artifacts'][slot+'_build'] = encoded(build)
            new['config']['publication']['slots'][slot]['build_receipt']['sha256'] = a._sha(encoded(build))
        seal(new)
        with self.assertRaises(Denied): verify(d)
        for key,value in (('portal_absent',True),('previous_child_raw','{}'),('schema',True)):
            d = self.clone(); d['proof'][key] = value; reseal(d)
            with self.subTest(key=key),self.assertRaises(Denied): verify(d)


if __name__ == '__main__': unittest.main()
