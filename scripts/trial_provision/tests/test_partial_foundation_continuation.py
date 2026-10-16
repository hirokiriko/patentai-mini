"""DRAFT: real schema10 validator/CLI, entirely fictional external I/O.

Install as scripts/trial_provision/tests/test_partial_foundation_continuation.py
after the root integrates the canonical patches. The only historical seam is
the already verified schema9 capability. This file is not execution evidence;
root must run it, then separately verify the real immutable recursive chain.
"""
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import attempt as a, cli, registry_publish_cli as publisher
from scripts.trial_provision import partial_foundation_continuation as target
from scripts.trial_provision.journal import replay_control_budget
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.tests.test_attempt import chain
from scripts.trial_provision.tests.test_attempt_succession import seal
from scripts.trial_provision.tests.test_pim_diagnosis import PimDiagnosisTests
from scripts.trial_provision.tests.test_unknown_identity_succession import compress
from scripts.trial_provision.tests.test_registry_retention import MemoryJournal


def fixture(case):
    """Own temporary fake-I/O resources through the supplied TestCase cleanup."""
    prior = PimDiagnosisTests('runTest'); prior.setUp(); case.addCleanup(prior.doCleanups)
    diagnostic = prior.run_reads(); h = prior.h; previous = h.verified
    assert diagnostic['counts']['owner_arm'] == 384 and diagnostic['counter_rows'] == 268
    public_raw = (h.root/'publication.json').read_bytes(); public = a._json(public_raw)
    config = {**deepcopy(public), 'authority_bundle': deepcopy(h.authority)}
    artifacts = {k: Path(ref['path']).read_bytes() for k, ref in public['attempt_evidence']['artifacts'].items()}
    parent_raw = h.parent_bytes
    parent_final_raw = Path(public['attempt_evidence']['parent_final']['path']).read_bytes()
    counter_raw = (h.root/'trial-control-budget.jsonl').read_bytes()
    child_raw = prior.evidence['child']
    state = replay_control_budget(counter_raw, binding=config['control_budget']['binding'], seed=a.SEED,
        directory=config['control_budget']['directory'], verified=previous)
    caps, reserve, delta = target.allocation(state['plan'], state['used'], state['counts'])
    assert state['counts'] == {'owner_arm':384, 'owner_control_blob':32, 'heartbeat_blob':0}
    assert caps['owner_arm']['cleanup'] == 117 and sum(caps['owner_arm'].values()) == 247
    old = previous.authority; authority = deepcopy(old); activation = previous.activation
    old_t = parse(old['publish_from']); new_t = old_t + timedelta(seconds=3600)
    stamp = lambda value: a._stamp(value)
    approved = stamp(old_t + timedelta(seconds=2400)); issued = stamp(old_t + timedelta(seconds=2500))
    head = '1'*40
    config.update(frozen_head=head, code_sources={'scripts/trial_provision/partial_foundation_continuation.py':'1'*64})
    compatibility = a._json(artifacts['local_ready'])['succession_proof']['image_compatibility']
    proof = {'schema':9, 'previous_authority_raw':encoded(old).decode(),
        'previous_activation_raw':encoded(previous.activation).decode(), 'previous_publication_raw':public_raw.decode(),
        'previous_provision_raw':encoded(h.config).decode(),
        'previous_bridge_inputs_raw':(h.root/'bridge-input.json').read_bytes().decode(),
        'previous_child_raw':child_raw.decode(),
        'previous_artifacts':{k:compress(v) if k=='local_ready' else v.decode() for k,v in artifacts.items()},
        'stop_guard_raw':prior.evidence['stop_guard'].decode(), 'stop_cleanup_raw':prior.evidence['stop_cleanup'].decode(),
        'diagnostic_result_raw':encoded(diagnostic).decode(), 'counter_prefix_raw':counter_raw.decode(),
        'diagnostic_history':{'grant_raw':encoded(prior.g).decode(),
            'marker_raw':(h.root/'trial-v8-pim-diagnosis-intent.json').read_text(),
            **{k:prior.evidence[k].decode() for k in ('prior_grant','prior_request','prior_result','prior_marker','direct_request')}},
        'image_compatibility':{**compatibility, 'local_head':head}}
    authority.update(schema=10, approval='ISSUE148_LINKED_ATTEMPT_V10', head=head,
        attempt_id='fictional-v8r1-partial-foundation', code_sources_sha256=digest(config['code_sources']),
        approved_at=approved, publish_from=stamp(new_t), counts_before=state['counts'], phase_caps=caps, unallocated=reserve,
        inherited_guardian_end=previous.activation['windows']['guardian']['end'],
        succession={'schema':9, 'kind':target.KIND, 'proof_sha256':digest(proof),
                    'child_name':target.CHILD_NAME, 'phase_reallocation':delta})
    artifacts['local_ready'] = encoded({'head':head, 'design_sha256':a.DESIGN_SHA256,
        'code_sources_sha256':authority['code_sources_sha256'], 'succession_proof':proof})
    artifacts['limits'] = encoded({'schema':1, 'head':head, 'counts_before':state['counts'],
        'phase_caps':caps, 'unallocated':reserve, 'purpose_caps':a.purpose_caps(authority),
        'limits':a._authority_limits(authority), 'limit_amendment':authority['limit_amendment']})
    activation.update(attempt_id=authority['attempt_id'], issued_at=issued,
        windows={k:{'start':stamp(new_t+timedelta(seconds=s)), 'end':stamp(new_t+timedelta(seconds=e))}
                 for k,(s,e) in a.window_offsets(authority).items()})
    config['publication']['publish_until'] = activation['windows']['publication']['end']
    parent_rows = [(r['event'],r['value']) for r in map(a._json,parent_raw.splitlines())]
    n = {'authority':authority, 'activation':activation, 'config':config, 'manifest':deepcopy(h.manifest),
         'artifacts':artifacts, 'parent_rows':parent_rows, 'parent_final':a._json(parent_final_raw)}
    seal(n)
    return {'new':n, 'old':previous, 'proof':proof, 'h':h, 'prior':prior, 'now':issued,
            'counter_raw':counter_raw, 'child_raw':child_raw,
            'counter_rows':[(r['event'],r['value']) for r in map(a._json,counter_raw.splitlines())]}


def verify(data):
    n = data['new']; original = a.verify_attempt
    def historical(*args, **kwargs):
        assert kwargs['authority_raw'] == data['proof']['previous_authority_raw'].encode()
        return data['old']
    with patch.object(a,'verify_attempt',side_effect=historical):
        return original(n['config'],n['manifest'],authority_raw=encoded(n['authority']),activation_raw=encoded(n['activation']),
            parent_journal_raw=chain(n['parent_rows'])[0],parent_final_raw=encoded(n['parent_final']),artifacts=n['artifacts'],
            trusted_authority_sha256=a._sha(encoded(n['authority'])),now=data['now'])


def reseal(data):
    n=data['new'];ready=a._json(n['artifacts']['local_ready']);ready['succession_proof']=data['proof']
    n['artifacts']['local_ready']=encoded(ready);n['authority']['succession']['proof_sha256']=digest(data['proof']);seal(n)


def clone(data):
    """Clone mutable proof bytes, preserving immutable capabilities and fake harness."""
    return deepcopy(data,{id(data[k]):data[k] for k in ('old','h','prior')})


def install(case, data):
    """Real publisher prepare/bind and CLI context; no publication wire is allowed."""
    h=data['h'];n=data['new'];c=deepcopy(n['config']);c.pop('authority_bundle')
    h.verified=verify(data);h.trusted=a._sha(encoded(n['authority']));h.windows=h.verified.activation['windows']
    h.f.head=n['authority']['head'];h.f.sources=c['code_sources']
    h.clock.start=parse(n['authority']['publish_from']);h.clock.seconds=0
    h.pool=OwnerTokenPool(h.verified,h.clock);case.addCleanup(h.pool.close)
    write=lambda name,value:h.f.write(name,value if type(value) is bytes else encoded(value))
    c['ci']=write('v8r1-ci.json',{'head_sha':h.f.head,'status':'completed','conclusion':'success',
        'required_checks':[{'name':name,'status':'completed','conclusion':'success'} for name in ('ci','isolated-pg16')],
        'source_url':'https://github.com/hirokiriko/patentai-mini/actions/runs/123','checked_at':data['now']})
    c['attempt']=write('v8r1-activation.json',n['activation'])
    c['attempt_evidence']={'authority':write('v8r1-authority.json',n['authority']),
        'parent_final':write('v8r1-parent-final.json',n['parent_final']),
        'artifacts':{k:write('v8r1-artifact-'+k+'.json',v) for k,v in n['artifacts'].items()}}
    for slot in ('guardian','runtime'):c['publication']['slots'][slot]['build_receipt']=c['attempt_evidence']['artifacts'][slot+'_build']
    original=a.verify_attempt
    def historical(*args,**kwargs):
        if kwargs['authority_raw']==data['proof']['previous_authority_raw'].encode():return data['old']
        return original(*args,**kwargs)
    case.enterContext(patch.object(a,'verify_attempt',side_effect=historical))
    for module in (cli,publisher):
        case.enterContext(patch.object(module,'git',return_value=(h.f.head+'\n').encode()))
        case.enterContext(patch.object(module,'local_sources',return_value=h.f.sources))
    reference=write('v8r1-publication.json',c)
    no_publication=Mock(side_effect=AssertionError('continuation must not send image/publication I/O'))
    def pub(action,**extra):
        return publisher.run_command({'config':reference['path'],'action':action,**extra},clock=h.clock,
            wire=no_publication,trusted_attempt_authority=h.trusted)
    case.assertEqual(384,pub('prepare')['control_requests_used'])
    inputs={'schema':1,'publication_config_sha256':reference['sha256'],
        'plan_bindings':{'guardian_window':h.windows['guardian'],'owner_window':h.windows['owner_input']},
        'deadline':h.windows['owner_input']['end'],'policy_verifier_node':str(h.root/'node.exe'),
        'secret_sources':a._json(data['proof']['previous_bridge_inputs_raw'].encode())['secret_sources']}
    result=pub('bind-provision',provision=write('v8r1-bridge-input.json',inputs));no_publication.assert_not_called()
    case.assertEqual('provision-continuation-v8r1-config.json',result['config_file'])
    h.config=h.f.config=a._json((h.root/result['config_file']).read_bytes())
    raw_journal=h.journal
    @contextmanager
    def journal():
        with raw_journal() as base:yield target.continuation_journal(base,h.verified,initialize=False)
    h.journal=journal;h.clock.seconds=600
    case.assertEqual(0,h.f.run_action('status')['unresolved'])
    case.assertEqual(data['child_raw'],(h.root/'trial-provision-successor-v8.jsonl').read_bytes())
    return h


class Journal(MemoryJournal):
    def receipts(self):
        result={}
        for value in self.values('progress'):result[value['operation_id']]=value
        return result


class PartialFoundationContinuationTests(unittest.TestCase):
    def setUp(self):self.data=fixture(self)

    def test_exact_thirteen_carry_and_lifetime_cleanup(self):
        d=self.data;v=verify(d);proof=a._proof(v)['succession'];old=d['old']
        self.assertEqual(set(target.SLOTS),set(target.carried_receipts(v)))
        self.assertEqual((3,117,120),(proof['cleanup_already_consumed'],proof['cleanup_remaining'],proof['cleanup_original']))
        self.assertEqual(old.activation['windows']['guardian']['end'],v.activation['windows']['guardian']['end'])
        self.assertEqual(old.authority['unknown_identity_retention'],v.authority['unknown_identity_retention'])
        for slot,operation in target.carried_operations(v).items():
            self.assertEqual(digest(operation),target.carried_receipts(v)[slot]['request_digest'])
        self.assertEqual(384+247,631)
        self.assertLess(len(d['new']['artifacts']['local_ready']),a._MAX_JSON)

    def test_no_replay_or_copied_receipt_in_new_chain(self):
        d=self.data;v=verify(d);binding=a.journal_descriptor(d['new']['config'],v)[1]
        base=Journal([('binding',binding),('plan',{})]);view=target.continuation_journal(base,v,initialize=True)
        before=deepcopy(base.rows);op=target.carried_operations(v)['webIdentity'];receipt=target.carried_receipts(v)['webIdentity']
        self.assertEqual(set(target.SLOTS),set(view.receipts()))
        for operation in (lambda:view.intent(op,d['now']),lambda:view.checkpoint(op,receipt),
                          lambda:view.append('intent',{'operation_id':'webIdentity'}),lambda:view.append('progress',receipt)):
            with self.assertRaises(Denied):operation()
        self.assertEqual(before,base.rows)
        base.append('progress',receipt)
        with self.assertRaises(Denied):target.continuation_journal(base,v)

    def test_changed_ack_or_duplicate_ack_cannot_be_resealed(self):
        for alter in ('unknown','properties','deadline','duplicate'):
            changed=clone(self.data);rows=[(r['event'],r['value']) for r in map(a._json,changed['child_raw'].splitlines())]
            last=rows[-1][1]
            if alter=='unknown':last.update(state='unknown',terminal=False,readback_verified=False)
            elif alter=='properties':last['properties']['name']='forged'
            elif alter=='deadline':next(v for e,v in reversed(rows) if e=='intent')['deadline']=changed['new']['activation']['windows']['owner_input']['end']
            else:rows.append(deepcopy(rows[-1]))
            changed['proof']['previous_child_raw']=chain(rows)[0].decode();reseal(changed)
            with self.subTest(alter=alter),self.assertRaises(Denied):verify(changed)

    def test_counts_cleanup_unknown_and_old_deadline_cannot_be_reset(self):
        edits=(lambda d:d['new']['authority']['counts_before'].update(owner_arm=383),
            lambda d:d['new']['authority']['phase_caps']['owner_arm'].update(cleanup=120),
            lambda d:d['new']['authority']['unknown_identity_retention'].update(old_unknown_preserved=False),
            lambda d:d['new']['authority'].update(inherited_guardian_end=a._stamp(parse(d['new']['authority']['inherited_guardian_end'])+timedelta(seconds=1))))
        for index,edit in enumerate(edits):
            changed=clone(self.data);edit(changed);seal(changed['new'])
            with self.subTest(index=index),self.assertRaises(Denied):verify(changed)

    def test_projection_uuid_ack_get_binding_and_empty_other_projections(self):
        d=self.data;v=verify(d);source=a._proof(v)['succession'];ops=target.carried_operations(v)
        final=target.carried_receipts(v)['webIdentity']
        ack=next(row for row in source['carried_progress'] if row['operation_id']=='webIdentity' and row['state']=='pending')
        check=lambda x,y:target._receipt_projection(ops['webIdentity'],x,y,d['new']['manifest'])
        check(ack,final)
        upper=deepcopy(final);upper['properties']={k:value.upper() for k,value in upper['properties'].items()};check(ack,upper)
        edits=(lambda x:x['properties'].pop('clientId'),lambda x:x['properties'].update(extra='secret-canary'),
            lambda x:x['properties'].update(clientId='11111111-1111-4111-8111-111111111111'),
            lambda x:x['properties'].update(principalId='not-a-uuid'),
            lambda x:x['properties'].update(tenantId='11111111-1111-4111-8111-111111111111'),
            lambda x:x.pop('identity_properties_digest'),lambda x:x.update(binding_digest='0'*64))
        for index,edit in enumerate(edits):
            changed=deepcopy(final);edit(changed)
            with self.subTest(index=index),self.assertRaises(Denied):check(ack,changed)
        changed=deepcopy(ack);changed.pop('identity_properties_digest')
        with self.assertRaises(Denied):check(changed,final)
        for slot in ('originals','C7'):
            receipt=target.carried_receipts(v)[slot]
            old_ack=next(row for row in source['carried_progress'] if row['operation_id']==slot and row['state']=='pending')
            target._receipt_projection(ops[slot],old_ack,receipt,d['new']['manifest'])
            receipt['properties']['unexpected']='not-retained'
            with self.assertRaises(Denied):target._receipt_projection(ops[slot],old_ack,receipt,d['new']['manifest'])

    def test_counter_exact_268_prefix_one_transition_and_cleanup_cumulative_120(self):
        d=self.data;v=verify(d);c=d['new']['config'];rows=d['counter_rows']+[('attempt_transition',target.transition_value(v))]
        replay=lambda value:replay_control_budget(chain(value)[0],binding=c['control_budget']['binding'],seed=a.SEED,
            directory=c['control_budget']['directory'],verified=v)
        self.assertEqual(384,replay(rows)['counts']['owner_arm'])
        with self.assertRaises(Denied):replay(rows+[rows[-1]])
        for phase in a.PHASES:
            cap=v.authority['phase_caps']['owner_arm'][phase]
            purpose=a.purpose_caps(v.authority).get(phase,{})
            tokens=min(purpose.get('owner_token',1),cap);http=cap-tokens
            self.assertLessEqual(http,purpose.get('http',cap))
            for name,count in (('owner_token',tokens),('http',http)):
                rows += [('request',{'kind':'owner_arm','attempt':v.binding_digest,'phase':phase,'purpose':name}) for _ in range(count)]
        self.assertEqual(631,replay(rows)['counts']['owner_arm'])
        with self.assertRaises(Denied):replay(rows+[rows[-1]])

    def test_real_cli_prepare_bind_and_old_create_stops_before_wire(self):
        d=self.data;h=install(self,d);before=(h.root/'trial-control-budget.jsonl').read_bytes()
        child=(h.root/(target.CHILD_NAME+'.jsonl')).read_bytes();calls=len(h.arm.calls)
        for slot in target.SLOTS:
            with self.subTest(slot=slot),self.assertRaises(Denied):h.f.run_action('create',operation_id=slot)
        self.assertEqual(calls,len(h.arm.calls))
        self.assertEqual(before,(h.root/'trial-control-budget.jsonl').read_bytes())
        self.assertEqual(child,(h.root/(target.CHILD_NAME+'.jsonl')).read_bytes())
        resolver,receipts=h.snapshot()
        for slot in target.SLOTS:self.assertEqual(target.carried_operations(h.verified)[slot],resolver.resolve(slot,receipts))


if __name__=='__main__':unittest.main()
