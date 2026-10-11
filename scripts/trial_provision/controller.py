"""Finite orchestration of reviewed operations; journal intent precedes writes."""
from copy import deepcopy
from datetime import timedelta
import re

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse


def cleanup_only(op):
    return (op['method']=='DELETE' or op['kind'].startswith('cleanup:') or
            op['expected'].get('auth_action','').startswith('cleanup:'))


class Controller:
    """Transport-independent executor, with explicit create vs recovery paths.

    resolve(id, receipts) materializes an operation from the immutable approved
    plan, never from a caller URL. Provider readback cannot adopt an unknown
    write. A new process may reconcile known attempts, but cannot repeat them.
    """
    def __init__(self, journal, clock, resolve, allowed_ids, adapters, *, easy_auth=None,
                 send_guard=None):
        if (not isinstance(allowed_ids,(list,tuple)) or len(allowed_ids)>128 or
            len(set(allowed_ids))!=len(allowed_ids) or
            any(not re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,63}',v) for v in allowed_ids)):
            raise Denied('operation_ids')
        self.journal,self.clock,self.resolve=journal,clock,resolve
        self.allowed,self.adapters=set(allowed_ids),adapters
        self.easy_auth,self.send_guard=easy_auth,send_guard
        actual=clock.utc()
        historical=[parse(v['at']) for v in journal.values('intent')]
        historical += [parse(v['at']) for v in journal.values('clock_observation')]
        self.wall,self.mono=max([actual]+historical),clock.monotonic()
        self.observed_wall=actual
        self.clock_unsafe=bool(journal.values('clock_revoked'))
        if actual<self.wall:self._revoke_clock()

    def _revoke_clock(self):
        self.clock_unsafe=True
        if not self.journal.values('clock_revoked'):
            self.journal.append('clock_revoked',{'at':self.wall.isoformat()})

    def now(self):
        actual=self.clock.utc();tick=self.clock.monotonic()
        derived=self.wall+timedelta(seconds=max(0,tick-self.mono))
        # Elapsed monotonic time can advance self.wall between raw UTC ticks.
        # That conservative deadline estimate is not a clock rollback.
        if actual<self.observed_wall or tick<self.mono:self._revoke_clock()
        self.observed_wall=actual
        self.wall,self.mono=max(actual,derived),tick
        return self.wall

    def _new_write_gate(self, op):
        if self.clock_unsafe:raise Denied('clock_rollback')
        for intent in self.journal.values('intent'):
            result=self.journal.latest(intent['operation_id']) or {}
            if result.get('terminal') is not True:raise Denied('prior_attempt_unresolved')

    def operation(self, operation_id):
        if operation_id not in self.allowed:raise Denied('operation_outside_plan')
        op=self.resolve(operation_id,self.journal.receipts())
        if (set(op)!={'id','provider','kind','method','url','body','deadline','depends_on','expected','cleanup'}
            or op['id']!=operation_id or op['provider'] not in self.adapters):
            raise Denied('operation_shape')
        return op

    def _dependencies(self, op):
        receipts=self.journal.receipts()
        for key in op['depends_on']:
            r=receipts.get(key,{})
            if r.get('state')!='succeeded' or r.get('terminal') is not True or r.get('readback_verified') is not True:
                raise Denied('dependency_unverified')

    def before_send(self, op):
        fixed=self.operation(op['id'])
        if digest(fixed)!=digest(op):raise Denied('operation_changed')
        self._dependencies(op)
        if self.now()>=parse(op['deadline']) and not cleanup_only(op):raise Denied('operation_expired')
        if self.clock_unsafe and not cleanup_only(op):
            raise Denied('clock_rollback')
        if self.send_guard is not None:self.send_guard(op,self.now())
        self.journal.append('clock_observation',{'at':self.now().isoformat()})
        return self.journal.intent(op,self.now().isoformat())

    def checkpoint(self, receipt):
        op=self.operation(receipt['operation_id'])
        self.journal.checkpoint(op,receipt)

    def _unknown(self, op):
        old=self.journal.latest(op['id'])
        if old:return old
        result={'operation_id':op['id'],'request_digest':digest(op),'state':'unknown',
                'terminal':False,'write_terminal':False,'readback_verified':False}
        self.journal.checkpoint(op,result)
        return result

    def create(self, operation_id, *, secret_delivery=None):
        op=self.operation(operation_id);self._dependencies(op)
        if op['method'] not in ('PUT','POST','PATCH'):raise Denied('not_create_operation')
        if self.now()>=parse(op['deadline']):raise Denied('operation_expired')
        prior=self.journal.values('intent')
        if any(v['operation_id']==operation_id for v in prior):
            raise Denied('operation_already_attempted')
        self._new_write_gate(op)
        adapter=self.adapters[op['provider']]
        try:
            action=op['expected'].get('auth_action')
            if action:
                if self.easy_auth is None:raise Denied('auth_adapter_required')
                if action=='authConfigs':method=self.easy_auth.execute
                elif action=='authIngress':method=self.easy_auth.enable_ingress
                else:raise Denied('secret_delivery_callback_only')
                result=method(op,self.journal.receipts(),self.before_send,self.checkpoint)
                if result is not None:self.journal.checkpoint(op,result)
                return self.journal.latest(op['id'])
            if op['provider']=='Microsoft.Graph':
                if op['kind']=='addPassword' and secret_delivery is None:
                    secret_delivery=self.deliver_secret
                result=adapter.execute(op,self.journal.receipts(),before_send=self.before_send,
                    checkpoint=self.checkpoint,deliver_secret=secret_delivery)
                if result is not None:self.journal.checkpoint(op,result)
                return self.journal.latest(op['id'])
            evidence=adapter.readback(op)
            if evidence.get('state')!='absent':raise Denied('create_target_not_absent')
            # Validation/readback have not sent a mutation. Journal last.
            self.before_send(op)
            result=adapter.send(op,evidence)
            self.journal.checkpoint(op,result)
            return self.reconcile(operation_id)
        except BaseException:
            if any(v['operation_id']==operation_id for v in self.journal.values('intent')):
                return self._unknown(op)
            raise

    def reconcile(self, operation_id, *, max_reads=8):
        if type(max_reads) is not int or not 1<=max_reads<=8:raise Denied('read_limit')
        op=self.operation(operation_id)
        receipt=self.journal.latest(operation_id)
        if receipt is None:
            if not any(v['operation_id']==operation_id for v in self.journal.values('intent')):
                raise Denied('operation_not_attempted')
            return self._unknown(op)
        adapter=self.adapters[op['provider']]
        for _ in range(max_reads):
            if receipt.get('terminal') is True:return receipt
            # No transport evidence: neither a GET match nor GET404 may adopt it.
            if not receipt.get('write_terminal') and not receipt.get('operation_url'):return receipt
            try:
                action=op['expected'].get('auth_action')
                if action:
                    if self.easy_auth is None:raise Denied('auth_adapter_required')
                    readers={'authPlatformSecret':self.easy_auth.readback,
                        'authConfigs':self.easy_auth.readback_config,
                        'authIngress':self.easy_auth.readback_ingress}
                    if action not in readers:raise Denied('cleanup_requires_creation_context')
                    updated=readers[action](op,receipt)
                elif op['kind'].startswith('cleanup:'):
                    raise Denied('cleanup_requires_creation_context')
                elif receipt.get('write_terminal'):
                    updated=adapter.readback(op,receipt)
                else:
                    updated=adapter.poll(op,receipt)
                self.journal.checkpoint(op,updated)
                receipt=updated
                # Bound one pending LRO poll per invocation; no hot polling.
                if not receipt.get('write_terminal') and receipt.get('terminal') is not True:return receipt
            except BaseException:return receipt
        return receipt

    def deliver_secret(self, secret, credential_receipt):
        if self.easy_auth is None:raise Denied('auth_adapter_required')
        op=self.operation('auth-platform-secret')
        predecessor=op['expected']['update_from']['operation_id']
        self._dependencies(op)
        result=self.easy_auth.deliver(op,secret,credential_receipt,self.before_send,
            self.checkpoint,self.journal.latest(predecessor))
        if result is not None:self.journal.checkpoint(op,result)
        return self.journal.latest(op['id'])

    def _auth_cleanup(self, op, created_op, created):
        adapter=self.adapters[op['provider']]
        action=op['expected'].get('auth_action')
        old=self.journal.latest(op['id'])
        attempted=any(v['operation_id']==op['id'] for v in self.journal.values('intent'))
        if attempted:
            if old is None:return self._unknown(op)
            if old.get('terminal') is True:return old
            if not old.get('write_terminal') and not old.get('operation_url'):return old
            if op['provider']=='Microsoft.Graph':
                result=adapter.readback_cleanup(created_op,created,op,old)
            else:
                result=self.easy_auth.readback(op,old)
            self.journal.checkpoint(op,result)
            return result
        try:
            if op['provider']=='Microsoft.Graph':
                result=adapter.cleanup(created_op,created,op,self.before_send,self.checkpoint)
            else:
                if self.easy_auth is None:raise Denied('auth_adapter_required')
                if action=='cleanup:authPlatformSecret':method=self.easy_auth.cleanup_secret
                elif action=='cleanup:authConfigs':method=self.easy_auth.cleanup_auth
                elif action=='cleanup:authIngress':method=self.easy_auth.cleanup_ingress
                else:raise Denied('auth_cleanup_action')
                result=method(created_op,created,op,self.before_send,self.checkpoint)
            if result is not None:self.journal.checkpoint(op,result)
            return self.journal.latest(op['id'])
        except BaseException:
            if any(v['operation_id']==op['id'] for v in self.journal.values('intent')):
                return self._unknown(op)
            raise

    def cleanup(self, operation_id, creation_id, *, reference_evidence=None):
        op=self.operation(operation_id)
        special=op['kind'].startswith('cleanup:') or op['expected'].get('auth_action','').startswith('cleanup:')
        if op['method']!='DELETE' and not special:raise Denied('cleanup_method')
        created_op=self.operation(creation_id)
        created=self.journal.latest(creation_id) or {}
        if (created.get('state')!='succeeded' or created.get('terminal') is not True or
            created.get('readback_verified') is not True or created.get('created_by_run') is not True
            or created.get('request_digest')!=digest(created_op)):
            raise Denied('cleanup_ownership_unproven')
        if special:return self._auth_cleanup(op,created_op,created)
        if any(v['operation_id']==operation_id for v in self.journal.values('intent')):
            return self.reconcile(operation_id)
        adapter=self.adapters[op['provider']]
        inspect=getattr(adapter,'inspect_cleanup',None)
        evidence=inspect(created_op,created,op) if inspect else adapter.readback(created_op)
        if evidence.get('state')!='matching':
            raise Denied('cleanup_current_binding')
        self.before_send(op)
        try:
            result=adapter.cleanup(op,created_op,created,evidence,reference_evidence)
            self.journal.checkpoint(op,result)
            return self.reconcile(operation_id)
        except BaseException:return self._unknown(op)

    def update(self, operation_id, predecessor_id):
        op=self.operation(operation_id)
        if op['method'] not in ('PATCH','PUT') or op['expected'].get('before_absent') is not False:
            raise Denied('update_method')
        previous_op=self.operation(predecessor_id)
        previous=self.journal.latest(predecessor_id) or {}
        if (previous.get('state')!='succeeded' or previous.get('terminal') is not True
            or previous.get('readback_verified') is not True or previous.get('created_by_run') is not True
            or previous.get('request_digest')!=digest(previous_op)):
            raise Denied('update_ownership_unproven')
        if any(v['operation_id']==operation_id for v in self.journal.values('intent')):
            return self.reconcile(operation_id)
        self.now()
        self._new_write_gate(op)
        adapter=self.adapters[op['provider']]
        evidence=adapter.readback(previous_op)
        if evidence.get('state')!='matching':
            raise Denied('update_current_binding')
        self.before_send(op)
        try:
            result=adapter.update(op,previous_op,previous,evidence)
            self.journal.checkpoint(op,result)
            return self.reconcile(operation_id)
        except BaseException:return self._unknown(op)

    def summary(self):
        attempts=self.journal.values('intent')
        values=[self.journal.latest(v['operation_id']) or {} for v in attempts]
        return {'attempts':len(attempts),
            'succeeded':sum(v.get('state')=='succeeded' for v in values),
            'failed':sum(v.get('state')=='failed' for v in values),
            'unresolved':sum(v.get('terminal') is not True for v in values)}
