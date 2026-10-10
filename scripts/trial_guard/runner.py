"""One bounded guardian step and explicit handoff; no scheduler or live default."""
from copy import deepcopy
from datetime import timedelta
from .lifecycle import Denied, parse
from .adapters import Handoff, digest


class GuardianRunner:
    def __init__(self, controller, journal, clock, actor_id, successor_probe):
        self.controller, self.journal, self.clock = controller, journal, clock
        self.actor_id, self.successor_probe = actor_id, successor_probe
        self.handoff = Handoff(journal, clock, actor_id)
        self.anchor_wall,self.anchor_mono,self.high=clock.utc(),clock.monotonic(),clock.utc()

    def effective_now(self, state):
        self.high=max(self.high,self.clock.utc(),parse(state['last_now']),self.anchor_wall+timedelta(seconds=max(0,self.clock.monotonic()-self.anchor_mono)))
        self.anchor_wall,self.anchor_mono=self.high,self.clock.monotonic()
        return self.high

    def opening_gate(self):
        with self.journal.locked():
            state = self.journal.load()
        proof = self.successor_probe()
        now = self.effective_now(state)
        runtime = state.get('successor_runtime') or {}
        if not (proof.get('actor') == state['successor_id'] and proof.get('lifecycle_id') == state['lifecycle_id'] and
                proof.get('nonce') == state['successor_nonce'] and proof.get('runtime_verified') is True and
                proof.get('independent_of_owner_pc') is True and proof.get('alive') is True and
                proof.get('accepted_cleanup_responsibility') is True and
                proof.get('entrypoint') == 'python -m trial_guard' and proof.get('mode') == 'receiver' and
                all(proof.get(k) and proof.get(k) == runtime.get(k) for k in ('image_digest', 'execution_id', 'principal_id', 'replica_name', 'available_until', 'permissions_until')) and
                proof.get('writer_epoch') == 'prearmed' and
                0 <= (now - parse(proof['at'])).total_seconds() <= 15 and
                parse(proof['permissions_until']) >= parse(proof['available_until']) >= parse(state['deadline'])):
            raise Denied('independent_successor_required')
        return True

    def step(self):
        with self.journal.locked():
            state = self.journal.load()
        if state['status'] == 'closed':
            return {'closed': True, 'exit': True, 'transferred': False}
        end = parse(state['cloud_guard']['job_deadline'])
        h = state.get('handoff') or {}
        if h.get('to') == self.actor_id and state.get('writer_actor') == self.actor_id:
            result = self.controller.tick()
            return {'closed': result['status'] == 'closed', 'exit': result['status'] == 'closed', 'transferred': False, 'status': result['status']}
        if state.get('handoff') or state['status'] == 'recovery_pending' or (end - self.clock.utc()).total_seconds() <= 300:
            if not state.get('handoff'):
                self.handoff.request()
            accepted = self.handoff.accepted()
            if not accepted:
                self.handoff.reclaim_stale_claim()
                with self.journal.locked():
                    current = self.journal.load()
                if current.get('writer_actor') == self.actor_id and self.controller is not None:
                    result = self.controller.tick()
                    if result['status'] == 'closed':
                        return {'closed': True, 'exit': True, 'transferred': False}
            # Job timeout cannot convert an unaccepted handoff into success.
            return {'closed': False, 'exit': accepted, 'transferred': accepted,
                    'attention': None if accepted else 'cleanup_handoff_required',
                    'deadline_exceeded': self.clock.utc() >= end}
        result = self.controller.tick()
        return {'closed': result['status'] == 'closed', 'exit': result['status'] == 'closed',
                'transferred': False, 'status': result['status']}


def validate_creation_cleanup(manifest, state):
    """Pure deletion plan. This never calls ARM and cannot accept arbitrary IDs."""
    if not (state.get('status') == 'closed' and state.get('rule_absent') is True and
            state.get('cleanup_responsibility_retained') is False):
        raise Denied('rule_cleanup_not_terminal')
    entries = manifest['created']
    approved = manifest.get('approved', [])
    if not approved or state.get('cleanup_targets_digest') != digest(approved):
        raise Denied('cleanup_manifest_unbound')
    targets = {e['id']: e for e in approved}
    if any(e.get('purpose') != 'guardian' or not e.get('created_by_this_run') for e in entries):
        raise Denied('cleanup_creation_ownership')
    for e in entries:
        fixed, receipt = targets.get(e['id']), e.get('creation_receipt') or {}
        if not fixed or fixed.get('kind') != e['kind'] or fixed.get('purpose') != e['purpose'] or receipt.get('terminal') != 'succeeded' or receipt.get('resource_id') != e['id'] or not receipt.get('request_id'):
            raise Denied('cleanup_receipt_unbound')
    if len({e['id'] for e in entries}) != len(entries):
        raise Denied('duplicate_cleanup_target')
    # Definitions cannot disappear while trial/operator assignments still use them.
    if any(e['kind'] in ('roleDefinition', 'image') and e.get('remaining_references') != 0 for e in entries):
        raise Denied('definition_still_referenced')
    order = {'roleAssignment': 0, 'job': 1, 'roleDefinition': 2, 'image': 3, 'journal': 4}
    if any(e['kind'] not in order for e in entries):
        raise Denied('cleanup_kind')
    return sorted(deepcopy(entries), key=lambda e: order[e['kind']])
