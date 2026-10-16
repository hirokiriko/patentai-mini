"""Cross-entrypoint contract with real durable stores and fictional wire I/O.

No cloud, CLI credential, Docker or Node process runs. Publication manifests,
ARM/Graph replies and the Node bootstrap artifacts are external-boundary
fixtures. Compilers, journals, counters, adapters, lifecycle/guardian, bootstrap
proof import and runtime/cleanup dispatch are production implementations.

This is a local contract, not real authorization/SQL/signature evidence. The
rehearsal's remote completion is a fixture, main GuardianRunner is assembled
from the verified seed rather than cloud __main__.assemble, and Git/CI/source
and Node policy-verifier inputs are fictional. The main OWNER execute entry,
closure state machine, 7 role definitions/18 assignments, and resulting receipt
bindings are exercised; live provider and database acceptance remain separate.
"""
from copy import deepcopy
from collections import Counter
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from scripts.trial_guard import execution
from scripts.trial_guard import catalog_execution as catalog
from scripts.trial_guard.__main__ import FIXED
from scripts.trial_guard.adapters import ArmTransport, BlobJournal, digest, encoded
from scripts.trial_guard.lifecycle import Controller as Lifecycle, Denied, parse
from scripts.trial_guard.runner import GuardianRunner
from scripts.trial_guard.workflow import closure_proven
from scripts.trial_provision import cli, registry_publish_cli, private_io
from scripts.trial_provision.configuration import SOURCE_FILES
from scripts.trial_provision.journal import Journal, ControlBudget
from scripts.trial_provision.attempt import journal_descriptor, WINDOW_OFFSETS, DESIGN_SHA256, PURPOSE_CAPS
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.registry_publish import verified_publication_images
from scripts.trial_provision.tests import test_cli as cli_fixture
from scripts.trial_provision.tests import test_operations as op_fixture
from scripts.trial_provision.tests import test_registry_publish as publish_fixture
from scripts.trial_provision.tests import test_rehearsal as rehearsal_fixture
from scripts.trial_provision.tests import test_attempt as attempt_fixture
from scripts.trial_guard.test_catalog_execution import Child as CatalogChild


def response(status, value=None, headers=None):
    if status == 404 and value is None:
        value = {'error': {'code': 'ResourceNotFound', 'message': 'Fictional fixed target is absent.'}}
    return {'status': status, 'body': b'' if value is None else encoded(value), 'headers': headers or {}}


class Clock(publish_fixture.Clock):
    def advance(self, seconds): self.seconds += seconds
    def iso(self, seconds=0): return (self.utc() + timedelta(seconds=seconds)).isoformat()


class Credential:
    """The only credential boundary: no real identity or token acquisition."""
    def __init__(self, mode, principal, tenant, *_):
        self.mode, self.principal, self.tenant = mode, principal, tenant
    def token(self, audience, deadline):
        deadline.remaining()
        return publish_fixture.jwt({'oid':self.principal,'tid':self.tenant,'aud':audience,
            'exp':parse('2027-02-01T00:00:00Z').timestamp()})


class ArmWire:
    def __init__(self, manifest, clock):
        self.manifest, self.clock = manifest, clock
        self.objects, self.calls = {}, []
        self.unknown_path = None
    def __call__(self, method, url, headers, body, deadline):
        deadline.remaining()
        u = urlsplit(url)
        self.calls.append((method, u.path))
        if u.netloc == 'graph.microsoft.com':
            if method == 'POST' and u.path == '/v1.0/applications':
                value = json.loads(body)
                value.update(id=op_fixture.guid(3000), appId=op_fixture.guid(3001))
                self.objects['/v1.0/applications/' + value['id']] = value
                return response(201, value)
            if method == 'POST' and u.path == '/v1.0/servicePrincipals':
                value = json.loads(body)
                value['id'] = op_fixture.guid(3002)
                self.objects[u.path + '/' + value['id']] = value
                return response(201, value)
            sp = '/v1.0/servicePrincipals/' + op_fixture.guid(3002)
            app = '/v1.0/applications/' + op_fixture.guid(3000)
            if method == 'POST' and u.path == sp + '/appRoleAssignedTo':
                value = json.loads(body)
                value['id'] = 'fictional-owner-assignment'
                self.objects[u.path + '/' + value['id']] = value
                return response(201, value)
            if method == 'POST' and u.path == app + '/addPassword':
                value = json.loads(body)['passwordCredential']
                value['keyId'] = op_fixture.guid(3003)
                self.objects[app]['passwordCredentials'].append(deepcopy(value))
                return response(200, {**value, 'secretText': 'fictional-memory-only-auth-secret'})
            if method == 'POST' and u.path == app + '/removePassword':
                key = json.loads(body)['keyId']
                self.objects[app]['passwordCredentials'] = [v for v in self.objects[app]['passwordCredentials'] if v['keyId'] != key]
                return response(204)
            if method == 'GET':
                return response(200, self.objects[u.path]) if u.path in self.objects else response(404)
            if method == 'DELETE' and u.path in (app, sp, sp + '/appRoleAssignedTo/fictional-owner-assignment'):
                self.objects.pop(u.path, None)
                return response(204)
            raise AssertionError('unplanned Graph boundary')
        if u.netloc != 'management.azure.com': raise AssertionError('unplanned ARM host')
        if method == 'GET': return response(200, self.objects[u.path]) if u.path in self.objects else response(404)
        if method == 'DELETE':
            self.objects.pop(u.path, None)
            return response(204)
        if method not in ('PUT', 'PATCH'): raise AssertionError('unplanned ARM mutation')
        # Auth PUT replaces its resource body; omission removes our exact
        # clientSecretSettingName on cleanup. App PATCH remains a deep merge.
        value = {} if u.path.endswith('/authConfigs/current') else deepcopy(self.objects.get(u.path, {}))
        incoming = json.loads(body)
        # ARM PATCH merges the supplied properties/configuration; fixed readback
        # expectations still pass through the actual provider comparator.
        def merge(target, source):
            for key, item in source.items():
                if isinstance(item, dict) and isinstance(target.get(key), dict): merge(target[key], item)
                else: target[key] = deepcopy(item)
        merge(value, incoming)
        value['id'] = u.path
        if '/userAssignedIdentities/' in u.path:
            slot = next(k for k,v in self.manifest['ids'].items() if v == u.path)
            index = list(self.manifest['ids']).index(slot)
            value['properties'] = {'tenantId': self.manifest['owner']['tenant_id'],
                'principalId': op_fixture.guid(2000 + index), 'clientId': op_fixture.guid(2100 + index)}
        if '/providers/Microsoft.App/' in u.path:
            value['properties']['provisioningState'] = 'Succeeded'
            if u.path == self.manifest['ids']['guard']:
                value['identity'].update(principalId=op_fixture.guid(2500), tenantId=self.manifest['owner']['tenant_id'])
            if u.path == self.manifest['ids']['app']:
                ingress = value['properties']['configuration']['ingress']
                label = '' if ingress['external'] else '.internal'
                from scripts.trial_provision.resources import canonical_region
                ingress['fqdn'] = self.manifest['names']['app'] + label + '.fictional.' + canonical_region(self.manifest['region']) + '.azurecontainerapps.io'
            for secret in value['properties'].get('configuration', {}).get('secrets', []): secret.pop('value', None)
        self.objects[u.path] = value
        if u.path == self.unknown_path: raise TimeoutError('fictional lost ACK')
        return response(201 if method == 'PUT' else 200, value)


class GuardianWire:
    """External Blob lease/CAS, Job and PG ARM service emulator only."""
    def __init__(self, config, arm, clock):
        self.config,self.arm,self.clock=config,arm,clock
        self.state,self.lease=None,None
        self.etag=0;self.calls=[];self.template=None
        self.job=config['guardian_job']['resource_id']
        self.execution=self.job+'/executions/'+self.job.rsplit('/',1)[1]+'-main'
        self.started=clock.utc().isoformat()
        self.rule=None
    def __call__(self,method,url,headers,body,deadline):
        deadline.remaining();self.calls.append((method,url))
        u=urlsplit(url);binding=self.config['binding']
        if u.netloc.endswith('.blob.core.windows.net'):
            if url not in (self.config['journal_url'],self.config['journal_url']+'?comp=lease'):
                raise AssertionError('unexpected Blob target')
            if u.query=='comp=lease':
                action=headers['x-ms-lease-action']
                if action=='acquire':
                    if self.lease: return response(409)
                    self.lease=headers['x-ms-proposed-lease-id'];return response(201,headers={'x-ms-lease-id':self.lease})
                if headers.get('x-ms-lease-id')!=self.lease: return response(412)
                if action=='release':self.lease=None
                elif action!='renew':raise AssertionError('unexpected lease operation')
                return response(200)
            if method=='GET':return response(404) if self.state is None else response(200,self.state,{'etag':str(self.etag)})
            if method!='PUT':raise AssertionError('unexpected Blob mutation')
            if headers.get('If-None-Match')=='*':
                if self.state is not None:return response(412)
            elif headers.get('If-Match')!=str(self.etag) or headers.get('x-ms-lease-id')!=self.lease:return response(412)
            self.state=json.loads(body);self.etag+=1
            return response(201,headers={'etag':str(self.etag)})
        if u.netloc!='management.azure.com':raise AssertionError('unexpected guardian host')
        if u.path==self.job+'/start':
            if method!='POST' or self.template is not None:raise AssertionError('duplicate Job start')
            self.template=json.loads(body)
            return response(202,{'id':self.execution})
        if u.path==self.job:return response(200,self.arm.objects[self.job])
        value={'id':self.execution,'properties':{'template':self.template,'startTime':self.started,'status':'Running'}}
        if u.path==self.execution:return response(200,value)
        if u.path==self.execution+'/replicas':return response(200,{'value':[{'name':self.execution.rsplit('/',1)[1]+'-replica'}]})
        if u.path==self.job+'/executions':return response(200,{'value':[value]})
        if u.path==binding['server_id']:
            return response(200,{'id':binding['server_id'],'properties':{'state':'Ready','network':binding['baseline_network']}})
        if u.path==binding['server_id']+'/firewallRules':return response(200,{'value':[] if self.rule is None else [self.rule]})
        if u.path==binding['rule_id']:
            if method=='GET':return response(404) if self.rule is None else response(200,self.rule)
            if method=='PUT':
                if self.rule is not None:raise AssertionError('duplicate rule PUT')
                self.rule={'id':u.path,**json.loads(body)};return response(201,self.rule)
            if method=='DELETE':self.rule=None;return response(204)
        raise AssertionError('unexpected guardian request')


class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        self.f = cli_fixture.CliTests('runTest'); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        # New private temp directory at inception; no existing ACL is changed.
        root = self.f.root / 'workflow'
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, wintypes.LPVOID]
            kernel.CreateDirectoryW.restype = wintypes.BOOL
            with private_io._owner_security_attributes(directory=True) as attrs:
                if not kernel.CreateDirectoryW(str(root), ctypes.byref(attrs)): raise ctypes.WinError(ctypes.get_last_error())
        else: root.mkdir(mode=0o700)
        self.root = self.f.root = root
        self.f.config_path = root / 'configuration.local.json'
        self.config = self.f.config
        self.config['recovery'] = {'directory': str(root), 'directory_digest': digest(str(root))}
        self.config['control_budget'].update(self.config['recovery'])
        self.config['live'] = True
        self.clock = self.f.clock = Clock()
        self.clock.start += timedelta(days=1)
        self.manifest = json.loads(Path(self.config['sources']['manifest']['path']).read_bytes())
        self.manifest.update(cleanupImageTag='fictional-guardian', imageTag='fictional-runtime')
        source = {k: json.loads(Path(v['path']).read_bytes()) for k,v in self.config['sources'].items()}
        def save(slot, value):
            ref = self.f.write(SOURCE_FILES[slot], value); self.config['sources'][slot] = ref
            return ref['sha256']
        mh = save('manifest', self.manifest)
        source['annex']['fixedManifestSha256'] = mh; ah = save('annex', source['annex'])
        source['approval'].update(boundProposalSha256=ah, fixedManifestSha256=mh); ph = save('approval', source['approval'])
        source['latest'].update(priorApprovalSha256=ph, originalProposalSha256=ah, fixedManifestSha256=mh)
        save('latest', source['latest'])
        for slot in ('network_binding','network_approval'):
            save(slot,Path(self.config['sources'][slot]['path']).read_bytes())
        self.config['control_budget']['binding']['manifest_sha256'] = mh
        self.authority = {k: Path(v['path']).read_bytes() for k,v in self.config['sources'].items()}
        self.f.credential.side_effect = Credential
        from scripts.trial_provision.auth import GraphAdapter, EasyAuthAdapter
        self.f.graph.side_effect = GraphAdapter; self.f.auth.side_effect = EasyAuthAdapter
        self.arm = ArmWire(self.manifest, self.clock)
        self.f.wire = self.arm
        self.trace = []
        self.action_trace = []
        self.verified = None
        self.enterContext(patch.object(cli, 'policy_verifier', return_value=lambda env: json.loads(env['TRIAL_POLICY_JSON'])))
        self.enterContext(patch.object(registry_publish_cli, 'git', return_value=(self.f.head+'\n').encode()))
        self.enterContext(patch.object(registry_publish_cli, 'local_sources', return_value=self.f.sources))
        self.enterContext(patch.object(registry_publish_cli, 'AzureCredential', Credential))
        for role in ('web', 'worker'):
            raw = ('fictional-database-' + role).encode()
            self.config.setdefault('secret_sources', {})['trial-'+role+'-database'] = self.f.write(role+'.credential', raw)
            self.config['resource_bindings']['db_secret_digests'][role] = hashlib.sha256(raw).hexdigest()

    def journal(self):
        name,binding=journal_descriptor(self.config,self.verified)
        return Journal(str(self.root), digest(str(self.root)), binding,name=name,require_existing=True)

    def snapshot(self):
        with self.journal() as journal:
            resolver=create_resolver(journal.values('core_plan')[0],self.manifest,self.authority,self.config['resource_bindings'],verified_attempt=self.verified)
            receipts=journal.receipts()
            for event in journal.values('rehearsal_binding'): resolver.bind_rehearsal(event,receipts)
            for event in journal.values('runtime_binding'): resolver.bind_runtime(event,receipts,verify_policy=lambda e:json.loads(e['TRIAL_POLICY_JSON']))
            for event in journal.values('cleanup_binding'): resolver.bind_cleanup(event['operation_id'],event['evidence'])
            return resolver,receipts

    def prepare_attempt(self, public):
        """A fictional signed-off artifact set, passed through the real verifier.

        The prior stopped publication is fixture evidence; this never makes
        local assertions stand in for a real OWNER approval or Cloud receipt.
        """
        data=attempt_fixture.fixture();data['manifest']=deepcopy(self.manifest)
        self.retained_body=encoded({'fictional':'retained-runtime'})
        retained='sha256:'+hashlib.sha256(self.retained_body).hexdigest()
        data['authority']['retained_runtime']['digest']=retained
        for event,value in data['parent_rows']:
            if event=='progress' and value.get('operation_id')=='runtimeImagePush':value['properties']['manifest_digest']=retained
        mh=self.config['sources']['manifest']['sha256'];head=self.f.head
        base={k:self.config['control_budget']['binding'][k] for k in ('manifest_sha256','owner_id','task_id')}
        rows=data['parent_rows'];rows[0]=('binding',base)
        prep=next(value for event,value in rows if event=='publication_preparation')
        prep.update(manifest_sha256=mh,run_binding_digest=digest(base),registry_id=self.manifest['existing']['registry'],
            login_server=self.manifest['registry']['loginServer'])
        for slot,repo_key,tag_key in (('guardian','cleanupImageRepository','cleanupImageTag'),('runtime','imageRepository','imageTag')):
            fixed=prep['slots'][slot];fixed.update(repository=self.manifest[repo_key],tag=self.manifest[tag_key])
            prefix='https://'+prep['login_server']+'/v2/'+fixed['repository']+'/manifests/'
            ns=next(value for event,value in rows if event==slot+'_image_namespace')
            ns.update(publication_preparation_digest=digest(prep),run_binding_digest=digest(base),registry_id=prep['registry_id'],
                login_server=prep['login_server'],repository=fixed['repository'],url='https://'+prep['login_server']+'/acr/v1/'+fixed['repository']+'?api-version=2021-07-01')
            for event,value in rows:
                if value.get('operation_id')!=slot+'ImagePush':continue
                if event=='intent':value['url']=prefix+fixed['tag']+'?api-version=2021-07-01'
                elif event=='progress':
                    value['object_id']=prefix+value['properties']['manifest_digest']+'?api-version=2021-07-01'
                    value['properties'].update(registry_id=prep['registry_id'],login_server=prep['login_server'],repository=fixed['repository'])
        # Both namespace proofs cover the final complete two-slot preparation.
        for event,value in rows:
            if event.endswith('_image_namespace'):value['publication_preparation_digest']=digest(prep)
            if value.get('operation_id')=='guardianImageCleanup':
                target='https://'+prep['login_server']+'/v2/'+self.manifest['cleanupImageRepository']+'/manifests/'+data['authority']['guardian_prior_digest']+'?api-version=2021-07-01'
                value['url' if event=='intent' else 'object_id']=target
        parent_raw,parent_chain=attempt_fixture.chain(rows)
        self.f.write('trial-provision.jsonl',parent_raw)
        self.parent_bytes=parent_raw
        stamp=lambda offset:(self.clock.start+timedelta(seconds=offset)).isoformat().replace('+00:00','Z')
        windows={key:{'start':stamp(start),'end':stamp(end)} for key,(start,end) in WINDOW_OFFSETS.items()}
        a=data['authority'];a.update(manifest_sha256=mh,owner_id=base['owner_id'],task_id=base['task_id'],head=head,
            code_sources_sha256=digest(self.f.sources),budget_binding_sha256=digest(self.config['control_budget']['binding']),
            publish_from=stamp(0),approved_at=stamp(-600),tags={slot:prep['slots'][slot]['tag']+'-'+head[:12] for slot in ('guardian','runtime')},
            retained_runtime={'tag':self.manifest['imageTag'],'digest':data['authority']['retained_runtime']['digest']})
        a['parent']={'journal_sha256':attempt_fixture.sha(parent_raw),'chain_sha256':parent_chain,
            'final_sha256':attempt_fixture.sha(encoded(data['parent_final']))}
        public['publication']['publish_until']=windows['publication']['end']
        for slot in ('guardian','runtime'):
            fixed=public['publication']['slots'][slot]
            proof=json.loads(Path(fixed['build_receipt']['path']).read_bytes())
            proof['image_ref']=prep['login_server']+'/'+prep['slots'][slot]['repository']+':'+a['tags'][slot]
            raw=encoded(proof);data['artifacts'][slot+'_build']=raw
            fixed['build_receipt']=self.f.write(slot+'-build.json',raw)
        data['artifacts']['local_ready']=encoded({'head':head,'design_sha256':DESIGN_SHA256,'code_sources_sha256':digest(self.f.sources)})
        data['artifacts']['limits']=encoded({'schema':1,'head':head,'counts_before':a['counts_before'],
            'phase_caps':a['phase_caps'],'unallocated':a['unallocated'],'purpose_caps':PURPOSE_CAPS})
        a['artifact_sha256']={key:attempt_fixture.sha(raw) for key,raw in data['artifacts'].items()}
        authority_ref=self.f.write('attempt-authority.json',encoded(a));self.trusted=authority_ref['sha256']
        activation={'schema':1,'attempt_id':a['attempt_id'],'authority_sha256':self.trusted,'issued_at':stamp(-300),'windows':windows}
        activation_ref=self.f.write('attempt-activation.json',encoded(activation))
        evidence={'authority':authority_ref,'parent_final':self.f.write('parent-final.json',encoded(data['parent_final'])),
            'artifacts':{key:self.f.write('attempt-'+key+'.json',raw) for key,raw in data['artifacts'].items()}}
        public.update(attempt=activation_ref,attempt_evidence=evidence)
        self.config.update(attempt=activation_ref,attempt_evidence=evidence,
            plan_bindings={'guardian_window':windows['guardian'],'owner_window':windows['owner_input']})
        self.config['cleanup_deadlines'].update(guardian=windows['guardian']['end'],owner_input=windows['owner_input']['end'])
        self.config['resource_bindings'].update(guardian_deadline=windows['guardian']['end'],deadline=windows['owner_input']['end'])
        loaded={**public,'authority_bundle':self.authority}
        self.verified=attempt_fixture.verify_attempt(loaded,self.manifest,authority_raw=encoded(a),activation_raw=encoded(activation),
            parent_journal_raw=parent_raw,parent_final_raw=encoded(data['parent_final']),artifacts=data['artifacts'],
            trusted_authority_sha256=self.trusted,now=self.clock.utc())
        self.pool=OwnerTokenPool(self.verified,self.clock);self.addCleanup(self.pool.close)
        self.windows=windows
        budget=self.config['control_budget']
        with ControlBudget(budget['directory'],budget['directory_digest'],budget['binding'],seed=budget['seed']) as counter:
            for _ in range(59):counter.consume('owner_arm',600)
        def run_action(action='prepare',**extra):
            self.f.write(self.f.config_path.name,self.config)
            calls=getattr(self.f.wire,'calls',self.arm.calls)
            before=len(calls)
            try:
                return cli.run_command({'config':str(self.f.config_path),'action':action,**extra},clock=self.clock,wire=self.f.wire,
                    trusted_attempt_authority=self.trusted,owner_token_pool=self.pool)
            finally:
                self.action_trace.append({'action':action,'operation':extra.get('operation_id'),
                    'requests':[(row[0],row[1]) for row in calls[before:]]})
        self.f.run_action=run_action

    def publish_and_prepare(self):
        p=publish_fixture.PublisherTests('runTest')
        p.clock=self.clock;p.manifest=self.manifest;p.host=self.manifest['registry']['loginServer']
        p.body=encoded({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json',
            'config':{'digest':'sha256:'+'3'*64,'size':200},'layers':[{'digest':'sha256:'+'2'*64,'size':300}]})
        p.image='sha256:'+hashlib.sha256(p.body).hexdigest();p.calls=[];p.processes=[]
        p.modify=p.process_modify=p.access=p.config_observed=None
        p.docker=self.root/('docker.exe' if os.name=='nt' else 'docker');p.docker.write_bytes(b'fictional-never-executed')
        p.bundle={'docker_host':'npipe:////./pipe/dockerDesktopLinuxEngine','local_image_id':'sha256:'+'3'*64}
        # Reuse strict fake wire/process boundaries, not a mocked publisher result.
        class Audit:
            def values(_, event):
                return [json.loads(row)['value'] for row in (self.root/'trial-provision-next.jsonl').read_bytes().splitlines() if json.loads(row)['event']==event]
        p.journal=Audit()
        public={k:deepcopy(self.config[k]) for k in ('schema','live','sources','frozen_head','ci','recovery','control_budget','code_sources')}
        public['publication']={'publish_until':'2026-10-11T01:10:00Z','slots':{}}
        for slot,repository,tag in (('guardian','cleanupImageRepository','cleanupImageTag'),('runtime','imageRepository','imageTag')):
            fixed={'docker_path':str(p.docker),'docker_sha256':hashlib.sha256(p.docker.read_bytes()).hexdigest(),**p.bundle}
            proof={'schema':1,'slot':slot,'manifest_sha256':public['sources']['manifest']['sha256'],
                'source_head':self.f.head,'request_digest':'c'*64,'method':'docker-build','attempt':1,'exit_code':0,
                'docker_sha256':fixed['docker_sha256'],'docker_host':fixed['docker_host'],
                'image_ref':p.host+'/'+self.manifest[repository]+':'+self.manifest[tag],'image_id':fixed['local_image_id'],
                'readback_verified':True,'managed_build_sha':self.f.head}
            fixed['build_receipt']=self.f.write(slot+'-build.json',proof)
            public['publication']['slots'][slot]=fixed
        self.prepare_attempt(public)
        p.manifest=deepcopy(self.manifest)
        p.manifest.update(cleanupImageTag=self.verified.authority['tags']['guardian'],imageTag=self.verified.authority['tags']['runtime'])
        retained=self.verified.authority['retained_runtime']['digest']
        def retention_wire(method,url):
            if p.bundle['slot']!='runtime':return None
            if '/oauth2/' in url:return None
            if '/acr/v1/' in url:return response(200,{'name':p.repo})
            if '/manifests/'+self.manifest['imageTag']+'?' in url or '/manifests/'+retained+'?' in url:
                return {'status':200,'headers':{'Docker-Content-Digest':retained},'body':self.retained_body}
            if not p.pushes()>=2:return response(404,{'errors':[{'code':'MANIFEST_UNKNOWN'}]})
            return None
        p.modify=retention_wire
        ref=self.f.write('publication.local.json',public)
        def command(action,slot=None):
            request={'config':ref['path'],'action':action}
            if slot: request['slot']=slot
            return registry_publish_cli.run_command(request,clock=self.clock,wire=p.wire,runner=p.runner,
                trusted_attempt_authority=self.trusted,owner_token_pool=self.pool)
        self.assertEqual('publication_prepared',command('prepare')['status'])
        self.trace.append('publication_prepare')
        for slot,key in (('guardian','cleanupImageRepository'),('runtime','imageRepository')):
            p.bundle['slot']=slot;p.repo=self.manifest[key]
            self.assertTrue(command('publish',slot)['push_verified']);self.trace.append(slot+'_published')
        with self.journal() as journal: images=verified_publication_images(journal,verified_attempt=self.verified)
        self.assertEqual(2,p.pushes())
        self.config['resource_bindings'].update(images)
        self.clock.seconds=2100
        self.assertEqual('prepared',self.f.run_action()['status']);self.trace.append('resource_prepare')
        self.publisher=p
        self.assertGreater(self.f.run_action('status')['control_requests_used'],187)
        self.assertEqual(self.parent_bytes,(self.root/'trial-provision.jsonl').read_bytes())
        with self.journal() as journal:
            self.assertEqual(1,len(journal.values('publication_preparation')))
            self.assertEqual(1,len(journal.values('publication_import')))
            self.assertEqual(images,{k:journal.values('plan')[0]['resource_bindings'][k] for k in images})

    def provision(self, all_permissions=False):
        for slot in ('webIdentity','workerIdentity','originals','artifacts','budget','journal','guard','R9','R8','job','app'):
            self.assertEqual('succeeded',self.f.run_action('create',operation_id=slot)['status'],slot)
        if all_permissions:
            for slot in ([f'C{i}' for i in range(1,8)]+[f'R{i}' for i in range(1,11) if i not in (8,9)]+[f'G{i}' for i in range(1,7)]):
                self.assertEqual('succeeded',self.f.run_action('create',operation_id=slot)['status'],slot)
        self.trace.append('registered')

    def rehearse(self):
        resolver,receipts=self.snapshot();create=resolver.resolve('guard',receipts)
        job=self.manifest['ids']['guard'];execution_id=job+'/executions/'+self.manifest['names']['guard']+'-one'
        blob='https://'+self.manifest['existing']['storage'].rsplit('/',1)[1]+'.blob.core.windows.net/'+self.manifest['names']['journal']+'/rehearsal.json'
        principal=receipts['guard']['properties']['principalId'];owner=self.manifest['owner']
        f=rehearsal_fixture.RehearsalTests('runTest');f.setUp();self.addCleanup(f.doCleanups)
        f.clock=self.clock;f.credential=Credential('owner',owner['principal_id'],owner['tenant_id'])
        f.owner.update(owner_id=owner['principal_id'],tenant_id=owner['tenant_id'],journal_url=blob,
            owner_permissions_until=self.clock.iso(28800),prearm_until=self.clock.iso(300),seed_not_before=self.clock.iso())
        f.owner['owner_access'].update(principal_id=owner['principal_id'],journal_url=blob,starts_at=self.clock.iso(),ends_at=self.clock.iso(28800))
        f.guardian.update(tenant_id=owner['tenant_id'],journal_url=blob,job_name=self.manifest['names']['guard'],prearm_until=self.clock.iso(300),seed_not_before=self.clock.iso())
        f.guardian['immutable']['owner_access']=deepcopy(f.owner['owner_access'])
        f.guardian['immutable']['cloud_guard'].update(execution_id=job+'/executions/$CURRENT',principal_id=principal,
            image_digest=self.config['resource_bindings']['guardian_image'].split('@')[1])
        ref=self.f.write('rehearsal.local.json',{'owner':f.owner,'guardian':f.guardian})
        with patch.multiple(rehearsal_fixture,JOB=job,EXECUTION=execution_id,BLOB=blob,PRINCIPAL=principal,TENANT=owner['tenant_id']):
            wire=rehearsal_fixture.Wire(self.clock,create);wire.replica_rows=[{'name':execution_id.rsplit('/',1)[1]+'-replica'}]
            if hasattr(self,'rehearsal_wire_setup'):self.rehearsal_wire_setup(wire,execution_id)
            start=self.clock.utc();saved_iso=self.clock.iso
            self.clock.iso=lambda seconds=0:(start+timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')
            old=self.f.wire;self.f.wire=wire
            try:
                for action in ('start','seed'):
                    self.assertIn(self.f.run_action('rehearsal-'+action,rehearsal_config=ref)['status'],('pending','succeeded'))
                    if action=='start' and hasattr(self,'rehearsal_wire_setup'):
                        self.clock.advance(2)
                        self.assertIn(self.f.run_action('rehearsal-poll',rehearsal_config=ref)['status'],('pending','succeeded'))
                self.clock.advance(10);wire.job_status='Succeeded';wire.state['version']=1
                wire.state['rehearsal']={'at':self.clock.iso(5),'reads_and_cas':True,'delete_measured':False}
                self.assertTrue(self.f.run_action('rehearsal-verify',rehearsal_config=ref)['rehearsal_verified'])
            finally:self.f.wire=old;self.clock.iso=saved_iso
        self.assertEqual('succeeded',self.f.run_action('update',operation_id='guardMainConfiguration',creation_id='guard')['status'])
        self.trace.append('guardian_main_ready')

    def policy(self):
        resolver,receipts=self.snapshot()
        f=op_fixture.OperationsTests('runTest')
        f.args=(None,self.manifest,None,self.config['resource_bindings']);f.receipts=receipts
        env={'DEPLOYMENT_KIND':'trial',**f.policy()};p=json.loads(env['TRIAL_POLICY_JSON'])
        from scripts.trial_provision.resources import public_trial_origin
        p['auth']['origin']=public_trial_origin(self.manifest,receipts['app']['properties']['defaultDomain'])
        p['database']['host']=self.manifest['existing']['db'].rsplit('/',1)[1]+'.postgres.database.azure.com'
        p['cost']['databaseBaselineBytes']=0
        p.update(startsAt=self.windows['initial']['start'],endsAt=self.windows['initial']['end'])
        p['localOperator']={'recoveryDirectoryDigest':hashlib.sha256(str(self.root).encode()).hexdigest(),'ticketDigest':'a'*64}
        env['TRIAL_POLICY_JSON']=json.dumps(p)
        return env

    def guardian_execute(self):
        self.clock.seconds=(parse(self.windows['owner_input']['start'])-self.clock.start).total_seconds()
        # Resource preparation and rehearsal precede the OWNER input window.
        # E1 is needed for bootstrap's fixed callback, and starts inside it.
        self.assertEqual('succeeded',self.f.run_action('create',operation_id='E1')['status'])
        for slot in ('O1','O2'):
            self.assertEqual('succeeded',self.f.run_action('create',operation_id=slot)['status'])
        if hasattr(self, 'before_main'): self.before_main()
        self.clock.seconds=(parse(self.windows['initial']['start'])-self.clock.start).total_seconds()
        resolver,receipts=self.snapshot();main=resolver.resolve('guardMainConfiguration',receipts)
        self.assertEqual(7,sum(slot.startswith('C') and slot[1:].isdigit() for slot in receipts))
        self.assertEqual(18,sum(slot[0] in 'RGO' and slot[1:].isdigit() for slot in receipts))
        at=self.clock.utc();iso=lambda seconds:(at+timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')
        owner=self.manifest['owner'];job=self.manifest['ids']['guard'];principal=receipts['guard']['properties']['principalId']
        journal_url='https://'+self.manifest['existing']['storage'].rsplit('/',1)[1]+'.blob.core.windows.net/'+self.manifest['names']['journal']+'/state.json'
        network=json.loads(self.authority['network_binding'])
        server=self.manifest['existing']['db'];rule=server+'/firewallRules/'+network['proposed_rule_name']
        binding={'mode':'guardian','server_id':server,'rule_id':rule,'ipv4':'192.0.2.1','region':self.manifest['region'],
            'lifecycle_id':op_fixture.guid(6000),'baseline_rules':[],'baseline_network':{'publicNetworkAccess':'Enabled'},
            'lro_authorization':{'approved':True,'readback_verified':True,'principal_id':principal,
                'scope':'/subscriptions/'+server.split('/')[2],'actions':list(ArmTransport.lro_actions),
                'assignment_id':receipts['G3']['object_id'],'evidence_sha256':digest(receipts['G3']),'ends_at':iso(3600)}}
        access={'approved':True,'readback_verified':True,'principal_id':owner['principal_id'],'journal_url':journal_url,
            'starts_at':iso(0),'ends_at':iso(3600),'assignment_id':receipts['G6']['object_id'],'evidence_sha256':digest(receipts['G6'])}
        runtime={'execution_id':job+'/executions/$CURRENT','replica_name':'$CURRENT',
            'image_digest':self.config['resource_bindings']['guardian_image'].split('@')[1],'principal_id':principal,
            'nonce':'fictional-main-nonce-bound','job_started_at':'$CURRENT','job_deadline':'$CURRENT'}
        template=self.arm.objects[job]['properties']['template'];identity=self.arm.objects[job]['identity']
        config={'live_enabled':True,'cleanup_strategy':'single_job','owner_id':owner['principal_id'],'tenant_id':owner['tenant_id'],
            'binding':binding,'owner_access':access,'owner_permissions_until':access['ends_at'],'cloud_guard':runtime,
            'journal_url':journal_url,'prearm_until':iso(300),'seed_not_before':iso(0),'cleanup_targets_digest':digest([]),
            'recovery_directory':str(self.root),'recovery_directory_digest':digest(str(self.root)),
            'control_budget':deepcopy(self.config['control_budget']),
            'guardian_job':{'resource_id':job,'environment_id':self.manifest['existing']['environment'],
                'template':template,'template_digest':digest(template),'identity_digest':digest(identity),
                'image_digest':runtime['image_digest'],'principal_id':principal,'readback_verified':True,
                'execution_schema_verified':True,'approved':True}}
        fixed={key:None for key in FIXED}
        fixed.update(lifecycle_id=binding['lifecycle_id'],rule_id=rule,cleanup_strategy='single_job',cloud_guard=runtime,
            owner_access=access,cleanup_targets_digest=digest([]))
        fixed.update({k:'$CURRENT' for k in ('prepared_at','cleanup_at','deadline','ready_until')})
        config['guardian_config']={k:deepcopy(config[k]) for k in ('live_enabled','tenant_id','journal_url','prearm_until','seed_not_before','binding')}
        config['guardian_config'].update(mode='main',job_name=self.manifest['names']['guard'],immutable=fixed)
        env=self.policy();policy=json.loads(env['TRIAL_POLICY_JSON'])
        window={'lifecycleId':binding['lifecycle_id'],'bindingDigest':'c'*64,'guardianNonce':runtime['nonce'],
            'ruleId':rule,'journalUrl':journal_url,'jobStartedAt':iso(0),'useUntil':iso(600)}
        payload={'azureCliPython':str(Path(sys.executable).resolve()),'environment':env,'recoveryDirectory':str(self.root),
            'requests':[],'access':{'databaseWindow':window,'startsAt':self.windows['owner_input']['start'],'endsAt':self.windows['owner_input']['end']},
            'bootstrap':{'mode':'apply','manifest':{'schema':1,'adminUser':'fictional_admin','adminCatalog':'postgres',
                'cases':[{'id':i,'title':'FICTIONAL TRIAL SAMPLE '+str(i)} for i in range(1,5)]}}}
        db=policy['database']
        plan={'schema':1,'server':db['host'],'adminUser':'fictional_admin','targetDatabase':db['database'],
            'roles':{'owner':db['ownerRole'],'migrator':db['migratorUser'],'web':db['webUser'],'worker':db['workerUser']},
            'excludedDatabases':[{'name':'template0','template':True,'allowConnect':False}],
            'maximumAuditConnections':6,'builtinManifestSha256':'b'*64,'querySetSha256':'c'*64,'limits':deepcopy(catalog.LIMITS)}
        policy['localOperator']['catalogPlanDigest']=catalog.catalog_digest(plan);env['TRIAL_POLICY_JSON']=json.dumps(policy)
        payload.update(catalogPlan=plan,databaseWindow=deepcopy(window),signingPrivateKey='FICTIONAL-SIGNING-KEY',
            operatorDatabaseUrl='postgresql://'+db['migratorUser']+':FICTIONAL-MIGRATOR@'+db['host']+'/'+db['database'])
        payload['bootstrap']['credentials']={'adminUrl':'postgresql://fictional_admin:FICTIONAL-ADMIN@'+db['host']+'/postgres',
            'migratorPassword':'FICTIONAL-MIGRATOR','webPassword':'FICTIONAL-WEB','workerPassword':'FICTIONAL-WORKER'}
        payload['requests']=[{'command':'initialize-ledger'},{'command':'package-import'}]
        for case_id in range(1,5):
            index=len(payload['requests']);payload['requests'].extend([{'command':'sample-save','caseId':case_id},
                {'command':'setting-save','setting':{'caseId':case_id,
                    'base':{'$sessionResult':{'requestIndex':index,'field':'base'}},'source':{'$sessionResult':{'requestIndex':index,'field':'source'}}}}])
        compiled=self.root/'.koho-ops'/'managed';(compiled/'scripts').mkdir(parents=True)
        script=compiled/'scripts'/'trial-session.js';script.write_bytes(b'// fictional Node boundary\n')
        node=Path(self.config['policy_verifier_node'])
        pin={'schema':1,'head':self.config['resource_bindings']['code_sha'],'node_sha256':hashlib.sha256(node.read_bytes()).hexdigest(),
            'compiled_root':str(compiled),'entry':'scripts/trial-session.js','source_digest':'b'*64,
            'files':{'scripts/trial-session.js':hashlib.sha256(script.read_bytes()).hexdigest()}}
        config['worker']={'node':str(node),'script':str(script),'payload':payload,'artifact_pin':pin,'mode':catalog.MODE}
        config['attempt_binding_digest']=self.verified.binding_digest
        config['preflight']={k:binding[k] for k in ('ipv4','server_id','rule_id')}
        config['preflight'].update(ci_head=self.f.head,reviewed_head=self.f.head,checked_at=iso(0),
            initial_forecast_yen=4311,initial_cap_yen=5000,all_unsettled_retained=True,schema=2,catalog_acl='pending_catalog',
            no_production_change=True,launch_checks_verified=True,
            evidence_sha256={k:'b'*64 for k in ('network_approval','current_ip','platform_isolation','current_ledger','current_prices','effective_permissions','additional_authority')})
        wire=GuardianWire(config,self.arm,self.clock);runner=None
        def sleep(seconds):
            nonlocal runner
            # Yield to the real stdout/broker threads at the process boundary.
            threading.Event().wait(.01)
            self.clock.advance(seconds)
            if wire.state is None:return
            if runner is None:
                state=wire.state;actual=state['cloud_guard']
                credential=Credential('guardian',principal,owner['tenant_id'])
                journal=BlobJournal(journal_url,state['binding_digest'],credential,wire,self.clock,
                    immutable={k:deepcopy(state[k]) for k in FIXED})
                transport=ArmTransport(binding,credential,wire,self.clock,journal.assert_send_lease)
                def proof():
                    heartbeat=parse(wire.state['owner_heartbeat']['at'])
                    return {**actual,'kind':'azure_job','lifecycle_id':state['lifecycle_id'],'runtime_verified':True,
                        'alive':(self.clock.utc()-heartbeat).total_seconds()<=15,'at':self.clock.utc().isoformat()}
                controller=Lifecycle(journal,transport,self.clock,proof)
                runner=GuardianRunner(controller,journal,self.clock,principal+':'+actual['execution_id'],lambda:None)
            if not wire.state.get('guardian_ready') and not wire.state.get('close_requested'):runner.opening_gate()
            else:runner.step()
        test=self
        child=CatalogChild();actual_window=None;pass_hashes=[];requested=False
        def emit_pass(number):
            value={'schema':1,'pass':number,'codeSha':self.config['resource_bindings']['code_sha'],'auditPlanDigest':catalog.catalog_digest(plan),
                'querySetDigest':plan['querySetSha256'],'builtinManifestSha256':plan['builtinManifestSha256'],
                'databaseWindowDigest':catalog.catalog_digest(actual_window),'lifecycleId':actual_window['lifecycleId'],
                'guardianNonce':actual_window['guardianNonce'],'targetInventoryDigest':'d'*64,'catalogDigest':'e'*64,
                'startedAt':self.clock.utc().isoformat(),'checkedAt':self.clock.utc().isoformat(),
                'auditConnectionAttempts':6,'counts':{'databases':6,'queries':114,'rows':6,'bytes':12},
                'status':'verified','automaticResend':False}
            ref=self.f.write('trial-catalog-pass-'+str(number)+'.json',catalog.canonical(value)+b'\n')
            pass_hashes.append(ref['sha256']);child.stdout.feed({'type':'catalog_pass','schema':1,'pass':number,'sha256':ref['sha256']})
        def flush(value):
            nonlocal actual_window,requested
            if value['type']=='catalog_start':
                test.assertTrue(wire.state['guardian_ready']);test.assertTrue(wire.state['usage_allowed'])
                test.assertNotIn('signingPrivateKey',value);test.assertNotIn('bootstrap',value)
                test.assertEqual(set(value['admin']),{'adminUrl','adminUser'})
                test.assertNotIn('FICTIONAL-WEB',json.dumps(value));actual_window=value['databaseWindow']
            elif value['type']=='permit' and not requested:
                requested=True;child.stdout.feed({'type':'permit_request','schema':1,'id':1})
            elif value['type']=='permit_snapshot':
                test.assertEqual(value['id'],1);test.assertEqual(value['snapshot']['status'],'active');emit_pass(1)
            elif value['type']=='bootstrap':
                rows=[json.loads(row) for row in (self.root/'trial-session.jsonl').read_bytes().splitlines()]
                test.assertEqual([r['value']['pass'] for r in rows if r['event']=='catalog_verified'],[1])
                test.assertTrue(any(r['event']=='bootstrap_frame_intent' for r in rows))
                test.assertEqual(value['payload']['signingPrivateKey'],'FICTIONAL-SIGNING-KEY')
                test.assertNotIn('catalogPlan',value['payload']);test.assertEqual(value['catalogPass1Sha256'],pass_hashes[0])
                emit_pass(2)
                final=deepcopy(policy);final['cost']['databaseBaselineBytes']=1024;final['localOperator']['ticketDigest']='b'*64
                final_env={**env,'TRIAL_POLICY_JSON':json.dumps(final)};final_ref=test.f.write('trial-runtime-policy.json',final_env)
                name='operator-'+'9'*64+'.jsonl'
                step={'schema':1,'intent':'9'*64,'ticketDigest':'c'*64,'startsAt':iso(0),'endsAt':iso(3600),
                    'status':'outcome_unknown','automaticResend':False}
                step_ref=test.f.write(name,encoded(step)+b'\n'+encoded({'terminal':'completed'})+b'\n')
                entries=[{'name':name,'sha256':step_ref['sha256']}]
                bootstrap={'status':'bootstrapped','databaseBaselineBytes':1024,'cases':4,'automaticResend':False}
                proof={'schema':1,'bootstrap':bootstrap,'databaseWindow':actual_window,
                    'database':{k:final['database'][k] for k in ('host','database','ownerRole','migratorUser','webUser','workerUser')},
                    'codeSha':test.config['resource_bindings']['code_sha'],'bootstrapManifest':payload['bootstrap']['manifest'],
                    'receipts':entries,'receiptScope':'verified_steps_this_invocation'}
                proof_ref=test.f.write('trial-bootstrap-proof.json',proof);emit_pass(3)
                child.stdout.feed({'status':'completed','completedRequests':10,
                    'bootstrap':{'schema':1,**bootstrap,'finalRuntimePolicySha256':final_ref['sha256'],
                        'databaseWindowDigest':catalog.catalog_digest(actual_window),'receiptSetSha256':digest(entries),
                        'receiptCount':1,'proofSha256':proof_ref['sha256']},
                    'catalog':{'schema':1,'auditPlanDigest':catalog.catalog_digest(plan),'auditConnectionAttempts':6,
                        **{'pass'+str(i)+'Sha256':pass_hashes[i-1] for i in (1,2,3)}}})
                test.final_environment=final_env;child.exit(0)
        child.stdin.on_flush=flush
        faults=[];original_fault=catalog.CatalogNodeWorker._latch_fault
        def record_fault(worker):
            faults.append(str(sys.exc_info()[1]));return original_fault(worker)
        with patch.object(execution,'COMPILED_ROOT',compiled),patch.object(execution,'AzureCredential',Credential),\
            patch('scripts.trial_guard.owner.AzureCredential',Credential),patch.object(execution.time,'sleep',sleep),\
            patch.object(execution.subprocess,'Popen',return_value=child) as spawn,\
            patch.object(catalog.CatalogNodeWorker,'_latch_fault',record_fault):
            before=(self.root/'trial-control-budget.jsonl').read_bytes()
            with patch.object(execution,'Receipt',side_effect=AssertionError('unsealed receipt write')) as blocked_receipt:
                with self.assertRaises(Denied):execution.execute(config,clock=self.clock,http=wire,owner_token_pool=self.pool)
            blocked_receipt.assert_not_called();spawn.assert_not_called();self.assertEqual(wire.calls,[])
            self.assertEqual((self.root/'trial-control-budget.jsonl').read_bytes(),before)
            result=execution.execute(config,clock=self.clock,http=wire,verified_attempt=self.verified,owner_token_pool=self.pool)
        self.assertEqual({'status':'completed','cleanupConfirmed':True,'workComplete':True},result,
            {'faults':faults,'events':[json.loads(r)['event'] for r in (self.root/'trial-session.jsonl').read_bytes().splitlines()],
             'requests':[(m,urlsplit(u).path.rsplit('/',1)[-1]) for m,u in wire.calls[-8:]],
             'state':None if wire.state is None else {k:wire.state.get(k) for k in ('status','blocked','block_reason')}})
        self.assertEqual(1,spawn.call_count);self.assertTrue(closure_proven(wire.state))
        self.assertEqual(faults,[])
        session_rows=[json.loads(row) for row in (self.root/'trial-session.jsonl').read_bytes().splitlines()]
        self.assertEqual([row['value']['pass'] for row in session_rows if row['event']=='catalog_verified'],[1,2,3])
        self.assertEqual(1,sum(m=='POST' and '/start?' in u for m,u in wire.calls))
        self.assertEqual(1,sum(m=='PUT' and urlsplit(u).path==rule for m,u in wire.calls))
        self.assertEqual(1,sum(m=='DELETE' and urlsplit(u).path==rule for m,u in wire.calls))
        override=json.loads(wire.template['containers'][0]['env'][0]['value'])
        self.assertEqual(config['guardian_config'],override)
        self.guard_config=config;self.guard_wire=wire
        budget_config=self.config['control_budget']
        with ControlBudget(budget_config['directory'],budget_config['directory_digest'],budget_config['binding'],
                seed=budget_config['seed'],require_existing=True) as budget:
            self.assertEqual(1,len(budget.journal.values('binding')))
            self.assertGreater(budget.count('owner_arm'),140)
            self.assertGreater(budget.count('owner_control_blob'),32)
            self.assertGreater(budget.count('heartbeat_blob'),0)
            for kind,limit in budget.LIMITS.items():self.assertLess(budget.count(kind),limit)
        self.trace.append('db_and_guardian_closed')

    def bind_and_deploy(self):
        before=self.f.run_action('status')['control_requests_used']
        bundle=self.f.write('bootstrap.local.json',{'schema':1,'execution_config':self.guard_config})
        self.assertTrue(self.f.run_action('bind-bootstrap',bootstrap_config=bundle)['bootstrapBound'])
        env={k:v for k,v in self.final_environment.items() if k!='DEPLOYMENT_KIND'}
        ref=self.f.write('runtime.local.json',env)
        self.assertEqual('runtime_bound',self.f.run_action('bind-runtime',runtime_environment=ref)['status'])
        self.assertEqual(before,self.f.run_action('status')['control_requests_used'])
        resolver,receipts=self.snapshot()
        self.assertEqual(digest(self.final_environment),receipts['trialDatabaseBootstrap']['properties']['final_policy_environment_sha256'])
        self.assertEqual(1024,receipts['trialDatabaseBootstrap']['properties']['database_baseline_bytes'])
        self.trace.append('bootstrap_and_runtime_bound')
        targets=(('jobRuntime','job'),) if resolver.combined_runtime_auth else (('jobRuntime','job'),('appRuntime','app'))
        for slot,parent in targets:
            self.assertEqual('succeeded',self.f.run_action('update',operation_id=slot,creation_id=parent)['status'])
        resolver,receipts=self.snapshot()
        for slot,_ in targets:
            self.assertEqual(digest(resolver.resolve(slot,receipts)),receipts[slot]['request_digest'])
        self.trace.append('runtime_deployed')

    def cleanup_after_due(self):
        resolver,receipts=self.snapshot();source=resolver.resolve('job',receipts)
        evidence={'initial_plan_digest':resolver.plan_digest,'deadline':source['cleanup']['deadline'],'reference_evidence':{}}
        ref=self.f.write('cleanup.local.json',evidence)
        self.clock.seconds=(parse('2026-11-01T00:00:00Z')-self.clock.start).total_seconds()
        self.assertEqual('cleanup_bound',self.f.run_action('bind-cleanup',operation_id='cleanup_job',cleanup_evidence=ref)['status'])
        self.assertEqual('succeeded',self.f.run_action('cleanup',operation_id='cleanup_job',creation_id='jobRuntime')['status'])
        self.assertNotIn(self.manifest['ids']['job'],self.arm.objects)
        _,receipts=self.snapshot();self.assertTrue(receipts['cleanup_job']['cleanup_overdue'])
        self.trace.append('overdue_cleanup_verified')

    def test_complete_entrypoint_chain_requires_same_closed_db_policy_then_overdue_cleanup(self):
        self.publish_and_prepare();self.provision(all_permissions=True);self.rehearse();self.guardian_execute();self.bind_and_deploy();self.cleanup_after_due()
        self.assertEqual(['publication_prepare','guardian_published','runtime_published','resource_prepare','registered',
            'guardian_main_ready','db_and_guardian_closed','bootstrap_and_runtime_bound','runtime_deployed','overdue_cleanup_verified'],self.trace)

    def enable_owner_auth(self):
        for slot in ('E2', 'E3', 'E4'):
            if slot in self.snapshot()[1]: continue
            self.assertEqual('succeeded', self.f.run_action('create', operation_id=slot)['status'], slot)
        resolver, receipts = self.snapshot()
        # The addPassword callback must actually dispatch the platform secret
        # through Controller.deliver_secret, not a test-inserted success receipt.
        self.assertEqual('succeeded', receipts['auth-platform-secret']['state'])
        self.assertTrue(receipts['auth-platform-secret']['readback_verified'])
        self.assertEqual('E4', receipts['auth-platform-secret']['properties']['credentialOperationId'])
        for slot in ('auth-config', 'auth-ingress'):
            self.assertEqual('succeeded', self.f.run_action('create', operation_id=slot)['status'], slot)
        resolver, receipts = self.snapshot()
        for slot in ('E2', 'E3', 'E4', 'auth-platform-secret', 'auth-config', 'auth-ingress'):
            op = resolver.resolve(slot, receipts)
            self.assertEqual(digest(op), receipts[slot]['request_digest'])
            self.assertTrue(receipts[slot]['terminal'])
            self.assertTrue(receipts[slot]['readback_verified'])
        app = self.arm.objects[self.manifest['ids']['app']]
        cfg = self.arm.objects[self.manifest['ids']['app'] + '/authConfigs/current']['properties']
        self.assertTrue(app['properties']['configuration']['ingress']['external'])
        self.assertTrue(cfg['platform']['enabled'])
        self.assertEqual('Return401', cfg['globalValidation']['unauthenticatedClientAction'])
        self.assertEqual([self.manifest['owner']['principal_id']], cfg['identityProviders']['azureActiveDirectory']['validation']['defaultAuthorizationPolicy']['allowedPrincipals']['identities'])
        self.assertTrue(self.arm.objects['/v1.0/servicePrincipals/' + op_fixture.guid(3002)]['appRoleAssignmentRequired'])
        self.assertNotIn(b'fictional-memory-only-auth-secret', (self.root / (journal_descriptor(self.config,self.verified)[0]+'.jsonl')).read_bytes())
        self.assertEqual(1, sum(m == 'POST' and p.endswith('/addPassword') for m, p in self.arm.calls))
        rows=[json.loads(row) for row in (self.root/'trial-control-budget.jsonl').read_bytes().splitlines()]
        provision=Counter(row['value']['purpose'] for row in rows if row['event']=='request' and row['value'].get('phase')=='provision' and row['value'].get('attempt')==self.verified.binding_digest)
        # Measured adapter sends: foundation 96 + main PATCH 3 + OWNER 8 +
        # runtime PATCHes 6 + remaining Graph/secret/auth 22 = 135. The 170
        # HTTP allocation therefore preserves 35 poll/error observations.
        self.assertEqual(provision['http'],(98 if self.verified.authority['schema']==10 else 132 if self.verified.authority['schema']==9 else 135)+getattr(self,'expected_provision_polls',0))
        self.assertEqual(provision['owner_token'],2 if self.verified.authority['schema'] in (9,10) else 1)
        self.assertLessEqual(provision['owner_token'],10)
        foundation={'webIdentity','workerIdentity','originals','artifacts','budget','journal','guard','job','app'}
        foundation.update('C'+str(i) for i in range(1,8));foundation.update('R'+str(i) for i in range(1,11))
        foundation.update('G'+str(i) for i in range(1,7))
        actions=[row for row in self.action_trace if row['action']=='create' and row['operation'] in foundation]
        self.assertEqual(len(actions),19 if self.verified.authority['schema']==10 else 32)
        if getattr(self,'expected_provision_polls',0):
            self.assertTrue(all(Counter(m for m,_ in row['requests'])['PUT']==1 for row in actions))
        else:self.assertTrue(all(Counter(method for method,_ in row['requests'])=={'GET':2,'PUT':1} for row in actions))
        self.assertEqual(self.parent_bytes,(self.root/'trial-provision.jsonl').read_bytes())
        self.trace.append('owner_auth_enabled')

    def cleanup_owner_auth(self):
        # Expiry prevents new work, but exact-owned cleanup still closes ingress,
        # detaches the auth reference, removes our one secret/key and OWNER role.
        self.clock.seconds = (parse('2027-01-30T00:00:00Z') - self.clock.start).total_seconds()
        previous = 'auth-ingress'
        for source in ('auth-ingress', 'auth-config', 'auth-platform-secret', 'E4', 'E3'):
            resolver, receipts = self.snapshot()
            creation = resolver.resolve(source, receipts)
            proof = {'complete': True, 'creation_request_digest': digest(creation),
                'creation_receipt_digest': digest(receipts[source]), 'object_id': receipts[source]['object_id'],
                'depends_on': [previous]}
            if source == 'auth-ingress':
                proof['latest_app_receipt'] = receipts['auth-ingress']
            elif source == 'auth-platform-secret':
                proof.update(references_cleared=True, latest_app_receipt=receipts['cleanup_auth_ingress'])
                proof['depends_on'].append('cleanup_auth_ingress')
                registration = self.arm.objects[self.manifest['ids']['app'] + '/authConfigs/current']['properties']['identityProviders']['azureActiveDirectory']['registration']
                self.assertNotIn('clientSecretSettingName', registration)
            slot = 'cleanup_' + source.replace('-', '_')
            event = {'initial_plan_digest': resolver.plan_digest,
                'deadline': creation['cleanup'].get('deadline', creation['deadline']), 'reference_evidence': proof}
            ref = self.f.write(slot + '.local.json', event)
            self.assertEqual('cleanup_bound', self.f.run_action('bind-cleanup', operation_id=slot, cleanup_evidence=ref)['status'])
            self.assertEqual('succeeded', self.f.run_action('cleanup', operation_id=slot, creation_id=source)['status'], slot)
            _, after = self.snapshot()
            self.assertTrue(after[slot]['terminal'])
            self.assertTrue(after[slot]['readback_verified'])
            # Reopening the CLI is GET-only or a terminal no-op; never resend.
            writes = sum(m != 'GET' for m, _ in self.arm.calls)
            self.assertEqual('succeeded', self.f.run_action('cleanup', operation_id=slot, creation_id=source)['status'])
            self.assertEqual(writes, sum(m != 'GET' for m, _ in self.arm.calls))
            previous = slot
        app = self.arm.objects[self.manifest['ids']['app']]
        cfg = self.arm.objects[self.manifest['ids']['app'] + '/authConfigs/current']['properties']
        self.assertFalse(app['properties']['configuration']['ingress']['external'])
        self.assertEqual([{'name': 'trial-web-database'}], app['properties']['configuration']['secrets'])
        self.assertTrue(cfg['platform']['enabled'])
        self.assertEqual([], self.arm.objects['/v1.0/applications/' + op_fixture.guid(3000)]['passwordCredentials'])
        self.assertNotIn('/v1.0/servicePrincipals/' + op_fixture.guid(3002) + '/appRoleAssignedTo/fictional-owner-assignment', self.arm.objects)
        for slot in ('originals', 'artifacts', 'budget', 'journal'):
            self.assertIn(self.manifest['ids'][slot], self.arm.objects)
        self.trace.append('owner_auth_cleanup_verified')

    def test_entrypoint_owner_auth_callback_enable_and_expired_exact_cleanup(self):
        self.publish_and_prepare();self.provision(all_permissions=True);self.rehearse();self.guardian_execute();self.bind_and_deploy()
        self.enable_owner_auth();self.cleanup_owner_auth()
        self.assertEqual(['owner_auth_enabled', 'owner_auth_cleanup_verified'], self.trace[-2:])

    def test_expired_owner_window_denies_new_secret_before_graph_write(self):
        self.publish_and_prepare();self.provision(all_permissions=True);self.rehearse();self.guardian_execute();self.bind_and_deploy()
        for slot in ('E2', 'E3'):
            self.assertEqual('succeeded', self.f.run_action('create', operation_id=slot)['status'])
        self.clock.seconds = (parse(self.config['plan_bindings']['owner_window']['end']) - self.clock.start).total_seconds() + 1
        with self.assertRaises(Denied):
            self.f.run_action('create', operation_id='E4')
        self.assertEqual(0, sum(m == 'POST' and p.endswith('/addPassword') for m, p in self.arm.calls))
        with self.journal() as journal:
            self.assertFalse(any(v['operation_id'] == 'E4' for v in journal.values('intent')))

    def test_closed_guardian_cannot_promote_changed_node_artifact_or_runtime_policy(self):
        self.publish_and_prepare();self.provision(all_permissions=True);self.rehearse();self.guardian_execute()
        bundle=self.f.write('bootstrap.local.json',{'schema':1,'execution_config':self.guard_config})
        session_path=self.root/'trial-session.jsonl';chain=session_path.read_bytes()
        lines=chain.splitlines();cut=next(i for i,line in enumerate(lines) if json.loads(line)['event']=='absence_confirmed')
        # A valid prefix of the real chain contains completed DB work but lacks
        # closure: it must not authorize resource runtime dispatch.
        self.f.write(session_path.name,b'\n'.join(lines[:cut])+b'\n')
        with self.assertRaises(Denied):self.f.run_action('bind-bootstrap',bootstrap_config=bundle)
        with self.journal() as journal:self.assertIsNone(journal.latest('trialDatabaseBootstrap'))
        self.f.write(session_path.name,chain)
        proof_path=self.root/'trial-bootstrap-proof.json'
        before=proof_path.read_bytes();changed=json.loads(before)
        changed['database']['webUser']='fictional_other_user'
        self.f.write(proof_path.name,changed)
        calls=len(self.arm.calls)
        with self.assertRaises(Denied):self.f.run_action('bind-bootstrap',bootstrap_config=bundle)
        with self.journal() as journal:self.assertIsNone(journal.latest('trialDatabaseBootstrap'))
        self.assertEqual(calls,len(self.arm.calls))
        self.f.write(proof_path.name,before)
        self.bind_and_deploy()
        # A changed but otherwise well-shaped policy cannot rebind the proven DB
        # baseline or silently update the already persisted runtime compilation.
        env={k:v for k,v in self.final_environment.items() if k!='DEPLOYMENT_KIND'}
        policy=json.loads(env['TRIAL_POLICY_JSON']);policy['cost']['databaseBaselineBytes']=2048
        env['TRIAL_POLICY_JSON']=json.dumps(policy)
        ref=self.f.write('changed-runtime.local.json',env)
        calls=len(self.arm.calls)
        with self.assertRaises(Denied):self.f.run_action('bind-runtime',runtime_environment=ref)
        self.assertEqual(calls,len(self.arm.calls))
        with self.journal() as journal:self.assertEqual(1,len(journal.values('runtime_binding')))

    def test_entrypoints_share_publication_receipts_counts_and_unknown_no_resend(self):
        self.publish_and_prepare();self.provision();self.rehearse()
        # Lost ACK is not cured by the resource now existing at its exact target.
        resolver,_=self.snapshot();op=resolver.resolve('C1',{})
        self.arm.unknown_path=op['expected']['resource_id']
        self.assertEqual('unknown',self.f.run_action('create',operation_id='C1')['status'])
        sent=len(self.arm.calls)
        with self.assertRaisesRegex(Denied,'operation_already_attempted'):
            self.f.run_action('create',operation_id='C1')
        self.assertEqual(sent,len(self.arm.calls))
        self.assertEqual(1,sum(m=='PUT' and p==self.arm.unknown_path for m,p in self.arm.calls))
        self.assertEqual(['publication_prepare','guardian_published','runtime_published','resource_prepare','registered','guardian_main_ready'],self.trace)


if __name__=='__main__':unittest.main()
