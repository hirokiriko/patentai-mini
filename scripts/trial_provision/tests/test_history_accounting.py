"""Fictional copies of the historical marker shape; never open a live ledger."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.journal import (ControlBudget, Journal, _HISTORY_SOURCE_SHA256,
    _HISTORY_SOURCES, validated_history_marker_indexes)
from scripts.trial_provision.tests.test_attempt import fixture, verify, SEED
from scripts.trial_provision.tests.test_attempt_accounting import scope


def historical_records(directory):
    sources=[{'path':str(Path(directory)/name),'sha256':checksum} for name,checksum in _HISTORY_SOURCES]
    common={'source_sha256':_HISTORY_SOURCE_SHA256,'subsequent_sources':sources,'kind':'owner_arm','requests':3}
    return [('history_debit_intent',{**deepcopy(common),'start_count':128}),
        *[('request',{'kind':'owner_arm'}) for _ in range(3)],
        ('history_debit_complete',{**deepcopy(common),'end_count':131}),
        *[('request',{'kind':'owner_arm'}) for _ in range(56)]]


class HistoricalAccountingTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.directory=Path(temporary.name).resolve();self.data=fixture()
        self.binding=self.data['config']['control_budget']['binding']
        self.binding['source_sha256']=_HISTORY_SOURCE_SHA256
        self.data['authority']['budget_binding_sha256']=digest(self.binding)
        self.verified=verify(self.data)
        self.args=(self.directory,digest(str(self.directory)),self.binding)

    def rows(self):
        return [{'event':'binding','value':{'binding':self.binding,'seed':SEED,'limits':ControlBudget.LIMITS}},
            *[{'event':event,'value':value} for event,value in historical_records(self.directory)]]

    def validate(self,rows,**changes):
        return validated_history_marker_indexes(rows,**({'binding':self.binding,'seed':SEED,'directory':self.directory}|changes))

    def save(self,rows):
        with Journal(*self.args[:2],{'binding':self.binding,'seed':SEED,'limits':ControlBudget.LIMITS},name='trial-control-budget') as journal:
            for row in rows[1:]:journal.append(row['event'],row['value'])
        return self.directory/'trial-control-budget.jsonl'

    def test_62_row_prefix_reopens_without_double_debit_and_can_consume_after_approval(self):
        rows=self.rows();self.assertEqual(len(rows),62);self.assertEqual(self.validate(rows),frozenset((1,5)))
        path=self.save(rows);before=path.read_bytes()
        with ControlBudget(*self.args,seed=SEED,require_existing=True) as budget:
            self.assertEqual(budget.counts(),{'owner_arm':187,'owner_control_blob':32,'heartbeat_blob':0})
            self.assertEqual(path.read_bytes(),before)
            budget.begin_attempt(self.verified,initialize=True)
            scope(budget,self.verified,'fresh_read').consume_owner_token()
            scope(budget,self.verified,'fresh_read').consume('owner_arm',600)
            self.assertEqual(budget.count('owner_arm'),189)
            self.assertTrue(path.read_bytes().startswith(before))
            self.assertEqual(len(budget.journal.values('phase_plan')),1)
            after=path.read_bytes()
        with ControlBudget(*self.args,seed=SEED,require_existing=True) as budget:
            budget.begin_attempt(self.verified)
            self.assertEqual(budget.count('owner_arm'),189);self.assertEqual(path.read_bytes(),after)
            self.assertEqual(budget.seed,SEED)

    def test_unknown_partial_reordered_duplicate_and_late_markers_are_rejected(self):
        original=self.rows();cases=[]
        cases += [original[:2],original[:5],original[:1]+original[2:],original[:5]+original[6:]]
        changed=deepcopy(original);changed[1],changed[5]=changed[5],changed[1];cases.append(changed)
        cases.append(deepcopy(original)+[deepcopy(original[1])])
        changed=deepcopy(original);changed[1]['event']='history_debit_unknown';cases.append(changed)
        changed=deepcopy(original);changed.insert(1,{'event':'phase_plan','value':{}});cases.append(changed)
        changed=deepcopy(original);changed[3]={'event':'request','value':{'kind':'owner_control_blob'}};cases.append(changed)
        changed=deepcopy(original);changed[4]={'event':'phase_plan','value':{}};cases.append(changed)
        for index,rows in enumerate(cases):
            with self.subTest(index=index),self.assertRaises(Denied):self.validate(rows)

    def test_malformed_counts_schema_hashes_paths_and_mutually_changed_provenance_rejected(self):
        original=self.rows()
        for index,key,value in ((1,'requests',True),(5,'requests',3.0),(1,'start_count',127),(5,'end_count',132),
                (1,'kind','owner_control_blob'),(5,'source_sha256','a'*64),(1,'unexpected',0)):
            rows=deepcopy(original);rows[index]['value'][key]=value
            with self.subTest(index=index,key=key),self.assertRaises(Denied):self.validate(rows)
        for change in ('hash','name','parent','extra','order','duplicate'):
            rows=deepcopy(original);sources=rows[1]['value']['subsequent_sources']
            if change=='hash':sources[0]['sha256']='a'*64
            elif change=='name':sources[0]['path']=str(self.directory/'other.json')
            elif change=='parent':sources[0]['path']=str(self.directory.parent/'preflight.local.json')
            elif change=='extra':sources[0]['extra']=True
            elif change=='order':sources.reverse()
            else:sources[1]=deepcopy(sources[0])
            rows[5]['value']['subsequent_sources']=deepcopy(sources)
            with self.subTest(change=change),self.assertRaises(Denied):self.validate(rows)
        with self.assertRaises(Denied):self.validate(original,binding={**self.binding,'source_sha256':'a'*64})
        with self.assertRaises(Denied):self.validate(original,seed={**SEED,'owner_arm':131})

    def test_invalid_durable_pair_fails_before_counter_append(self):
        rows=self.rows();rows[5]['value']['end_count']=132;path=self.save(rows);before=path.read_bytes()
        with self.assertRaises(Denied):ControlBudget(*self.args,seed=SEED,require_existing=True)
        self.assertEqual(path.read_bytes(),before)


if __name__=='__main__':unittest.main()
