"""Canonical operation/adapter boundary: secret, source, ACK and recovery."""
from copy import deepcopy
import json
import unittest
from scripts.trial_provision.runtime_auth import combined_operations, CombinedRuntimeAuthAdapter
from scripts.trial_provision.providers import BoundedArmProvider
from scripts.trial_provision.auth import instant, AuthDenied
from scripts.trial_provision.tests import test_operations as operations
from scripts.trial_provision.tests.test_operations import receipt, guid
from scripts.trial_provision.tests.test_auth import Clock, Credential, Wire, response
from scripts.trial_guard.lifecycle import Denied


class RuntimeAuthTests(unittest.TestCase):
    def setUp(self):
        f=self.f=operations.OperationsTests('runTest');f.setUp();f.add_graph();f.bind_runtime()
        self.source=f.resolver.resolve('app',f.receipts);self.target=f.resolver.resolve('appRuntime',f.receipts)
        for key in ('jobRuntime','appRuntime'):f.receipts[key]=receipt(f.resolver.resolve(key,f.receipts))
        e4=f.resolver.resolve('E4',f.receipts)
        f.receipts['E4']=receipt(e4,{'kind':'addPassword','keyId':guid(3004)},guid(3004));del f.receipts['appRuntime']
        self.binding=deepcopy(f.resolver._auth_binding)
        self.op=combined_operations(self.binding,f.receipts,f.resolver._auth_deadline,self.source,self.target)[0]
        self.before=deepcopy(self.source['body']);self.before['id']=self.source['expected']['resource_id']
        self.before['properties']['provisioningState']='Succeeded'
        self.before['properties']['configuration']['ingress']['fqdn']=f.receipts['app']['properties']['defaultDomain']
        for item in self.before['properties']['configuration']['secrets']:item.pop('value',None)
        self.after=deepcopy(self.before);self.after['properties']['template']=deepcopy(self.target['body']['properties']['template'])
        self.after['properties']['configuration']['secrets']=[{'name':n} for n in self.binding['runtime_secret_names']+[self.binding['platform_secret_name']]]

    def adapter(self,responses):
        clock=Clock();clock.value=instant('2026-10-11T02:01:00Z');credential=Credential()
        credential.principal=self.binding['owner_id'];credential.tenant=self.binding['tenant_id'];wire=Wire(responses)
        provider=BoundedArmProvider(credential,wire,clock)
        adapter=CombinedRuntimeAuthAdapter(self.binding,credential,wire,
            lambda:{n:'fictional-private-db' for n in self.binding['runtime_secret_names']},clock,
            arm_provider=provider,context=lambda:(self.source,self.target,self.op))
        return adapter,wire,clock

    def deliver(self,adapter):
        intents,checks=[],[]
        result=adapter.deliver(self.op,'fictional-private-auth-secret',self.f.receipts['E4'],intents.append,checks.append,self.f.receipts['app'])
        self.assertNotIn('fictional-private-',json.dumps([result,intents,checks]));return result,intents

    def mutations(self):
        return {
            'image':lambda x:x['properties']['template']['containers'][0].update(image='foreign.invalid/x:y'),
            'identity':lambda x:x.update(identity={'type':'None'}),
            'registry':lambda x:x['properties']['configuration']['registries'][0].update(server='foreign.invalid'),
            'open_ingress':lambda x:x['properties']['configuration']['ingress'].update(external=True),
            'extra_secret':lambda x:x['properties']['configuration']['secrets'].append({'name':'foreign'}),
            'expose_auth':lambda x:x['properties']['template']['containers'][0]['env'].append({'name':'LEAK','secretRef':self.binding['platform_secret_name']}),
            'mount_all_secrets':lambda x:x['properties']['template'].update(volumes=[{'name':'all','storageType':'Secret'}]),
            'top_error':lambda x:x.update(error={}), 'properties_error':lambda x:x['properties'].update(error={})}

    def test_normal_single_patch_and_no_secret_receipt(self):
        adapter,wire,_=self.adapter([response(200,self.before),response(200,self.before),response(200,self.after),response(200,self.after)])
        result,intents=self.deliver(adapter)
        self.assertTrue(result['terminal']);self.assertTrue(result['readback_verified'])
        self.assertEqual([x[0] for x in wire.calls],['GET','GET','PATCH','GET']);self.assertEqual(len(intents),1)
        self.assertEqual(wire.calls[2][2]['properties']['template'],self.target['body']['properties']['template'])

    def test_source_changes_reject_before_write(self):
        for label,mutate in self.mutations().items():
            with self.subTest(label=label):
                bad=deepcopy(self.before);mutate(bad);adapter,wire,_=self.adapter([response(200,bad),response(200,bad)])
                result,intents=self.deliver(adapter)
                self.assertFalse(result['terminal']);self.assertEqual(intents,[]);self.assertTrue(all(x[0]=='GET' for x in wire.calls))

    def test_target_changes_preserve_ack_without_success(self):
        for label,mutate in self.mutations().items():
            with self.subTest(label=label):
                bad=deepcopy(self.after);mutate(bad)
                adapter,_,_=self.adapter([response(200,self.before),response(200,self.before),response(200,self.after),response(200,bad)])
                result,intents=self.deliver(adapter);self.assertTrue(result['write_terminal']);self.assertFalse(result['terminal']);self.assertEqual(len(intents),1)

    def test_unknown_ack_permits_no_readback(self):
        adapter,wire,_=self.adapter([response(200,self.before),response(200,self.before),TimeoutError()])
        result,_=self.deliver(adapter);count=len(wire.calls)
        self.assertFalse(adapter.readback(self.op,result)['terminal']);self.assertEqual(len(wire.calls),count)

    def test_known_ack_allows_only_fixed_get_after_expiry(self):
        adapter,wire,clock=self.adapter([response(200,self.before),response(200,self.before),response(200,self.after),TimeoutError()])
        result,_=self.deliver(adapter);self.assertTrue(result['write_terminal']);self.assertFalse(result['terminal'])
        clock.value=instant(self.op['deadline'])+60;wire.responses=[response(200,self.after)]
        self.assertTrue(adapter.readback(self.op,result)['terminal']);self.assertEqual(wire.calls[-1][0:2],('GET',adapter.app_url))
        self.assertEqual(sum(x[0]=='PATCH' for x in wire.calls),1)

    def test_changed_context_rejected_before_any_request(self):
        adapter,wire,_=self.adapter([]);changed=deepcopy(self.op);changed['body']['properties']['template']={}
        adapter.context=lambda:(self.source,self.target,changed)
        with self.assertRaises(AuthDenied):self.deliver(adapter)
        self.assertEqual(wire.calls,[])


if __name__=='__main__':unittest.main()
