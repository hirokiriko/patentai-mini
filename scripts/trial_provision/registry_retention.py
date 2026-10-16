"""Fixed retained-runtime observations for the one linked publication attempt."""
import hashlib
import json
from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied,parse
from .attempt import _proof

VERSION='2021-07-01'
def need(ok):
    if not ok:raise Denied('registry_retention_unconfirmed')
def check_attempt(journal,verified):
    bindings=journal.values('binding');need(len(bindings)==1)
    binding=bindings[0]
    if 'attempt' not in binding:need(verified is None);return
    p=_proof(verified);a=p['authority']
    need(binding=={'manifest_sha256':a['manifest_sha256'],'owner_id':a['owner_id'],'task_id':a['task_id'],'attempt':{
        'schema':1,'id':a['attempt_id'],'binding_digest':verified.binding_digest,'authority_sha256':p['authority_sha256'],
        'activation_sha256':p['activation_sha256'],'parent':a['parent']}})
def urls(prep,verified):
    a=_proof(verified)['authority'];need(prep['code_sha']==a['head'] and prep['slots']['runtime']['tag']==a['tags']['runtime'])
    base='https://'+prep['login_server'];repo=prep['slots']['runtime']['repository'];prefix=base+'/v2/'+repo+'/manifests/'
    return {'repository':base+'/acr/v1/'+repo+'?api-version='+VERSION,
        'retained_tag':prefix+a['retained_runtime']['tag']+'?api-version='+VERSION,
        'retained_digest':prefix+a['retained_runtime']['digest']+'?api-version='+VERSION,
        'new_tag':prefix+a['tags']['runtime']+'?api-version='+VERSION}
def _observe(p,key,url):
    r=p._wire('GET',url,token=p.access);status=200 if key!='new_tag' else 404;need(r['status']==status)
    code=None;content=r['headers'].get('docker-content-digest');checksum=hashlib.sha256(r['body']).hexdigest()
    if key=='new_tag':
        errors=json.loads(r['body']).get('errors');need(isinstance(errors,list) and len(errors)==1 and errors[0].get('code')=='MANIFEST_UNKNOWN' and content is None);code='MANIFEST_UNKNOWN'
    elif key in ('retained_tag','retained_digest'):
        expected=p.verified_attempt.authority['retained_runtime']['digest'];need(content==expected and 'sha256:'+checksum==expected)
    return {'url':url,'http':status,'response_sha256':checksum,'observed_at':p.clock.utc().isoformat(),'content_digest':content,'error_code':code}
def observe_namespace(p):
    prep=p.journal.values('publication_preparation')[0];a=p.verified_attempt.authority
    checks={key:_observe(p,key,url) for key,url in urls(prep,p.verified_attempt).items()}
    return {'schema':1,'mode':'retained-runtime','attempt_binding_digest':p.verified_attempt.binding_digest,
        'publication_preparation_digest':p.preparation,'run_binding_digest':p.run_digest,
        **{k:p.binding[k] for k in ('registry_id','login_server','repository')},'push_operation_id':p.ident,'push_request_digest':digest(p.op),
        'retained_tag':a['retained_runtime']['tag'],'retained_digest':a['retained_runtime']['digest'],'authenticated':True,
        'observed_at':p.clock.utc().isoformat(),'checks':checks}
def observe_after(p,ack):
    prep=p.journal.values('publication_preparation')[0];namespace=p.journal.values('runtime_image_namespace');need(len(namespace)==1)
    checks={key:_observe(p,key,url) for key,url in urls(prep,p.verified_attempt).items() if key in ('retained_tag','retained_digest')}
    result={'schema':1,'namespace_sha256':digest(namespace[0]),'push_request_digest':digest(p.op),'manifest_digest':p.image_digest,
        'retained_digest':p.verified_attempt.authority['retained_runtime']['digest'],'push_ack_sha256':digest(ack),
        'checks':checks,'observed_at':p.clock.utc().isoformat()}
    # Interrupted readback may have already stored its immutable after-proof.
    # Never replace it; a new read still needs to agree with the pinned hashes.
    prior=p.journal.values('runtime_image_retention')
    if prior:
        need(len(prior)==1)
        for key in ('namespace_sha256','push_request_digest','manifest_digest','retained_digest','push_ack_sha256'):need(prior[0][key]==result[key])
    else:p.journal.append('runtime_image_retention',result)
def _checks(checks,expected,retained,earliest,latest):
    need(isinstance(checks,dict) and set(checks)==set(expected))
    for key,url in expected.items():
        row=checks[key];need(isinstance(row,dict) and set(row)=={'url','http','response_sha256','observed_at','content_digest','error_code'})
        need(row['url']==url and type(row['http']) is int and earliest<=parse(row['observed_at'])<=latest)
        checksum=row['response_sha256'];need(isinstance(checksum,str) and len(checksum)==64 and all(c in '0123456789abcdef' for c in checksum))
        if key=='new_tag':need(row['http']==404 and row['content_digest'] is None and row['error_code']=='MANIFEST_UNKNOWN')
        elif key=='repository':need(row['http']==200 and row['error_code'] is None)
        else:need(row['http']==200 and row['error_code'] is None and row['content_digest']==retained and 'sha256:'+checksum==retained)
def verify_retention(journal,prep,namespace,intent,receipt,verified):
    from datetime import timedelta
    check_attempt(journal,verified);a=verified.authority;retained=a['retained_runtime']['digest'];expected=urls(prep,verified)
    need(set(namespace)=={'schema','mode','attempt_binding_digest','publication_preparation_digest','run_binding_digest','registry_id','login_server','repository',
        'push_operation_id','push_request_digest','retained_tag','retained_digest','authenticated','observed_at','checks'})
    need(type(namespace['schema']) is int and namespace['schema']==1 and namespace['mode']=='retained-runtime'
        and namespace['attempt_binding_digest']==verified.binding_digest and namespace['publication_preparation_digest']==digest(prep)
        and namespace['run_binding_digest']==prep['run_binding_digest'] and namespace['push_operation_id']=='runtimeImagePush'
        and namespace['push_request_digest']==receipt['request_digest'] and namespace['authenticated'] is True
        and all(namespace[k]==prep[k] for k in ('registry_id','login_server')) and namespace['repository']==prep['slots']['runtime']['repository']
        and namespace['retained_tag']==a['retained_runtime']['tag'] and namespace['retained_digest']==retained)
    at=parse(intent['at']);need(at-timedelta(seconds=30)<=parse(namespace['observed_at'])<=at)
    _checks(namespace['checks'],expected,retained,at-timedelta(seconds=30),parse(namespace['observed_at']))
    after=journal.values('runtime_image_retention');need(len(after)==1);after=after[0]
    need(set(after)=={'schema','namespace_sha256','push_request_digest','manifest_digest','retained_digest','push_ack_sha256','checks','observed_at'}
        and type(after['schema']) is int and after['schema']==1 and after['namespace_sha256']==digest(namespace)
        and after['push_request_digest']==receipt['request_digest'] and after['manifest_digest']==receipt['properties']['manifest_digest']
        and after['retained_digest']==retained and after['manifest_digest']!=retained)
    acks=[r for r in journal.values('progress') if r.get('operation_id')=='runtimeImagePush' and digest(r)==after['push_ack_sha256']]
    need(len(acks)==1 and acks[0].get('write_terminal') is True and acks[0].get('ack_kind')=='docker_exit0_digest' and acks[0].get('terminal') is False
        and acks[0]['request_digest']==receipt['request_digest'] and acks[0]['properties']==receipt['properties'])
    need(parse(acks[0]['observed_at'])<=parse(after['observed_at'])<=parse(receipt['observed_at']))
    _checks(after['checks'],{k:v for k,v in expected.items() if k in ('retained_tag','retained_digest')},retained,parse(acks[0]['observed_at']),parse(after['observed_at']))
