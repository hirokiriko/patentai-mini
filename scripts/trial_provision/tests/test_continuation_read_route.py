"""Real schema10 CLI routes with fictional process, credential, and ARM I/O.

Draft for root integration. No actual local/cloud evidence is used.
"""
from copy import deepcopy
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision import cli, reduction_lists as lists
from scripts.trial_provision.tests import test_partial_foundation_continuation as fixture
from scripts.trial_provision.tests.test_workflow_contract import response


class ContinuationReadRouteTests(unittest.TestCase):
    def setUp(self):
        self.data=fixture.fixture(self);self.h=fixture.install(self,self.data);h=self.h
        resolver,receipts=h.snapshot()
        self.specs=lists.carry_specifications(h.manifest,{slot:(resolver.resolve(slot,receipts),receipts[slot]) for slot in lists.CARRIED})
        self.pages={}
        for spec in self.specs:
            rows=[]
            if spec['kind']=='pim':
                self.pages[spec['url']]=response(200,{'value':[]});continue
            for item in spec['owned'].values():
                rid=item['receipt']['object_id'];row=deepcopy(h.arm.objects[rid])
                row.update(name=rid.rsplit('/',1)[1],type=spec['resource_type']);rows.append(row)
            self.pages[spec['url']]=response(200,{'value':rows})

    def test_cli_default_foundation_transport_is_read_http(self):
        h=self.h;seen=[]
        def wire(method,url,headers,body,deadline):
            deadline.remaining();self.assertEqual('GET',method);self.assertIsNone(body)
            self.assertEqual(set(headers),{'Authorization'});seen.append(url);return self.pages[url]
        with patch('scripts.trial_provision.read_http.ReadHttp',return_value=wire) as read, \
             patch.object(cli,'BoundedHttp',side_effect=AssertionError('legacy transport selected')):
            result=cli.run_command({'config':str(h.f.config_path),'action':'revalidate-foundation'},clock=h.clock,
                trusted_attempt_authority=h.trusted,owner_token_pool=h.pool)
        self.assertEqual('foundation_current_verified',result['status'])
        self.assertEqual([s['url'] for s in self.specs],seen);read.assert_called_once_with()
        self.assertEqual(self.data['child_raw'],(h.root/'trial-provision-successor-v8.jsonl').read_bytes())

    def test_known_ack_reconcile_survives_list_ttl_and_foundation_window(self):
        h=self.h;guard=h.manifest['ids']['guard'];name=h.manifest['names']['guard'];subscription=guard.split('/')[2]
        poll='https://management.azure.com/subscriptions/'+subscription+'/providers/Microsoft.App/jobs/'+name+'/operationResults/22222222-2222-4222-8222-222222222222?api-version=2025-07-01'
        calls=[];polls=[]
        def wire(method,url,headers,body,deadline):
            calls.append((method,url));deadline.remaining()
            if url in self.pages:return self.pages[url]
            if url==poll:
                polls.append(url);return response(200,{'status':'InProgress' if len(polls)==1 else 'Succeeded'},headers={'Retry-After':'1'})
            result=h.arm(method,url,headers,body,deadline)
            if method=='PUT' and urlsplit(url).path==guard:
                return response(201,headers={'Azure-AsyncOperation':poll,'Retry-After':'1'})
            return result
        h.f.wire=wire
        self.assertEqual('foundation_current_verified',h.f.run_action('revalidate-foundation')['status'])
        self.assertEqual('pending',h.f.run_action('create',operation_id='guard')['status'])
        # Force exactly one inconclusive poll after its Retry-After instant.
        h.clock.advance(2)
        self.assertEqual('pending',h.f.run_action('reconcile',operation_id='guard')['status'])
        # Both the List's ten-minute TTL and the foundation input boundary have
        # elapsed. Known ACK recovery may perform only its bound poll/fixed GET.
        h.clock.seconds=3301;before=len(calls)
        self.assertEqual('succeeded',h.f.run_action('reconcile',operation_id='guard')['status'])
        after=calls[before:]
        self.assertEqual(['GET','GET'],[method for method,_ in after])
        self.assertEqual(poll,after[0][1]);self.assertEqual(guard,urlsplit(after[1][1]).path)
        before=len(calls)
        with self.assertRaises(Denied):h.f.run_action('create',operation_id='G1')
        self.assertEqual(before,len(calls))
        self.assertEqual(1,sum(method=='PUT' and urlsplit(url).path==guard for method,url in calls))
        self.assertEqual(self.data['child_raw'],(h.root/'trial-provision-successor-v8.jsonl').read_bytes())


if __name__=='__main__':unittest.main()
