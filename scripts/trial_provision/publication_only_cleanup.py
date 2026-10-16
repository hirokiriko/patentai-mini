"""Expired publication-only guardian cleanup. Never invents a provision plan.

The caller supplies a canonical loaded publication configuration and holds its
existing journal/budget locks. Only its owned guardian manifest is removable.
"""
from copy import deepcopy
from scripts.trial_guard.adapters import Deadline,digest,encoded
from scripts.trial_guard.lifecycle import Denied,parse
from scripts.trial_provision.registry_publish import prepare_publication,verified_publication_image
from scripts.trial_provision.registry_publish_cli import validate_build_receipts
from scripts.trial_provision.registry import BoundedRegistryProvider,_binding
from scripts.trial_provision.registry_cli import _summary
from scripts.trial_provision.rehearsal_cli import _Clock
from scripts.trial_provision.journal import CountedControlHttp

IDENT='guardianImageCleanup'
PUSH='guardianImagePush'
ARM='https://management.azure.com'

def need(value):
    if not value:raise Denied('publication_only_cleanup_unconfirmed')

def prepare(config,journal,now):
    manifest=config['manifest'];owner=manifest['owner']
    need(config['live'] is True and parse(config['publication']['publish_until'])<=now)
    need(not journal.values('clock_revoked'))
    need(not any(r['event'] in ('core_plan','plan','publication_import') or r['event'].startswith('provision_bridge_') for r in journal.records))
    preparations=journal.values('publication_preparation');need(len(preparations)==1)
    run=journal.values('binding');need(len(run)==1)
    from .attempt import journal_descriptor
    _,expected_binding=journal_descriptor(config,config.get('verified_attempt'))
    need(run[0]==expected_binding)
    validate_build_receipts(config,manifest)
    preparation=prepare_publication(config,manifest,config['config_sha256'],journal)
    image=verified_publication_image(journal,'guardian',verified_attempt=config.get('verified_attempt'))
    need(preparations==[preparation] and manifest['cleanupImageRepository']!=manifest['imageRepository'])
    intents=journal.values('intent')
    need({v['operation_id'] for v in intents}<={'guardianImagePush','runtimeImagePush',IDENT})
    need(sum(v['operation_id']==IDENT for v in intents)<=1)
    namespace=journal.values('guardian_image_namespace');need(len(namespace)==1)
    push=journal.latest(PUSH)
    ids=[manifest['ids'][k] for k in ('app','job','guard')]
    scope={'schema':1,'mode':'expired_publication_without_provision',
        'publication_configuration_sha256':config['config_sha256'],
        'publication_preparation_digest':digest(preparation),'run_binding_digest':digest(run[0]),
        'source_sha256':preparation['source_sha256'],'namespace_receipt_digest':digest(namespace[0]),
        'guardian_push_receipt_digest':digest(journal.latest('guardianImagePush')),
        'authorized_resource_ids':ids,'publish_until':preparation['publish_until']}
    binding=_binding({'registry_id':manifest['existing']['registry'],'login_server':manifest['registry']['loginServer'],
        'repository':manifest['cleanupImageRepository'],'tenant_id':owner['tenant_id'],
        'authorized_resource_ids':ids,'exclusivity_evidence_digest':digest(scope)})
    manifest_digest=image.split('@',1)[1]
    op={'id':IDENT,'provider':'AzureContainerRegistry','kind':'manifest','method':'DELETE',
        'url':'https://'+binding['login_server']+'/v2/'+binding['repository']+'/manifests/'+manifest_digest+'?api-version=2021-07-01',
        'body':None,'deadline':preparation['publish_until'],'depends_on':[PUSH],
        'expected':{'binding_digest':digest(binding),'manifest_digest':manifest_digest,
            'push_request_digest':push['request_digest'],'push_receipt_digest':digest(push)},
        'cleanup':{'created_only':True,'zero_reference_required':True,'purpose':'guardian'}}
    return binding,op,push,scope

def run(config,journal,budget,credential,wire,clock,source_guard):
    binding,op,push,scope=prepare(config,journal,clock.utc())
    owner=config['manifest']['owner']
    need(credential.mode=='owner' and credential.principal==owner['principal_id'] and credential.tenant==owner['tenant_id'])
    fixed={'scope':scope,'operation':op};saved=journal.values('publication_cleanup_binding')
    need(not saved or saved==[fixed])
    fenced=_Clock(journal,clock);proof=None
    def guard():
        source_guard();instant=fenced.utc();need(not fenced.unsafe)
        need(prepare(config,journal,instant)==(binding,op,push,scope))
    def final_wire(method,url,headers,body,deadline):
        deadline.remaining();guard()
        if method=='DELETE':
            need(url==op['url'] and proof is not None)
            provider.validate_zero_references(op,push,proof)
        return wire(method,url,headers,body,deadline)
    counted=CountedControlHttp(final_wire,budget,registry_host=binding['login_server'])
    def before_send(operation):
        guard();need(operation==op and not any(v['operation_id']==IDENT for v in journal.values('intent')))
        # An unknown runtime upload cannot refer to the distinct guardian
        # repository. It is retained as unknown, never adopted or deleted.
        need(all(v['operation_id']=='runtimeImagePush' or (journal.latest(v['operation_id']) or {}).get('terminal') is True for v in journal.values('intent')))
        journal.append('clock_observation',{'at':fenced.utc().isoformat()})
        journal.intent(op,fenced.utc().isoformat())
    provider=BoundedRegistryProvider(credential,counted,fenced,binding=binding,
        before_send=before_send,checkpoint=lambda receipt:journal.checkpoint(op,receipt))
    provider._operation(op);provider._push(op,push)
    if not saved:journal.append('publication_cleanup_binding',fixed)
    attempted=[v for v in journal.values('intent') if v['operation_id']==IDENT]
    if attempted:
        need(len(attempted)==1 and attempted[0]['request_digest']==digest(op))
        receipt=journal.latest(IDENT)
        if receipt is None:return {'status':'unknown','terminal':False,'cleanup_verified':False,'automatic_retry':False}
        provider._receipt(op,receipt)
        if receipt.get('terminal') is True or receipt.get('delete_acknowledged') is not True:return _summary(receipt)
        return _summary(provider.readback(op,receipt))
    guard()
    # No normal provisioning exists: any present consumer is a scope mismatch,
    # not an invitation to broaden this adapter to revision/execution scans.
    deadline=Deadline(30,fenced.monotonic)
    started=fenced.utc();token=credential.token(ARM+'/',deadline);rows=[]
    for rid in binding['authorized_resource_ids']:
        observed=fenced.utc()
        response=counted('GET',ARM+rid+'?api-version=2025-07-01',{'Authorization':'Bearer '+token},None,deadline)
        need(response['status']==404 and len(response['body'])<=1024*1024
             and not {'location','azure-asyncoperation'}&{k.lower() for k in response['headers']})
        import json
        value=json.loads(response['body']);need(value.get('error',{}).get('code')=='ResourceNotFound')
        rows.append({'resource_id':rid,'observed_at':observed.isoformat(),'complete':True,'pages_complete':True,
            'coverage':'all_revisions' if '/containerApps/' in rid else 'template_and_all_executions','images':[]})
    token=None
    proof={'complete':True,'foreign_references_excluded':True,'repository_exclusive':True,'writers_fenced':True,
        'exclusivity_evidence_digest':binding['exclusivity_evidence_digest'],'observed_at':started.isoformat(),
        'push_receipt_digest':digest(push),'object_id':op['url'],'observations':rows}
    proof_digest=provider.validate_zero_references(op,push,proof)
    journal.append('publication_cleanup_observation',{'request_digest':digest(op),'proof_digest':proof_digest,'proof':proof})
    return _summary(provider.cleanup(op,push,proof))
