"""Offline boundary tests. All resource identifiers and tokens are fictional."""
import base64
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import unittest
from urllib.parse import parse_qs

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.registry import BoundedRegistryProvider, ARM_AUDIENCE, MAX_BODY


def jwt(value):
    return 'e30.' + base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=') + '.fictional'


class Clock:
    def __init__(self):
        self.start = datetime(2026, 10, 10, tzinfo=timezone.utc)
        self.seconds = 0
        self.wall_offset = 0
    def utc(self): return self.start + timedelta(seconds=self.seconds+self.wall_offset)
    def monotonic(self): return self.seconds


class Credential:
    mode = 'owner'
    def __init__(self, clock): self.clock, self.calls, self.delay = clock, [], 0
    def token(self, audience, deadline):
        self.calls.append(audience)
        self.clock.seconds += self.delay
        return 'fictional-owner-token'


class Wire:
    def __init__(self, clock, binding):
        self.clock, self.binding, self.calls = clock, binding, []
        self.head = [200]
        self.delete = 202
        self.digest = 'sha256:' + '1'*64
        self.modify = None
    def __call__(self, method, url, headers, body, deadline):
        self.calls.append((method, url, headers, body))
        if self.modify:
            result = self.modify(method, url)
            if result is not None: return result
        token = {'aud':self.binding['login_server'], 'exp':self.clock.start.timestamp()+3600,
            'nbf':self.clock.start.timestamp()-1}
        if url.endswith('/oauth2/exchange'):
            token.update(tenant=self.binding['tenant_id'], grant_type='refresh_token')
            return self.response(200, body=json.dumps({'refresh_token':jwt(token)}).encode())
        if url.endswith('/oauth2/token'):
            token['access'] = [{'type':'repository', 'name':self.binding['repository'], 'actions':['pull','delete']}]
            return self.response(200, body=json.dumps({'access_token':jwt(token)}).encode())
        if method == 'HEAD':
            status = self.head.pop(0) if len(self.head)>1 else self.head[0]
            head = {'docker-distribution-api-version':'registry/2.0'}
            if status == 200: head['docker-content-digest'] = self.digest
            return self.response(status, head)
        if method == 'DELETE':
            if isinstance(self.delete, Exception): raise self.delete
            return self.response(self.delete)
        raise AssertionError('unexpected offline request')
    @staticmethod
    def response(status, headers=None, body=b''):
        return {'status':status, 'headers':headers or {}, 'body':body}


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        prefix = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/fictional'
        self.binding = {'registry_id':prefix+'/providers/Microsoft.ContainerRegistry/registries/fictionalregistry',
            'login_server':'fictionalregistry.azurecr.io', 'repository':'trial/guardian',
            'tenant_id':'00000000-0000-0000-0000-000000000002',
            'authorized_resource_ids':[prefix+'/providers/Microsoft.App/containerApps/trial-app',
                prefix+'/providers/Microsoft.App/jobs/trial-worker', prefix+'/providers/Microsoft.App/jobs/trial-guardian'],
            'exclusivity_evidence_digest':'a'*64}
        self.push = {'operation_id':'guardian_push', 'request_digest':'b'*64, 'state':'succeeded',
            'terminal':True, 'created_by_run':True, 'readback_verified':True,
            'properties':{'registry_id':self.binding['registry_id'], 'login_server':self.binding['login_server'],
                'repository':self.binding['repository'], 'manifest_digest':'sha256:'+'1'*64, 'purpose':'guardian'}}
        self.op = {'id':'guardian_manifest_delete', 'provider':'AzureContainerRegistry', 'kind':'manifest',
            'method':'DELETE', 'url':'https://fictionalregistry.azurecr.io/v2/trial/guardian/manifests/sha256:'+'1'*64+'?api-version=2021-07-01',
            'body':None, 'deadline':(self.clock.utc()+timedelta(minutes=5)).isoformat(), 'depends_on':['guardian_terminal'],
            'expected':{'binding_digest':digest(self.binding), 'manifest_digest':'sha256:'+'1'*64,
                'push_request_digest':self.push['request_digest'], 'push_receipt_digest':digest(self.push)},
            'cleanup':{'created_only':True,'zero_reference_required':True,'purpose':'guardian'}}
        self.evidence = {'complete':True, 'foreign_references_excluded':True, 'repository_exclusive':True,
            'writers_fenced':True, 'exclusivity_evidence_digest':'a'*64, 'observed_at':self.clock.utc().isoformat(),
            'push_receipt_digest':digest(self.push), 'object_id':self.op['url'], 'observations':[
                {'resource_id':rid, 'observed_at':self.clock.utc().isoformat(), 'complete':True,
                 'pages_complete':True, 'coverage':'all_revisions' if '/containerApps/' in rid else 'template_and_all_executions',
                 'images':[]} for rid in self.binding['authorized_resource_ids']]}
        self.credential = Credential(self.clock)
        self.wire = Wire(self.clock,self.binding)
        self.intents, self.receipts = [], []
        self.provider = self.make()
    def before(self, op):
        if any(x['id']==op['id'] for x in self.intents): raise Denied('duplicate_intent')
        self.intents.append(deepcopy(op))
    def make(self, **kwargs):
        return BoundedRegistryProvider(self.credential,self.wire,self.clock,binding=kwargs.get('binding',self.binding),
            before_send=kwargs.get('before_send',self.before),checkpoint=kwargs.get('checkpoint',self.receipts.append))
    def cleanup(self): return self.provider.cleanup(self.op,self.push,self.evidence)
    def test_known_ack_then_absence_only_completes(self):
        pending = self.cleanup()
        self.assertEqual('pending',pending['state']); self.assertFalse(pending['terminal'])
        self.assertFalse(pending['write_terminal']); self.assertEqual(pending,self.receipts[-1])
        self.wire.head=[404]
        result=self.provider.readback(self.op,pending)
        self.assertEqual('succeeded',result['state']); self.assertTrue(result['readback_verified'])
        self.assertTrue(result['terminal']); self.assertTrue(result['write_terminal'])
        self.assertEqual(['POST','POST','HEAD','DELETE','HEAD'],[r[0] for r in self.wire.calls])
    def test_exchange_uses_normal_owner_fixed_tenant_and_least_scope(self):
        self.cleanup()
        self.assertEqual([ARM_AUDIENCE],self.credential.calls)
        first=parse_qs(self.wire.calls[0][3].decode()); second=parse_qs(self.wire.calls[1][3].decode())
        self.assertEqual(['access_token'],first['grant_type'])
        self.assertEqual([self.binding['tenant_id']],first['tenant'])
        self.assertEqual(['repository:trial/guardian:pull,delete'],second['scope'])
        self.assertEqual(['refresh_token'],second['grant_type'])
    def test_target_mutations_rejected_before_credentials(self):
        mutations = [('url',self.op['url'].replace('fictionalregistry.azurecr.io','evil.example')),
            ('url',self.op['url'].replace('/trial/guardian/','/other/')),
            ('url',self.op['url'].replace('sha256:'+'1'*64,'latest')),
            ('url',self.op['url']+'&extra=1'), ('url',self.op['url'].replace('https:','http:')),
            ('method','PUT'),('body',{}),('provider','Microsoft.App')]
        for key,value in mutations:
            with self.subTest(key=key,value=value):
                op=deepcopy(self.op);op[key]=value
                with self.assertRaises(Denied): self.provider.cleanup(op,self.push,self.evidence)
        self.assertFalse(self.credential.calls);self.assertFalse(self.wire.calls)
    def test_registry_binding_rejects_host_port_alias_and_bad_repository(self):
        for key,value in [('login_server','fictionalregistry.azurecr.io:443'),('login_server','otherregistry.azurecr.io'),
            ('repository','trial/../guardian'),('repository','trial/%67uardian')]:
            b=deepcopy(self.binding);b[key]=value
            with self.assertRaises(Denied): self.make(binding=b)
    def test_guardian_identity_cannot_get_cleanup_credentials(self):
        self.credential.mode='guardian'
        with self.assertRaises(Denied): self.make()
    def test_invalid_push_evidence_cannot_be_adopted(self):
        for key,value in [('terminal',False),('created_by_run',False),('state','unknown'),('readback_verified',False)]:
            p=deepcopy(self.push);p[key]=value
            op=deepcopy(self.op);op['expected']['push_receipt_digest']=digest(p)
            with self.assertRaises(Denied): self.provider.cleanup(op,p,self.evidence)
        self.assertFalse(self.wire.calls)
    def test_no_missing_duplicate_or_extra_inventory(self):
        for rows in [self.evidence['observations'][:-1],self.evidence['observations']+[self.evidence['observations'][0]],
            [self.evidence['observations'][0]]*3]:
            e=deepcopy(self.evidence);e['observations']=rows
            with self.assertRaises(Denied):self.provider.cleanup(self.op,self.push,e)
        self.assertFalse(self.credential.calls)
    def test_partial_foreign_shared_or_unfenced_inventory_holds(self):
        for key in ('complete','foreign_references_excluded','repository_exclusive','writers_fenced'):
            e=deepcopy(self.evidence);e[key]=False
            with self.assertRaises(Denied):self.provider.cleanup(self.op,self.push,e)
        for key,value in [('pages_complete',False),('complete',False),('coverage','current_template_only')]:
            e=deepcopy(self.evidence);e['observations'][0][key]=value
            with self.assertRaises(Denied):self.provider.cleanup(self.op,self.push,e)
        self.assertFalse(self.wire.calls)
    def test_target_digest_tag_and_noncanonical_reference_hold(self):
        target='fictionalregistry.azurecr.io/trial/guardian'
        refs=[target+'@sha256:'+'1'*64,target+':current',target,
            target.replace('.io/','.io:443/')+'@sha256:'+'2'*64,
            target.upper()+'@sha256:'+'2'*64]
        for ref in refs:
            e=deepcopy(self.evidence);e['observations'][1]['images']=[ref]
            with self.subTest(ref=ref), self.assertRaises(Denied):self.provider.cleanup(self.op,self.push,e)
        self.assertFalse(self.wire.calls)
    def test_different_pinned_digest_and_other_repository_are_not_references(self):
        self.evidence['observations'][0]['images']=['fictionalregistry.azurecr.io/trial/guardian@sha256:'+'2'*64,
            'fictionalregistry.azurecr.io/trial/web:current']
        self.assertEqual('pending',self.cleanup()['state'])
    def test_stale_or_future_reference_evidence_holds(self):
        for seconds in (-31,1):
            e=deepcopy(self.evidence);e['observations'][0]['observed_at']=(self.clock.utc()+timedelta(seconds=seconds)).isoformat()
            with self.assertRaises(Denied):self.provider.cleanup(self.op,self.push,e)
        self.assertFalse(self.wire.calls)
    def test_wrong_head_digest_prevents_intent_and_delete(self):
        self.wire.digest='sha256:'+'2'*64
        with self.assertRaises(Denied):self.cleanup()
        self.assertFalse(self.intents);self.assertNotIn('DELETE',[x[0] for x in self.wire.calls])
    def test_unknown_delete_not_retried_or_promoted_by_absence(self):
        self.wire.delete=OSError('fictional-secret-in-raw-error')
        result=self.cleanup();self.assertEqual('unknown',result['state'])
        self.wire.head=[404]
        observed=self.provider.readback(self.op,result)
        self.assertEqual('unknown',observed['state']);self.assertFalse(observed['terminal'])
        with self.assertRaises(Denied):self.cleanup()
        # A restarted adapter still requires the durable one-send hook.
        self.wire.head=[200];self.provider=self.make()
        with self.assertRaises(Denied):self.cleanup()
        self.assertEqual(1,sum(r[0]=='DELETE' for r in self.wire.calls))
        self.assertNotIn('fictional-secret-in-raw-error',json.dumps(self.receipts))
    def test_unknown_read_keeps_known_ack_for_later_read_only_recovery(self):
        pending=self.cleanup();self.wire.head=[503]
        uncertain=self.provider.readback(self.op,pending)
        self.assertEqual('unknown',uncertain['state']);self.assertTrue(uncertain['delete_acknowledged'])
        self.provider=self.make();self.wire.head=[404]
        self.assertEqual('succeeded',self.provider.readback(self.op,uncertain)['state'])
        self.assertEqual(1,sum(r[0]=='DELETE' for r in self.wire.calls))
    def test_403_and_unmarked_404_are_not_absence(self):
        pending=self.cleanup()
        for status in (401,403,404):
            self.wire.modify=lambda method,url:Wire.response(status) if method=='HEAD' else None
            result=self.provider.readback(self.op,pending)
            self.assertEqual('unknown',result['state']);self.assertFalse(result['terminal'])
    def test_redirect_is_never_followed(self):
        self.wire.modify=lambda method,url:Wire.response(307,{'Location':'https://evil.example/'})
        result=self.provider.readback(self.op)
        self.assertEqual('unknown',result['state']);self.assertEqual(1,len(self.wire.calls))
        self.assertTrue(all('evil.example' not in r[1] for r in self.wire.calls))
    def test_request_deadline_expired_during_owner_token_acquisition_sends_nothing(self):
        self.op['deadline']=(self.clock.utc()+timedelta(seconds=5)).isoformat()
        self.credential.delay=31
        with self.assertRaises(Denied):self.cleanup()
        self.assertFalse(self.wire.calls)
    def test_deadline_expired_during_intent_sends_no_delete(self):
        def before(op): self.before(op);self.clock.seconds=301
        self.provider=self.make(before_send=before)
        result=self.cleanup()
        self.assertEqual('unknown',result['state']);self.assertNotIn('DELETE',[r[0] for r in self.wire.calls])
    def test_request_deadline_expired_after_delete_ack_is_unknown(self):
        self.op['deadline']=(self.clock.utc()+timedelta(seconds=5)).isoformat()
        def modify(method,url):
            if method=='DELETE':self.clock.seconds=31
        self.wire.modify=modify
        result=self.cleanup()
        self.assertEqual('unknown',result['state']);self.assertFalse(result['delete_acknowledged'])
    def test_known_ack_head_recovery_after_removal_due_keeps_original_operation(self):
        self.op['deadline']=(self.clock.utc()+timedelta(seconds=5)).isoformat()
        before=deepcopy(self.op)
        pending=self.cleanup()
        self.clock.seconds=6;self.wire.head=[404];self.provider=self.make()
        self.assertEqual('succeeded',self.provider.readback(self.op,pending)['state'])
        self.assertEqual(before,self.op)
    def test_owned_unattempted_removal_after_due_uses_fresh_reference_proof(self):
        self.op['deadline']=(self.clock.utc()-timedelta(seconds=1)).isoformat()
        self.assertEqual('pending',self.cleanup()['state'])
        self.assertEqual(1,sum(method=='DELETE' for method,*_ in self.wire.calls))
    def test_oauth_refresh_cannot_send_delete_with_stale_reference_proof(self):
        # HEAD has a valid token. Persisting intent approaches its refresh
        # threshold, then a fresh exchange makes the reference proof stale.
        def before(op):
            self.before(op)
            self.clock.seconds=25
            self.provider._expires=self.clock.start.timestamp()+50
        def modify(method,url):
            if url.endswith('/oauth2/token') and self.intents:
                self.clock.seconds += 6
        self.provider=self.make(before_send=before)
        self.wire.modify=modify
        result=self.cleanup()
        self.assertEqual('unknown',result['state'])
        self.assertEqual(1,len(self.intents))
        self.assertEqual(2,sum(r[1].endswith('/oauth2/token') for r in self.wire.calls))
        self.assertNotIn('DELETE',[r[0] for r in self.wire.calls])
    def test_utc_rollback_cannot_extend_deadline(self):
        self.provider._now();self.clock.seconds=10;self.provider._now()
        self.clock.wall_offset=-3600;self.clock.seconds=301
        with self.assertRaises(Denied):self.cleanup()
        self.assertFalse(self.wire.calls)
    def test_journal_failure_prevents_delete(self):
        def before(op):raise OSError('disk-full')
        self.provider=self.make(before_send=before)
        with self.assertRaises(OSError):self.cleanup()
        self.assertNotIn('DELETE',[r[0] for r in self.wire.calls])
    def test_invalid_token_audience_scope_or_expiry_never_sends_head(self):
        for mutation in ('audience','scope','expired','tenant'):
            self.wire=Wire(self.clock,self.binding);self.provider=self.make()
            def modify(method,url):
                if url.endswith('/oauth2/exchange') and mutation=='tenant':
                    value={'aud':self.binding['login_server'],'exp':self.clock.start.timestamp()+3600,'nbf':0,'grant_type':'refresh_token','tenant':'wrong'}
                    return Wire.response(200,body=json.dumps({'refresh_token':jwt(value)}).encode())
                if url.endswith('/oauth2/token'):
                    value={'aud':self.binding['login_server'],'exp':self.clock.start.timestamp()+3600,'nbf':0,
                        'access':[{'type':'repository','name':self.binding['repository'],'actions':['pull','delete']}]}
                    if mutation=='audience':value['aud']='evil.example'
                    if mutation=='scope':value['access'][0]['actions'].append('push')
                    if mutation=='expired':value['exp']=0
                    return Wire.response(200,body=json.dumps({'access_token':jwt(value)}).encode())
            self.wire.modify=modify
            with self.subTest(mutation=mutation),self.assertRaises(Denied):self.cleanup()
            self.assertNotIn('HEAD',[r[0] for r in self.wire.calls])
    def test_large_or_error_bodies_never_escape(self):
        self.wire.modify=lambda method,url:Wire.response(500,body=b'private-marker'*(MAX_BODY//14+2))
        result=self.provider.readback(self.op)
        self.assertEqual('unknown',result['state']);self.assertNotIn('private-marker',json.dumps(result))
    def test_receipts_do_not_contain_tokens_or_raw_responses(self):
        self.cleanup()
        serialized=json.dumps(self.receipts)
        for forbidden in ('fictional-owner-token','refresh_token','access_token','Authorization','fictional'):
            if forbidden=='fictional':continue  # Fictional object_id is intentional private metadata.
            self.assertNotIn(forbidden,serialized)
    def test_forged_ack_and_other_operation_receipt_cannot_complete(self):
        pending=self.cleanup();self.wire.head=[404]
        pending['ack_digest']='f'*64
        self.assertEqual('unknown',self.provider.readback(self.op,pending)['state'])
        pending['operation_id']='other'
        with self.assertRaises(Denied):self.provider.readback(self.op,pending)
    def test_request_accounting_uses_shared_http_for_every_attempt(self):
        # No token exchange or read bypasses the injected counted transport.
        count=[];original=self.wire
        def counted(*args):count.append(args[0]);return original(*args)
        self.provider.http=counted
        pending=self.cleanup();self.wire.head=[404]
        self.provider.readback(self.op,pending)
        self.assertEqual(['POST','POST','HEAD','DELETE','HEAD'],count)


if __name__ == '__main__': unittest.main()
