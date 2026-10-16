"""Manual cleanup Job entry point. Reads private configuration from stdin.

No live defaults. A launcher must bind the approved manifest and measured
runtime/successor evidence before enabling this entry point. No secrets are
created; all credentials use the injected ACA managed identity.
"""
import json
import os
import sys
import time
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
from .adapters import AzureCredential, ArmTransport, BlobJournal, BoundedHttp, Deadline, Handoff, digest,json_body
from .lifecycle import Controller, Denied, Conflict, parse,initial
from .runner import GuardianRunner


class Clock:
    utc = staticmethod(lambda: datetime.now(timezone.utc))
    monotonic = staticmethod(time.monotonic)


FIXED = {'lifecycle_id', 'rule_id', 'prepared_at', 'cleanup_at', 'deadline',
    'cloud_guard', 'ready_until', 'successor_id', 'successor_nonce', 'successor_runtime', 'cleanup_targets_digest','cleanup_strategy','owner_access'}


def report(value):
    try:
        print(json.dumps(value), flush=True)
    except Exception:
        pass  # Losing a log sink must not stop cleanup.


class PermissionHttp:
    """Final transport fence, after credential/lease awaits, for receiver access."""
    def __init__(self, wire, clock, ends_at):
        self.wire,self.clock,self.end=wire,clock,parse(ends_at)
        self.wall,self.mono,self.high=clock.utc(),clock.monotonic(),clock.utc()
    def observe(self, at):
        self.high=max(self.high,at,self.clock.utc(),self.wall+timedelta(seconds=max(0,self.clock.monotonic()-self.mono)))
        self.wall,self.mono=self.high,self.clock.monotonic()
    def __call__(self, method, url, headers, body, deadline):
        self.observe(self.clock.utc())
        now=self.high
        if (self.end-now).total_seconds() <= deadline.remaining():
            raise Denied('receiver_permission_expired')
        return self.wire(method,url,headers,body,deadline)


def assemble(config, *, http=None, clock=None, environment=None):
    if config.get('live_enabled') is not True or config.get('mode') not in ('rehearsal', 'main', 'receiver'):
        raise Denied('live_not_enabled')
    basename = 'rehearsal.json' if config['mode'] == 'rehearsal' else 'state.json'
    if urlsplit(config['journal_url']).path.split('/')[-1] != basename:
        raise Denied('journal_mode_binding')
    env = os.environ if environment is None else environment
    clock, http = clock or Clock(), http or BoundedHttp()
    fixed = deepcopy(config['immutable'])
    if (config['mode']=='rehearsal') != (fixed.get('cleanup_strategy')=='rehearsal'):
        raise Denied('rehearsal_mode_binding')
    if fixed.get('cleanup_strategy')=='rehearsal':
        if config['mode']!='rehearsal':raise Denied('rehearsal_mode_binding')
        http=PermissionHttp(http,clock,config['prearm_until'] if fixed['deadline']=='$CURRENT' else fixed['deadline'])
    if set(fixed) != FIXED or config['binding']['mode'] != 'guardian' or fixed['rule_id'] != config['binding']['rule_id'] or fixed['lifecycle_id'] != config['binding']['lifecycle_id']:
        raise Denied('immutable_configuration')
    if fixed['cleanup_strategy'] == 'single_job' and (config['mode']=='receiver' or any(fixed[k] is not None for k in ('successor_id','successor_nonce','successor_runtime'))):
        raise Denied('single_job_no_receiver')
    expected = fixed['successor_runtime'] if config['mode'] == 'receiver' else fixed['cloud_guard']
    if config['mode'] == 'receiver':
        http=PermissionHttp(http,clock,expected['permissions_until'])
    # Job execution/replica names are platform-generated. The only substitution
    # allowed by a seed is this Job's injected current runtime, never user text.
    execution = env.get('CONTAINER_APP_JOB_EXECUTION_NAME', '')
    replica = env.get('CONTAINER_APP_REPLICA_NAME', '')
    if not execution.startswith(config['job_name'] + '-') or not replica or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in execution + replica):
        raise Denied('runtime_binding')
    if expected['execution_id'].endswith('/executions/$CURRENT'):
        expected['execution_id'] = expected['execution_id'].removesuffix('$CURRENT') + execution
    if expected['replica_name'] == '$CURRENT':
        expected['replica_name'] = replica
    if (env.get('CONTAINER_APP_JOB_EXECUTION_NAME') != expected['execution_id'].split('/')[-1] or
        env.get('CONTAINER_APP_REPLICA_NAME') != expected['replica_name'] or
        env.get('CONTAINER_APP_JOB_NAME') != config['job_name']):
        raise Denied('runtime_binding')
    credential = AzureCredential('guardian', expected['principal_id'], config['tenant_id'], http, env)
    credential.token('https://management.azure.com/', Deadline(10, clock.monotonic))
    if fixed.get('cleanup_strategy') in ('single_job','rehearsal') and fixed['prepared_at']=='$CURRENT':
        # OWNER writes the exact actual ARM start only after the Job exists.
        # Read a bounded seed; then validate every static and time-derived field
        # before binding a normal immutable leased journal. No rule write here.
        seed=BlobJournal(config['journal_url'],'unresolved',credential,http,clock,immutable={})
        response=seed._request('GET',Deadline(10,clock.monotonic))
        if response['status']==404:raise Conflict('seed_not_ready')
        state=json_body(response)
        if response['status']!=200 or not response['headers'].get('etag'):raise Conflict('seed_unconfirmed')
        actual={k:deepcopy(state.get(k)) for k in FIXED}
        for key in FIXED-{'cloud_guard','prepared_at','cleanup_at','deadline','ready_until'}:
            if actual[key]!=fixed[key]:raise Denied('seed_static_binding')
        for key in expected.keys()-{'job_started_at','job_deadline'}:
            if actual['cloud_guard'].get(key)!=expected[key]:raise Denied('seed_runtime_binding')
        at=parse(actual['cloud_guard']['job_started_at'])
        if not (parse(config['seed_not_before'])<=at<=clock.utc()<parse(config['prearm_until']) and
                (clock.utc()-at).total_seconds()<300):raise Denied('seed_time_binding')
        derived=initial(at=at.isoformat(),rule_id=actual['rule_id'],lifecycle_id=actual['lifecycle_id'],guardian_pid=None,
            independent_guard_verified=True,cleanup_seconds=600 if fixed['cleanup_strategy']=='single_job' else None,
            cloud_guard=actual['cloud_guard'],cleanup_strategy=fixed['cleanup_strategy'])
        if any(actual[k]!=derived[k] for k in ('prepared_at','cleanup_at','deadline','ready_until')):
            raise Denied('seed_deadlines')
        if state.get('binding_digest')!=digest({'binding':config['binding'],'immutable':actual}):raise Denied('seed_digest')
        fixed,expected=actual,actual['cloud_guard']
        if fixed['cleanup_strategy']=='rehearsal':
            http.end=min(http.end,parse(fixed['deadline']))
    journal = BlobJournal(config['journal_url'], digest({'binding': config['binding'], 'immutable': fixed}), credential, http, clock, immutable=fixed)
    # OWNER creates this exact immutable state after ARM returns the current
    # execution/replica IDs, before any firewall PUT. No seed may invent them.
    with journal.locked():
        state = journal.load()
    evidence = state.get('successor_readback' if config['mode'] == 'receiver' else 'runtime_readback') or {}
    if (evidence.get('execution_id') != expected['execution_id'] or evidence.get('image_digest') != expected['image_digest'] or
        evidence.get('principal_id') != expected['principal_id'] or evidence.get('status') != 'Running' or
        not 0 <= (clock.utc() - parse(evidence['at'])).total_seconds() <= 60):
        raise Denied('runtime_readback_missing')
    if fixed['cleanup_strategy'] in ('single_job','rehearsal') and evidence.get('job_started_at')!=expected['job_started_at']:
        raise Denied('actual_start_readback_missing')
    if fixed['cleanup_strategy']=='rehearsal' and (state.get('put') is not None or state.get('delete') is not None or state.get('usage_allowed') is not False):
        raise Denied('rehearsal_write_binding')
    transport = ArmTransport(config['binding'], credential, http, clock, journal.assert_send_lease)
    actor = expected['principal_id'] + ':' + expected['execution_id']
    if config['mode'] == 'receiver' and (actor != fixed['successor_id'] or expected['nonce'] != fixed['successor_nonce'] or
            evidence.get('independent_of_owner_pc') is not True or evidence.get('entrypoint') != 'python -m trial_guard' or
            evidence.get('mode') != 'receiver' or not parse(fixed['deadline']) <= parse(expected['available_until']) <= parse(evidence['available_until']) or
            not parse(expected['available_until']) <= parse(expected['permissions_until']) <= parse(evidence['permissions_until'])):
        raise Denied('successor_runtime_unverified')

    def proof():
        # Controller calls under its existing lease: no nested lock.
        s = journal.state or {}
        hb = s.get('owner_heartbeat') or {}
        alive = (hb.get('lifecycle_id') == fixed['lifecycle_id'] and hb.get('nonce') == expected['nonce'] and
                 hb.get('at') is not None and 0 <= (clock.utc() - parse(hb['at'])).total_seconds() <= 15)
        return {**expected, 'kind': 'azure_job', 'alive': alive, 'runtime_verified': True,
                'lifecycle_id': fixed['lifecycle_id'], 'at': clock.utc().isoformat()}

    controller = Controller(journal, transport, clock, proof, actor_id=actor)

    def successor():
        with journal.locked():
            return journal.load().get('successor_runtime_proof') or {}

    runner = GuardianRunner(controller, journal, clock, actor, successor)
    return runner, journal, transport, clock


def run(config):
    # Bounded prearm wait for the OWNER-created immutable state. No firewall
    # operation is possible during this wait. Failure never starts another Job.
    ready = parse(config['prearm_until'] if config['immutable']['ready_until']=='$CURRENT' else config['immutable']['ready_until'])
    if config.get('mode') != 'receiver' and not 0 < (ready - Clock.utc()).total_seconds() <= 300:
        raise Denied('ready_window')
    while True:
        try:
            runner, journal, transport, clock = assemble(config)
            break
        except Conflict:
            if config.get('mode') == 'receiver' or Clock.utc() >= ready:
                raise Denied('prearm_expired') from None
            time.sleep(2)
    if config['mode'] == 'rehearsal':
        # Exact absence/read/lease/CAS only. Never a firewall mutation or AI call.
        with journal.locked():
            state = journal.load()
            if state.get('put') is not None:
                raise Denied('rehearsal_write_exists')
            observed = transport.inspect(rule_id=state['rule_id'], lifecycle_id=state['lifecycle_id'], timeout=20)
            if not (observed.get('rule') == 'absent' and observed.get('complete_list') and observed.get('network_unchanged') and observed.get('existing_rules_unchanged')):
                raise Denied('rehearsal_unconfirmed')
            state.update(version=state['version']+1, rehearsal={'at': clock.utc().isoformat(), 'reads_and_cas': True, 'delete_measured': False})
            journal.save(state, expected_version=state['version']-1)
        return {'status': 'rehearsal_reads_verified', 'live_delete_verified': False}
    if config['mode'] == 'receiver':
        return run_receiver(runner, journal, clock, config)
    runner.opening_gate()
    last_report = None
    while True:
        try:
            result = runner.step()
        except Exception:
            result = {'closed': False, 'exit': False, 'attention': 'cleanup_recovery_required'}
        message = {k: result[k] for k in ('closed', 'transferred', 'attention', 'deadline_exceeded') if k in result}
        if message != last_report:
            report(message); last_report = message
        if result.get('exit'):
            return {'status': 'closed' if result['closed'] else 'responsibility_transferred'}
        # No fresh execution, period extension or timeout-as-success fallback.
        time.sleep(2)


def run_receiver(runner, journal, clock, config, pause=time.sleep):
    """Already-running, separately approved receiver; never creates a resource.

    Its fixed runtime and original guardian binding are independent. Publishing
    a proof is not handoff acceptance; acceptance requires a fenced recovery tick.
    """
    last_report = None
    while True:
        try:
            result = receiver_step(runner, journal, clock)
        except Exception:
            result = {'status': 'cleanup_recovery_required', 'closed': False}
        if result != last_report:
            report(result); last_report = result
        if result.get('closed'):
            return result
        # Ordinary contention or exhausted availability never releases duty.
        pause(2)


def receiver_step(runner, journal, clock):
        with journal.locked():
            state = journal.load()
            runtime = state['successor_runtime']
            now=runner.effective_now(state)
            # Availability is immutable and ARM-readback-verified at assembly.
            # Do not renew the runtime's end simply by refreshing its heartbeat.
            if state['status'] == 'closed':
                return {'status': 'closed', 'closed': True}
            handoff = state.get('handoff') or {}
            claimed = (isinstance(handoff.get('claim_token'),str) and bool(handoff['claim_token']) and bool(handoff.get('nonce')) and
                handoff.get('deadline') == state['deadline'] and handoff.get('claim_at') is not None and
                parse(state['prepared_at']) <= parse(handoff['claim_at']) < parse(runtime['available_until']) and parse(handoff['claim_at']) <= now)
            owned = (handoff.get('accepted') or claimed) and handoff.get('to') == runner.actor_id and state.get('writer_actor') == runner.actor_id
            expired = now >= parse(runtime['available_until'])
            if now >= parse(runtime['permissions_until']):
                return {'status': 'cleanup_permissions_expired', 'closed': False}
            if expired and not owned:
                return {'status': 'cleanup_availability_expired', 'closed': False}
            proof = {'actor': runner.actor_id, 'lifecycle_id': state['lifecycle_id'], 'nonce': state['successor_nonce'],
                'runtime_verified': True, 'independent_of_owner_pc': True, 'alive': True,
                'accepted_cleanup_responsibility': True, 'available_until': runtime['available_until'], 'permissions_until': runtime['permissions_until'],
                'at': now.isoformat(), 'entrypoint': 'python -m trial_guard', 'mode': 'receiver',
                'image_digest': runtime['image_digest'], 'execution_id': runtime['execution_id'], 'principal_id': runtime['principal_id'],
                'replica_name': runtime['replica_name'], 'writer_epoch': (state.get('handoff') or {}).get('claim_token', 'prearmed')}
            if not expired:
                state.update(version=state['version']+1, successor_runtime_proof=proof,last_now=now.isoformat())
                journal.save(state, expected_version=state['version']-1)
        if state['status'] == 'closed':
            return {'status': 'closed', 'closed': True}
        handoff = state.get('handoff') or {}
        if not handoff:
            handoff=runner.handoff.offer_after_sender_deadline() or {}
        if handoff.get('to') == runner.actor_id:
            if not handoff.get('accepted') and not expired:
                Handoff(journal, clock, runner.actor_id).accept(runner.controller)
            result = runner.step()
            if result.get('closed'):
                return {'status': 'closed', 'closed': True}
        return {'status': 'cleanup_availability_expired' if expired else 'recovery_active' if handoff.get('to') == runner.actor_id else 'receiver_ready', 'closed': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise Denied('stdin_only')
        configured = os.environ.pop('TRIAL_GUARD_CONFIG_JSON', None)
        raw = configured.encode() if configured is not None else sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise Denied('configuration_limit')
        print(json.dumps(run(json.loads(raw))))
    except Exception:
        print('{"status":"cleanup_recovery_required","closed":false}')
        raise SystemExit(2)
