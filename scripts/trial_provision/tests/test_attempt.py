"""Fictional in-memory proofs; no real paths, credentials or Cloud."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import hashlib
import json
import unittest
from unittest.mock import patch
from scripts.trial_guard.adapters import digest,encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.attempt import (AUTH_END,CHILD_JOURNAL,DESIGN_SHA256,FORMAL_END,LIMITS,OWNER_CAPS,PARENT_COUNTS,PHASES,
    PURPOSE_CAPS,SEED,WINDOW_OFFSETS,VerifiedAttempt,check_budget_snapshot,check_phase_send,check_window,effective_slot,journal_descriptor,phase_plan,verify_attempt)

def sha(raw):return hashlib.sha256(raw).hexdigest()
def stamp(seconds=0):return (datetime(2026,10,12,1,tzinfo=timezone.utc)+timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')
def chain(rows):
    result,previous=[],'0'*64
    for event,value in rows:
        row={'sequence':len(result),'previous':previous,'event':event,'value':value};previous=digest(row);result.append(encoded({**row,'hash':previous})+b'\n')
    return b''.join(result),previous
def fixture():
    owner='00000000-0000-0000-0000-000000000002'
    registry='/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/fictional/providers/Microsoft.ContainerRegistry/registries/fictionalacr'
    manifest={'owner':{'principal_id':owner,'tenant_id':'00000000-0000-0000-0000-000000000003'},'existing':{'registry':registry},
        'registry':{'loginServer':'fictionalacr.azurecr.io'},'imageRepository':'trial/runtime','imageTag':'old-runtime',
        'cleanupImageRepository':'trial/guardian','cleanupImageTag':'old-guardian'}
    head,old_head='a'*40,'b'*40;manifest_raw=encoded(manifest);mh=sha(manifest_raw)
    binding={'manifest_sha256':mh,'owner_id':owner,'task_id':'fictional-task'};hashes={'guardian':'sha256:'+'c'*64,'runtime':'sha256:'+'d'*64}
    slots={key:{'repository':manifest[repo],'tag':manifest[tag],'local_image_id':'sha256:'+'e'*64} for key,repo,tag in
        (('guardian','cleanupImageRepository','cleanupImageTag'),('runtime','imageRepository','imageTag'))}
    prep={'schema':1,'manifest_sha256':mh,'code_sha':old_head,'run_binding_digest':digest(binding),'registry_id':registry,
        'login_server':manifest['registry']['loginServer'],'slots':slots,'publish_until':'2026-10-11T11:57:25Z'}
    rows=[('binding',binding),('publication_preparation',prep)];observed='2026-10-11T11:40:00Z'
    for slot in ('guardian','runtime'):
        ident=slot+'ImagePush';rd=digest({'fictional':ident});prefix='https://'+prep['login_server']+'/v2/'+slots[slot]['repository']+'/manifests/'
        intent={'operation_id':ident,'request_digest':rd,'method':'PUT','url':prefix+slots[slot]['tag']+'?api-version=2021-07-01','at':observed,'deadline':prep['publish_until']}
        namespace={'publication_preparation_digest':digest(prep),'run_binding_digest':digest(binding),'push_request_digest':rd,'authenticated':True,
            'http':404,'error_code':'NAME_UNKNOWN','method':'GET','push_operation_id':ident,'registry_id':registry,'login_server':prep['login_server'],
            'repository':slots[slot]['repository'],'url':'https://'+prep['login_server']+'/acr/v1/'+slots[slot]['repository']+'?api-version=2021-07-01',
            'response_sha256':'e'*64,'observed_at':observed}
        receipt={'operation_id':ident,'request_digest':rd,'object_id':prefix+hashes[slot]+'?api-version=2021-07-01','state':'succeeded','terminal':True,
            'write_terminal':True,'created_by_run':True,'readback_verified':True,'ack_kind':'docker_exit0_digest','observed_at':observed,
            'properties':{'registry_id':registry,'login_server':prep['login_server'],'repository':slots[slot]['repository'],'manifest_digest':hashes[slot],'purpose':slot}}
        rows.extend([(slot+'_image_namespace',namespace),('intent',intent),('progress',receipt)])
    rd=digest({'fictional':'cleanup'});url='https://'+prep['login_server']+'/v2/'+slots['guardian']['repository']+'/manifests/'+hashes['guardian']+'?api-version=2021-07-01'
    rows.extend([('intent',{'operation_id':'guardianImageCleanup','request_digest':rd,'method':'DELETE','url':url}),
        ('progress',{'operation_id':'guardianImageCleanup','request_digest':rd,'object_id':url,'state':'succeeded','terminal':True,'write_terminal':True,
            'readback_verified':True,'created_by_run':True,'delete_acknowledged':True,'delete_status':202,'http':404,'ack_digest':digest({'request_digest':rd,'http':202})})])
    parent_raw,last=chain(rows)
    final={'schema':1,'status':'STOPPED_AT_FIXED_DEADLINE_CLEANUP_VERIFIED','head':old_head,'dedicatedCloudResourcesAbsent':9,'guardianManifestDeleted':True,
        'guardianManifestAuthenticatedAbsenceVerified':True,'runtimeManifestRetainedByOriginalPlan':True,'fixedDbRuleAbsent':True,'deleteAcknowledgementObserved':True,
        'temporaryDockerCredentialsAbsent':True,'counters':deepcopy(PARENT_COUNTS),'counterLimits':deepcopy(LIMITS),'initialReservationYen':5000,
        'formalReservationYen':10000,'globalCapYen':53331,'unsettledReservationYenPreserved':11527,'recordedAt':'2026-10-11T12:27:00Z'}
    control_binding={**binding,'source_sha256':'f'*64};directory='/fictional-owner-recovery';code={'scripts/trial_provision/attempt.py':'f'*64}
    caps={k:{phase:0 for phase in PHASES} for k in LIMITS};caps['owner_arm']=deepcopy(OWNER_CAPS);caps['owner_control_blob'].update(run=2800,cleanup=168);caps['heartbeat_blob']['run']=5250
    reserve={'owner_arm':23,'owner_control_blob':0,'heartbeat_blob':0};tags={slot:slots[slot]['tag']+'-'+head[:12] for slot in slots}
    artifacts={'local_ready':encoded({'head':head,'design_sha256':DESIGN_SHA256,'code_sources_sha256':digest(code)}),
        'limits':encoded({'schema':1,'head':head,'counts_before':PARENT_COUNTS,'phase_caps':caps,'unallocated':reserve,'purpose_caps':PURPOSE_CAPS})}
    publication={'publish_until':stamp(1800),'slots':{}}
    for slot in ('guardian','runtime'):
        proof={'schema':1,'slot':slot,'manifest_sha256':mh,'source_head':head,'managed_build_sha':head,'method':'docker-build','attempt':1,'exit_code':0,
            'readback_verified':True,'image_ref':prep['login_server']+'/'+slots[slot]['repository']+':'+tags[slot],'image_id':'sha256:'+'e'*64,
            'request_digest':'f'*64,'docker_sha256':'e'*64,'docker_host':'npipe:////./pipe/docker_engine'}
        artifacts[slot+'_build']=encoded(proof);publication['slots'][slot]={'local_image_id':proof['image_id'],'docker_sha256':proof['docker_sha256'],'docker_host':proof['docker_host'],
            'build_receipt':{'path':'/fictional/'+slot+'.json','sha256':sha(artifacts[slot+'_build'])}}
    authority={'schema':1,'approval':'ISSUE148_LINKED_ATTEMPT_V1','decision':'APPROVED','design_sha256':DESIGN_SHA256,'attempt_id':'fictional-next','manifest_sha256':mh,
        'owner_id':owner,'task_id':binding['task_id'],'head':head,'code_sources_sha256':digest(code),'budget_binding_sha256':digest(control_binding),
        'parent':{'journal_sha256':sha(parent_raw),'chain_sha256':last,'final_sha256':sha(encoded(final))},'tags':tags,
        'retained_runtime':{'tag':manifest['imageTag'],'digest':hashes['runtime']},'guardian_prior_digest':hashes['guardian'],
        'artifact_sha256':{k:sha(v) for k,v in artifacts.items()},'publish_from':stamp(),'approved_at':stamp(-600),
        'counts_before':deepcopy(PARENT_COUNTS),'phase_caps':caps,'unallocated':reserve,'initial_forecast_yen':4330,
        'catalog_options':{'temporary_owner_set':False,'excluded_databases':[{'name':'template0','template':True,'allowConnect':False}]}}
    activation={'schema':1,'attempt_id':authority['attempt_id'],'authority_sha256':sha(encoded(authority)),'issued_at':stamp(-300),
        'windows':{k:{'start':stamp(start),'end':stamp(end)} for k,(start,end) in WINDOW_OFFSETS.items()}}
    config={'frozen_head':head,'sources':{'manifest':{'sha256':mh}},'authority_bundle':{'manifest':manifest_raw},'code_sources':code,
        'recovery':{'directory':directory,'directory_digest':digest(directory)},'control_budget':{'directory':directory,'directory_digest':digest(directory),
        'binding':control_binding,'seed':deepcopy(SEED)},'publication':publication,'attempt':{'path':'/fictional/next-activation.json','sha256':sha(encoded(activation))}}
    return {'config':config,'manifest':manifest,'authority':authority,'activation':activation,'parent_rows':rows,'parent_final':final,'artifacts':artifacts}
def verify(data,*,reseal=True,**overrides):
    d=deepcopy(data);parent_raw,last=chain(d['parent_rows'])
    if reseal:
        d['authority']['parent']={'journal_sha256':sha(parent_raw),'chain_sha256':last,'final_sha256':sha(encoded(d['parent_final']))}
        d['authority']['artifact_sha256']={k:sha(v) for k,v in d['artifacts'].items()};d['activation']['authority_sha256']=sha(encoded(d['authority']));d['config']['attempt']['sha256']=sha(encoded(d['activation']))
    args={'authority_raw':encoded(d['authority']),'activation_raw':encoded(d['activation']),'parent_journal_raw':parent_raw,'parent_final_raw':encoded(d['parent_final']),
        'artifacts':d['artifacts'],'trusted_authority_sha256':sha(encoded(d['authority'])),'now':stamp(-300)};args.update(overrides)
    return verify_attempt(d['config'],d['manifest'],**args)

class AttemptTests(unittest.TestCase):
    def setUp(self):self.d=fixture()
    def test_valid_parent_proof_does_not_modify_inputs(self):
        before=deepcopy(self.d);value=verify(self.d);self.assertEqual(self.d,before);self.assertEqual(value.authority['head'],'a'*40)
        self.assertEqual(phase_plan(value)['purpose_caps'],PURPOSE_CAPS);self.assertEqual(phase_plan(value)['budget_binding_sha256'],digest(self.d['config']['control_budget']['binding']))
    def test_no_external_io_or_boolean_authority(self):
        with patch('builtins.open',side_effect=AssertionError('file I/O')),patch('subprocess.run',side_effect=AssertionError('process')),patch('socket.create_connection',side_effect=AssertionError('network')):verify(self.d)
        for fake in ({},{'verified':True},True):
            with self.subTest(fake=fake),self.assertRaises(Denied):phase_plan(fake)
        with self.assertRaises(Denied):VerifiedAttempt({'approved':True})
    def test_trusted_hash_is_independent_of_changed_json(self):
        trusted=sha(encoded(self.d['authority']));self.d['authority']['initial_forecast_yen']=4331
        with self.assertRaises(Denied):verify(self.d,trusted_authority_sha256=trusted)
    def test_catalog_options_are_explicit_and_covered_by_authority_hash(self):
        trusted=sha(encoded(self.d['authority']))
        self.d['authority']['catalog_options']['temporary_owner_set']=True
        with self.assertRaises(Denied):verify(self.d,trusted_authority_sha256=trusted)
        self.assertTrue(verify(self.d).authority['catalog_options']['temporary_owner_set'])
        for options in ({}, {'temporary_owner_set':1,'excluded_databases':[]},
            {'temporary_owner_set':False,'excluded_databases':[{'name':'postgres','template':False,'allowConnect':False}]},
            {'temporary_owner_set':False,'excluded_databases':[{'name':'template1','template':True,'allowConnect':True}]},
            {'temporary_owner_set':False,'excluded_databases':[{'name':'template0','template':True,'allowConnect':False}]*2}):
            d=deepcopy(self.d);d['authority']['catalog_options']=options
            with self.subTest(options=options),self.assertRaises(Denied):verify(d)
    def test_unknown_field_and_duplicate_json_rejected(self):
        self.d['authority']['auto_approve']=True
        with self.assertRaises(Denied):verify(self.d)
        self.d=fixture();raw=b'{"schema":1,'+encoded(self.d['authority'])[1:]
        with self.assertRaises(Denied):verify(self.d,authority_raw=raw,trusted_authority_sha256=sha(raw))
    def test_partial_or_broken_parent_chain_rejected(self):
        raw,_=chain(self.d['parent_rows'])
        for changed in (raw[:-1],raw.replace(b'"sequence":1',b'"sequence":9',1)):
            with self.subTest(changed=changed[-20:]),self.assertRaises(Denied):verify(self.d,parent_journal_raw=changed)
    def test_parent_ack_and_authenticated_namespace_required(self):
        for event,field,replacement in (('guardian_image_namespace','authenticated',False),('runtime_image_namespace','error_code','UNKNOWN')):
            d=deepcopy(self.d);next(v for e,v in d['parent_rows'] if e==event)[field]=replacement
            with self.subTest(field=field),self.assertRaises(Denied):verify(d)
        d=deepcopy(self.d);next(v for e,v in d['parent_rows'] if e=='progress' and v['operation_id']=='guardianImagePush')['ack_kind']='get_only'
        with self.assertRaises(Denied):verify(d)
    def test_parent_cleanup_ack_and_old_runtime_retention_required(self):
        for field,value in (('delete_acknowledged',False),('ack_digest','0'*64),('http',200)):
            d=deepcopy(self.d);d['parent_rows'][-1][1][field]=value
            with self.subTest(field=field),self.assertRaises(Denied):verify(d)
        self.d['parent_final']['runtimeManifestRetainedByOriginalPlan']=False
        with self.assertRaises(Denied):verify(self.d)
    def test_same_seed_binding_owner_and_source_pins(self):
        for mutate in (lambda d:d['config']['control_budget']['seed'].update(owner_arm=187),lambda d:d['config']['control_budget']['binding'].update(task_id='other'),
            lambda d:d['config']['code_sources'].update({'scripts/new.py':'f'*64}),lambda d:d['authority'].update(owner_id='another-owner')):
            d=deepcopy(self.d);mutate(d)
            with self.assertRaises(Denied):verify(d)
    def test_artifact_hash_build_source_and_tag_checked(self):
        with self.assertRaises(Denied):verify(self.d,artifacts={**self.d['artifacts'],'local_ready':b'{}'})
        for field,value in (('source_head','b'*40),('readback_verified',False),('image_ref','other/tag')):
            d=deepcopy(self.d);build=json.loads(d['artifacts']['guardian_build']);build[field]=value;d['artifacts']['guardian_build']=encoded(build)
            with self.subTest(field=field),self.assertRaises(Denied):verify(d)
    def test_new_tags_and_retained_digest_are_fixed(self):
        for mutate in (lambda d:d['authority']['tags'].update(runtime='old-runtime'),lambda d:d['authority']['retained_runtime'].update(digest='sha256:'+'0'*64),
            lambda d:d['authority'].update(guardian_prior_digest='sha256:'+'0'*64)):
            d=deepcopy(self.d);mutate(d)
            with self.assertRaises(Denied):verify(d)
    def test_lead_time_and_windows_cannot_roll(self):
        for mutate in (lambda d:d['activation'].update(issued_at=stamp(-299)),lambda d:d['activation']['windows']['owner_input'].update(end=stamp(8401)),
            lambda d:d['config']['publication'].update(publish_until=stamp(1801))):
            d=deepcopy(self.d);mutate(d)
            with self.assertRaises(Denied):verify(d,now=stamp())
    def test_reserved_capacity_and_snapshot(self):
        v=verify(self.d);check_budget_snapshot(v,PARENT_COUNTS,initializing=True)
        check_phase_send(v,'owner_arm','provision',{**PARENT_COUNTS,'owner_arm':456},179);check_phase_send(v,'owner_arm','cleanup',{**PARENT_COUNTS,'owner_arm':576},119)
        for kind,phase,count,used in (('owner_arm','provision',457,0),('owner_arm','provision',200,180),('owner_arm','cleanup',577,0)):
            with self.subTest(phase=phase,count=count),self.assertRaises(Denied):check_phase_send(v,kind,phase,{**PARENT_COUNTS,kind:count},used)
        with self.assertRaises(Denied):check_budget_snapshot(v,{**PARENT_COUNTS,'owner_arm':186})
        with self.assertRaises(Denied):check_budget_snapshot(v,{**PARENT_COUNTS,'owner_arm':188},initializing=True)
    def test_cost_and_overallocation_rejected(self):
        for mutate in (lambda d:d['authority'].update(initial_forecast_yen=4501),lambda d:d['authority']['phase_caps']['owner_arm'].update(provision=181),lambda d:d['authority']['unallocated'].update(owner_arm=22)):
            d=deepcopy(self.d);mutate(d)
            with self.assertRaises(Denied):verify(d)
    def test_legacy_and_child_descriptors_are_distinct(self):
        v=verify(self.d);name,binding=journal_descriptor(self.d['config'],v);self.assertEqual(name,CHILD_JOURNAL);self.assertEqual(binding['attempt']['binding_digest'],v.binding_digest)
        self.assertEqual(binding['attempt']['parent'],self.d['authority']['parent']);legacy=deepcopy(self.d['config']);del legacy['attempt'];self.assertEqual(journal_descriptor(legacy)[0],'trial-provision')
        with self.assertRaises(Denied):journal_descriptor(self.d['config'])
        with self.assertRaises(Denied):journal_descriptor(legacy,v)
    def test_effective_slot_binds_manifest_and_preserves_old_tags(self):
        v=verify(self.d);m=self.d['manifest'];self.assertEqual(effective_slot(m,'a'*40,'runtime')['tag'],'old-runtime')
        self.assertEqual(effective_slot(m,'a'*40,'runtime',v)['tag'],'old-runtime-'+'a'*12);changed=deepcopy(m);changed['imageRepository']='other/repository'
        with self.assertRaises(Denied):effective_slot(changed,'a'*40,'runtime',v)
        self.assertEqual(m['imageTag'],'old-runtime')
    def test_proof_is_immutable_and_copies_are_detached(self):
        v=verify(self.d);before=v.binding_digest;a=v.authority;a['tags']['runtime']='changed';plan=phase_plan(v);plan['purpose_caps']['provision']['http']=1000
        self.assertEqual(v.binding_digest,before);self.assertEqual(phase_plan(v)['purpose_caps'],PURPOSE_CAPS)
        with self.assertRaises(Denied):v._raw=b'{}'
    def test_cached_projections_preserve_seal_and_canonical_proof(self):
        from scripts.trial_provision.attempt import _proof
        v=verify(self.d);proof=_proof(v)
        self.assertEqual(v.binding_digest,digest(proof));self.assertEqual(v.binding_digest,sha(v._raw))
        self.assertEqual(v.authority,proof['authority']);self.assertEqual(v.activation,proof['activation'])
        changed=v.activation;changed['windows']['initial']['end']='changed'
        self.assertEqual(v.activation,proof['activation'])
        for slot in VerifiedAttempt.__slots__:
            with self.assertRaises(Denied):setattr(v,slot,None)
        class Subclass(VerifiedAttempt):pass
        for cls in (VerifiedAttempt,Subclass):
            fake=object.__new__(cls)
            for slot in VerifiedAttempt.__slots__:
                if slot!='_seal':object.__setattr__(fake,slot,getattr(v,slot))
            for field in ('authority','activation','binding_digest'):
                with self.assertRaises(Denied):getattr(fake,field)
    def test_window_send_includes_wait_and_exact_end(self):
        v=verify(self.d);check_window(v,'publication',stamp(),1799)
        for at,duration in ((stamp(-1),0),(stamp(),1800),(stamp(1800),0),(stamp(),float('nan'))):
            with self.subTest(at=at,duration=duration),self.assertRaises(Denied):check_window(v,'publication',at,duration)
        expired=verify(self.d,now=stamp(40000))
        with self.assertRaises(Denied):check_window(expired,'guardian',stamp(40000))
    def test_provision_uses_same_authority_without_new_budget(self):
        d=deepcopy(self.d);w=d['activation']['windows'];del d['config']['publication']
        d['config'].update(plan_bindings={'guardian_window':w['guardian'],'owner_window':w['owner_input']},runtime_deadline=FORMAL_END,auth_deadline=AUTH_END,
            cleanup_deadlines={'guardian':w['guardian']['end'],'owner_input':w['owner_input']['end'],'runtime':FORMAL_END,'auth':AUTH_END},
            resource_bindings={'code_sha':'a'*40,'guardian_deadline':w['guardian']['end']})
        self.assertEqual(verify(d).binding_digest,verify(self.d).binding_digest)

if __name__=='__main__':unittest.main()
