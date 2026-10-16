"""Real schema-9 CLI/bridge/controller/adapters with fictional external I/O."""
from copy import deepcopy
from pathlib import Path
from collections import Counter
import json
import unittest
from urllib.parse import urlsplit
from unittest.mock import patch, Mock
from scripts.trial_guard.adapters import digest, encoded, Deadline
from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision import attempt as a, cli, registry_publish_cli as publisher, publication_configuration
from scripts.trial_provision import guard_assignments as assignments
from scripts.trial_provision.configuration import SOURCE_FILES
from scripts.trial_provision.journal import ControlBudget, CountedControlHttp, scope_for_dispatch
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.tests import test_unknown_identity_succession as fixture
from scripts.trial_provision.tests import test_workflow_contract as workflow
from scripts.trial_provision.tests.test_workflow_contract import ArmWire, Credential, response
from scripts.trial_provision.tests.test_private_io import create_owner_directory
from scripts.trial_provision.tests.test_attempt import chain


class WorkflowV8Tests(unittest.TestCase):
    def setUp(self):
        h = self.h = workflow.WorkflowContractTests('runTest'); h.setUp(); self.addCleanup(h.doCleanups)
        with patch.object(Path, 'cwd', return_value=h.root.parent): data = fixture.fixture()
        self.data = data; n=data['new']; c=deepcopy(n['config']); directory=Path(c['recovery']['directory'])
        create_owner_directory(directory); h.root=h.f.root=directory; h.f.config_path=directory/'configuration.local.json'
        write=lambda name,value:h.f.write(name,value if type(value) is bytes else encoded(value))
        write('trial-provision.jsonl',chain(n['parent_rows'])[0]); h.parent_bytes=chain(n['parent_rows'])[0]
        write('trial-control-budget.jsonl',data['counter_raw']); write('trial-provision-continuation-v7r1.jsonl',data['child_raw'])
        write('trial-control-budget.lock',b''); write('trial-provision-continuation-v7r1.lock',b'')
        c['sources']={k:write(SOURCE_FILES[k],v) for k,v in c.pop('authority_bundle').items()}
        c.update(schema=1, live=True, ci=write('ci.json',{'head_sha':n['authority']['head'], 'status':'completed','conclusion':'success',
            'required_checks':[{'name':name,'status':'completed','conclusion':'success'} for name in ('ci','isolated-pg16')],
            'source_url':'https://github.com/hirokiriko/patentai-mini/actions/runs/123','checked_at':n['activation']['issued_at']}))
        c['attempt']=write('activation.json',n['activation'])
        c['attempt_evidence']={'authority':write('authority.json',n['authority']), 'parent_final':write('parent-final.json',n['parent_final']),
            'artifacts':{k:write('artifact-'+k+'.json',v) for k,v in n['artifacts'].items()}}
        for slot in ('guardian','runtime'): c['publication']['slots'][slot]['build_receipt']=c['attempt_evidence']['artifacts'][slot+'_build']
        h.verified=fixture.verify(data); h.trusted=c['attempt_evidence']['authority']['sha256']; h.windows=h.verified.activation['windows']
        h.f.head=n['authority']['head']; h.f.sources=c['code_sources']; h.authority=n['config']['authority_bundle']; h.manifest=n['manifest']
        h.clock.start=parse(n['authority']['publish_from']); h.clock.seconds=0
        h.pool=OwnerTokenPool(h.verified,h.clock); self.addCleanup(h.pool.close)
        h.arm=ArmWire(h.manifest,h.clock); h.f.wire=h.arm
        original=a.verify_attempt
        def historical(*args,**kwargs):
            if kwargs['authority_raw']==data['proof']['previous_authority_raw'].encode():return data['old']
            return original(*args,**kwargs)
        self.enterContext(patch.object(a,'verify_attempt',side_effect=historical))
        self.enterContext(patch.object(publication_configuration,'_executable'))
        for module in (cli,publisher):
            self.enterContext(patch.object(module,'git',return_value=(h.f.head+'\n').encode()))
            self.enterContext(patch.object(module,'local_sources',return_value=h.f.sources))
        reference=write('publication.json',c)
        def pub(action,**extra):
            return publisher.run_command({'config':reference['path'],'action':action,**extra},clock=h.clock,
                wire=Mock(side_effect=AssertionError('publication I/O')),trusted_attempt_authority=h.trusted)
        self.assertEqual(pub('prepare')['control_requests_used'],333)
        inputs={'schema':1,'publication_config_sha256':reference['sha256'],
            'plan_bindings':{'guardian_window':h.windows['guardian'],'owner_window':h.windows['owner_input']},
            'deadline':h.windows['owner_input']['end'],'policy_verifier_node':write('node.exe',b'fictional executable boundary')['path'],
            'secret_sources':{f'trial-{s}-database':write(s+'.credential',('fictional-database-'+s).encode()) for s in ('web','worker')}}
        result=pub('bind-provision',provision=write('bridge-input.json',inputs))
        self.assertEqual(result['config_file'],'provision-successor-v8-config.json')
        h.config=h.f.config=json.loads((directory/result['config_file']).read_bytes())
        def run(action='prepare',**extra):
            write(h.f.config_path.name,h.config); calls=getattr(h.f.wire,'calls',h.arm.calls); before=len(calls)
            try:return cli.run_command({'config':str(h.f.config_path),'action':action,**extra},clock=h.clock,
                wire=h.f.wire,trusted_attempt_authority=h.trusted,owner_token_pool=h.pool)
            finally:h.action_trace.append({'action':action,'operation':extra.get('operation_id'),'requests':[(r[0],r[1]) for r in calls[before:]]})
        h.f.run_action=run; h.clock.seconds=600
        self.assertEqual(run('status')['unresolved'],0)
        h.before_main=self.main_role_checks

    def timed_credential(self, ttl=3600):
        clock=self.h.clock
        class TimedCredential(Credential):
            def token(self,audience,deadline):
                deadline.remaining()
                return workflow.publish_fixture.jwt({'oid':self.principal,'tid':self.tenant,'aud':audience,
                    'exp':clock.utc().timestamp()+ttl})
        self.enterContext(patch.object(workflow,'Credential',TimedCredential))
        self.enterContext(patch(__name__+'.Credential',TimedCredential))
        self.h.f.credential.side_effect=TimedCredential
        return TimedCredential

    def test_sixty_minute_pool_known_lro_and_actual_phase_counters(self):
        from scripts.trial_provision.attempt_dispatch import ApprovedAttemptSession
        h=self.h; self.timed_credential(); h.expected_provision_polls=7
        original=h.arm.__class__.__call__; polls={}
        def asynchronous(wire,method,url,headers,body,deadline):
            if url in polls:
                wire.calls.append((method,urlsplit(url).path));return response(200,{'status':'Succeeded'})
            result=original(wire,method,url,headers,body,deadline)
            rid=urlsplit(url).path
            if method in ('PUT','PATCH') and rid in (h.manifest['ids'][slot] for slot in ('guard','job','app')):
                kind,name=rid.split('/')[-2:]
                poll=f'https://management.azure.com/subscriptions/{rid.split("/")[2]}/providers/Microsoft.App/{kind}/{name}/operationResults/11111111-1111-4111-8111-111111111111?api-version=2025-07-01'
                polls[poll]=True
                return response(201 if method=='PUT' else 202,headers={'Azure-AsyncOperation':poll,'Retry-After':'1'})
            return result
        self.enterContext(patch.object(ArmWire,'__call__',asynchronous))
        session=ApprovedAttemptSession(h.verified,h.clock);session.pool.close();session.pool=h.pool
        self.addCleanup(session.close)
        # Production dispatcher handles known ACKs; writes are never retried.
        session.dispatch=lambda kind,request:h.f.run_action(**{k:v for k,v in request.items() if k!='config'})
        try:result=session.run_group(h.f.config_path,'foundation',sleep=h.clock.advance)
        except Denied:
            last=h.action_trace[-1]
            self.fail(str({'last':last,'receipt':h.snapshot()[1].get(last['operation'])}))
        self.assertEqual(result['status'],'phase_verified')
        raw=h.f.run_action
        def completed(action='prepare',**extra):
            result=raw(action,**extra)
            if action in ('create','update') and result.get('status')=='pending':
                h.clock.advance(2);result=raw('reconcile',operation_id=extra['operation_id'])
            if extra.get('operation_id')=='E4':
                receipt=h.snapshot()[1].get('auth-platform-secret')
                if receipt and receipt['state']=='pending':
                    h.clock.advance(2);self.assertEqual(raw('reconcile',operation_id='auth-platform-secret')['status'],'succeeded')
            return result
        h.f.run_action=completed
        def rehearsal_async(wire,execution_id):
            rid=h.manifest['ids']['guard']; poll=f'https://management.azure.com/subscriptions/{rid.split("/")[2]}/providers/Microsoft.App/jobs/{h.manifest["names"]["guard"]}/operationResults/22222222-2222-4222-8222-222222222222?api-version=2025-07-01'
            wire.start_response=response(202,headers={'Location':poll,'Retry-After':'1'})
            wire.modify=lambda m,u,headers,body:response(200,{'id':execution_id}) if u==poll else None
        h.rehearsal_wire_setup=rehearsal_async
        h.clock.seconds=2100;h.rehearse();h.guardian_execute();h.bind_and_deploy();h.enable_owner_auth()
        rows=[json.loads(line) for line in (h.root/'trial-control-budget.jsonl').read_bytes().splitlines()]
        used=Counter((r['value']['phase'],r['value']['purpose']) for r in rows if r['event']=='request' and r['value'].get('attempt')==h.verified.binding_digest and r['value']['kind']=='owner_arm')
        self.assertEqual(used,Counter({('provision','http'):139,('provision','owner_token'):2,('run','http'):18,('run','owner_token'):2}))
        # The separately exercised actual preflight contributes sixteen fresh
        # HTTP calls. An extra poll/token must stop before external I/O.
        b=h.config['control_budget']; credential=Credential('owner',h.manifest['owner']['principal_id'],h.manifest['owner']['tenant_id'])
        with ControlBudget(b['directory'],b['directory_digest'],b['binding'],seed=b['seed'],require_existing=True) as budget:
            for entry,action in (('owner-run','execute'),('provision','create')):
                resolver,receipts=h.snapshot()
                scope=scope_for_dispatch(budget,h.verified,entry_point=entry,action=action,
                    operation=resolver.resolve('auth-config',receipts) if entry=='provision' else None)
                spy=Mock(side_effect=AssertionError('exhausted budget reached wire'))
                with self.assertRaises(Denied):CountedControlHttp(spy,scope)('GET','https://management.azure.com/',{},None,Deadline(10,h.clock.monotonic))
                spy.assert_not_called()
            self.assertEqual(budget.count('owner_arm')+16+120,630)

    def test_twenty_minute_tokens_stop_before_third_run_acquisition(self):
        h=self.h; cls=self.timed_credential(1200); raw=cls('owner',h.manifest['owner']['principal_id'],h.manifest['owner']['tenant_id'])
        raw.token=Mock(wraps=raw.token);b=h.config['control_budget']
        with ControlBudget(b['directory'],b['directory_digest'],b['binding'],seed=b['seed'],require_existing=True) as budget:
            scope=scope_for_dispatch(budget,h.verified,entry_point='owner-run',action='execute')
            credential=h.pool.bind(raw,scope,h.verified)
            for audience in ('https://storage.azure.com/','https://management.azure.com/'):
                credential.token(audience,Deadline(10,h.clock.monotonic))
            h.clock.advance(1200)
            with self.assertRaisesRegex(Denied,'budget_purpose_exhausted'):
                credential.token('https://storage.azure.com/',Deadline(10,h.clock.monotonic))
            self.assertEqual(raw.token.call_count,2)
            self.assertEqual(budget.count('owner_arm'),335)

    def main_role_checks(self):
        h=self.h
        for slot in ('E2','E3'):self.assertEqual(h.f.run_action('create',operation_id=slot)['status'],'succeeded')
        h.clock.seconds=3900; resolver, receipts=h.snapshot()
        facts={s:(resolver.resolve(s,receipts),receipts[s]) for s in assignments.OWNED}
        url, expected=assignments.specification(facts)
        # Derive list from every actual fake ARM object, including extras.
        principal=receipts['guard']['properties']['principalId']; page=[]
        for rid,v in h.arm.objects.items():
            if '/roleAssignments/' not in rid or v.get('properties',{}).get('principalId')!=principal:continue
            scope,name=rid.rsplit('/providers/Microsoft.Authorization/roleAssignments/',1)
            page.append({**deepcopy(v),'name':name,'type':'Microsoft.Authorization/roleAssignments',
                'properties':{**v['properties'],'scope':scope}})
        wire=lambda method,target,headers,body,deadline: response(200,{'value':page}) if target==url else h.arm(method,target,headers,body,deadline)
        b=h.config['control_budget']
        with ControlBudget(b['directory'],b['directory_digest'],b['binding'],seed=b['seed'],require_existing=True) as budget:
            scope=scope_for_dispatch(budget,h.verified,entry_point='owner-run',action='execute')
            http=CountedControlHttp(wire,scope); deadline=Deadline(60,h.clock.monotonic)
            token=h.pool.bind(Credential('owner',h.manifest['owner']['principal_id'],h.manifest['owner']['tenant_id']),scope,h.verified).token('https://management.azure.com/',deadline)
            for slot in ('C1','C2','C3'):
                op=resolver.resolve(slot,receipts);self.assertEqual(http('GET',op['url'],{'Authorization':'Bearer '+token},None,deadline)['status'],200)
            value=http('GET',url,{'Authorization':'Bearer '+token},None,deadline)
            self.assertEqual(assignments.checked_page(json.loads(value['body']),expected),expected)

    def test_real_bridge_callback_runtime_and_expired_cleanup(self):
        h=self.h; h.provision(all_permissions=True); h.clock.seconds=2100; h.rehearse(); h.guardian_execute(); h.bind_and_deploy()
        resolver,receipts=h.snapshot()
        self.assertNotIn('appRuntime',receipts)
        with self.assertRaises(Denied):resolver.resolve('appRuntime',receipts)
        h.enable_owner_auth()
        template=deepcopy(h.arm.objects[h.manifest['ids']['app']]['properties']['template'])
        h.cleanup_owner_auth()
        self.assertEqual(h.arm.objects[h.manifest['ids']['app']]['properties']['template'],template)
        self.assertTrue((h.root/'trial-control-budget.jsonl').read_bytes().startswith(self.data['counter_raw']))
        self.assertEqual((h.root/'trial-provision-continuation-v7r1.jsonl').read_bytes(),self.data['child_raw'])
        rows=[json.loads(line) for line in (h.root/'trial-control-budget.jsonl').read_bytes().splitlines()]
        used=Counter((r['value']['phase'],r['value']['purpose']) for r in rows if r['event']=='request' and r['value'].get('attempt')==h.verified.binding_digest and r['value']['kind']=='owner_arm')
        self.assertEqual(used['provision','http'],132)
        self.assertEqual(used['run','http'],17)


if __name__=='__main__':unittest.main()
