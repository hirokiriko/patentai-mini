"""Inert Local entry. One verified attempt, one memory-only OWNER token pool.

The caller validates the protected authority, activation, parent chain and
build artifacts first. JSON cannot supply a phase, pool or fresh deadline.
"""
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import time
from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied,parse
from .attempt import _proof,journal_descriptor,check_window
from .owner_tokens import OwnerTokenPool

FOUNDATION=('webIdentity','workerIdentity','originals','artifacts','budget','journal',
    'C1','C2','C3','C4','C5','C6','C7','guard','G1','G2','G3','G4','G5','G6',
    'R1','R2','R3','R4','R5','R6','R7','R8','R9','job','R10','app')
GROUPS={'foundation':FOUNDATION,'main-configuration':('guardMainConfiguration',),
    'owner-input':('O1','O2','E1','E2','E3'),'runtime':('jobRuntime','appRuntime'),
    'owner-auth':('E4','auth-platform-secret','auth-config','auth-ingress')}
UPDATE_FROM={'guardMainConfiguration':'guard','jobRuntime':'job','appRuntime':'app'}

def need(value):
    if not value:raise Denied('attempt_dispatch_unconfirmed')

class ApprovedAttemptSession:
    def __init__(self,verified,clock):
        proof=_proof(verified)
        self.verified,self.clock=verified,clock
        self.authority_sha256=proof['authority_sha256']
        self.pool=OwnerTokenPool(verified,clock);self.closed=False
    def close(self):self.closed=True;self.pool.close()
    def __enter__(self):return self
    def __exit__(self,*_):self.close()
    def _open(self):need(not self.closed)
    def dispatch(self,kind,request):
        self._open();need(kind in ('publication','provision'))
        if kind=='publication':from .registry_publish_cli import run_command
        else:from .cli import run_command
        return run_command(deepcopy(request),clock=self.clock,
            trusted_attempt_authority=self.authority_sha256,owner_token_pool=self.pool)
    def execute(self,config):
        self._open()
        from scripts.trial_guard.execution import execute
        return execute(deepcopy(config),clock=self.clock,verified_attempt=self.verified,owner_token_pool=self.pool)
    def _state(self,path,slot):
        from . import cli
        from .configuration import load_configuration
        from .journal import Journal
        from .operations import create_resolver,_final
        self._open();source=Path(path);cli.verify_owner_file(source)
        raw=source.read_bytes();need(0<len(raw)<=cli.MAX_INPUT)
        preview=json.loads(raw);manifest=json.loads(cli.private_bytes(preview['sources']['manifest']))
        head=cli.git(['rev-parse','HEAD']).decode('ascii').strip()
        config=load_configuration(source,now=self.clock.utc(),local_head=head,
            owner_context={'mode':'AzureCliCredential',**{k:manifest['owner'][k] for k in ('tenant_id','principal_id')}},
            local_source_digests=cli.local_sources(head,live=True),trusted_attempt_authority=self.authority_sha256)
        need(config['verified_attempt'].binding_digest==self.verified.binding_digest and config['live'] is True)
        name,binding=journal_descriptor(config,self.verified)
        with Journal(config['recovery']['directory'],config['recovery']['directory_digest'],binding,name=name,require_existing=True) as journal:
            cores=journal.values('core_plan');need(len(cores)==1)
            resolver=create_resolver(cores[0],manifest,config['authority_bundle'],config['resource_bindings'],verified_attempt=self.verified);receipts=journal.receipts()
            for event in journal.values('rehearsal_binding'):resolver.bind_rehearsal(event,receipts)
            for event in journal.values('runtime_binding'):resolver.bind_runtime(event,receipts,verify_policy=cli.policy_verifier(config['policy_verifier_node']))
            op=resolver.resolve(slot,receipts);receipt=receipts.get(slot)
            intents=[row for row in journal.values('intent') if row['operation_id']==slot];need(len(intents)<=1)
            if receipt is not None:
                need(receipt['request_digest']==digest(op))
                if receipt.get('terminal') is True:_final(op,receipt);return 'complete',op,receipt
            if intents:
                need(receipt is not None and (receipt.get('write_terminal') is True or receipt.get('operation_url')))
                need(len(journal.values('dispatch_poll_intent'))<35)
                journal.append('dispatch_poll_intent',{'operation_id':slot,'at':self.clock.utc().isoformat()})
                return 'reconcile',op,receipt
            need(slot!='auth-platform-secret')
            return 'create',op,receipt
    def run_group(self,config_path,group,*,sleep=time.sleep):
        self._open();need(group in GROUPS);completed=[];started=self.clock.utc()
        slots=('jobRuntime',) if group=='runtime' and self.verified.authority['schema']==9 else GROUPS[group]
        for slot in slots:
            attempted=False
            while True:
                now=self.clock.utc();need(now>=started)
                foundation=group in ('foundation','main-configuration')
                check_window(self.verified,'guardian' if foundation else 'owner_input',now)
                if foundation:need(now<parse(self.verified.activation['windows']['owner_input']['start']))
                state,op,receipt=self._state(config_path,slot)
                if state=='complete':completed.append(slot);break
                need(now<parse(op['deadline']))
                if state=='reconcile':
                    delay=max(2,(parse(receipt['not_before'])-now).total_seconds()) if receipt.get('not_before') else 2
                    need(delay<=60 and now+timedelta(seconds=delay)<parse(op['deadline']))
                    sleep(delay);command={'action':'reconcile','operation_id':slot}
                else:
                    need(not attempted);attempted=True;command={'action':'create','operation_id':slot}
                    if slot in UPDATE_FROM:command.update(action='update',creation_id=UPDATE_FROM[slot])
                final=self.clock.utc();need(final>=now and final<parse(op['deadline']))
                check_window(self.verified,'guardian' if foundation else 'owner_input',final)
                if foundation:need(final<parse(self.verified.activation['windows']['owner_input']['start']))
                self.dispatch('provision',{'config':str(config_path),**command})
        return {'status':'phase_verified','phase':group,'completed':completed,'automatic_write_retry':False}
