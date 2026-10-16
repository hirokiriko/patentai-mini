"""Private stdin command runner; preparation never acquires a credential.

One requested operation per invocation. Unknown attempts require explicit
GET-only reconciliation; there is no automatic retry, grant renewal or sweep.
"""
from contextlib import ExitStack
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from scripts.trial_guard.__main__ import Clock
from scripts.trial_guard.adapters import AzureCredential, BoundedHttp, digest, encoded
from .identity_http import IdentityHttp
from .read_http import JobHttp
from scripts.trial_guard.lifecycle import Denied, parse
from .configuration import load_configuration
from .controller import Controller, cleanup_only
from .journal import Journal, ControlBudget, CountedControlHttp, scope_for_dispatch
from .attempt import journal_descriptor,check_window
from .private_io import verify_owner_file
from .plan import build_plan
from .resources import build_resource_operations, canonical_region
from .operations import create_resolver
from .providers import BoundedArmProvider
from .auth import GraphAdapter, EasyAuthAdapter

ROOT=Path(__file__).resolve().parents[2]
MAX_INPUT=2*1024*1024
MODULES={
    'trial_guard':('adapters','catalog_execution','execution','lifecycle','owner','runner','workflow','__init__','__main__'),
    'trial_provision':('attempt','attempt_dispatch','input_succession','unknown_publication_succession','acknowledged_image_succession','restart_budget','succession','published_succession','owner_tokens','auth','bootstrap','cli','configuration','controller','journal','operations','plan','private_io',
        'providers','identity_http','read_http','read_observation','stopped_reads','pim_diagnosis','unknown_observation','observed_identity_succession','readback_continuation','partial_foundation_continuation','unknown_identity_succession','runtime_auth','guard_assignments','reduction_lists','publication_configuration','publication_bridge','publication_only_cleanup','registry','registry_cli','registry_publish','registry_publish_cli','registry_retention',
        'rehearsal','rehearsal_cli','resources','__init__','__main__')}
REQUIRED_SOURCES={f'scripts/{package}/{name}.py' for package,names in MODULES.items() for name in names}
REQUIRED_SOURCES.update(('scripts/__init__.py','scripts/trial-policy-verify.cjs','src/lib/trial/policy.ts',
    'scripts/trial-bootstrap.ts','scripts/trial-operator.ts','scripts/trial-session.ts',
    'scripts/trial-owner-token.ts','src/lib/trial/bootstrap.ts','package.json','pnpm-lock.yaml','scripts/trial-catalog-session.ts','scripts/trial-catalog-prepare.ts',
    'src/lib/trial/catalog-access.ts','src/lib/trial/catalog-builtins.ts','src/lib/trial/catalog-evaluate.ts',
    'src/lib/trial/catalog-queries.ts','src/lib/trial/catalog-runtime.ts','src/lib/trial/catalog-schema.ts',
    'src/lib/trial/catalog-pg16-builtins.json','src/lib/trial/strict-json.ts','src/lib/trial/database-permit.ts','src/lib/trial/database-client.ts'))


def _arm_http(operation):
    if operation is not None and (operation['provider'], operation['kind']) == ('Microsoft.ManagedIdentity', 'userAssignedIdentities'):
        return IdentityHttp()
    if operation is not None and (operation['provider'], operation['kind']) == ('Microsoft.App', 'jobs'):
        return JobHttp()
    return BoundedHttp()


def git(arguments, *, input=None):
    try:
        result=subprocess.run(['git','-C',str(ROOT),*arguments],capture_output=True,
            **({'stdin':subprocess.DEVNULL} if input is None else {'input':input}),check=True,timeout=30,
            creationflags=0x08000000 if os.name=='nt' else 0)
        if len(result.stdout)>8*1024*1024:raise ValueError()
        return result.stdout
    except Exception:raise Denied('local_source_unverified') from None


def private_bytes(reference, maximum=MAX_INPUT):
    if not isinstance(reference,dict) or set(reference)!={'path','sha256'}:
        raise Denied('private_reference')
    path=Path(reference['path'])
    if not path.is_absolute() or path.is_symlink() or not path.is_file():raise Denied('private_path')
    verify_owner_file(path)
    raw=path.read_bytes()
    if not 0<len(raw)<=maximum or hashlib.sha256(raw).hexdigest()!=reference['sha256']:
        raise Denied('private_source_changed')
    return raw


def local_sources(head, *, live):
    """Exact tracked source bytes, including transitive guardian journal imports."""
    names=git(['ls-files','--','scripts/__init__.py','scripts/trial_guard/*.py','scripts/trial_provision/*.py',
        'scripts/trial-policy-verify.cjs','scripts/trial-bootstrap.ts','scripts/trial-operator.ts',
        'scripts/trial-session.ts','scripts/trial-owner-token.ts','src/lib/trial/bootstrap.ts',
        'scripts/trial-catalog-session.ts','scripts/trial-catalog-prepare.ts','src/lib/trial/*.ts','src/lib/trial/*.json','package.json','pnpm-lock.yaml']).decode('utf-8').splitlines()
    names=[n for n in names if '/tests/' not in n]
    if not REQUIRED_SOURCES.issubset(set(names)):
        raise Denied('source_not_committed')
    loaded_root=sys.modules.get('scripts')
    if loaded_root is not None and Path(loaded_root.__file__).resolve()!=(ROOT/'scripts/__init__.py').resolve():
        raise Denied('loaded_source_path')
    for package,names_in_package in MODULES.items():
        for name in names_in_package:
            module=sys.modules.get('scripts.'+package+('' if name=='__init__' else '.'+name))
            if module is not None and Path(module.__file__).resolve()!=(ROOT/'scripts'/package/(name+'.py')).resolve():
                raise Denied('loaded_source_path')
    # One Git process preserves exact committed-byte comparison without making
    # every provider send spend its evidence freshness window on 100+ processes.
    if not re.fullmatch('[a-f0-9]{40}',head) or len(names)!=len(set(names)) or any(
            not n or any(ord(c)<32 for c in n) or ':' in n for n in names):raise Denied('source_batch')
    specs=''.join(head+':'+name+'\n' for name in names).encode('utf-8')
    stream=io.BytesIO(git(['cat-file','--batch'],input=specs));committed_sources={}
    for name in names:
        header=stream.readline(128)
        match=re.fullmatch(rb'([a-f0-9]{40}) blob ([0-9]{1,8})\n',header)
        if match is None:raise Denied('source_batch')
        size=int(match[2])
        if size>4*1024*1024:raise Denied('source_batch')
        blob=stream.read(size)
        if len(blob)!=size or stream.read(1)!=b'\n' or hashlib.sha1(b'blob '+str(size).encode()+b'\0'+blob).hexdigest().encode()!=match[1]:
            raise Denied('source_batch')
        committed_sources[name]=blob
    if stream.read(1):raise Denied('source_batch')
    hashes={}
    for name in names:
        current=(ROOT/name).read_bytes()
        committed=committed_sources[name]
        if live and current.replace(b'\r\n',b'\n')!=committed.replace(b'\r\n',b'\n'):
            raise Denied('source_not_committed')
        hashes[name]=hashlib.sha256(current).hexdigest()
    return hashes


def policy_verifier(node):
    executable=Path(node)
    if not executable.is_absolute() or executable.name.lower() not in ('node.exe','node'):
        raise Denied('policy_verifier_executable')
    def verify(environment):
        try:
            result=subprocess.run([str(executable),str(ROOT/'scripts/trial-policy-verify.cjs')],
                input=encoded(environment),stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                cwd=ROOT,check=True,timeout=30,
                creationflags=0x08000000 if os.name=='nt' else 0)
            if len(result.stdout)>65536:raise ValueError()
            return json.loads(result.stdout)
        except Exception:raise Denied('policy_unverified') from None
    return verify


def _window_guard(core,verified=None):
    def check(op,now):
        if cleanup_only(op):return
        if verified is not None:
            check_window(verified,'guardian',now)
            # Foundation resources and their grants must finish before the
            # separate OWNER input window. Runtime changes happen afterwards.
            from .attempt import _proof
            windows=_proof(verified)['activation']['windows']
            foundation=op['id'] in ('webIdentity','workerIdentity','originals','artifacts','budget','journal','guard','job','app','guardMainConfiguration') or (
                op['id'][:1] in ('C','G','R') and op['id'][1:].isdigit())
            if foundation and now>=parse(windows['owner_input']['start']):raise Denied('foundation_window_closed')
            if not foundation:check_window(verified,'owner_input',now)
        slot=op['id']
        name='guardian' if slot.startswith('G') and slot[1:].isdigit() else (
            'owner_input' if slot.startswith('O') and slot[1:].isdigit() else None)
        auth_window=(op.get('provider') == 'Microsoft.Graph' and slot in ('E1','E2','E3','E4')) or bool(op.get('expected',{}).get('auth_action'))
        if auth_window:
            name='owner_input'
        if name:
            window=core['windows'][name]
            # A saved older plan is immutable. Refuse its wider creation
            # deadline instead of letting intent/accounting cross this window.
            if auth_window and parse(op['deadline'])>parse(window['end']):raise Denied('grant_window_binding')
            if not parse(window['start'])<=now<parse(window['end']):raise Denied('grant_window')
    return check


def run_command(request, *, clock=None, wire=None,trusted_attempt_authority=None,owner_token_pool=None):
    if (not isinstance(request,dict) or set(request)-{'config','action','operation_id','creation_id','runtime_environment','cleanup_evidence','rehearsal_config','bootstrap_config','registry_config'}
        or not {'config','action'}<=set(request)):
        raise Denied('command_shape')
    action=request['action']
    rehearsal_actions=('rehearsal-start','rehearsal-poll','rehearsal-seed','rehearsal-verify')
    if action not in ('prepare','status','create','update','reconcile','cleanup','bind-runtime','bind-cleanup','bind-bootstrap','registry-cleanup','revalidate-foundation')+rehearsal_actions:
        raise Denied('command_action')
    clock=clock or Clock()
    path=Path(request['config'])
    if not path.is_absolute() or path.is_symlink():raise Denied('config_path')
    verify_owner_file(path)
    raw=path.read_bytes()
    if not 0<len(raw)<=MAX_INPUT:raise Denied('config_limit')
    preview=json.loads(raw)
    manifest=json.loads(private_bytes(preview['sources']['manifest']))
    owner=manifest['owner']
    head=git(['rev-parse','HEAD']).decode('ascii').strip()
    mutating=action in ('create','update','cleanup','reconcile','registry-cleanup','revalidate-foundation')+rehearsal_actions
    sources=local_sources(head,live=mutating)
    loaded=load_configuration(path,now=clock.utc(),local_head=head,
        owner_context={'mode':'AzureCliCredential','tenant_id':owner['tenant_id'],
            'principal_id':owner['principal_id']},local_source_digests=sources,trusted_attempt_authority=trusted_attempt_authority)
    config=loaded
    if mutating and (config.get('live') is not True or config.get('code_sources')!=sources):
        raise Denied('live_not_enabled')
    recovery=config['recovery']; budget_config=config['control_budget']
    verified=config.get('verified_attempt');journal_name,journal_binding=journal_descriptor(config,verified)
    with ExitStack() as stack:
        journal=stack.enter_context(Journal(recovery['directory'],recovery['directory_digest'],
            journal_binding,name=journal_name,require_existing=verified is not None and action!='prepare'))
        budget=stack.enter_context(ControlBudget(budget_config['directory'],budget_config['directory_digest'],
            budget_config['binding'],seed=budget_config['seed'],require_existing=verified is not None or action!='prepare'))
        if verified is not None:budget.begin_attempt(verified,initialize=action=='prepare')
        resource_ops=build_resource_operations(manifest,loaded['authority_bundle'],config['resource_bindings'])
        old=journal.values('core_plan')
        if old:core=old[0]
        else:
            if action!='prepare':raise Denied('plan_not_prepared')
            bindings={**config['plan_bindings'],'prerequisite_digests':{o['id']:digest(o) for o in resource_ops}}
            core=build_plan(manifest,loaded['authority_bundle'],bindings,clock.utc(),journal.allocate_id,
                verified_attempt=verified)
            journal.append('core_plan',core)
        verifier=policy_verifier(config['policy_verifier_node'])
        resolver=create_resolver(core,manifest,loaded['authority_bundle'],config['resource_bindings'],verified_attempt=verified)
        journal.fix_plan(resolver.initial_plan)
        from .partial_foundation_continuation import continuation_journal
        journal=continuation_journal(journal,verified,initialize=action=='prepare')
        if journal.values('publication_preparation') or journal.values('image_reuse_preparation'):
            from .registry_publish import bind_publication
            bind_publication(journal,resolver,config['resource_bindings'],verified_attempt=verified)
        saved=journal.values('runtime_binding')
        if saved:resolver.bind_runtime(saved[0],journal.receipts(),verify_policy=verifier)
        for record in journal.values('cleanup_binding'):
            resolver.bind_cleanup(record['operation_id'],record['evidence'])
        for record in journal.values('rehearsal_binding'):
            resolver.bind_rehearsal(record,journal.receipts())
        if action=='revalidate-foundation':
            from . import reduction_lists as lists
            if verified is None or verified.authority['schema']!=10 or owner_token_pool is None:
                raise Denied('foundation_read_authority')
            facts={slot:(resolver.resolve(slot,journal.receipts()),journal.receipts()[slot]) for slot in lists.CARRIED}
            previous=journal.values('foundation_readback')
            if previous:
                if len(previous)!=1 or previous[0]['attempt']!=verified.binding_digest:
                    raise Denied('foundation_read_changed')
                lists.validate_carry(previous[0]['record'],manifest,facts,clock.utc())
                return {'status':'foundation_current_verified','cloud_calls':0,'control_requests_used':budget.count('owner_arm')}
            if journal.values('foundation_read_intent'):
                raise Denied('foundation_read_already_attempted')
            target=resolver.resolve('guard',journal.receipts())
            scoped=scope_for_dispatch(budget,verified,entry_point='provision',action='create',operation=target)
            def observation_guard():
                check_window(verified,'guardian',clock.utc())
                if clock.utc()>=parse(verified.activation['windows']['owner_input']['start']):
                    raise Denied('foundation_window_closed')
            observation_guard()
            journal.append('foundation_read_intent',{'attempt':verified.binding_digest,'at':clock.utc().isoformat(),
                'specifications_sha256':digest(lists.carry_specifications(manifest,facts))})
            from .read_http import ReadHttp
            counted=CountedControlHttp(wire or ReadHttp(),scoped)
            credential=owner_token_pool.bind(AzureCredential('owner',owner['principal_id'],owner['tenant_id'],counted),scoped,verified)
            record=lists.collect_carry(manifest,facts,counted,credential,clock,observation_guard)
            journal.append('foundation_readback',{'attempt':verified.binding_digest,'record':record})
            return {'status':'foundation_current_verified','cloud_calls':5,'control_requests_used':budget.count('owner_arm')}
        if action=='bind-bootstrap':
            from .bootstrap import bind_bootstrap
            bundle=json.loads(private_bytes(request['bootstrap_config']))
            return bind_bootstrap(bundle,journal,resolver,clock,verify_policy=verifier,verified_attempt=verified)
        if action=='bind-cleanup':
            ident=request.get('operation_id')
            evidence=json.loads(private_bytes(request['cleanup_evidence']))
            resolver.bind_cleanup(ident,evidence)
            resolver.resolve(ident,journal.receipts())
            record={'operation_id':ident,'evidence':evidence}
            previous=[v for v in journal.values('cleanup_binding') if v['operation_id']==ident]
            if previous and previous[0]!=record:raise Denied('cleanup_binding_changed')
            if not previous:journal.append('cleanup_binding',record)
            return {'status':'cleanup_bound','cloud_calls':0}
        if action=='bind-runtime':
            environment=json.loads(private_bytes(request['runtime_environment'],131072))
            runtime_policy=verifier({'DEPLOYMENT_KIND':'trial',**environment})
            write_end=min(parse(runtime_policy['endsAt']),parse(core['windows']['owner_input']['end']))
            binding=resolver.make_runtime_binding(environment,journal.receipts(),verify_policy=verifier,
                deadline=write_end.isoformat().replace('+00:00','Z'))
            if saved and saved[0]!=binding:raise Denied('runtime_binding_changed')
            if not saved:journal.append('runtime_binding',binding)
            return {'status':'runtime_bound','cloud_calls':0}
        if action in ('prepare','status'):
            return {'status':'prepared' if action=='prepare' else 'status',
                'planned_operations':len(resolver.allowed_ids),'attempts':len(journal.values('intent')),
                'unresolved':sum((journal.latest(x['operation_id']) or {}).get('terminal') is not True
                    for x in journal.values('intent')),'cloud_calls':0,
                'control_requests_used':budget.count('owner_arm')}
        requested_operation=None
        scoped=budget
        if verified is not None:
            if owner_token_pool is None:raise Denied('owner_token_pool_required')
            if action=='registry-cleanup':scoped=scope_for_dispatch(budget,verified,entry_point='registry-cleanup',action='cleanup')
            elif action in rehearsal_actions:scoped=scope_for_dispatch(budget,verified,entry_point='rehearsal',action=action.removeprefix('rehearsal-'))
            else:
                requested_operation=resolver.resolve(request.get('operation_id'),journal.receipts())
                scoped=scope_for_dispatch(budget,verified,entry_point='provision',action=action,operation=requested_operation)
        if action != 'registry-cleanup' and action not in rehearsal_actions:
            requested_operation=requested_operation or resolver.resolve(request.get('operation_id'),journal.receipts())
        counted=CountedControlHttp(wire or _arm_http(requested_operation),scoped)
        credential=AzureCredential('owner',owner['principal_id'],owner['tenant_id'],counted)
        if verified is not None:credential=owner_token_pool.bind(credential,scoped,verified)
        if action=='registry-cleanup':
            from .registry_cli import run_registry_cleanup
            bundle=json.loads(private_bytes(request['registry_config']))
            return run_registry_cleanup(bundle,manifest,config['resource_bindings'],journal,resolver,
                credential,wire or BoundedHttp(),scoped,clock,verified_attempt=verified)
        if action in rehearsal_actions:
            from .rehearsal_cli import run_rehearsal
            bundle=json.loads(private_bytes(request['rehearsal_config']))
            kwargs={'credential_factory':lambda _credential:credential} if verified is not None else {}
            if verified is not None:
                check_window(verified,'guardian',clock.utc())
                from .attempt import _proof
                if clock.utc()>=parse(_proof(verified)['activation']['windows']['owner_input']['start']):raise Denied('foundation_window_closed')
            return run_rehearsal(action.removeprefix('rehearsal-'),bundle,journal,resolver,
                credential,wire or BoundedHttp(),scoped,clock,**kwargs)
        def secret(source):
            reference=config.get('secret_sources',{}).get(source)
            return private_bytes(reference,65536).decode('utf-8')
        provider=BoundedArmProvider(credential,counted,clock,secret)
        auth_binding=deepcopy(core['auth_binding'])
        # The builder fixes these from the same manifest and approved safe body.
        auth_binding.update(location=canonical_region(manifest['region']),environment_id=manifest['existing']['environment'],
            runtime_secret_names=['trial-web-database'])
        graph=auth=None
        requested_operation=requested_operation or resolver.resolve(request.get('operation_id'),journal.receipts())
        if requested_operation['provider']=='Microsoft.Graph' or requested_operation['expected'].get('auth_action'):
            application_op=resolver.resolve('E1',journal.receipts())
            auth_binding['redirect_uri']=application_op['body']['web']['redirectUris'][0]
            graph=GraphAdapter(auth_binding,credential,counted,clock)
            adapter,extra=EasyAuthAdapter,{}
            if resolver.combined_runtime_auth and (requested_operation['id']=='E4' or requested_operation['id']=='auth-platform-secret'):
                from .runtime_auth import CombinedRuntimeAuthAdapter
                adapter=CombinedRuntimeAuthAdapter
                extra={'context':lambda:resolver.combined_auth_context(journal.receipts())[:3]}
            auth=adapter(auth_binding,credential,counted,
                lambda:{'trial-web-database':secret('trial-web-database')},clock,arm_provider=provider,**extra)
        adapters={name:provider for name in ('Microsoft.App','Microsoft.ManagedIdentity','Microsoft.Storage','Microsoft.Authorization')}
        adapters['Microsoft.Graph']=graph
        window_guard=_window_guard(core,verified)
        def execution_guard(op,now):
            window_guard(op,now)
            if verified is not None and verified.authority['schema']==10 and not cleanup_only(op):
                from .attempt_dispatch import FOUNDATION
                from . import reduction_lists as lists
                if op['id'] in lists.CARRIED:
                    raise Denied('carried_operation_write_forbidden')
                if op['id'] in FOUNDATION:
                    records=journal.values('foundation_readback')
                    if len(records)!=1 or records[0]['attempt']!=verified.binding_digest:
                        raise Denied('foundation_current_required')
                    facts={slot:(resolver.resolve(slot,journal.receipts()),journal.receipts()[slot]) for slot in lists.CARRIED}
                    lists.validate_carry(records[0]['record'],manifest,facts,now)
        control=Controller(journal,clock,resolver.resolve,resolver.allowed_ids,adapters,
            easy_auth=auth,send_guard=execution_guard)
        ident=request.get('operation_id')
        if verified is not None and verified.authority['schema']==10 and action in ('create','update'):
            execution_guard(requested_operation,clock.utc())
        if action=='create':result=control.create(ident)
        elif action=='update':result=control.update(ident,request.get('creation_id'))
        elif action=='cleanup':
            creation_id=resolver.cleanup_creation_id(ident,journal.receipts())
            if request.get('creation_id',creation_id)!=creation_id:raise Denied('cleanup_creation_changed')
            result=control.cleanup(ident,creation_id,
                reference_evidence=resolver.cleanup_reference_evidence(ident))
        else:result=control.reconcile(ident)
        return {'status':(result or {}).get('state','unknown'),
            'terminal':(result or {}).get('terminal') is True,**control.summary(),
            'control_requests_used':budget.count('owner_arm')}


def main():
    try:
        raw=sys.stdin.buffer.read(MAX_INPUT+1)
        if not 0<len(raw)<=MAX_INPUT:raise Denied('command_limit')
        result=run_command(json.loads(raw))
        print(json.dumps(result),flush=True)
        return 0 if result.get('status') not in ('failed','unknown','pending') else 2
    except BaseException:
        # Never echo paths, identities, URLs, raw provider errors or private input.
        print('{"status":"unconfirmed"}',flush=True)
        return 1
