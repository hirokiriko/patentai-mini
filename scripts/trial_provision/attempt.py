"""Pure linked-attempt validation; no file, credential or network I/O.

The private launcher supplies the exact authority bytes and trusted hash
independently of command JSON. This module never issues an approval/window.
"""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import hashlib
import json
import math
from pathlib import PurePosixPath,PureWindowsPath
import re
from scripts.trial_guard.adapters import digest,encoded
from scripts.trial_guard.lifecycle import Denied
from .restart_budget import V7_RUN_HTTP_CAP, V7_RUN_TOKEN_ALLOWANCE

DESIGN_SHA256='731c6b63ced5ea8e66c6f87f91fde106972537ac5761359b7f716c3f251b290d'
CHILD_JOURNAL='trial-provision-next'
LIMITS={'owner_arm':600,'owner_control_blob':3000,'heartbeat_blob':5250}
SEED={'owner_arm':128,'owner_control_blob':32,'heartbeat_blob':0}
PARENT_COUNTS={'owner_arm':187,'owner_control_blob':32,'heartbeat_blob':0}
PHASES=('fresh_read','publication','provision','run','cleanup')
OWNER_CAPS=dict(zip(PHASES,(24,24,180,42,120)))
PURPOSE_CAPS={'provision':{'http':170,'owner_token':10}}
REUSED_IMAGE_PURPOSE_CAPS={**PURPOSE_CAPS,'publication':{'http':6,'owner_token':2},'run':{'http':24,'owner_token':8}}
OBSERVED_IDENTITY_PURPOSE_CAPS={'fresh_read':{'http':21,'owner_token':3},
    'publication':{'http':6,'owner_token':0},'provision':{'http':139,'owner_token':4},
    'run':{'http':V7_RUN_HTTP_CAP,'owner_token':V7_RUN_TOKEN_ALLOWANCE}}
WINDOW_OFFSETS={'publication':(0,1800),'guardian':(2100,30900),'owner_input':(4800,8400),'initial':(5700,7500)}
REUSED_IMAGE_WINDOW_OFFSETS={'publication':(0,600),'guardian':(600,29400),'owner_input':(3300,6900),'initial':(4200,6000)}
FORMAL_END='2026-10-31T00:00:00Z'
AUTH_END='2027-01-29T00:00:00Z'
ARTIFACTS=('local_ready','guardian_build','runtime_build','limits')
_MAX_JSON=4*1024*1024
_SEAL=object()

def _need(ok,code):
    if not ok:raise Denied(code)

def window_offsets(authority):
    """V6 reuses acknowledged images; earlier fixed publication windows remain."""
    _need(type(authority) is dict and type(authority.get('schema')) is int
          and authority['schema'] in (1,2,3,4,5,6,7),'attempt_window_schema')
    return deepcopy(REUSED_IMAGE_WINDOW_OFFSETS if authority['schema'] in (6,7) else WINDOW_OFFSETS)
def _keys(value,expected):_need(isinstance(value,dict) and set(value)==set(expected),'attempt_fields')
def _hex(value,length=64):
    _need(isinstance(value,str) and re.fullmatch('[a-f0-9]{'+str(length)+'}',value),'attempt_digest');return value
def _sha(raw):
    _need(type(raw) is bytes,'attempt_bytes');return hashlib.sha256(raw).hexdigest()
def _json(raw,maximum=_MAX_JSON):
    _need(type(raw) is bytes and 0<len(raw)<=maximum,'attempt_bytes')
    def pairs(items):
        result={}
        for k,v in items:_need(k not in result,'attempt_duplicate_key');result[k]=v
        return result
    def invalid(_):raise Denied('attempt_json')
    try:value=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=invalid)
    except (ValueError,UnicodeError,RecursionError):raise Denied('attempt_json') from None
    _need(isinstance(value,dict),'attempt_json');return value
def _time(value):
    try:
        result=value if isinstance(value,datetime) else datetime.fromisoformat(value.replace('Z','+00:00'))
        _need(result.tzinfo is not None and result.utcoffset()==timedelta(0),'attempt_time');return result.astimezone(timezone.utc)
    except (ValueError,TypeError,AttributeError,OverflowError):raise Denied('attempt_time') from None
def _stamp(value):
    result=_time(value);_need(result.microsecond==0,'attempt_whole_second');return result.isoformat().replace('+00:00','Z')
def _ref(value):
    _keys(value,('path','sha256'));path=value['path']
    _need(isinstance(path,str) and 0<len(path)<=4096 and (PureWindowsPath(path).is_absolute() or PurePosixPath(path).is_absolute())
        and '..' not in PureWindowsPath(path).parts and not any(ord(c)<32 for c in path),'attempt_reference');_hex(value['sha256'])
def _authority_limits(authority):
    # Historical authorities and the lifetime journal header remain at 600.
    # V4 adds these 31 requests; V5 can only inherit the identical approval.
    limits=deepcopy(LIMITS)
    if authority.get('schema') in (4,5,6,7):
        amendment=authority['limit_amendment']
        _keys(amendment,('schema','kind','previous','current','delta','approval_sha256'))
        _need(all(type(amendment[k]) is int for k in ('schema','previous','current','delta'))
            and {k:amendment[k] for k in ('schema','kind','previous','current','delta')}==
            {'schema':1,'kind':'owner_arm','previous':600,'current':631,'delta':31},'attempt_limit_amendment')
        _hex(amendment['approval_sha256']);limits['owner_arm']=631
    return limits

def origin_manifest_hash(authority):
    return _hex(authority['origin_manifest_sha256']) if authority['schema']==7 else authority['manifest_sha256']

def effective_limits(verified):return _authority_limits(_proof(verified)['authority'])

def purpose_caps(authority):
    if authority['schema']==7:return deepcopy(OBSERVED_IDENTITY_PURPOSE_CAPS)
    return deepcopy(REUSED_IMAGE_PURPOSE_CAPS if authority['schema']==6 else PURPOSE_CAPS)

def _counts(value,limits=LIMITS):
    _keys(value,limits);_need(all(type(value[k]) is int and 0<=value[k]<=limits[k] for k in limits),'attempt_counts')
def _allocations(authority):
    before,caps,reserve=(authority[k] for k in ('counts_before','phase_caps','unallocated'))
    limits=_authority_limits(authority)
    _counts(before,limits);_keys(caps,limits);_keys(reserve,limits)
    for kind in limits:
        _keys(caps[kind],PHASES)
        _need(all(type(v) is int and v>=0 for v in caps[kind].values()) and type(reserve[kind]) is int and reserve[kind]>=0
            and sum(caps[kind].values())+reserve[kind]<=limits[kind]-before[kind],'attempt_allocation')
    published=authority.get('schema') in (3,4,5,6,7)
    _need(all(caps['owner_arm'][phase]<=maximum for phase,maximum in OWNER_CAPS.items())
        and caps['owner_arm']['cleanup']>=120 and (reserve['owner_arm']==0 if published else reserve['owner_arm']>=23),'attempt_cleanup_reservation')
def _slot(manifest,head,slot):
    _need(slot in ('guardian','runtime'),'attempt_slot')
    repo_key,tag_key=('cleanupImageRepository','cleanupImageTag') if slot=='guardian' else ('imageRepository','imageTag')
    repo,old=manifest[repo_key],manifest[tag_key]
    _need(isinstance(repo,str) and re.fullmatch(r'[a-z0-9]+(?:[._/-][a-z0-9]+)*',repo) and isinstance(old,str)
        and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',old),'attempt_image_slot')
    tag=old+'-'+_hex(head,40)[:12];_need(len(tag)<=128,'attempt_image_tag');return {'repository':repo,'tag':tag}
def _journal(raw,expected_binding):
    _need(type(raw) is bytes and 0<len(raw)<=16*1024*1024 and raw.endswith(b'\n'),'attempt_parent_journal')
    lines=raw.splitlines();_need(0<len(lines)<=15000,'attempt_parent_journal');records,previous=[],'0'*64
    for line in lines:
        row=_json(line);_keys(row,('sequence','previous','event','value','hash'));proof=row.pop('hash')
        _need(type(row['sequence']) is int and row['sequence']==len(records) and row['previous']==previous and digest(row)==proof
            and isinstance(row['event'],str) and re.fullmatch('[a-z_]{1,40}',row['event']) and isinstance(row['value'],dict),'attempt_parent_chain')
        records.append(row);previous=proof
    _need(records[0]['event']=='binding' and records[0]['value']==expected_binding,'attempt_parent_binding');return records,previous
class _ParentView:
    def __init__(self,records):self._records=records
    def values(self,event):return [deepcopy(row['value']) for row in self._records if row['event']==event]
    def latest(self,ident):
        rows=[v for v in self.values('progress') if v.get('operation_id')==ident];return rows[-1] if rows else None
def _parent_proof(records,manifest,authority,final):
    from .registry_publish import verified_publication_images
    view=_ParentView(records);images=verified_publication_images(view);preparations=view.values('publication_preparation')
    _need(len(preparations)==1,'attempt_parent_publication');prep=preparations[0]
    _need(prep['manifest_sha256']==authority['manifest_sha256'] and prep['run_binding_digest']==digest(records[0]['value'])
        and prep['registry_id']==manifest['existing']['registry'] and prep['login_server']==manifest['registry']['loginServer'],'attempt_parent_publication')
    host=manifest['registry']['loginServer']
    for slot,tag_key in (('guardian','cleanupImageTag'),('runtime','imageTag')):
        fixed=prep['slots'][slot];_need(fixed['tag']==manifest[tag_key]
            and fixed['repository']==_slot(manifest,authority['head'],slot)['repository'],'attempt_parent_publication')
    retained=authority['retained_runtime'];_keys(retained,('tag','digest'))
    _need(retained['tag']==manifest['imageTag'] and images['runtime_image']==host+'/'+manifest['imageRepository']+'@'+retained['digest']
        and images['guardian_image']==host+'/'+manifest['cleanupImageRepository']+'@'+authority['guardian_prior_digest'],'attempt_parent_image')
    cleanup=view.latest('guardianImageCleanup')
    _need(isinstance(cleanup,dict) and cleanup.get('state')=='succeeded' and all(cleanup.get(k) is True for k in
        ('terminal','write_terminal','readback_verified','created_by_run','delete_acknowledged')) and cleanup.get('delete_status')==202 and cleanup.get('http')==404
        and cleanup.get('object_id')=='https://'+host+'/v2/'+manifest['cleanupImageRepository']+'/manifests/'+authority['guardian_prior_digest']+'?api-version=2021-07-01','attempt_parent_cleanup')
    intents=[v for v in view.values('intent') if v.get('operation_id')=='guardianImageCleanup']
    _need(len(intents)==1 and intents[0]['method']=='DELETE' and intents[0]['url']==cleanup['object_id']
        and intents[0]['request_digest']==cleanup['request_digest'] and cleanup.get('ack_digest')==digest({'request_digest':cleanup['request_digest'],'http':202}),'attempt_parent_cleanup')
    _need(final.get('schema')==1 and final.get('status')=='STOPPED_AT_FIXED_DEADLINE_CLEANUP_VERIFIED' and final.get('head')==prep['code_sha']
        and final.get('dedicatedCloudResourcesAbsent')==9 and all(final.get(k) is True for k in ('guardianManifestDeleted',
        'guardianManifestAuthenticatedAbsenceVerified','runtimeManifestRetainedByOriginalPlan','fixedDbRuleAbsent','deleteAcknowledgementObserved','temporaryDockerCredentialsAbsent'))
        and final.get('counters')==PARENT_COUNTS and final.get('counterLimits')==LIMITS and final.get('initialReservationYen')==5000
        and final.get('formalReservationYen')==10000 and final.get('globalCapYen')==53331 and final.get('unsettledReservationYenPreserved')==11527,'attempt_parent_final')
    _need(_time(final['recordedAt'])<=_time(authority['approved_at']),'attempt_parent_final_time')
class VerifiedAttempt:
    __slots__=('_raw','_seal')
    def __init__(self,value,seal=None):
        _need(seal is _SEAL,'attempt_verifier_required');object.__setattr__(self,'_raw',encoded(value));object.__setattr__(self,'_seal',_SEAL)
    def __setattr__(self,*_):raise Denied('attempt_immutable')
    @property
    def authority(self):return _proof(self)['authority']
    @property
    def activation(self):return _proof(self)['activation']
    @property
    def binding_digest(self):return digest(_proof(self))
def _proof(value):
    _need(type(value) is VerifiedAttempt and value._seal is _SEAL,'attempt_verifier_required');return _json(value._raw)

def verify_attempt(config,manifest,*,authority_raw,activation_raw,parent_journal_raw,parent_final_raw,artifacts,trusted_authority_sha256,now):
    try:return _verify(config,manifest,authority_raw,activation_raw,parent_journal_raw,parent_final_raw,artifacts,trusted_authority_sha256,now)
    except (KeyError,TypeError,ValueError,AttributeError,IndexError,OverflowError):raise Denied('attempt_binding') from None
def _verify(config,manifest,authority_raw,activation_raw,parent_journal_raw,parent_final_raw,artifacts,trusted_hash,now):
    _need(_sha(authority_raw)==_hex(trusted_hash),'attempt_trusted_authority');a,activation=_json(authority_raw),_json(activation_raw)
    successor=type(a.get('schema')) is int and a['schema'] in (2,3,4,5,6,7)
    fields=('schema','approval','decision','design_sha256','attempt_id','manifest_sha256','owner_id','task_id','head','code_sources_sha256',
        'budget_binding_sha256','parent','tags','retained_runtime','guardian_prior_digest','artifact_sha256','publish_from','approved_at',
        'counts_before','phase_caps','unallocated','initial_forecast_yen','catalog_options')
    _keys(a,fields+(('succession',) if successor else ())+(('limit_amendment',) if a.get('schema') in (4,5,6,7) else ())
        +(('image_build_head',) if a.get('schema') in (6,7) else ())
        +(('origin_manifest_sha256','identity_disposition') if a.get('schema')==7 else ()))
    _need(type(a['schema']) is int and a['schema'] in (1,2,3,4,5,6,7)
        and a['approval']=='ISSUE148_LINKED_ATTEMPT_V'+str(a['schema']) and a['decision']=='APPROVED'
        and a['design_sha256']==DESIGN_SHA256 and isinstance(a['attempt_id'],str) and re.fullmatch('[A-Za-z0-9_-]{1,128}',a['attempt_id']),'attempt_authority')
    _need(type(a['initial_forecast_yen']) is int and 0<a['initial_forecast_yen']<=4500,'attempt_cost')
    options=a['catalog_options'];_keys(options,('temporary_owner_set','excluded_databases'))
    _need(type(options['temporary_owner_set']) is bool and isinstance(options['excluded_databases'],list) and len(options['excluded_databases'])<=16,'attempt_catalog_options')
    names=set()
    for row in options['excluded_databases']:
        _keys(row,('name','template','allowConnect'))
        _need(isinstance(row['name'],str) and 0<len(row['name'].encode('utf-8'))<=63 and not re.search('[\x00-\x1f\x7f]',row['name'])
            and row['name'] not in names and row['name']!='postgres' and type(row['template']) is bool and row['allowConnect'] is False,'attempt_catalog_options')
        names.add(row['name'])
    _ref(config['attempt']);_need(config['attempt']['sha256']==_sha(activation_raw),'attempt_activation_ref')
    _need(config['frozen_head']==_hex(a['head'],40) and config['sources']['manifest']['sha256']==_hex(a['manifest_sha256'])
        and a['owner_id']==manifest['owner']['principal_id'] and _hex(a['code_sources_sha256'])==digest(config['code_sources']) and bool(config['code_sources']),'attempt_config')
    manifest_raw=config['authority_bundle']['manifest'];_need(_sha(manifest_raw)==a['manifest_sha256'] and _json(manifest_raw)==manifest,'attempt_manifest')
    b=config['control_budget'];_keys(b,('directory','directory_digest','binding','seed'));_keys(b['binding'],('manifest_sha256','owner_id','task_id','source_sha256'))
    _need(b['seed']==SEED and all(type(v) is int for v in b['seed'].values()) and b['binding']['manifest_sha256']==origin_manifest_hash(a)
        and b['binding']['owner_id']==a['owner_id'] and b['binding']['task_id']==a['task_id'] and digest(b['binding'])==_hex(a['budget_binding_sha256'])
        and b['directory']==config['recovery']['directory'] and b['directory_digest']==config['recovery']['directory_digest']==digest(b['directory']),'attempt_budget_binding')
    _hex(b['binding']['source_sha256']);_keys(a['parent'],('journal_sha256','chain_sha256','final_sha256'))
    _need(_sha(parent_journal_raw)==_hex(a['parent']['journal_sha256']) and _sha(parent_final_raw)==_hex(a['parent']['final_sha256']),'attempt_parent_hash')
    parent_binding={'manifest_sha256':origin_manifest_hash(a),'owner_id':a['owner_id'],'task_id':a['task_id']}
    records,chain=_journal(parent_journal_raw,parent_binding);_need(chain==_hex(a['parent']['chain_sha256']),'attempt_parent_chain');final=_json(parent_final_raw)
    _need(isinstance(a['guardian_prior_digest'],str) and re.fullmatch('sha256:[a-f0-9]{64}',a['guardian_prior_digest']) and isinstance(a['retained_runtime'],dict)
        and isinstance(a['retained_runtime'].get('digest'),str) and re.fullmatch('sha256:[a-f0-9]{64}',a['retained_runtime']['digest']),'attempt_parent_image')
    _parent_proof(records,manifest,{**a,'manifest_sha256':origin_manifest_hash(a)},final);_keys(a['tags'],('guardian','runtime'))
    image_head=_hex(a['image_build_head'],40) if a['schema'] in (6,7) else a['head']
    for slot in ('guardian','runtime'):_need(a['tags'][slot]==_slot(manifest,image_head,slot)['tag'],'attempt_new_tag')
    _keys(a['artifact_sha256'],ARTIFACTS);_keys(artifacts,ARTIFACTS);parsed={}
    for slot in ARTIFACTS:
        _need(_sha(artifacts[slot])==_hex(a['artifact_sha256'][slot]),'attempt_artifact_hash');parsed[slot]=_json(artifacts[slot])
    _need(parsed['local_ready'].get('head')==a['head'] and parsed['local_ready'].get('design_sha256')==DESIGN_SHA256
        and parsed['local_ready'].get('code_sources_sha256')==a['code_sources_sha256'],'attempt_local_ready')
    for slot in ('guardian','runtime'):
        proof=parsed[slot+'_build'];expected=_slot(manifest,image_head,slot)
        _need(proof.get('source_head')==proof.get('managed_build_sha')==image_head and proof.get('manifest_sha256')==origin_manifest_hash(a)
            and proof.get('slot')==slot and proof.get('method')=='docker-build' and type(proof.get('attempt')) is int and proof['attempt']==1
            and type(proof.get('exit_code')) is int and proof['exit_code']==0 and proof.get('readback_verified') is True
            and proof.get('image_ref')==manifest['registry']['loginServer']+'/'+expected['repository']+':'+expected['tag']
            and isinstance(proof.get('image_id'),str) and re.fullmatch('sha256:[a-f0-9]{64}',proof['image_id']),'attempt_build')
        if 'publication' in config:
            fixed=config['publication']['slots'][slot]
            _need(fixed['build_receipt']['sha256']==a['artifact_sha256'][slot+'_build'] and fixed['local_image_id']==proof['image_id']
                and fixed['docker_sha256']==proof.get('docker_sha256') and fixed['docker_host']==proof.get('docker_host'),'attempt_build_binding')
    _allocations(a);_need(all(a['counts_before'][k]>=final['counters'][k] for k in LIMITS),'attempt_counts_reset')
    expected_limits={'schema':1,'head':a['head'],'counts_before':a['counts_before'],'phase_caps':a['phase_caps'],'unallocated':a['unallocated'],'purpose_caps':purpose_caps(a)}
    if a['schema'] in (4,5,6,7):expected_limits.update(limits=_authority_limits(a),limit_amendment=a['limit_amendment'])
    _need(parsed['limits']==expected_limits,'attempt_limits_artifact')
    _keys(activation,('schema','attempt_id','authority_sha256','issued_at','windows'))
    _need(type(activation['schema']) is int and activation['schema']==1 and activation['attempt_id']==a['attempt_id'] and activation['authority_sha256']==trusted_hash,'attempt_activation')
    approved,issued,current=_time(a['approved_at']),_time(activation['issued_at']),_time(now);publication=_time(a['publish_from'])
    _need(approved<=issued<=current and issued.microsecond==publication.microsecond==0 and publication>=issued+timedelta(minutes=5),'attempt_activation_time')
    offsets=window_offsets(a)
    _keys(activation['windows'],offsets)
    for name,(start,end) in offsets.items():
        expected={'start':_stamp(publication+timedelta(seconds=start)),'end':_stamp(publication+timedelta(seconds=end))}
        _need(activation['windows'][name]==expected and _time(expected['end'])<=_time(FORMAL_END),'attempt_window')
    w=activation['windows']
    if 'publication' in config:_need(config['publication']['publish_until']==w['publication']['end'],'attempt_config_window')
    if 'plan_bindings' in config:
        _need(config['plan_bindings']['guardian_window']==w['guardian'] and config['plan_bindings']['owner_window']==w['owner_input'],'attempt_config_window')
        _need(config['runtime_deadline']==FORMAL_END and config['auth_deadline']==AUTH_END and config['cleanup_deadlines']=={
            'guardian':w['guardian']['end'],'owner_input':w['owner_input']['end'],'runtime':FORMAL_END,'auth':AUTH_END},'attempt_cleanup_deadline')
        if 'resource_bindings' in config:_need(config['resource_bindings']['code_sha']==image_head and config['resource_bindings']['guardian_deadline']==w['guardian']['end'],'attempt_resource_binding')
    proof={'authority':a,'activation':activation,'authority_sha256':trusted_hash,'activation_sha256':_sha(activation_raw),'manifest_digest':digest(manifest)}
    if successor:
        if a['schema']==7:from .observed_identity_succession import validate_proof
        elif a['schema']==6:from .acknowledged_image_succession import validate_proof
        elif a['schema']==5:from .unknown_publication_succession import validate_proof
        elif a['schema']==4:from .input_succession import validate_proof
        elif a['schema']==3:from .published_succession import validate_proof
        else:from .succession import validate_proof
        proof['succession']=validate_proof(a,parsed['local_ready'],config,manifest,
            parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,now=now)
    return VerifiedAttempt(proof,_SEAL)
def journal_descriptor(config,verified=None):
    b=config['control_budget']['binding'];base={'manifest_sha256':config['sources']['manifest']['sha256'],'owner_id':b['owner_id'],'task_id':b['task_id']}
    if 'attempt' not in config:_need(verified is None,'attempt_not_configured');return 'trial-provision',base
    proof=_proof(verified);a=proof['authority']
    _need(config['attempt']['sha256']==proof['activation_sha256'] and config['frozen_head']==a['head'] and digest(b)==a['budget_binding_sha256']
        and base=={'manifest_sha256':a['manifest_sha256'],'owner_id':a['owner_id'],'task_id':a['task_id']},'attempt_descriptor')
    name=CHILD_JOURNAL
    if 'succession' in proof:
        if a['schema']==7:from .observed_identity_succession import CHILD_NAME
        elif a['schema']==6:from .acknowledged_image_succession import CHILD_NAME
        elif a['schema']==5:from .unknown_publication_succession import CHILD_NAME
        elif a['schema']==4:from .input_succession import CHILD_NAME
        elif a['schema']==3:from .published_succession import CHILD_NAME
        else:from .succession import CHILD_NAME
        name=CHILD_NAME
    return name,{**base,'attempt':{'schema':1,'id':a['attempt_id'],'binding_digest':verified.binding_digest,'authority_sha256':proof['authority_sha256'],
        'activation_sha256':proof['activation_sha256'],'parent':deepcopy(a['parent'])}}
def effective_slot(manifest,head,slot,verified=None):
    if verified is None:
        _need(slot in ('guardian','runtime'),'attempt_slot');repo,tag=('cleanupImageRepository','cleanupImageTag') if slot=='guardian' else ('imageRepository','imageTag')
        return {'repository':manifest[repo],'tag':manifest[tag]}
    proof=_proof(verified);a=proof['authority'];_need(digest(manifest)==proof['manifest_digest'],'attempt_manifest_changed')
    image_head=a['image_build_head'] if a['schema'] in (6,7) else a['head']
    result=_slot(manifest,image_head,slot)
    _need(head in (a['head'],image_head) and a['tags'][slot]==result['tag'] and a['owner_id']==manifest['owner']['principal_id'],'attempt_slot_binding');return result

def effective_image_head(verified,fallback_head):
    """Separate V6's reviewed local executor from the unchanged image build."""
    _hex(fallback_head,40)
    if verified is None:return fallback_head
    authority=_proof(verified)['authority']
    _need(authority['head']==fallback_head,'attempt_local_head_binding')
    return _hex(authority['image_build_head'],40) if authority['schema'] in (6,7) else fallback_head
def phase_plan(verified):
    a=_proof(verified)['authority'];return {'schema':1,'attempt':verified.binding_digest,'limits':effective_limits(verified),'counts_before':deepcopy(a['counts_before']),
        'phase_caps':deepcopy(a['phase_caps']),'unallocated':deepcopy(a['unallocated']),'budget_binding_sha256':a['budget_binding_sha256'],'purpose_caps':purpose_caps(a)}
def check_budget_snapshot(verified,counts,initializing=False):
    a=_proof(verified)['authority'];_counts(counts,effective_limits(verified));_need(type(initializing) is bool and all(counts[k]>=a['counts_before'][k] for k in LIMITS),'attempt_budget_reset')
    if initializing:_need(counts==a['counts_before'],'attempt_budget_snapshot')
def check_phase_send(verified,kind,phase,counts,used):
    a=_proof(verified)['authority'];check_budget_snapshot(verified,counts);limits=effective_limits(verified)
    _need(kind in LIMITS and phase in PHASES and type(used) is int and used>=0 and used<a['phase_caps'][kind][phase]
        and counts[kind]<limits[kind]-a['unallocated'][kind],'attempt_phase_exhausted')
    if kind=='owner_arm' and phase!='cleanup':_need(counts[kind]<(limits[kind]-120 if a['schema'] in (3,4,5,6,7) else 457),'attempt_cleanup_reserved')
def check_window(verified,name,now,request_seconds=0):
    windows=_proof(verified)['activation']['windows'];_need(name in windows and type(request_seconds) in (int,float)
        and math.isfinite(request_seconds) and request_seconds>=0,'attempt_window_argument')
    start,end=(_time(windows[name][k]) for k in ('start','end'));current=_time(now)
    _need(start<=current and current+timedelta(seconds=request_seconds)<end,'attempt_window_closed')
