"""Private publication entry before registry manifest digests are known.

Preparation performs no authentication or network I/O. Both phases retain the
same provisioning Journal and lifetime ControlBudget; a publish cannot create
or reset either. Only the fixed two approved Docker image slots are supported.
"""
from contextlib import ExitStack
import json
from pathlib import Path
import re
import sys

from scripts.trial_guard.__main__ import Clock
from scripts.trial_guard.adapters import AzureCredential, BoundedHttp
from scripts.trial_guard.lifecycle import Denied
from .cli import MAX_INPUT, git, local_sources, private_bytes
from .journal import Journal, ControlBudget, CountedControlHttp,scope_for_dispatch
from .attempt import effective_slot,effective_image_head,journal_descriptor
from .private_io import verify_owner_file
from .publication_configuration import load_publication_configuration
from .registry_publish import (prepare_publication, run_registry_publish,
    cleanup_docker_config, verified_publication_images,reuses_acknowledged_images,
    verify_reused_images)


def need(value):
    if not value: raise Denied('publication_command_unconfirmed')


def validate_build_receipts(config, manifest):
    """Bind exact protected successful build proof, never a planned image ID."""
    keys={'schema','slot','manifest_sha256','source_head','request_digest','method',
        'attempt','exit_code','docker_sha256','docker_host','image_ref','image_id',
        'readback_verified','managed_build_sha'}
    image_head=effective_image_head(config.get('verified_attempt'),config['frozen_head'])
    manifest_hash=config['sources']['manifest']['sha256']
    if config.get('verified_attempt') is not None:
        from .attempt import origin_manifest_hash
        manifest_hash=origin_manifest_hash(config['verified_attempt'].authority)
    for slot,repository,tag in (('guardian','cleanupImageRepository','cleanupImageTag'),
                               ('runtime','imageRepository','imageTag')):
        proof=config['build_receipts'][slot]; fixed=config['publication']['slots'][slot]
        selected=effective_slot(manifest,config['frozen_head'],slot,config.get('verified_attempt'))
        need(isinstance(proof,dict) and set(proof)==keys
            and type(proof['schema']) is int and proof['schema']==1
            and type(proof['attempt']) is int and proof['attempt']==1
            and type(proof['exit_code']) is int and proof['exit_code']==0
            and proof['slot']==slot and proof['method']=='docker-build'
            and proof['readback_verified'] is True
            and proof['manifest_sha256']==manifest_hash
            and proof['source_head']==image_head==proof['managed_build_sha']
            and proof['docker_sha256']==fixed['docker_sha256']
            and proof['docker_host']==fixed['docker_host']
            and proof['image_id']==fixed['local_image_id']
            and proof['image_ref']==manifest['registry']['loginServer']+'/'+selected['repository']+':'+selected['tag']
            and isinstance(proof['request_digest'],str)
            and re.fullmatch('[a-f0-9]{64}',proof['request_digest']))


def run_command(request, *, clock=None, wire=None, runner=None,trusted_attempt_authority=None,owner_token_pool=None):
    need(isinstance(request,dict) and not set(request)-{'config','action','slot','provision'}
        and {'config','action'}<=set(request))
    action=request['action']
    need(action in ('prepare','status','publish','cleanup-config','cleanup-publication','bind-provision','verify-reused-images'))
    if action=='bind-provision': need('provision' in request)
    else: need('provision' not in request)
    if action in ('publish','cleanup-config'):
        need(request.get('slot') in ('guardian','runtime'))
    else: need('slot' not in request)
    clock=clock or Clock()
    path=Path(request['config'])
    need(path.is_absolute() and not path.is_symlink() and path.is_file())
    verify_owner_file(path)
    raw=path.read_bytes();need(0<len(raw)<=MAX_INPUT)
    preview=json.loads(raw)
    manifest=json.loads(private_bytes(preview['sources']['manifest']))
    owner=manifest['owner']
    recovery=preview['recovery']; budget_config=preview['control_budget']
    binding={'manifest_sha256':preview['sources']['manifest']['sha256'],
        'owner_id':owner['principal_id'],'task_id':budget_config['binding']['task_id']}
    # Local crash cleanup has no credential or provider operation. An old CI or
    # expired publication time must not strand our exact recorded token file.
    # Journal validates its existing immutable binding and every saved hash.
    if action=='cleanup-config':
        name='trial-provision'
        if 'attempt' in preview:
            # Local token-file cleanup reads its immutable attempt proof; it
            # does not claim current CI/source checks or open a send window.
            cleanup=load_publication_configuration(path,now=clock.utc(),local_head=preview['frozen_head'],
                owner_context={'mode':'AzureCliCredential','tenant_id':owner['tenant_id'],'principal_id':owner['principal_id']},
                local_source_digests=preview['code_sources'],trusted_attempt_authority=trusted_attempt_authority)
            name,binding=journal_descriptor(cleanup,cleanup['verified_attempt'])
        with Journal(recovery['directory'],recovery['directory_digest'],binding,name=name,require_existing=True) as journal:
            # Always attempt token cleanup even when the empty probe is damaged.
            try: cleanup_docker_config(journal,request['slot'])
            finally: cleanup_docker_config(journal,request['slot'],probe=True)
        return {'status':'temporary_config_removed','temporary_config_absent':True,'cloud_calls':0}
    head=git(['rev-parse','HEAD']).decode('ascii').strip()
    sources=local_sources(head,live=action in ('publish','cleanup-publication','verify-reused-images'))
    loaded=load_publication_configuration(path,now=clock.utc(),local_head=head,
        owner_context={'mode':'AzureCliCredential','tenant_id':owner['tenant_id'],'principal_id':owner['principal_id']},
        local_source_digests=sources,trusted_attempt_authority=trusted_attempt_authority)
    validate_build_receipts(loaded,manifest)
    need(loaded['recovery']==recovery and loaded['control_budget']==budget_config and loaded['manifest']==manifest)
    if action in ('publish','cleanup-publication','verify-reused-images'):
        need(loaded.get('live') is True and loaded.get('code_sources')==sources)
    verified=loaded.get('verified_attempt');name,binding=journal_descriptor(loaded,verified)
    reuse=reuses_acknowledged_images(verified)
    if verified is not None and verified.authority['schema'] in (8,9,10):
        need(action not in ('verify-reused-images','publish','cleanup-publication'))
    need(not (reuse and action in ('publish','cleanup-publication'))
        and (action!='verify-reused-images' or reuse))
    with ExitStack() as stack:
        journal=stack.enter_context(Journal(recovery['directory'],recovery['directory_digest'],binding,name=name,
            require_existing=action!='prepare'))
        budget=stack.enter_context(ControlBudget(budget_config['directory'],budget_config['directory_digest'],
            budget_config['binding'],seed=budget_config['seed'],require_existing=verified is not None or action!='prepare'))
        if verified is not None:budget.begin_attempt(verified,initialize=action=='prepare')
        if action=='prepare':
            prepare_publication(loaded,manifest,loaded['config_sha256'],journal)
            return {'status':'publication_prepared','image_slots':2,'cloud_calls':0,
                'control_requests_used':budget.count('owner_arm')}
        # Revalidation must not append a new preparation on publish or status.
        need(len(journal.values('image_reuse_preparation' if reuse else 'publication_preparation'))==1)
        prepare_publication(loaded,manifest,loaded['config_sha256'],journal)
        if action=='cleanup-publication':
            from .publication_only_cleanup import run
            scoped=budget
            if verified is not None:
                need(owner_token_pool is not None)
                scoped=scope_for_dispatch(budget,verified,entry_point='registry-cleanup',action='cleanup')
            credential=AzureCredential('owner',owner['principal_id'],owner['tenant_id'],CountedControlHttp(wire or BoundedHttp(),scoped))
            if verified is not None:credential=owner_token_pool.bind(credential,scoped,verified)
            def source_guard():
                need(local_sources(head,live=True)==sources)
            return run(loaded,journal,scoped,credential,wire or BoundedHttp(),clock,source_guard)
        if action=='bind-provision':
            from .publication_bridge import prepare_bridge, complete_bridge
            binding=prepare_bridge(loaded,journal,request['provision'],now=clock.utc())
            # Normal preparation reopens these exact files. Never nest their locks.
            stack.close()
            return complete_bridge(loaded,binding,clock=clock,trusted_attempt_authority=trusted_attempt_authority)
        if action=='status':
            if reuse:
                complete=verified.authority['schema'] in (8,9,10) or bool(journal.values('image_reuse_readback'))
                if complete:verified_publication_images(journal,verified_attempt=verified)
                return {'status':'publication_status','verified_images':2 if complete else 0,
                    'attempts':len(journal.values('image_reuse_readback_intent')),
                    'cloud_calls':0,'control_requests_used':budget.count('owner_arm')}
            receipts=[journal.latest(k+'ImagePush') or {} for k in ('guardian','runtime')]
            verified_count=sum(r.get('state')=='succeeded' and r.get('readback_verified') is True for r in receipts)
            if verified_count==2: verified_publication_images(journal,verified_attempt=verified)
            return {'status':'publication_status','verified_images':verified_count,
                'attempts':sum(v['operation_id'] in ('guardianImagePush','runtimeImagePush') for v in journal.values('intent')),
                'cloud_calls':0,'control_requests_used':budget.count('owner_arm')}
        if action=='verify-reused-images':
            need(owner_token_pool is not None)
            if not journal.values('image_reuse_readback_intent'):need(loaded['gates']['publication_window_open'])
            scoped=scope_for_dispatch(budget,verified,entry_point='publication',action=action)
            credential=AzureCredential('owner',owner['principal_id'],owner['tenant_id'],CountedControlHttp(wire or BoundedHttp(),scoped))
            credential=owner_token_pool.bind(credential,scoped,verified)
            def source_guard():need(local_sources(head,live=True)==sources)
            result=verify_reused_images(journal,credential,wire or BoundedHttp(),scoped,clock,
                verified_attempt=verified,source_guard=source_guard)
            return {**result,'control_requests_used':budget.count('owner_arm')}
        slot=request['slot']; fixed=loaded['publication']['slots'][slot]
        # A known ACK may finish GET-only verification after the original
        # deadline. A first push is fenced again at every send/process boundary.
        attempted=any(v['operation_id']==slot+'ImagePush' for v in journal.values('intent'))
        if not attempted: need(loaded['gates']['publication_window_open'])
        scoped=budget
        if verified is not None:
            need(owner_token_pool is not None);scoped=scope_for_dispatch(budget,verified,entry_point='publication',action='publish')
        counted=CountedControlHttp(wire or BoundedHttp(),scoped)
        credential=AzureCredential('owner',owner['principal_id'],owner['tenant_id'],counted)
        if verified is not None:credential=owner_token_pool.bind(credential,scoped,verified)
        bundle={k:fixed[k] for k in ('docker_path','docker_sha256','docker_host','local_image_id')}
        bundle.update(schema=1,slot=slot,deadline=loaded['publication']['publish_until'])
        kwargs={} if runner is None else {'runner':runner}
        result=run_registry_publish(bundle,manifest,journal,credential,wire or BoundedHttp(),scoped,clock,verified_attempt=verified,**kwargs)
        return {**result,'control_requests_used':budget.count('owner_arm')}


def main():
    try:
        raw=sys.stdin.buffer.read(MAX_INPUT+1)
        need(0<len(raw)<=MAX_INPUT)
        result=run_command(json.loads(raw))
        print(json.dumps(result),flush=True)
        return 0 if result.get('status') not in ('failed','unknown','pending') else 2
    except BaseException:
        print('{"status":"unconfirmed"}',flush=True)
        return 1


if __name__=='__main__':raise SystemExit(main())
