"""Fictional token claims only: never launches Azure CLI or calls an endpoint."""
import base64
import io
import json
import os
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from types import SimpleNamespace
from unittest.mock import Mock, patch

from .adapters import AzureCredential, Deadline, encoded
from .lifecycle import Denied

ARM='https://management.azure.com/'
STORAGE='https://storage.azure.com/'
OWNER='11111111-1111-4111-8111-111111111111'
TENANT='22222222-2222-4222-8222-222222222222'


def token(audience=ARM,**changes):
    claims={'aud':audience,'oid':OWNER,'tid':TENANT,'exp':int(time.time())+3600,**changes}
    payload=base64.urlsafe_b64encode(encoded(claims)).decode().rstrip('=')
    return 'fictional.'+payload+'.fixture'


class AzureCredentialTests(unittest.TestCase):
    def setUp(self):
        self.run_patch=patch(__package__+'.adapters.subprocess.run')
        self.run=self.run_patch.start();self.addCleanup(self.run_patch.stop)
        self.http=Mock(side_effect=AssertionError('external call forbidden'))

    def owner(self,value):
        self.run.return_value=SimpleNamespace(stdout=encoded({'accessToken':value}),stderr=b'')
        return AzureCredential('owner',OWNER,TENANT,self.http)

    def test_one_isolated_cli_python_command_preserves_profile_and_captures_pipes(self):
        value=token();credential=self.owner(value)
        self.assertEqual(credential.token(ARM,Deadline(10)),value)
        args,kwargs=self.run.call_args
        self.assertEqual(args[0],[sys.executable,'-I','-m','azure.cli','account','get-access-token',
            '--resource',ARM,'--output','json','--only-show-errors'])
        self.assertIs(kwargs['shell'],False);self.assertIs(kwargs['capture_output'],True)
        self.assertEqual(kwargs['stdin'],subprocess.DEVNULL)
        self.assertIs(kwargs['check'],True);self.assertGreater(kwargs['timeout'],0);self.assertLessEqual(kwargs['timeout'],10)
        self.assertEqual(kwargs['creationflags'],0x08000000 if os.name=='nt' else 0)
        self.assertNotIn('env',kwargs);self.assertNotIn('cwd',kwargs)
        self.run.assert_called_once();self.http.assert_not_called()

    def test_arm_accepts_only_the_two_canonical_public_resource_identifiers(self):
        for audience in ('https://management.azure.com','https://management.azure.com/',
                'https://management.core.windows.net','https://management.core.windows.net/'):
            with self.subTest(audience=audience):
                value=token(audience)
                self.assertEqual(self.owner(value).token(ARM,Deadline(10)),value)

    def test_storage_preserves_its_one_audience_with_no_arm_alias(self):
        for audience in ('https://storage.azure.com','https://storage.azure.com/'):
            with self.subTest(audience=audience):
                value=token(audience)
                self.assertEqual(self.owner(value).token(STORAGE,Deadline(10)),value)
        for audience in ('https://management.azure.com/','https://management.core.windows.net/'):
            with self.subTest(audience=audience),self.assertRaisesRegex(Denied,'identity_binding'):
                self.owner(token(audience)).token(STORAGE,Deadline(10))

    def test_aliases_do_not_accept_prefixes_suffixes_ports_queries_or_arbitrary_slashes(self):
        for audience in ('https://storage.azure.com/','https://management.azure.com//',
                'https://management.core.windows.net//','https://management.azure.com.evil.invalid/',
                'http://management.azure.com/','https://management.core.windows.net:443/',
                'https://management.azure.com/?x=1','https://management.azure.com/#x',
                'https://MANAGEMENT.azure.com/',' https://management.azure.com/',
                ['https://management.azure.com/']):
            with self.subTest(audience=audience),self.assertRaisesRegex(Denied,'identity_binding'):
                self.owner(token(audience)).token(ARM,Deadline(10))
        with self.assertRaisesRegex(Denied,'identity_binding'):
            self.owner(token('https://storage.azure.com//')).token(STORAGE,Deadline(10))

    def test_request_resource_stays_fixed_and_does_not_use_the_claim_alias(self):
        for audience in ('https://management.core.windows.net/','https://graph.microsoft.com/',STORAGE+'other'):
            with self.subTest(audience=audience),self.assertRaisesRegex(Denied,'token_audience'):
                self.owner(token()).token(audience,Deadline(10))
        self.run.assert_not_called();self.http.assert_not_called()

    def test_missing_cli_failed_cli_timeout_and_invalid_output_are_private_no_fallback(self):
        marker='FICTIONAL_PRIVATE_CANARY'
        errors=[FileNotFoundError(marker),subprocess.CalledProcessError(1,['fictional'],output=marker.encode(),stderr=marker.encode()),
            subprocess.TimeoutExpired(['fictional'],1,output=marker.encode(),stderr=marker.encode())]
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                self.run.reset_mock();self.run.side_effect=error
                output=io.StringIO()
                with redirect_stdout(output),redirect_stderr(output),self.assertRaisesRegex(Denied,'owner_credential_unavailable') as caught:
                    AzureCredential('owner',OWNER,TENANT,self.http).token(ARM,Deadline(10))
                self.assertEqual(output.getvalue(),'');self.assertNotIn(marker,str(caught.exception));self.run.assert_called_once()
        self.run.side_effect=None
        for raw in (b'not-json',b'[]',b'x'*131073):
            self.run.return_value=SimpleNamespace(stdout=raw,stderr=b'')
            with self.assertRaisesRegex(Denied,'owner_credential_unavailable'):
                AzureCredential('owner',OWNER,TENANT,self.http).token(ARM,Deadline(10))
        self.http.assert_not_called()

    def test_identity_expiry_and_deadline_are_not_relaxed_by_alias_acceptance(self):
        for changes in ({'oid':TENANT},{'tid':OWNER},{'exp':0},{'exp':int(time.time())+1}):
            with self.subTest(changes=list(changes)),self.assertRaisesRegex(Denied,'identity_binding'):
                self.owner(token('https://management.core.windows.net/',**changes)).token(ARM,Deadline(10))
        now=[0];deadline=Deadline(1,lambda:now[0]);value=token()
        def delayed(*args,**kwargs):
            now[0]=2
            return SimpleNamespace(stdout=encoded({'accessToken':value}),stderr=b'')
        self.run.side_effect=delayed
        with self.assertRaisesRegex(Denied,'identity_binding'):
            AzureCredential('owner',OWNER,TENANT,self.http).token(ARM,deadline)

    def test_guardian_mi_uses_same_claim_validation_without_owner_cli(self):
        value=token('https://management.core.windows.net/')
        self.http.side_effect=None
        self.http.return_value={'status':200,'body':encoded({'access_token':value,'resource':ARM,'token_type':'Bearer'}),'headers':{}}
        credential=AzureCredential('guardian',OWNER,TENANT,self.http,
            {'IDENTITY_ENDPOINT':'http://127.0.0.1:4123/msi/token','IDENTITY_HEADER':'fictional'})
        self.assertEqual(credential.token(ARM,Deadline(10)),value)
        self.run.assert_not_called();self.http.assert_called_once()
