"""Fictional sealed dispatcher inputs; no real ledger, approvals or Cloud."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from scripts.trial_guard.adapters import digest,encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import attempt as a,input_succession as target,published_succession as prior
from scripts.trial_provision.journal import ControlBudget,Journal,replay_control_budget
from scripts.trial_provision.tests.test_attempt import chain
from scripts.trial_provision.tests.test_attempt_accounting import scope
from scripts.trial_provision.tests.test_attempt_succession import owner_save
from scripts.trial_provision.tests.test_published_succession import published_fixture,verified


def fixture(directory):
    data=published_fixture(directory);old=verified(data);config=data['new']['config']
    rows=data['counter_rows']+[('attempt_transition',prior.transition_value(old))]
    for phase,count in (('fresh_read',6),('publication',15),('cleanup',10)):
        rows.extend(('request',{'kind':'owner_arm','attempt':old.binding_digest,'phase':phase,
            'purpose':'owner_token' if i==0 else 'http'}) for i in range(count))
    prefix,_=chain(rows);assert len(rows)==148
    state=replay_control_budget(prefix,binding=config['control_budget']['binding'],seed=a.SEED,directory=directory,verified=old)
    caps,reserve,delta=target.allocation(state['plan'],state['used'],state['counts'])
    name,binding=a.journal_descriptor(config,old);child,tail=chain([('binding',binding)])
    p=a._proof(old);authority=p['authority'];authority.update(schema=4,approval='ISSUE148_LINKED_ATTEMPT_V4',
        counts_before=state['counts'],phase_caps=caps,unallocated=reserve,
        limit_amendment={'schema':1,'kind':'owner_arm','previous':600,'current':631,'delta':31,'approval_sha256':'a'*64})
    # This fixture isolates dispatcher/accounting behavior after verification.
    # Closed-history verification is independently tested with immutable input.
    p['authority_sha256']=digest(authority)
    p['succession']={'previous_attempt':old.binding_digest,'previous_plan':state['plan'],
        'previous_transitions':state['transitions'],'counter_prefix_sha256':a._sha(prefix),
        'counter_rows':148,'counter_tail':state['tail'],'counts':state['counts'],'phase_reallocation':delta,
        'proof_sha256':'b'*64,'child_name':name,'child_binding':binding,'child_sha256':a._sha(child),
        'child_tail':tail,'docker_paths':[]}
    current=a.VerifiedAttempt(p,a._SEAL)
    return current,old,config,prefix,child,state


class InputSuccessionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name).resolve()
        self.current,self.old,self.config,self.prefix,self.child,self.state=fixture(self.root)
        self.binding=self.config['control_budget']['binding'];self.path=self.root/'trial-control-budget.jsonl'
        owner_save(self.path,self.prefix)
        owner_save(self.root/'trial-provision-successor-v3.jsonl',self.child)
        for name in ('trial-control-budget.lock','trial-provision-successor-v3.lock'):owner_save(self.root/name,b'0')
    def open(self):
        budget=ControlBudget(self.root,digest(str(self.root)),self.binding,seed=a.SEED,require_existing=True)
        self.addCleanup(budget.close);return budget
    def replay(self,raw,verified=None):
        return replay_control_budget(raw,binding=self.binding,seed=a.SEED,directory=self.root,verified=verified or self.current)

    def test_append_reopen_old_scope_and_new_child(self):
        budget=self.open();oldscope=scope(budget,self.old,'run')
        with self.assertRaises(Denied):budget.begin_attempt(self.current)
        self.assertEqual(self.path.read_bytes(),self.prefix)
        budget.begin_attempt(self.current,initialize=True);saved=self.path.read_bytes()
        self.assertTrue(saved.startswith(self.prefix));self.assertEqual(len(saved.splitlines()),149)
        self.assertEqual(budget.counts(),target.COUNTS)
        self.assertEqual(budget.journal.values('binding')[0]['limits']['owner_arm'],600)
        for action in (lambda:oldscope.consume('owner_arm',600),lambda:budget.begin_attempt(self.old,initialize=True)):
            with self.assertRaises(Denied):action()
        budget.begin_attempt(self.current,initialize=True);self.assertEqual(saved,self.path.read_bytes())
        budget.close();budget=self.open();budget.begin_attempt(self.current)
        self.assertEqual(saved,self.path.read_bytes());self.assertEqual(budget.count('owner_arm'),270)
        config=deepcopy(self.config);config['frozen_head']=self.current.authority['head']
        name,binding=a.journal_descriptor(config,self.current);self.assertEqual(name,target.CHILD_NAME)
        with Journal(self.root,digest(str(self.root)),binding,name=name) as child:self.assertEqual(child.values('binding'),[binding])

    def test_all_caps_shared_tokens_cleanup_and_legacy_nominal_argument(self):
        budget=self.open();budget.begin_attempt(self.current,initialize=True)
        for phase,count in (('fresh_read',24),('publication',22),('provision',143),('run',42)):
            handle=scope(budget,self.current,phase)
            with self.assertRaises(Denied):handle.consume('owner_arm',631)
            for _ in range(count):handle.consume('owner_arm',600)
        handle=scope(budget,self.current,'provision')
        for _ in range(10):handle.consume_owner_token()
        self.assertEqual(budget.count('owner_arm'),511)
        for phase in ('fresh_read','publication','provision','run'):
            with self.assertRaises(Denied):scope(budget,self.current,phase).consume('owner_arm',600)
        cleanup=scope(budget,self.current,'cleanup')
        for _ in range(90):cleanup.consume('owner_arm',600)
        self.assertEqual(budget.count('owner_arm'),601);cleanup.consume_owner_token()
        for _ in range(29):cleanup.consume('owner_arm',600)
        self.assertEqual(budget.count('owner_arm'),631)
        with self.assertRaises(Denied):cleanup.consume_owner_token()
        saved=self.path.read_bytes();budget.close();budget=self.open();budget.begin_attempt(self.current)
        self.assertEqual(budget.count('owner_arm'),631);self.assertEqual(saved,self.path.read_bytes())

    def test_old_600_new_631_boundary_and_amendment_types(self):
        counts={'owner_arm':630,'owner_control_blob':32,'heartbeat_blob':0}
        a.check_phase_send(self.current,'owner_arm','cleanup',counts,0)
        for count,phase in ((511,'run'),(631,'cleanup')):
            with self.assertRaises(Denied):a.check_phase_send(self.current,'owner_arm',phase,{**counts,'owner_arm':count},0)
        with self.assertRaises(Denied):a.check_phase_send(self.old,'owner_arm','cleanup',{**counts,'owner_arm':600},0)
        for key,value in (('schema',True),('current',632),('previous',599),('delta',30),('approval_sha256','invalid')):
            authority=self.current.authority;authority['limit_amendment'][key]=value
            with self.assertRaises(Denied):a._authority_limits(authority)

    def test_transition_tampering_and_fourth_transition_fail(self):
        rows=[(r['event'],r['value']) for r in map(a._json,self.prefix.splitlines())]
        transition=target.transition_value(self.current);rows.append(('attempt_transition',transition))
        self.assertEqual(self.replay(chain(rows)[0])['counts'],target.COUNTS)
        for change in ('first','second','third','fourth','approval','delta','prefix','count'):
            mutated=deepcopy(rows)
            if change in ('first','second','third'):
                index={'first':71,'second':116,'third':148}[change];mutated[index][1]['proof_sha256']='0'*64
            elif change=='fourth':mutated.append(deepcopy(mutated[-1]))
            elif change=='approval':mutated[-1][1]['limit_amendment']['approval_sha256']='0'*64
            elif change=='delta':mutated[-1][1]['phase_reallocation']['phase_delta']['cleanup']=9
            elif change=='prefix':mutated[-1][1]['prefix_rows']=147
            else:mutated[-1][1]['counts']['owner_arm']=269
            with self.subTest(change=change),self.assertRaises(Denied):self.replay(chain(mutated)[0])


if __name__=='__main__':unittest.main()
