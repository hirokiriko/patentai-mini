"""Local proof import for one completed, guarded database bootstrap.

No credential, network, SQL, retry or recovery adoption lives here. The trusted
launcher records Node's real result in its locked hash chain; this bridge checks
that chain, the closed guardian session, and every protected proof byte again.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import re

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.execution import execution_binding
from scripts.trial_guard.lifecycle import Denied, parse
from .configuration import _json, _path
from .private_io import verify_owner_file


HEX = r'[a-f0-9]{64}'
POLICY_KEYS = {'DEPLOYMENT_KIND', 'TRIAL_POLICY_JSON', 'TRIAL_POLICY_SIGNATURE', 'TRIAL_POLICY_PUBLIC_KEY'}


def _need(value):
    if not value: raise Denied('bootstrap_proof_unconfirmed')


def _read(path, maximum):
    path = _path(path)
    verify_owner_file(path)
    before = path.stat()
    _need(0 < before.st_size <= maximum)
    with path.open('rb') as stream: raw = stream.read(maximum + 1)
    after = path.stat()
    verify_owner_file(path)
    _need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
          (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and len(raw) == after.st_size)
    return raw


@contextmanager
def _closed_chain(config):
    directory = _path(config['recovery_directory'], directory=True)
    _need(digest(str(directory)) == config['recovery_directory_digest'])
    lock_path = _path(directory / 'trial-session.lock')
    verify_owner_file(lock_path)
    # r+b never creates a missing recovery file. The byte-range lock is the
    # launcher's own lock, so a running or recovering guardian cannot race us.
    with lock_path.open('r+b') as lock:
        try:
            lock.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError: raise Denied('bootstrap_session_running') from None
        raw = _read(directory / 'trial-session.jsonl', 16 * 1024**2)
        _need(raw.endswith(b'\n'))
        rows, previous = [], '0' * 64
        for line in raw.splitlines():
            row = _json(line); proof = row.pop('hash', None)
            _need(row.get('sequence') == len(rows) and row.get('previous') == previous and digest(row) == proof)
            rows.append(row); previous = proof
        _need(rows[0] == {'sequence': 0, 'previous': '0' * 64, 'event': 'configuration',
            'value': {'configuration_digest': digest(execution_binding(config))}})
        yield rows, hashlib.sha256(raw).hexdigest()


def _one(rows, event):
    values = [r for r in rows if r['event'] == event]
    _need(len(values) == 1)
    return values[0]


def _complete(receipt):
    return isinstance(receipt, dict) and receipt.get('state') == 'succeeded' and all(
        receipt.get(k) is True for k in ('terminal', 'write_terminal', 'created_by_run', 'readback_verified'))


def _observed(receipt):
    return isinstance(receipt, dict) and receipt.get('state') == 'succeeded' and all(
        receipt.get(k) is True for k in ('terminal', 'readback_verified'))


def _validate(config, journal, resolver, verify_policy, *, verified_attempt=None):
    payload = config['worker']['payload']
    _need(config['live_enabled'] is True and payload['bootstrap']['mode'] in ('apply','reconcile'))
    staged=config['worker'].get('mode')=='catalog_then_bootstrap_v1'
    if staged:
        from scripts.trial_guard.catalog_execution import validate_catalog_payload,catalog_digest,read_catalog_receipt,bootstrap_binding
        validate_catalog_payload(payload)
        f=config['preflight']
        _need(f.get('schema')==2 and f.get('catalog_acl')=='pending_catalog' and f.get('launch_checks_verified') is True and
            f.get('no_production_change') is True and 'external_business_acl_verified' not in f and 'all_evidence_verified' not in f)
    else:_need(all(config['preflight'].get(k) is True for k in ('external_business_acl_verified','all_evidence_verified','no_production_change')))
    manifest = resolver._manifest  # Fixed compiler-owned authority, never bundle assertions.
    _need(config['owner_id'] == manifest['owner']['principal_id'] and config['tenant_id'] == manifest['owner']['tenant_id'])
    budget = config['control_budget']
    local_binding = journal.values('binding')[0]
    expected_budget = {k:local_binding[k] for k in ('manifest_sha256','owner_id','task_id')}
    if verified_attempt is not None and verified_attempt.authority['schema'] in (7, 8, 9):
        from .attempt import origin_manifest_hash
        _need(local_binding['manifest_sha256'] == verified_attempt.authority['manifest_sha256'])
        expected_budget['manifest_sha256'] = origin_manifest_hash(verified_attempt.authority)
    _need({k: budget['binding'][k] for k in expected_budget} == expected_budget)
    if 'attempt' in local_binding:_need(config.get('attempt_binding_digest')==local_binding['attempt']['binding_digest'])
    if verified_attempt is not None:
        _need(local_binding.get('attempt',{}).get('binding_digest') == verified_attempt.binding_digest ==
              config.get('attempt_binding_digest'))
    _need(Path(budget['directory']) == journal.path.parent and digest(str(journal.path.parent)) == budget['directory_digest'])
    _need(budget['seed'] == {'owner_arm':128, 'owner_control_blob':32, 'heartbeat_blob':0})
    receipts = journal.receipts()
    main = resolver.resolve('guardMainConfiguration', receipts)
    guard = resolver.resolve('guard', receipts)
    for op in (guard, main):
        _need(_complete(receipts.get(op['id'])) and receipts[op['id']]['request_digest'] == digest(op))
    target = config['guardian_job']
    # The main PATCH only changes the timeout configuration. Its readback
    # expectation retains the original template; the PATCH body has none.
    # Bind both fixed compiler outputs, not an optional caller-supplied body.
    template = guard['body']['properties']['template']
    _need(main['expected']['properties']['properties.template'] == template)
    _need(target['resource_id'] == manifest['ids']['guard'] and target['template'] == template)
    _need(target['principal_id'] == receipts['guard']['properties']['principalId'])
    _need(target['environment_id'] == manifest['existing']['environment'])
    original = verify_policy(payload['environment'])
    _need(original == json.loads(payload['environment']['TRIAL_POLICY_JSON']))
    db = original['database']; fixed_db = manifest['db']
    _need(db['host'] == manifest['existing']['db'].rsplit('/',1)[1] + '.postgres.database.azure.com')
    _need(db['database'] == fixed_db['name'] and db['webUser'] == fixed_db['web'] and db['workerUser'] == fixed_db['worker'])
    with _closed_chain(config) as (rows, session_sha):
        start = _one(rows, 'start_intent'); work = _one(rows, 'work_intent')
        worker = _one(rows, 'worker_result'); complete = _one(rows, 'work_complete')
        absence = _one(rows, 'absence_confirmed'); handoff = _one(rows, 'handoff_complete')
        _need(start['sequence'] < work['sequence'] < worker['sequence'] < complete['sequence'] < absence['sequence'] < handoff['sequence'])
        _need(handoff == rows[-1] and handoff['value'] == {'cleanup_responsibility_retained':False, 'successor':False})
        _need(not any(r['event'] in ('work_unknown', 'closed_work_incomplete', 'deadline_unresolved', 'execution_unresolved') for r in rows))
        _need(re.fullmatch(HEX, absence['value']['evidence_digest']) and type(absence['value']['journal_version']) is int and absence['value']['journal_version'] > 0)
        runtime = _one(rows, 'start_ack')['value']['runtime']
        _need(runtime['execution_id'].startswith(target['resource_id'] + '/executions/') and runtime['principal_id'] == target['principal_id'])
        _need(runtime['image_digest'] == target['image_digest'] and runtime['nonce'] == config['cloud_guard']['nonce'])
        _need(parse(runtime['job_deadline']) - parse(runtime['job_started_at']) == timedelta(minutes=30))
        result = worker['value']['output']; window = worker['value']['database_window']; b = result['bootstrap']
        _need(result['status'] == 'completed' and type(result['completedRequests']) is int and result['completedRequests'] == len(payload['requests']))
        _need(b['schema'] == 1 and b['status'] == ('bootstrapped' if payload['bootstrap']['mode'] == 'apply' else 'reconciled') and b['automaticResend'] is False)
        _need(window['ruleId'] == config['binding']['rule_id'] and window['journalUrl'] == config['journal_url'])
        _need(window['guardianNonce'] == runtime['nonce'] and parse(window['jobStartedAt']) == parse(runtime['job_started_at']))
        _need(parse(window['useUntil']) - parse(window['jobStartedAt']) == timedelta(minutes=10) and digest(window) == b['databaseWindowDigest'])
        for key in ('lifecycleId', 'guardianNonce', 'ruleId', 'journalUrl'):
            _need(window[key] == payload['access']['databaseWindow'][key])
        directory = _path(payload['recoveryDirectory'], directory=True)
        _need(hashlib.sha256(str(directory).encode()).hexdigest() == original['localOperator']['recoveryDirectoryDigest'])
        if staged:
            catalog=result.get('catalog');_need(isinstance(catalog,dict))
            _need(set(catalog)=={'schema','pass1Sha256','pass2Sha256','pass3Sha256','auditPlanDigest','auditConnectionAttempts'} and
                type(catalog['schema']) is int and catalog['schema']==1 and type(catalog['auditConnectionAttempts']) is int)
            verified=[r for r in rows if r['event']=='catalog_verified']
            _need(len(verified)==3 and work['sequence']<verified[0]['sequence']<verified[1]['sequence']<verified[2]['sequence']<worker['sequence'])
            intent=_one(rows,'bootstrap_frame_intent');sent=_one(rows,'bootstrap_frame_sent')
            _need(verified[0]['sequence']<intent['sequence']<sent['sequence']<verified[1]['sequence'])
            binding=bootstrap_binding(payload,window);previous=None
            for number,row in enumerate(verified,1):
                checksum=catalog['pass%dSha256'%number]
                proof=read_catalog_receipt(directory,number,checksum,original,payload['catalogPlan'],window,prior=previous)
                _need(row['value']=={'pass':number,'sha256':checksum,'receipt_digest':catalog_digest(proof),'bootstrap_binding':binding})
                previous=proof
            _need(intent['value']==sent['value']=={'pass1_sha256':catalog['pass1Sha256'],'bootstrap_binding':binding})
            _need(catalog['auditPlanDigest']==catalog_digest(payload['catalogPlan']) and catalog['auditConnectionAttempts']==previous['auditConnectionAttempts'])
        proof_raw = _read(directory / 'trial-bootstrap-proof.json', 256 * 1024)
        final_raw = _read(directory / 'trial-runtime-policy.json', 65536)
        _need(hashlib.sha256(proof_raw).hexdigest() == b['proofSha256'] and hashlib.sha256(final_raw).hexdigest() == b['finalRuntimePolicySha256'])
        proof, environment = _json(proof_raw), _json(final_raw)
        _need(set(proof) == {'schema','bootstrap','databaseWindow','database','codeSha','bootstrapManifest','receipts','receiptScope'})
        _need(proof['schema'] == 1 and proof['receiptScope'] == 'verified_steps_this_invocation')
        _need(proof['bootstrap'] == {k:b[k] for k in ('status','databaseBaselineBytes','cases','automaticResend')})
        _need(proof['databaseWindow'] == window and proof['bootstrapManifest'] == payload['bootstrap']['manifest'])
        _need(type(b['cases']) is int and b['cases'] == len(proof['bootstrapManifest']['cases']))
        _need(type(b['databaseBaselineBytes']) is int and 0 <= b['databaseBaselineBytes'] <= 64 * 1024**2)
        _need(set(environment) == POLICY_KEYS and environment['DEPLOYMENT_KIND'] == 'trial')
        policy = verify_policy(environment)
        _need(policy == json.loads(environment['TRIAL_POLICY_JSON']))
        _need(environment['TRIAL_POLICY_PUBLIC_KEY'] == payload['environment']['TRIAL_POLICY_PUBLIC_KEY'])
        expected = deepcopy(original)
        expected['cost']['databaseBaselineBytes'] = b['databaseBaselineBytes']
        expected['localOperator']['ticketDigest'] = policy['localOperator']['ticketDigest']
        _need(policy == expected and re.fullmatch(HEX, policy['localOperator']['ticketDigest']))
        _need(proof['database'] == {k: policy['database'][k] for k in ('host','database','ownerRole','migratorUser','webUser','workerUser')})
        from .attempt import effective_image_head
        local_head = config['preflight']['ci_head']
        image_head = effective_image_head(verified_attempt, local_head)
        _need(local_head == config['preflight']['reviewed_head'] and
              proof['codeSha'] == policy['codeSha'] == resolver.initial_plan['resource_bindings']['code_sha'] == image_head)
        entries = proof['receipts']
        _need(isinstance(entries, list) and 1 <= len(entries) <= 1000 and type(b['receiptCount']) is int and len(entries) == b['receiptCount'])
        _need(digest(entries) == b['receiptSetSha256'] and entries == sorted(entries, key=lambda x: x['name']))
        _need(len({entry['name'] for entry in entries}) == len(entries))
        for entry in entries:
            _need(set(entry) == {'name','sha256'} and re.fullmatch(r'operator-[a-f0-9]{64}\.jsonl', entry['name']) and re.fullmatch(HEX, entry['sha256']))
            raw = _read(directory / entry['name'], 65536)
            _need(raw.endswith(b'\n') and hashlib.sha256(raw).hexdigest() == entry['sha256'])
            lines = [_json(line) for line in raw.splitlines() if line]
            _need(2 <= len(lines) <= 100 and lines[-1] == {'terminal':'completed'})
            for first in lines:
                if first == {'terminal':'completed'}: continue
                _need(set(first) == {'schema','intent','ticketDigest','startsAt','endsAt','status','automaticResend'})
                _need(first['schema'] == 1 and first['intent'] == entry['name'][9:-6] and first['automaticResend'] is False and first['status'] == 'outcome_unknown')
                _need(re.fullmatch(HEX, first['ticketDigest']) and parse(first['startsAt']) < parse(first['endsAt']))
            # The last attempt is complete. Earlier unknown attempts stay as
            # historical evidence; explicit reconcile verified current state.
        # Reuse the exact signed-policy-to-resource compiler checks, without
        # installing runtime operations or accepting arbitrary operation JSON.
        runtime_env = {k:v for k,v in environment.items() if k != 'DEPLOYMENT_KIND'}
        deadline = min(parse(policy['endsAt']), parse(resolver.initial_plan['windows']['owner_input']['end'])).isoformat().replace('+00:00','Z')
        resolver.make_runtime_binding(runtime_env, receipts, verify_policy=verify_policy, deadline=deadline)
        return {'session_sha256':session_sha, 'proof_sha256':b['proofSha256'],
            'final_policy_environment_sha256':digest(environment), 'database_baseline_bytes':b['databaseBaselineBytes'],
            'code_sha':policy['codeSha'], 'database_binding_sha256':digest(proof['database']),
            'receipt_set_sha256':b['receiptSetSha256'], 'receipt_count':len(entries),
            'cleanup_verified':True, 'automatic_resend':False, 'bootstrap_mode':payload['bootstrap']['mode'],
            'observation_only':True, 'cleanup_ownership_proof':False}


def bind_bootstrap(bundle, journal, resolver, clock, *, verify_policy, verified_attempt=None):
    """Import once from fixed local artifacts; no caller success proof accepted.

    The CLI ACL/hash-checks the private bundle before calling. A bridge intent
    left unknown by process loss remains unknown; this path cannot adopt it.
    """
    try:
        _need(isinstance(bundle, dict) and set(bundle) == {'schema','execution_config'} and bundle['schema'] == 1)
        config = bundle['execution_config']
        binding = digest(execution_binding(config))
        op = {'id':'trialDatabaseBootstrap','provider':'Local','kind':'guardedDatabaseBootstrap','method':'GET',
            'url':'local://trial-database-bootstrap','body':None,'deadline':config['owner_access']['ends_at'],
            'depends_on':['guardMainConfiguration'],'expected':{'execution_binding':binding,'initial_plan_digest':resolver.plan_digest},'cleanup':{}}
        prior = [v for v in journal.values('intent') if v['operation_id'] == op['id']]
        if prior:
            _need(len(prior) == 1 and prior[0]['request_digest'] == digest(op))
            receipt = journal.latest(op['id']) or {}
            if _observed(receipt):
                _need(receipt['request_digest'] == digest(op))
                return {'status':'bootstrap_bound','bootstrapBound':True,'cloud_calls':0}
            return {'status':'unknown','bootstrapBound':False,'cloud_calls':0}
        properties = _validate(config, journal, resolver, verify_policy, verified_attempt=verified_attempt)
        # Local observation only, after proof validation. Fsync unknown before
        # the terminal record; a partial append never manufactures success.
        journal.intent(op, clock.utc().isoformat())
        base = {'operation_id':op['id'],'request_digest':digest(op),'object_id':binding,
            'state':'unknown','terminal':False,'write_terminal':False,'readback_verified':False,'created_by_run':False}
        journal.checkpoint(op, base)
        known_ack = config['worker']['payload']['bootstrap']['mode'] == 'apply'
        journal.checkpoint(op, {**base,'state':'succeeded','terminal':True,'write_terminal':known_ack,
            'readback_verified':True,'created_by_run':known_ack,'properties':properties})
        return {'status':'bootstrap_bound','bootstrapBound':True,'cloud_calls':0}
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        raise Denied('bootstrap_proof_unconfirmed') from None
