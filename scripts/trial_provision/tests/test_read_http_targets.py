"""Focused fake-process tests for the host-only GET boundary; no network."""
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
from scripts.trial_guard.adapters import Deadline
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.read_http import ReadHttp, AnonymousIpHttp, ReadFailure, _read_child

ARM='https://management.azure.com'
SUB='/subscriptions/11111111-1111-4111-8111-111111111111'
RG=SUB+'/resourceGroups/fictional'
PREFIX='scripts.trial_provision.read_http.'


class ReadHttpTargetTests(unittest.TestCase):
    def valid(self):
        return (
            ARM+RG+'/providers/Microsoft.ManagedIdentity/userAssignedIdentities?api-version=2023-01-31',
            ARM+RG+'/providers/Microsoft.Storage/storageAccounts/fictional/blobServices/default/containers?api-version=2023-05-01',
            ARM+RG+'/providers/Microsoft.CognitiveServices/accounts/fictional/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter=type%20eq%20%27CustomRole%27',
            ARM+RG+'/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional?api-version=2024-08-01',
            ARM+RG+'/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional/firewallRules?api-version=2024-08-01',
            ARM+RG+'/providers/Microsoft.App/containerApps/fictional?api-version=2025-07-01',
            ARM+RG+'/providers/Microsoft.App/jobs/fictional?api-version=2025-07-01',
            ARM+SUB+'/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01',
            ARM+SUB+'/providers/Microsoft.Authorization/roleEligibilitySchedules?api-version=2020-10-01',
            ARM+SUB+'/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$skiptoken=fictional',
        )

    def successful(self,transport,url,headers):
        with patch(PREFIX+'multiprocessing.get_context') as context:
            ctx=context.return_value;parent,child=MagicMock(),MagicMock();ctx.Pipe.return_value=parent,child
            process=ctx.Process.return_value;process.pid=123;process.is_alive.side_effect=[True,False]
            parent.recv.return_value=(True,200,{},b'fictional-response')
            result=transport('GET',url,headers,None,Deadline(20))
            self.assertEqual({'status':200,'headers':{},'body':b'fictional-response'},result)
            context.assert_called_once_with('spawn');ctx.Process.assert_called_once();process.start.assert_called_once()
            request=ctx.Process.call_args.kwargs['args'][1]
            self.assertEqual((url,headers),request[:2]);self.assertGreater(request[2],0);self.assertLessEqual(request[2],20)
            parent.poll.assert_not_called();parent.close.assert_called_once();process.terminate.assert_called_once()
            return request

    def test_exact_new_get_families_reach_one_killable_child(self):
        for url in self.valid():
            with self.subTest(url=url):self.successful(ReadHttp(),url,{'Authorization':'Bearer fictional-token'})

    def test_wrong_api_filter_child_or_host_rejects_before_context(self):
        fixed=self.valid();bad=[]
        for url in fixed:
            bad.extend((url.replace('api-version=','api-version=1900-01-01&old='),url+'&other=1',url+'#fragment',
                url.replace('https:','http:'),url.replace('management.azure.com','management.azure.com:443'),
                url.replace('management.azure.com','user@management.azure.com'),url.replace('management.azure.com','evil.invalid'),
                '\n'+url,url+'\t',url.replace('Microsoft.','MicrosoftX')))
        bad += [fixed[0].replace('userAssignedIdentities?','userAssignedIdentities/extra?'),
            fixed[1].replace('/containers?','/containers/extra?'),
            fixed[2].replace('CustomRole','BuiltInRole'),fixed[2].replace('%20','+'),
            fixed[2].split('&$filter=')[0],fixed[2]+'&$skiptoken=extra',
            fixed[4].replace('/firewallRules?','/firewallRules/extra?'),
            fixed[7]+"&$filter=asTarget()",fixed[8]+'&api-version=2020-10-01']
        with patch(PREFIX+'multiprocessing.get_context') as context:
            for url in bad:
                with self.subTest(url=url),self.assertRaises(Denied):ReadHttp()('GET',url,{},None,Deadline(20))
            for method,body in (('POST',None),('PUT',None),('DELETE',None),('GET',b'x')):
                with self.subTest(method=method,body=body),self.assertRaises(Denied):ReadHttp()(method,fixed[0],{},body,Deadline(20))
            context.assert_not_called()

    def test_only_two_exact_anonymous_targets_with_zero_headers(self):
        for url in ('https://api.ipify.org','https://checkip.amazonaws.com'):
            request=self.successful(AnonymousIpHttp(),url,{})
            self.assertEqual({},request[1])
        with patch(PREFIX+'multiprocessing.get_context') as context:
            cases=[('GET',url,{},None) for url in ('https://api.ipify.org/','https://api.ipify.org?format=json',
                'http://api.ipify.org','https://checkip.amazonaws.com/','https://api.ipify.org:443',self.valid()[0])]
            cases += [('GET','https://api.ipify.org',headers,None) for headers in
                ({'Authorization':'Bearer canary'},{'authorization':''},{'Cookie':'canary'},{'X-Fixture':'value'})]
            cases += [('POST','https://api.ipify.org',{},None),('GET','https://api.ipify.org',{},b'x')]
            for args in cases:
                with self.subTest(args=args),self.assertRaises(Denied):AnonymousIpHttp()(*args,Deadline(20))
            context.assert_not_called()

    def test_anonymous_child_has_no_injected_request_headers(self):
        pipe,connection,reply=MagicMock(),MagicMock(),MagicMock()
        reply.status=200;reply.getheaders.return_value=[];reply.read.return_value=b'8.8.8.8\n'
        connection.getresponse.return_value=reply
        with patch(PREFIX+'http.client.HTTPSConnection',return_value=connection):
            _read_child(pipe,('https://api.ipify.org',{},20))
        connection.request.assert_called_once_with('GET','/',headers={})
        self.assertEqual((True,200,{},b'8.8.8.8\n'),pipe.send.call_args.args[0])

    def test_partial_pipe_frame_is_bounded_for_arm_and_anonymous(self):
        for transport,url in ((ReadHttp(),self.valid()[0]),(AnonymousIpHttp(),'https://api.ipify.org')):
            with self.subTest(transport=type(transport).__name__),patch(PREFIX+'multiprocessing.get_context') as context:
                ctx=context.return_value;parent,child=MagicMock(),MagicMock();ctx.Pipe.return_value=parent,child
                process=ctx.Process.return_value;process.pid=123;process.is_alive.side_effect=[True,False]
                release=threading.Event()
                def receive():
                    release.wait(2)
                    return (False,0,'ipc_incomplete',None)
                parent.recv.side_effect=receive;parent.close.side_effect=release.set
                started=time.monotonic()
                with self.assertRaises(ReadFailure) as error:transport('GET',url,{},None,Deadline(.02))
                self.assertEqual('deadline',error.exception.observation['transport_stage'])
                self.assertLess(time.monotonic()-started,1)
                parent.poll.assert_not_called();process.start.assert_called_once();process.terminate.assert_called_once()
                process.join.assert_called_once_with(timeout=1);parent.close.assert_called_once()
                self.assertGreaterEqual(child.close.call_count,1);self.assertTrue(release.is_set())


if __name__=='__main__':unittest.main()
