"""Fictional 71-row/195-request predecessor only; no live ledger or Cloud."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.attempt import (DESIGN_SHA256, LIMITS, PHASES, PURPOSE_CAPS, SEED,
    WINDOW_OFFSETS, journal_descriptor, phase_plan, _journal)
from scripts.trial_provision.journal import (ControlBudget, Journal, _HISTORY_SOURCE_SHA256,
    replay_control_budget)
from scripts.trial_provision.private_io import create_owner_file
from scripts.trial_provision.succession import CHILD_NAME, COUNTS, transition_value
from scripts.trial_provision.tests.test_attempt import fixture, verify, chain, sha, stamp
from scripts.trial_provision.tests.test_attempt_accounting import scope
from scripts.trial_provision.tests.test_history_accounting import historical_records


def seal(data):
    authority=data['authority'];parent,last=chain(data['parent_rows'])
    authority['parent']={'journal_sha256':sha(parent),'chain_sha256':last,'final_sha256':sha(encoded(data['parent_final']))}
    authority['artifact_sha256']={key:sha(value) for key,value in data['artifacts'].items()}
    data['activation']['authority_sha256']=sha(encoded(authority))
    data['config']['attempt']['sha256']=sha(encoded(data['activation']))
    return data


def proof_fixture(directory):
    """Canonical source shape, including historical marker provenance."""
    old=fixture();config=old['config'];directory=str(directory)
    for key in ('recovery','control_budget'):
        config[key]['directory']=directory;config[key]['directory_digest']=digest(directory)
    binding=config['control_budget']['binding'];binding['source_sha256']=_HISTORY_SOURCE_SHA256
    old['authority']['budget_binding_sha256']=digest(binding)
    for slot in ('guardian','runtime'):config['publication']['slots'][slot]['docker_path']=str(Path(directory)/'fictional-docker')
    seal(old);previous=verify(old,reseal=False)
    publication={k:deepcopy(v) for k,v in config.items() if k!='authority_bundle'}
    publication_raw=encoded(publication);_,child_binding=journal_descriptor(config,previous)
    prep={'schema':1,'configuration_sha256':sha(publication_raw),
        'manifest_sha256':old['authority']['manifest_sha256'],'code_sha':old['authority']['head'],
        'source_sha256':{k:v['sha256'] for k,v in config['sources'].items()},'run_binding_digest':digest(child_binding),
        'registry_id':old['manifest']['existing']['registry'],'login_server':old['manifest']['registry']['loginServer'],
        'tenant_id':old['manifest']['owner']['tenant_id'],'owner_id':old['manifest']['owner']['principal_id'],
        'publish_until':config['publication']['publish_until'],'slots':{}}
    for slot,repo in (('guardian','cleanupImageRepository'),('runtime','imageRepository')):
        source=config['publication']['slots'][slot]
        prep['slots'][slot]={'repository':old['manifest'][repo],'tag':old['authority']['tags'][slot],
            **{k:source[k] for k in ('local_image_id','docker_sha256','docker_host')},
            'docker_path_sha256':sha(source['docker_path'].encode()),'build_receipt_sha256':source['build_receipt']['sha256']}
    docker_path=str(Path(directory)/('trial-guardian-docker-'+digest(child_binding)[:16]))
    child_rows=[('binding',child_binding),('publication_preparation',prep),
        ('clock_observation',{'at':stamp(3)}),('clock_observation',{'at':stamp(4)}),
        ('guardian_docker_directory',{'identity':[1,2],'path_digest':digest(docker_path)}),
        ('guardian_docker_config',{'identity':[1,3]}),
        ('guardian_docker_config_absent',{'absent':True,'path_digest':digest(docker_path)})]
    child_raw,_=chain(child_rows)
    requests=[('fresh_read','owner_token')]+[('fresh_read','http')]*5+[('publication','http')]*2
    counter_rows=[('binding',{'binding':binding,'limits':LIMITS,'seed':SEED}),*historical_records(directory),
        ('phase_plan',phase_plan(previous)),*[('request',{'kind':'owner_arm','attempt':previous.binding_digest,
            'phase':phase,'purpose':purpose}) for phase,purpose in requests]]
    counter_raw,_=chain(counter_rows)
    proof={'schema':1,'previous_authority_raw':encoded(old['authority']).decode(),
        'previous_activation_raw':encoded(old['activation']).decode(),'previous_publication_raw':publication_raw.decode(),
        'previous_child_raw':child_raw.decode(),'counter_prefix_raw':counter_raw.decode(),
        'previous_artifacts':{k:v.decode() for k,v in old['artifacts'].items()}}
    new=deepcopy(old);a=new['authority'];new_config=new['config'];head='c'*40
    new_config['frozen_head']=a['head']=head
    new_config['code_sources']={'scripts/trial_provision/succession.py':'d'*64}
    a['code_sources_sha256']=digest(new_config['code_sources'])
    a.update(schema=2,approval='ISSUE148_LINKED_ATTEMPT_V2',attempt_id='fictional-successor',
        publish_from=stamp(7200),approved_at=stamp(600),counts_before=deepcopy(COUNTS),
        succession={'schema':1,'kind':'STOPPED_BEFORE_PUSH_V1','child_name':CHILD_NAME,'proof_sha256':digest(proof)})
    a['phase_caps']['owner_arm'].update(fresh_read=18,publication=22)
    new['activation'].update(attempt_id=a['attempt_id'],issued_at=stamp(660),
        windows={k:{'start':stamp(7200+start),'end':stamp(7200+end)} for k,(start,end) in WINDOW_OFFSETS.items()})
    new_config['publication']['publish_until']=stamp(9000)
    new['artifacts']['local_ready']=encoded({'head':head,'design_sha256':DESIGN_SHA256,
        'code_sources_sha256':a['code_sources_sha256'],'succession_proof':proof})
    new['artifacts']['limits']=encoded({'schema':1,'head':head,'counts_before':COUNTS,
        'phase_caps':a['phase_caps'],'unallocated':a['unallocated'],'purpose_caps':PURPOSE_CAPS})
    for slot,key in (('guardian','cleanupImageTag'),('runtime','imageTag')):
        a['tags'][slot]=new['manifest'][key]+'-'+head[:12]
        build=json.loads(new['artifacts'][slot+'_build']);build['source_head']=build['managed_build_sha']=head
        build['image_ref']=build['image_ref'].rsplit(':',1)[0]+':'+a['tags'][slot]
        new['artifacts'][slot+'_build']=encoded(build)
        new_config['publication']['slots'][slot]['build_receipt']['sha256']=sha(encoded(build))
    seal(new)
    return {'old':old,'new':new,'previous':previous,'proof':proof,'counter_raw':counter_raw,
        'counter_rows':counter_rows,'child_raw':child_raw,'child_rows':child_rows,'docker_path':docker_path}


def verified_successor(data):return verify(data['new'],reseal=False,now=stamp(660))


def reseal_proof(data):
    ready=json.loads(data['new']['artifacts']['local_ready']);ready['succession_proof']=data['proof']
    data['new']['artifacts']['local_ready']=encoded(ready)
    data['new']['authority']['succession']['proof_sha256']=digest(data['proof']);seal(data['new'])


def enable_transfer(data):
    authority=data['new']['authority']
    authority['succession']['phase_reallocation']={'schema':1,'kind':'owner_arm','from_phase':'provision',
        'to_phase':'fresh_read','requests':6}
    authority['phase_caps']['owner_arm'].update(fresh_read=24,provision=174)
    limits=json.loads(data['new']['artifacts']['limits']);limits['phase_caps']=authority['phase_caps']
    data['new']['artifacts']['limits']=encoded(limits);seal(data['new'])
    return data


def owner_save(path,raw):
    fd=create_owner_file(path)
    with os.fdopen(fd,'wb') as stream:stream.write(raw)


class SuccessionProofTests(unittest.TestCase):
    def setUp(self):
        self.data=proof_fixture(Path.cwd()/'fictional-proof-recovery');self.data.pop('previous')

    def test_pure_nested_verification_and_counter_readback_have_no_io(self):
        before=deepcopy(self.data)
        with patch.object(Path,'read_bytes',side_effect=AssertionError('file read forbidden')),\
             patch.object(Journal,'__init__',side_effect=AssertionError('writer forbidden')):
            verified=verified_successor(self.data)
            state=replay_control_budget(self.data['counter_raw'],binding=self.data['new']['config']['control_budget']['binding'],
                seed=SEED,directory=Path.cwd()/'fictional-proof-recovery')
        self.assertEqual(state['counts'],COUNTS);self.assertEqual(state['rows'],71)
        self.assertEqual(state['used']['owner_arm']['fresh_read'],6);self.assertEqual(state['used']['owner_arm']['publication'],2)
        self.assertEqual(journal_descriptor(self.data['new']['config'],verified)[0],CHILD_NAME)
        self.assertEqual(self.data,before)

    def test_boolean_untrusted_and_recursive_authority_are_rejected(self):
        for name,value in (('schema',True),('decision','PENDING'),('approval','ISSUE148_LINKED_ATTEMPT_V1')):
            data=deepcopy(self.data);data['new']['authority'][name]=value;seal(data['new'])
            with self.subTest(name=name),self.assertRaises(Denied):verified_successor(data)
        data=deepcopy(self.data);old=json.loads(data['proof']['previous_authority_raw']);old['schema']=2
        data['proof']['previous_authority_raw']=encoded(old).decode();reseal_proof(data)
        with self.assertRaises(Denied):verified_successor(data)
        with self.assertRaises(Denied):verify(self.data['new'],reseal=False,now=stamp(660),trusted_authority_sha256='0'*64)

    def test_any_unknown_write_or_changed_predecessor_evidence_rejected(self):
        for event in ('intent','progress','guardian_image_namespace','clock_revoked','credential_intent'):
            data=deepcopy(self.data);data['proof']['previous_child_raw']=chain(data['child_rows']+[(event,{})])[0].decode();reseal_proof(data)
            with self.subTest(event=event),self.assertRaises(Denied):verified_successor(data)
        for index,key,value in ((1,'configuration_sha256','0'*64),(2,'at',stamp(8)),
                (4,'path_digest','0'*64),(6,'absent',False)):
            data=deepcopy(self.data);data['child_rows'][index][1][key]=value
            data['proof']['previous_child_raw']=chain(data['child_rows'])[0].decode();reseal_proof(data)
            with self.subTest(index=index,key=key),self.assertRaises(Denied):verified_successor(data)

    def test_truncated_changed_or_reclassified_counter_is_rejected(self):
        for change in ('partial','extra','reclassify','attempt','history'):
            data=deepcopy(self.data)
            if change=='partial':raw=data['counter_raw'][:-1]
            else:
                rows=data['counter_rows']
                if change=='extra':rows.append(deepcopy(rows[-1]))
                elif change=='reclassify':rows[63][1].update(phase='publication')
                elif change=='attempt':rows[70][1]['attempt']='0'*64
                else:rows[5][1]['end_count']=132
                raw=chain(rows)[0]
            data['proof']['counter_prefix_raw']=raw.decode();reseal_proof(data)
            with self.subTest(change=change),self.assertRaises(Denied):verified_successor(data)

    def test_budget_floor_catalog_and_parent_bindings_cannot_change(self):
        for name,value in (('initial_forecast_yen',4400),('owner_id','other-owner'),('task_id','other-task'),
            ('catalog_options',{'temporary_owner_set':True,'excluded_databases':[]})):
            data=deepcopy(self.data);data['new']['authority'][name]=value;seal(data['new'])
            with self.subTest(name=name),self.assertRaises(Denied):verified_successor(data)
        for phase,cap in (('fresh_read',19),('publication',23),('cleanup',119)):
            data=deepcopy(self.data);data['new']['authority']['phase_caps']['owner_arm'][phase]=cap
            limits=json.loads(data['new']['artifacts']['limits']);limits['phase_caps']=data['new']['authority']['phase_caps']
            data['new']['artifacts']['limits']=encoded(limits);seal(data['new'])
            with self.subTest(phase=phase),self.assertRaises(Denied):verified_successor(data)

    def test_fixed_transfer_is_optional_and_bound_to_independent_authority_hash(self):
        before=verified_successor(self.data);old_trusted=sha(encoded(self.data['new']['authority']))
        proof_before=deepcopy(self.data['proof']);enable_transfer(self.data)
        after=verified_successor(self.data)
        self.assertNotEqual(before.binding_digest,after.binding_digest)
        self.assertEqual(self.data['proof'],proof_before)
        self.assertEqual(after.authority['phase_caps']['owner_arm'],dict(zip(PHASES,(24,22,174,42,120))))
        self.assertEqual(sum(after.authority['phase_caps']['owner_arm'].values())+195+23,600)
        with self.assertRaisesRegex(Denied,'attempt_trusted_authority'):
            verify(self.data['new'],reseal=False,now=stamp(660),trusted_authority_sha256=old_trusted)
        old=deepcopy(self.data['old']);old['authority']['succession']=deepcopy(self.data['new']['authority']['succession']);seal(old)
        with self.assertRaises(Denied):verify(old,reseal=False)

    def test_arbitrary_transfer_fields_amounts_cleanup_and_missing_authority_rejected(self):
        original=enable_transfer(self.data)
        changes=(('schema',True),('schema',1.0),('kind','owner_control_blob'),('from_phase','publication'),
            ('from_phase','cleanup'),('from_phase','unallocated'),('to_phase','cleanup'),('requests',True),
            ('requests',6.0),('requests',5),('requests',7),('extra','unapproved'))
        for key,value in changes:
            data=deepcopy(original);data['new']['authority']['succession']['phase_reallocation'][key]=value;seal(data['new'])
            with self.subTest(key=key,value=value),self.assertRaises(Denied):verified_successor(data)
        for absent in (True,False):
            data=deepcopy(original)
            if absent:del data['new']['authority']['succession']['phase_reallocation']
            else:data['new']['authority']['succession']['phase_reallocation']=None
            seal(data['new'])
            with self.subTest(absent=absent),self.assertRaises(Denied):verified_successor(data)

    def test_transition_reallocation_and_plan_cannot_be_changed_even_with_same_total(self):
        enable_transfer(self.data);verified=verified_successor(self.data);event=transition_value(verified)
        cases=[]
        value=deepcopy(event);del value['phase_reallocation'];cases.append(value)
        value=deepcopy(event);value['phase_reallocation']['from_phase']='cleanup';cases.append(value)
        value=deepcopy(event);value['phase_reallocation']['requests']=6.0;cases.append(value)
        value=deepcopy(event);value['plan']['phase_caps']['owner_arm'].update(fresh_read=23,provision=175);cases.append(value)
        value=deepcopy(event);value['plan']['phase_caps']['owner_arm'].update(fresh_read=24,provision=180,cleanup=114);cases.append(value)
        for value in cases:
            for verifier in (None,verified):
                with self.subTest(verifier=verifier is not None),self.assertRaises(Denied):
                    replay_control_budget(chain(self.data['counter_rows']+[('attempt_transition',value)])[0],
                        binding=self.data['new']['config']['control_budget']['binding'],seed=SEED,
                        directory=Path.cwd()/'fictional-proof-recovery',verified=verifier)


class SuccessionDurableTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.directory=Path(temporary.name).resolve();self.data=proof_fixture(self.directory)
        self.verified=verified_successor(self.data);self.old=self.data['previous']
        self.binding=self.data['new']['config']['control_budget']['binding']
        self.args=(self.directory,digest(str(self.directory)),self.binding)
        self.counter=self.directory/'trial-control-budget.jsonl';self.child=self.directory/'trial-provision-next.jsonl'
        owner_save(self.counter,self.data['counter_raw']);owner_save(self.child,self.data['child_raw'])
        for name in ('trial-control-budget.lock','trial-provision-next.lock'):owner_save(self.directory/name,b'0')

    def open(self):
        budget=ControlBudget(*self.args,seed=SEED,require_existing=True);self.addCleanup(budget.close);return budget

    def test_single_transition_same_bytes_counts_and_reopen_with_old_scope_rejected(self):
        budget=self.open();old_scope=scope(budget,self.old,'publication')
        with self.assertRaises(Denied):budget.begin_attempt(self.verified)
        self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])
        budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(budget.counts(),COUNTS);self.assertEqual(self.child.read_bytes(),self.data['child_raw'])
        after=self.counter.read_bytes();self.assertTrue(after.startswith(self.data['counter_raw']))
        self.assertEqual(len(after.splitlines()),72);self.assertEqual(len(budget.journal.values('attempt_transition')),1)
        for action in (lambda:old_scope.consume('owner_arm',600),lambda:budget.begin_attempt(self.old,initialize=True)):
            with self.assertRaises(Denied):action()
        budget.begin_attempt(self.verified,initialize=True);self.assertEqual(self.counter.read_bytes(),after)
        scope(budget,self.verified,'fresh_read').consume_owner_token();self.assertEqual(budget.count('owner_arm'),196)
        after=self.counter.read_bytes();budget.close();reopened=self.open();reopened.begin_attempt(self.verified)
        self.assertEqual(reopened.count('owner_arm'),196);self.assertEqual(self.counter.read_bytes(),after)
        self.assertEqual(reopened.seed,SEED)

    def test_remaining_caps_and_all_cleanup_reservation_persist_across_reopen(self):
        budget=self.open();budget.begin_attempt(self.verified,initialize=True)
        for phase,cap in (('fresh_read',18),('publication',22),('provision',170),('run',42)):
            scoped=scope(budget,self.verified,phase)
            for _ in range(cap):scoped.consume('owner_arm',600)
            if phase!='provision':
                with self.assertRaises(Denied):scoped.consume('owner_arm',600)
        for _ in range(10):scope(budget,self.verified,'provision').consume_owner_token()
        self.assertEqual(budget.count('owner_arm'),457);budget.close();budget=self.open()
        cleanup=scope(budget,self.verified,'cleanup')
        for _ in range(120):cleanup.consume('owner_arm',600)
        self.assertEqual(budget.count('owner_arm'),577)
        with self.assertRaises(Denied):cleanup.consume('owner_arm',600)
        self.assertEqual(600-budget.count('owner_arm'),23)

    def test_approved_transfer_uses_24_22_174_then_preserves_120_cleanup_and_23_reserve(self):
        enable_transfer(self.data);self.verified=verified_successor(self.data)
        budget=self.open();budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(budget.counts(),COUNTS);self.assertTrue(self.counter.read_bytes().startswith(self.data['counter_raw']))
        self.assertEqual(budget.journal.values('attempt_transition')[0],transition_value(self.verified))
        for phase,cap in (('fresh_read',24),('publication',22),('provision',164),('run',42)):
            scoped=scope(budget,self.verified,phase)
            for _ in range(cap):scoped.consume('owner_arm',600)
            if phase!='provision':
                with self.assertRaises(Denied):scoped.consume('owner_arm',600)
        provision=scope(budget,self.verified,'provision')
        for _ in range(10):provision.consume_owner_token()
        self.assertEqual(budget.count('owner_arm'),457)
        with self.assertRaises(Denied):provision.consume('owner_arm',600)
        after=self.counter.read_bytes();budget.close();budget=self.open();budget.begin_attempt(self.verified)
        self.assertEqual(self.counter.read_bytes(),after)
        cleanup=scope(budget,self.verified,'cleanup')
        for _ in range(120):cleanup.consume('owner_arm',600)
        self.assertEqual(budget.count('owner_arm'),577)
        with self.assertRaises(Denied):cleanup.consume('owner_arm',600)
        self.assertEqual(self.child.read_bytes(),self.data['child_raw'])

    def test_changed_live_child_config_or_locked_writer_cannot_transition(self):
        budget=self.open();child_binding=self.data['child_rows'][0][1]
        with Journal(self.directory,digest(str(self.directory)),child_binding,name='trial-provision-next',require_existing=True):
            with self.assertRaises((Denied,OSError)):budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])
        config_path=Path(self.data['docker_path']);config_path.mkdir()
        try:
            with self.assertRaises(Denied):budget.begin_attempt(self.verified,initialize=True)
            self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])
        finally:config_path.rmdir()
        with Journal(self.directory,digest(str(self.directory)),child_binding,name='trial-provision-next',require_existing=True) as child:
            child.append('intent',{'operation_id':'fictionalUnknown'})
        with self.assertRaises(Denied):budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])

    def test_transition_fsync_failure_poisoned_and_no_automatic_retry(self):
        budget=self.open()
        with patch('scripts.trial_provision.journal.os.fsync',side_effect=OSError('fictional fsync')):
            with self.assertRaises(OSError):budget.begin_attempt(self.verified,initialize=True)
        with self.assertRaisesRegex(Denied,'budget_unavailable'):budget.begin_attempt(self.verified,initialize=True)
        self.assertTrue(self.counter.read_bytes().startswith(self.data['counter_raw']))
        self.assertEqual(len(self.counter.read_bytes().splitlines()),72)

    def test_dangling_config_entry_and_changed_live_counter_fail_before_append(self):
        budget=self.open();original=os.path.lexists
        def present(path):
            return True if str(path)==self.data['docker_path'] else original(path)
        with patch('scripts.trial_provision.journal.os.path.lexists',side_effect=present):
            with self.assertRaisesRegex(Denied,'budget_succession_config_present'):
                budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])
        scope(budget,self.old,'fresh_read').consume('owner_arm',600)
        appended=self.counter.read_bytes()
        with self.assertRaises(Denied):budget.begin_attempt(self.verified,initialize=True)
        self.assertEqual(self.counter.read_bytes(),appended);self.assertEqual(budget.count('owner_arm'),196)

    def test_malformed_duplicate_partial_old_scope_and_legacy_transition_rows_fail_pure_readback(self):
        event=transition_value(self.verified);prefix=self.data['counter_rows']
        old_request=deepcopy(prefix[-1]);cases=[prefix+[('attempt_transition',event)]*2,
            prefix+[('attempt_transition',event),old_request],prefix+[('attempt_transition',event),('request',{'kind':'owner_arm'})]]
        for field,replacement in (('prefix_sha256','0'*64),('prefix_tail','0'*64),('prefix_rows',True),('proof_sha256','0'*64)):
            changed=deepcopy(event);changed[field]=replacement;cases.append(prefix+[('attempt_transition',changed)])
        for rows in cases:
            with self.subTest(last=rows[-1][0]),self.assertRaises(Denied):
                replay_control_budget(chain(rows)[0],binding=self.binding,seed=SEED,directory=self.directory,verified=self.verified)
        with self.assertRaises(Denied):replay_control_budget(chain(prefix+[('attempt_transition',event)])[0][:-1],
            binding=self.binding,seed=SEED,directory=self.directory)
        self.assertEqual(self.counter.read_bytes(),self.data['counter_raw'])


if __name__=='__main__':unittest.main()
