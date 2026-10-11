"""Private CLI bridge for the finite guardian rehearsal adapter.

The caller has already checked OWNER-only file protection and SHA256 for the
exact {owner, guardian} bundle. No user-supplied operation JSON is accepted.
The existing provisioning Journal holds the exclusive writer lock throughout;
the existing ControlBudget is reopened by the caller, never initialized here.
"""
from copy import deepcopy
from datetime import timedelta
from urllib.parse import urlsplit

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.execution import CountedHttp
from scripts.trial_guard.lifecycle import Denied, parse
from .rehearsal import GuardianRehearsalAdapter, successful


class _Clock:
    """Reuse the journal high-water mark; no restart or rollback renews time."""
    def __init__(self, journal, clock):
        self.journal, self.clock = journal, clock
        past = [parse(v['at']) for event in ('intent', 'clock_observation') for v in journal.values(event)]
        past += [parse(v['observed_at']) for v in journal.values('progress') if 'observed_at' in v]
        now = clock.utc()
        self.wall, self.tick = max([now] + past), clock.monotonic()
        self.observed_wall = now
        self.unsafe = bool(journal.values('clock_revoked'))
        if now < self.wall:
            self._revoke()
    def _revoke(self):
        self.unsafe = True
        if not self.journal.values('clock_revoked'):
            self.journal.append('clock_revoked', {'at': self.wall.isoformat()})
    def utc(self):
        now, tick = self.clock.utc(), self.clock.monotonic()
        # The effective deadline clock may lead the wall clock between coarse
        # UTC ticks. Compare rollback with the previous raw UTC observation,
        # while retaining monotonic elapsed time for every deadline check.
        if now < self.observed_wall or tick < self.tick:
            self._revoke()
        self.observed_wall = now
        self.wall, self.tick = max(now, self.wall + timedelta(seconds=max(0, tick - self.tick))), tick
        return self.wall
    def monotonic(self): return self.clock.monotonic()


class _Audit:
    def __init__(self, journal): self.journal = journal
    def consume(self, kind, limit):
        # CountedHttp debits the one persistent lifetime budget first. This is
        # only audit detail, never an independent or resettable allowance.
        self.journal.append('rehearsal_request', {'kind': kind, 'limit': limit})


def _require(value):
    if not value:
        raise Denied('rehearsal_cli_binding')


def _summary(action, receipt):
    props = receipt.get('properties', {})
    return {'status': receipt.get('state', 'unknown'), 'phase': action,
        'terminal': receipt.get('terminal') is True,
        'rehearsal_verified': receipt.get('operation_id') == 'guardRehearsal' and successful(receipt),
        'cleanup_verified': props.get('cleanup_verified') is True,
        'live_delete_verified': False}


def run_rehearsal(action, configbundle, journal, resolver, credential, raw_wire, budget, clock):
    """Run one start/poll/seed/verify step; return a sanitized, ID-free result.

    Trusted generated operations are stored separately from the initial plan.
    A known start ACK may be read; an unknown POST or seed is never resent.
    verify success records a local observation intent and rehearsal_binding;
    it does not delete the retained Blob, start main, or open the DB rule.
    """
    _require(action in ('start', 'poll', 'seed', 'verify'))
    _require(isinstance(configbundle, dict) and set(configbundle) == {'owner', 'guardian'})
    bundle = deepcopy(configbundle)
    binding = digest(bundle)
    old_binding = journal.values('rehearsal_config_binding')
    _require(not old_binding or old_binding == [binding])
    receipts = journal.receipts()
    create = resolver.resolve('guard', receipts)
    created = receipts.get('guard')
    _require(successful(created))
    fenced = _Clock(journal, clock)
    counted = CountedHttp(raw_wire, _Audit(journal), shared_budget=budget)
    fixed_blob = bundle['owner']['journal_url']

    def dispatch(method, url, headers, body, deadline):
        # The adapter enforces the exact ARM Job and ACK-derived LRO routes.
        # Here the existing generic Blob counter is additionally confined to
        # the one reviewed path and its finite lease sub-operation.
        u = urlsplit(url)
        _require(u.netloc == 'management.azure.com' or url in (fixed_blob, fixed_blob + '?comp=lease'))
        return counted(method, url, headers, body, deadline)

    def register(op):
        _require(op['id'] in adapter.operations and digest(adapter.operations[op['id']]) == digest(op))
        old = [v['operation'] for v in journal.values('rehearsal_operation') if v['operation_id'] == op['id']]
        _require(not old or old == [op])
        if not old:
            journal.append('rehearsal_operation', {'operation_id': op['id'], 'operation': deepcopy(op)})

    def before_send(op):
        _require(op['id'] in adapter.operations and digest(adapter.operations[op['id']]) == digest(op))
        now = fenced.utc()
        _require(not fenced.unsafe and now < parse(op['deadline']))
        for prior in journal.values('intent'):
            _require((journal.latest(prior['operation_id']) or {}).get('terminal') is True)
        current = journal.receipts()
        for dependency in op['depends_on']:
            _require(successful(current.get(dependency)))
        register(op)
        journal.append('clock_observation', {'at': now.isoformat()})
        journal.intent(op, now.isoformat())

    def checkpoint(receipt):
        op = adapter.operations.get(receipt['operation_id'])
        _require(op is not None)
        register(op)
        journal.checkpoint(op, receipt)

    adapter = GuardianRehearsalAdapter(create, created, bundle['owner'], bundle['guardian'],
        credential, dispatch, fenced, before_send=before_send, checkpoint=checkpoint)
    if not old_binding:
        journal.append('rehearsal_config_binding', binding)
    saved = journal.values('rehearsal_operation')
    for row in saved:
        op = row['operation']
        _require(row['operation_id'] == op['id'] and op['id'] in ('guardRehearsalStart', 'guardRehearsalSeed', 'guardRehearsal'))
        if op['id'] in adapter.operations:
            _require(op == adapter.operations[op['id']])
        else:
            adapter.operations[op['id']] = deepcopy(op)

    existing = journal.values('rehearsal_binding')
    if existing:
        _require(len(existing) == 1)
        event = existing[0]
        _require(event['receipt'] == journal.latest('guardRehearsal'))
        resolver.bind_rehearsal(event, journal.receipts())
        return _summary(action, event['receipt'])

    def latest(ident):
        return journal.latest(ident)

    if action == 'start':
        if any(v['operation_id'] == 'guardRehearsalStart' for v in journal.values('intent')):
            receipt = latest('guardRehearsalStart') or adapter._base(adapter.start_op)
            if latest('guardRehearsalStart') is None:
                checkpoint(receipt)
            return _summary(action, receipt)
        _require(not fenced.unsafe)
        _, result = adapter.start()
    elif action == 'poll':
        result = latest('guardRehearsalStart')
        _require(result is not None)
        if result.get('write_terminal') is not True and result.get('operation_url'):
            if fenced.utc() >= parse(result['not_before']):
                result = adapter.poll_start(result)
    elif action == 'seed':
        if any(v['operation_id'] == 'guardRehearsalSeed' for v in journal.values('intent')):
            result = latest('guardRehearsalSeed')
            if result is None:
                seed_op = adapter.operations['guardRehearsalSeed']
                result = adapter._base(seed_op, fixed_blob)
                checkpoint(result)
            return _summary(action, result)
        started = latest('guardRehearsalStart')
        _require(started is not None)
        _require(not fenced.unsafe)
        _, result = adapter.initialize(started)
    else:
        started, seed = latest('guardRehearsalStart'), latest('guardRehearsalSeed')
        _require(started is not None and seed is not None and 'guardRehearsalSeed' in adapter.operations)
        op, result = adapter.verify(started, adapter.operations['guardRehearsalSeed'], seed)
        if successful(result):
            register(op)
            previous = latest('guardRehearsal')
            if previous is None or previous.get('terminal') is not True:
                intents = [v for v in journal.values('intent') if v['operation_id'] == op['id']]
                _require(not intents or (len(intents) == 1 and intents[0]['request_digest'] == digest(op)
                    and intents[0]['method'] == 'GET' and intents[0]['url'] == op['url']))
                if not intents:
                    journal.intent(op, fenced.utc().isoformat())  # Local observation only.
                checkpoint(result)
            else:
                _require(successful(previous) and previous['request_digest'] == digest(op))
                result = previous
            event = {'initial_plan_digest': resolver.plan_digest, 'operation': deepcopy(op), 'receipt': deepcopy(result)}
            resolver.bind_rehearsal(event, journal.receipts())
            journal.append('rehearsal_binding', event)
        else:
            journal.append('rehearsal_observation', _summary(action, result))
    return _summary(action, result)
