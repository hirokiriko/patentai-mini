"""Fictional V1/V2 publication and real canonical cleanup; no Cloud capability."""
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts.trial_guard.adapters import digest,encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a,published_succession as target,publication_only_cleanup as cleanup
from scripts.trial_provision.configuration import SOURCE_FILES
from scripts.trial_provision.journal import ControlBudget,Journal,replay_control_budget
from scripts.trial_provision.registry_publish import prepare_publication
from scripts.trial_provision.tests.test_attempt import fixture,verify,chain,sha,stamp
from scripts.trial_provision.tests import test_attempt_succession as prior
from scripts.trial_provision.tests.test_registry_retention import publication_fixture
from scripts.trial_provision.tests.test_rehearsal_cli import MemoryJournal,Budget
from scripts.trial_provision.tests.test_registry import Clock,Credential
from scripts.trial_provision.tests.test_publication_only_cleanup import AbsentWire


def published_fixture(directory):
    base=fixture();manifest=base['manifest']
    prefix=manifest['existing']['registry'].split('/providers/')[0]+'/providers/Microsoft.App/'
    manifest['ids']={'app':prefix+'containerApps/trial-app','job':prefix+'jobs/trial-worker','guard':prefix+'jobs/trial-guardian'}
    manifest['registry']['id']=manifest['existing']['registry'];raw=encoded(manifest);mh=sha(raw)
    base['config']['authority_bundle']['manifest']=raw;base['config']['sources']['manifest']['sha256']=mh
    for name in SOURCE_FILES:
        base['config']['sources'].setdefault(name,{'sha256':sha(encoded({'fictional':name}))})
    base['config']['control_budget']['binding']['manifest_sha256']=mh;base['authority']['manifest_sha256']=mh
    binding=base['parent_rows'][0][1];binding['manifest_sha256']=mh
    prep=next(v for e,v in base['parent_rows'] if e=='publication_preparation')
    prep.update(manifest_sha256=mh,run_binding_digest=digest(binding))
    for event,value in base['parent_rows']:
        if event.endswith('_image_namespace'):value.update(publication_preparation_digest=digest(prep),run_binding_digest=digest(binding))
    for slot in ('guardian','runtime'):
        build=json.loads(base['artifacts'][slot+'_build']);build['manifest_sha256']=mh
        base['artifacts'][slot+'_build']=encoded(build);base['config']['publication']['slots'][slot]['build_receipt']['sha256']=sha(encoded(build))
    old_digest=base['authority']['retained_runtime']['digest'];actual='sha256:'+sha(encoded({'schemaVersion':2,'fictional':'retained runtime manifest'}))
    def replace(v):
        if isinstance(v,str):return v.replace(old_digest,actual)
        if isinstance(v,dict):return {k:replace(x) for k,x in v.items()}
        if isinstance(v,(tuple,list)):return [replace(x) for x in v]
        return v
    base['parent_rows']=replace(base['parent_rows']);base['authority']['retained_runtime']['digest']=actual
    data=prior.enable_transfer(prior.proof_fixture(directory,base=base));old=data['new'];previous=prior.verified_successor(data)
    old['config']['live']=True
    public={k:deepcopy(v) for k,v in old['config'].items() if k!='authority_bundle'};public_raw=encoded(public)
    loaded={**deepcopy(old['config']),'manifest':old['manifest'],'live':True,'config_sha256':sha(public_raw),
        'verified_attempt':previous,'build_receipts':{s:json.loads(old['artifacts'][s+'_build']) for s in ('guardian','runtime')}}
    memory,_,_=publication_fixture(old,verified=previous,offset=7200)
    journal=MemoryJournal();journal.records=[{'event':'binding','value':memory.rows[0][1]}]
    prep=prepare_publication(loaded,old['manifest'],sha(public_raw),journal)
    rows=deepcopy(memory.rows[2:])
    for event,value in rows:
        if event.endswith('_image_namespace'):value['publication_preparation_digest']=digest(prep)
    namespace=next(v for e,v in rows if e=='runtime_image_namespace')
    next(v for e,v in rows if e=='runtime_image_retention')['namespace_sha256']=digest(namespace)
    journal.records.extend({'event':e,'value':v} for e,v in rows)
    _,child_binding=a.journal_descriptor(old['config'],previous)
    for slot in ('guardian','runtime'):
        for probe in (False,True):
            suffix='-docker-probe-' if probe else '-docker-';event='_docker_probe' if probe else '_docker'
            path=str(Path(directory)/('trial-'+slot+suffix+digest(child_binding)[:16]))
            journal.append(slot+event+'_config_absent',{'absent':True,'path_digest':digest(path)})
    clock=Clock();clock.start=datetime.fromisoformat(stamp(7200).replace('Z','+00:00'));clock.seconds=1801
    registry,op,_,_=cleanup.prepare(loaded,journal,clock.utc())
    wire=AbsentWire(clock,registry);wire.digest=op['expected']['manifest_digest'];credential=Credential(clock)
    credential.principal=old['manifest']['owner']['principal_id'];credential.tenant=old['manifest']['owner']['tenant_id']
    assert cleanup.run(loaded,journal,Budget(),credential,wire,clock,lambda:None)['status']=='pending'
    wire.head=[404];assert cleanup.run(loaded,journal,Budget(),credential,wire,clock,lambda:None)['cleanup_verified']
    child_rows=[(r['event'],r['value']) for r in journal.records];child_raw,_=chain(child_rows)
    counter_rows=deepcopy(data['counter_rows'])+[('attempt_transition',prior.transition_value(previous))]
    for phase,count in (('fresh_read',6),('publication',15),('cleanup',23)):
        counter_rows.extend(('request',{'kind':'owner_arm','attempt':previous.binding_digest,'phase':phase,
            'purpose':'owner_token' if i==0 else 'http'}) for i in range(count))
    counter_raw,_=chain(counter_rows)
    proof={'schema':2,'previous_authority_raw':encoded(old['authority']).decode(),
        'previous_activation_raw':encoded(old['activation']).decode(),'previous_publication_raw':public_raw.decode(),
        'previous_child_raw':child_raw.decode(),'counter_prefix_raw':counter_raw.decode(),
        'previous_artifacts':{k:v.decode() for k,v in old['artifacts'].items()}}
    state=replay_control_budget(counter_raw,binding=old['config']['control_budget']['binding'],seed=a.SEED,directory=directory,verified=previous)
    caps,reserve,delta=target.allocation(state['plan'],state['used'],state['counts'])
    new=deepcopy(old);authority=new['authority'];config=new['config'];head='d'*40
    config['frozen_head']=head;config['code_sources']={'scripts/trial_provision/published_succession.py':'e'*64}
    authority.update(schema=3,approval='ISSUE148_LINKED_ATTEMPT_V3',head=head,attempt_id='fictional-published-successor',approved_at=stamp(10000),
        publish_from=stamp(10800),counts_before=state['counts'],phase_caps=caps,unallocated=reserve,code_sources_sha256=digest(config['code_sources']),
        succession={'schema':2,'kind':target.KIND,'child_name':target.CHILD_NAME,'proof_sha256':digest(proof),'phase_reallocation':delta})
    new['artifacts']['local_ready']=encoded({'head':head,'design_sha256':a.DESIGN_SHA256,'code_sources_sha256':authority['code_sources_sha256'],'succession_proof':proof})
    new['artifacts']['limits']=encoded({'schema':1,'head':head,'counts_before':state['counts'],'phase_caps':caps,'unallocated':reserve,'purpose_caps':a.PURPOSE_CAPS})
    for slot in ('guardian','runtime'):
        tag=a._slot(new['manifest'],head,slot)['tag'];authority['tags'][slot]=tag
        build=json.loads(new['artifacts'][slot+'_build']);build.update(source_head=head,managed_build_sha=head,image_ref=build['image_ref'].rsplit(':',1)[0]+':'+tag)
        new['artifacts'][slot+'_build']=encoded(build);config['publication']['slots'][slot]['build_receipt']['sha256']=sha(encoded(build))
    new['activation'].update(attempt_id=authority['attempt_id'],issued_at=stamp(10000),
        windows={k:{'start':stamp(10800+s),'end':stamp(10800+e)} for k,(s,e) in a.WINDOW_OFFSETS.items()})
    config['publication']['publish_until']=stamp(12600);prior.seal(new)
    return {'new':new,'old':old,'previous':previous,'proof':proof,'child_rows':child_rows,'counter_rows':counter_rows,'counter_raw':counter_raw,'state':state}


def verified(data):return verify(data['new'],reseal=False,now=stamp(10000))
def clone(data):return deepcopy(data,{id(data['previous']):data['previous']})
def reseal(data):
    ready=json.loads(data['new']['artifacts']['local_ready']);ready['succession_proof']=data['proof']
    data['new']['artifacts']['local_ready']=encoded(ready);data['new']['authority']['succession']['proof_sha256']=digest(data['proof']);prior.seal(data['new'])


class PublishedProofTests(unittest.TestCase):
    def setUp(self):self.data=published_fixture(Path.cwd()/'fictional-published-recovery')

    def test_complete_closed_history_and_balanced_allocation(self):
        v=verified(self.data);self.assertEqual(a.journal_descriptor(self.data['new']['config'],v)[0],target.CHILD_NAME)
        self.assertEqual(v.authority['counts_before'],{'owner_arm':239,'owner_control_blob':32,'heartbeat_blob':0})
        self.assertEqual(v.authority['phase_caps']['owner_arm'],dict(zip(a.PHASES,(24,22,153,42,120))))
        self.assertEqual(v.authority['succession']['phase_reallocation']['phase_delta'],dict(zip(a.PHASES,(6,15,-21,0,23))))

    def test_missing_unknown_ack_wrong_digest_or_premature_delete_rejected(self):
        for change in ('missing_ack','unknown_ack','wrong_digest','premature','unknown_progress','bridge','missing_config','missing_probe','future_clock'):
            data=clone(self.data);rows=data['child_rows']
            if change=='missing_ack':rows[:]=[(e,v) for e,v in rows if not(e=='progress' and v.get('operation_id')==cleanup.IDENT and v['state']=='pending')]
            elif change=='unknown_ack':next(v for e,v in rows if e=='progress' and v.get('operation_id')==cleanup.IDENT)['delete_acknowledged']=False
            elif change=='wrong_digest':next(v for e,v in rows if e=='progress' and v.get('operation_id')==cleanup.IDENT)['object_id']='https://wrong.invalid/'
            elif change=='premature':next(v for e,v in rows if e=='intent' and v.get('operation_id')==cleanup.IDENT)['at']=stamp(8999)
            elif change=='unknown_progress':rows.append(('progress',{'operation_id':'unapproved'}))
            elif change=='bridge':rows.append(('provision_bridge_intent',{}))
            elif change=='future_clock':rows.append(('clock_observation',{'at':stamp(20000)}))
            else:
                event='guardian_docker_config_absent' if change=='missing_config' else 'runtime_docker_probe_config_absent'
                rows[:]=[(e,v) for e,v in rows if e!=event]
            data['proof']['previous_child_raw']=chain(rows)[0].decode();reseal(data)
            with self.subTest(change=change),self.assertRaises(Denied):verified(data)

    def test_budget_reset_transfer_change_and_blob_usage_rejected(self):
        for change in ('count','reserve','transfer','prefix','blob'):
            data=clone(self.data)
            if change=='count':data['new']['authority']['counts_before']['owner_arm']=238
            elif change=='reserve':data['new']['authority']['unallocated']['owner_arm']=1
            elif change=='transfer':data['new']['authority']['succession']['phase_reallocation']['phase_delta']['cleanup']=22
            elif change=='prefix':data['proof']['counter_prefix_raw']=data['proof']['counter_prefix_raw'][:-1]
            else:
                rows=data['counter_rows'];rows.append(('request',{'kind':'owner_control_blob','attempt':data['previous'].binding_digest,'phase':'run','purpose':'http'}))
                data['proof']['counter_prefix_raw']=chain(rows)[0].decode()
                data['new']['authority']['counts_before']['owner_control_blob']=33
            reseal(data)
            with self.subTest(change=change),self.assertRaises(Denied):verified(data)

    def test_transition_replay_rejects_third_and_mutated_first(self):
        v=verified(self.data);rows=self.data['counter_rows']+[('attempt_transition',target.transition_value(v))]
        def replay(rows):return replay_control_budget(chain(rows)[0],binding=self.data['new']['config']['control_budget']['binding'],seed=a.SEED,
            directory=self.data['new']['config']['recovery']['directory'],verified=v)
        self.assertEqual(replay(rows)['counts']['owner_arm'],239)
        with self.assertRaises(Denied):replay(rows+[deepcopy(rows[-1])])
        changed=deepcopy(rows);changed[71][1]['proof_sha256']='0'*64
        with self.assertRaises(Denied):replay(changed)

    def test_noncleanup_stops_at_480_and_old_reserve_floor_remains(self):
        v=verified(self.data)
        with self.assertRaises(Denied):a.check_phase_send(v,'owner_arm','run',{'owner_arm':480,'owner_control_blob':32,'heartbeat_blob':0},0)
        a.check_phase_send(v,'owner_arm','cleanup',{'owner_arm':599,'owner_control_blob':32,'heartbeat_blob':0},0)
        with self.assertRaises(Denied):a.check_phase_send(v,'owner_arm','cleanup',{'owner_arm':600,'owner_control_blob':32,'heartbeat_blob':0},0)
        old=deepcopy(self.data['old']);old['authority']['unallocated']['owner_arm']=0;prior.seal(old)
        with self.assertRaises(Denied):verify(old,reseal=False,now=stamp(660))


class PublishedBudgetTests(unittest.TestCase):
    def test_locked_append_existing_prefix_and_old_authority_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();data=published_fixture(root);v=verified(data);config=data['new']['config'];c=config['control_budget']
            prior.owner_save(root/'trial-control-budget.jsonl',data['counter_raw'])
            prior.owner_save(root/'trial-provision-successor.jsonl',data['proof']['previous_child_raw'].encode())
            prior.owner_save(root/'trial-control-budget.lock',b'0')
            prior.owner_save(root/'trial-provision-successor.lock',b'0')
            with ControlBudget(str(root),digest(str(root)),c['binding'],seed=a.SEED,require_existing=True) as budget:
                budget.begin_attempt(v,initialize=True);self.assertEqual(budget.count('owner_arm'),239)
                saved=(root/'trial-control-budget.jsonl').read_bytes();self.assertTrue(saved.startswith(data['counter_raw']))
                budget.begin_attempt(v);self.assertEqual((root/'trial-control-budget.jsonl').read_bytes(),saved)
                with self.assertRaises(Denied):budget.begin_attempt(data['previous'])
            name,binding=a.journal_descriptor(config,v)
            with Journal(str(root),digest(str(root)),binding,name=name) as child:
                self.assertEqual(child.values('binding'),[binding])


if __name__=='__main__':unittest.main()
