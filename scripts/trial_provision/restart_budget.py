"""Offline arithmetic for a possible restart after the stopped MI creation.

No authority, counter, clock, file, credential or transport is accepted here.
The result is a proposal, never a live admission decision. The separate pure
required_run_requests function supplies a numerical floor for a schema-6
consumer; that consumer still verifies authority, stages and actual ledger.
"""
from copy import deepcopy


LIFETIME_LIMIT = 631
ALREADY_SPENT = 302
CLEANUP_RESERVED = 120
CURRENT_REMAINING = {
    'fresh_read': 18, 'publication': 4, 'provision': 145,
    'run': 42, 'cleanup': CLEANUP_RESERVED,
}
# OWNER ARM HTTP only. Blob requests, Cloud MI requests and paid AI/Job usage
# belong to their existing separate counters and are not free or reset here.
NORMAL_RUN_HTTP = {
    'rehearsal_start': 2, 'rehearsal_seed': 2, 'rehearsal_verify': 1,
    'main_preflight': 7, 'main': 8,
}
RUN_TOKEN_ALLOWANCE = 8
RUN_POLL_ALLOWANCE = 4
V7_RUN_TOKEN_ALLOWANCE = 3
V7_RUN_POLL_ALLOWANCE = 1
V7_RUN_HTTP_CAP = sum(NORMAL_RUN_HTTP.values()) + V7_RUN_POLL_ALLOWANCE
LEGACY_REHEARSAL_FLOORS = {
    'rehearsal_start': 5 + 18 + 7,
    'rehearsal_seed': 6 + 18 + 7,
    'rehearsal_verify': 7 + 18 + 7,
}
_LEGACY_FLOORS = {**LEGACY_REHEARSAL_FLOORS, 'rehearsal_poll': 2 + 18 + 7,
                  'main_preflight': 7 + 18, 'main': 18}
_HTTP_BEFORE = {'rehearsal_start': 0, 'rehearsal_poll': 2,
                'rehearsal_seed': 2, 'rehearsal_verify': 4,
                'main_preflight': 5, 'main': 12}
INTEGRATION_GAPS = (
    'new_explicit_authority_and_immutable_stopped_history_binding',
    'separate_local_head_and_exact_acknowledged_image_build_head',
    'bounded_read_only_image_reuse_consumer_and_measurement',
    'new_run_admission_and_token_poll_enforcement',
    'whole_launcher_contract_including_expiry_and_unknown_failure',
    'current_mi_absence_bound_to_new_create_without_old_ack_adoption',
)


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('restart_budget_integer')
    return value


def required_run_requests(schema, stage, *, http_used, owner_token_used):
    """Numerical floor only; accepts neither receipts nor approval booleans.

    Schema 1..5 keep their old conservative floors. Schema 6 reserves the
    remaining normal HTTP sequence and all unspent token allowance. Its four
    extra HTTP slots remain shared, strictly counted observations; no new
    observation/retry route is authorized. V7 narrows these allowances to
    three token misses and one known poll; it never assumes future cache hits
    or guarantees completion. A poll also reserves its own GET.
    The live caller must compare this floor with both phase and global limits
    and authenticate the stage against its existing canonical ACK evidence.
    """
    _integer(schema, 1, 9)
    if not isinstance(stage, str) or stage not in _LEGACY_FLOORS:
        raise ValueError('restart_admission_stage')
    _integer(http_used, 0, 42); _integer(owner_token_used, 0, 42)
    if schema not in (6, 7, 8, 9):
        return _LEGACY_FLOORS[stage]
    token_allowance = 2 if schema == 9 else V7_RUN_TOKEN_ALLOWANCE if schema in (7, 8) else RUN_TOKEN_ALLOWANCE
    poll_allowance = V7_RUN_POLL_ALLOWANCE if schema in (7, 8, 9) else RUN_POLL_ALLOWANCE
    _integer(owner_token_used, 0, token_allowance)
    normal_http = 17 if schema == 9 else sum(NORMAL_RUN_HTTP.values())
    before = (9 if stage == 'main' else _HTTP_BEFORE[stage]) if schema == 9 else _HTTP_BEFORE[stage]
    _integer(http_used, before, before + poll_allowance)
    # A new start must be the first run dispatch; prior requests cannot be
    # reinterpreted as another start's observation allowance.
    if stage == 'rehearsal_start' and http_used != 0:
        raise ValueError('restart_start_already_attempted')
    remaining_http = normal_http - before
    if stage == 'rehearsal_poll':
        remaining_http += 1
    if http_used + remaining_http > normal_http + poll_allowance:
        raise ValueError('restart_http_reserve_exhausted')
    return remaining_http + token_allowance - owner_token_used


def proposed_budget(*, additional_readbacks=0):
    """Keep the full acceptance scope; spend extra observations from poll slack.

    Image reuse allocates eight: per repository, two OAuth exchanges, one GET
    of the exact known manifest and at most one OWNER-token miss. It assumes
    neither free authentication nor a cache hit. This consumer is not built by
    this module. A separate MI absence GET must be charged here unless the new
    create's mandatory existing preflight supplies the independently bound 404.

    Normal provision is the existing fixture's 135 HTTP plus its ten-token
    allowance. There is no extra provisioning-poll allowance in this proposal.
    Eight run-token misses are a proposed hard allowance, not a guarantee about
    future token expiry. Exhaustion must stop, never borrow cleanup or refund.
    """
    extra = _integer(additional_readbacks, 0, RUN_POLL_ALLOWANCE)
    caps = {'fresh_read': 24, 'publication': 8 + extra, 'provision': 145,
            'run': 32 - extra, 'cleanup': CLEANUP_RESERVED}
    if sum(CURRENT_REMAINING.values()) != LIFETIME_LIMIT - ALREADY_SPENT:
        raise ValueError('restart_previous_allocation')
    if sum(caps.values()) + ALREADY_SPENT != LIFETIME_LIMIT:
        raise ValueError('restart_total')
    return {
        'schema': 1, 'kind': 'offline_restart_budget_proposal',
        'status': 'proposed_only', 'execution_permitted': False,
        'approval_required': True, 'live_admission_compatible': False,
        'lifetime_limit': LIFETIME_LIMIT, 'already_spent': ALREADY_SPENT,
        'remaining': LIFETIME_LIMIT - ALREADY_SPENT,
        'current_remaining': deepcopy(CURRENT_REMAINING),
        'proposed_caps': caps,
        'delta': {k: caps[k] - CURRENT_REMAINING[k] for k in caps},
        'refunds': 0, 'ledger_writes': 0, 'publication_pushes': 0,
        'image_reuse': {'repositories': 2, 'oauth_http_each': 2,
                       'manifest_get_each': 1, 'owner_token_each': 1,
                       'additional_readbacks': extra},
        'provision': {'normal_http': 135, 'owner_token_allowance': 10,
                      'extra_poll_allowance': 0},
        'run': {'normal_http_by_stage': deepcopy(NORMAL_RUN_HTTP),
                'normal_http': sum(NORMAL_RUN_HTTP.values()),
                'owner_token_allowance': RUN_TOKEN_ALLOWANCE,
                'known_poll_http_allowance': RUN_POLL_ALLOWANCE - extra},
        'acceptance_scope': {'cases': 4, 'passes': 2, 'normal_runs': 8,
                             'artifact_versions': 16, 'pdf_csv_files': 32,
                             'artifact_gets': 64, 'artifact_displays': 32},
        'paid_limits_and_retained_holds_changed': False,
        'old_unknown_reinterpreted': False,
        'integration_gaps': list(INTEGRATION_GAPS),
    }


def assess_run_trace(records, *, additional_readbacks=0, complete=False):
    """Check a sanitized fictional trace against the proposed run envelope.

    Rows carry only stage/purpose/attempts/outcome. Unknown attempts consume
    their full reservation and stop the trace; no later request is admissible.
    Normal HTTP stages must be ordered and exactly complete before advancing.
    This is a counting simulation and cannot mint a dispatch capability.
    """
    proposal = proposed_budget(additional_readbacks=additional_readbacks)
    if type(complete) is not bool or not isinstance(records, list) or len(records) > 128:
        raise ValueError('restart_trace_shape')
    stages = tuple(NORMAL_RUN_HTTP)
    http = dict.fromkeys(stages, 0)
    tokens = polls = 0
    index = 0
    unknown = False
    for row in records:
        if unknown:
            raise ValueError('restart_unknown_no_continuation')
        if not isinstance(row, dict) or set(row) != {'stage', 'purpose', 'attempts', 'outcome'}:
            raise ValueError('restart_trace_shape')
        stage, purpose = row['stage'], row['purpose']
        if (stage not in stages or purpose not in ('http', 'owner_token', 'known_poll_http')
                or row['outcome'] not in ('observed', 'unknown')):
            raise ValueError('restart_trace_scope')
        count = _integer(row['attempts'], 1, 32)
        position = stages.index(stage)
        if position < index or any(http[s] != NORMAL_RUN_HTTP[s] for s in stages[:position]):
            raise ValueError('restart_trace_order')
        index = position
        if purpose == 'http':
            http[stage] += count
            if http[stage] > NORMAL_RUN_HTTP[stage]:
                raise ValueError('restart_normal_http_exhausted')
        elif purpose == 'owner_token':
            tokens += count
            if tokens > RUN_TOKEN_ALLOWANCE:
                raise ValueError('restart_token_allowance_exhausted')
        else:
            if stage != 'rehearsal_start' or http[stage] != NORMAL_RUN_HTTP[stage]:
                raise ValueError('restart_poll_scope')
            polls += count
            if polls > proposal['run']['known_poll_http_allowance']:
                raise ValueError('restart_poll_allowance_exhausted')
        unknown = row['outcome'] == 'unknown'
    normal = sum(http.values())
    spent = normal + tokens + polls
    required_http = sum(NORMAL_RUN_HTTP.values()) - normal
    if complete and (unknown or required_http != 0):
        raise ValueError('restart_trace_incomplete')
    return {
        'status': 'stopped_unknown' if unknown else ('fictional_complete' if complete else 'fictional_prefix'),
        'execution_permitted': False, 'normal_http': normal,
        'owner_token_attempts': tokens, 'known_poll_http': polls,
        'run_spent': spent, 'run_remaining': proposal['proposed_caps']['run'] - spent,
        'remaining_normal_http': required_http,
        'remaining_token_allowance': RUN_TOKEN_ALLOWANCE - tokens,
        'remaining_known_poll_allowance': proposal['run']['known_poll_http_allowance'] - polls,
        'cleanup_preserved': CLEANUP_RESERVED,
        'live_admission_compatible': False,
    }
