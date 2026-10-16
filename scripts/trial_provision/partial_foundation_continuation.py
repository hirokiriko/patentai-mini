"""Finite schema-10 continuation of thirteen acknowledged writes.

Pure evidence validation; no network, credential acquisition or authority issuance.
Original writes remain in their original chain and retain their deadlines.
"""
from copy import deepcopy
from pathlib import PureWindowsPath, PurePosixPath

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import Denied, parse
from .succession import need, keys, raw

CHILD_NAME = 'trial-provision-continuation-v8r1'
KIND = 'STOPPED_V8_PARTIAL_FOUNDATION'
COUNTS = {'owner_arm':384,'owner_control_blob':32,'heartbeat_blob':0}
PREFIX_ROWS = (268,)  # The exact immutable prefix hash is bound by the authority.
SLOTS = ('webIdentity', 'workerIdentity', 'originals', 'artifacts', 'budget', 'journal') + tuple('C'+str(i) for i in range(1, 8))
BASE_EVENTS = ('binding', 'image_reuse_preparation', 'provision_bridge_intent',
               *('allocation',)*14, 'core_plan', 'provision_bridge_output', 'plan',
               'publication_import', 'provision_bridge_prepared')
EVENTS = BASE_EVENTS + tuple(event for _ in SLOTS for event in
    ('clock_observation', 'allocation', 'intent', 'progress', 'progress'))

PHASE_DELTA = {'fresh_read': -5, 'publication': 0, 'provision': 7, 'run': -2, 'cleanup': 0}
PURPOSE_CAPS = {'fresh_read': {'http': 10, 'owner_token': 0},
    'publication': {'http': 0, 'owner_token': 0},
    'provision': {'http': 100, 'owner_token': 2}, 'run': {'http': 16, 'owner_token': 2}}


def allocation(previous_plan, used, counts):
    from . import attempt as a
    fresh = used['owner_arm']['fresh_read']
    need(type(fresh) is int and fresh == 2
         and counts == COUNTS
         and all(type(v) is int for v in counts.values())
         and previous_plan['limits'] == {**a.LIMITS, 'owner_arm': 631}
         and previous_plan['counts_before'] == {'owner_arm':333,'owner_control_blob':32,'heartbeat_blob':0}
         and previous_plan['phase_caps']['owner_arm'] == dict(zip(a.PHASES, (17,0,141,20,120)))
         and previous_plan['purpose_caps'] == a.V8_PURPOSE_CAPS
         and previous_plan['unallocated']['owner_arm'] == 0
         and used['owner_arm'] == dict(zip(a.PHASES, (fresh,0,46,0,3)))
         and all(type(v) is int for phases in used.values() for v in phases.values())
         and all(used[k][p] == 0 for k in ('owner_control_blob','heartbeat_blob') for p in a.PHASES))
    caps = {k:{p:previous_plan['phase_caps'][k][p]-used[k][p] for p in a.PHASES} for k in a.LIMITS}
    delta = {'schema':1,'kind':'owner_arm','phase_delta':deepcopy(PHASE_DELTA),'unallocated_delta':0}
    need(sum(PHASE_DELTA.values()) == 0 and PHASE_DELTA['cleanup'] == PHASE_DELTA['publication'] == 0)
    for phase in a.PHASES: caps['owner_arm'][phase] += PHASE_DELTA[phase]
    need(all(type(v) is int and v >= 0 for v in caps['owner_arm'].values())
         and caps['owner_arm']['cleanup'] == 117 and caps['owner_arm']['publication'] == 0
         and sum(caps['owner_arm'].values()) + counts['owner_arm'] == 631)
    return caps, deepcopy(previous_plan['unallocated']), delta


def transition_value(verified):
    from . import attempt as a
    p=a._proof(verified);s=p['succession'];need(p['authority']['schema']==10)
    return {'schema':9,'kind':KIND,'previous_attempt':s['previous_attempt'],
        'previous_plan_sha256':digest(s['previous_plan']),'prefix_rows':s['counter_rows'],
        'prefix_sha256':s['counter_prefix_sha256'],'prefix_tail':s['counter_tail'],
        'counts':deepcopy(s['counts']),'authority_sha256':p['authority_sha256'],
        'proof_sha256':s['proof_sha256'],'plan':a.phase_plan(verified),
        'phase_reallocation':deepcopy(s['phase_reallocation']),
        'limit_amendment':deepcopy(p['authority']['limit_amendment'])}


def validate_transition(value, *, prefix_raw, previous_plan, counts, used, verified=None):
    from . import attempt as a
    keys(value, ('schema','kind','previous_attempt','previous_plan_sha256','prefix_rows','prefix_sha256',
        'prefix_tail','counts','authority_sha256','proof_sha256','plan','phase_reallocation','limit_amendment'))
    need(type(value['schema']) is int and value['schema']==9 and value['kind']==KIND
         and type(value['prefix_rows']) is int and value['prefix_rows'] in PREFIX_ROWS
         and len(prefix_raw.splitlines())==value['prefix_rows']
         and a._sha(prefix_raw)==a._hex(value['prefix_sha256'])
         and a._json(prefix_raw.splitlines()[-1])['hash']==a._hex(value['prefix_tail'])
         and previous_plan is not None and value['previous_attempt']==previous_plan['attempt']
         and value['previous_plan_sha256']==digest(previous_plan) and value['counts']==counts)
    a._hex(value['authority_sha256']);a._hex(value['proof_sha256'])
    caps,reserve,delta=allocation(previous_plan,used,counts)
    need(value['phase_reallocation']==delta and type(value['phase_reallocation']['schema']) is int
         and type(value['phase_reallocation']['unallocated_delta']) is int
         and all(type(v) is int for v in value['phase_reallocation']['phase_delta'].values()))
    rows=[a._json(line) for line in prefix_raw.splitlines()]
    need(rows[216]['event']=='attempt_transition'
         and rows[216]['value']['limit_amendment']==value['limit_amendment'])
    # V8 foundation 41, stopped cleanup 3, first diagnostic 5. Optional second
    # diagnostic is a finite fresh_read suffix (token first, then <=2 GETs).
    expected=([('provision','owner_token')]+[('provision','http')]*40
        +[('cleanup','owner_token')]+[('cleanup','http')]*2
        +[('provision','owner_token')]+[('provision','http')]*4)
    expected += ([('fresh_read','owner_token')]+[('fresh_read','http')]*2)[:len(rows)-266]
    need([(r['value'].get('phase'),r['value'].get('purpose')) for r in rows[217:]]==expected
         and all(r['event']=='request' and r['value'].get('kind')=='owner_arm'
             and r['value'].get('attempt')==previous_plan['attempt'] for r in rows[217:]))
    plan=value['plan']
    need(type(plan) is dict and plan.get('counts_before')==counts and plan.get('attempt')!=previous_plan['attempt']
         and plan.get('phase_caps')==caps and plan.get('unallocated')==reserve
         and plan.get('limits')==a._authority_limits({'schema':10,'limit_amendment':value['limit_amendment']})
         and plan.get('purpose_caps')==PURPOSE_CAPS)
    if verified is not None:need(value==transition_value(verified))
    return deepcopy(plan)


def _receipt_projection(operation, ack, final, manifest):
    """Validate stored projections, not an unretained full response body.

    The old sealed operation and original body digest remain authoritative;
    the new bounded List proof independently rechecks current resource state.
    """
    from .plan import _guid
    expected = operation['expected']
    projection = final.get('properties')
    need(type(projection) is dict and set(projection) == set(expected.get('receipt_properties', []))
         and ack.get('properties') == {} and final.get('binding_digest') == digest(expected['properties']))
    if operation['provider'] == 'Microsoft.ManagedIdentity':
        need(operation['kind'] == 'userAssignedIdentities'
             and set(projection) == {'principalId','tenantId','clientId'})
        try: canonical = {key:_guid(value) for key,value in projection.items()}
        except ValueError: raise Denied('partial_foundation_identity_projection') from None
        need(canonical['tenantId'] == _guid(manifest['owner']['tenant_id'])
             and ack.get('identity_properties_digest') == final.get('identity_properties_digest') == digest(canonical))
    else:
        need(projection == {} and 'identity_properties_digest' not in ack and 'identity_properties_digest' not in final)


def _previous_foundation(old_config, manifest, previous, public_raw, provision_raw, inputs_raw, binding, records):
    from . import attempt as a
    from .publication_bridge import compose_configuration, _core_plan, _prepared_record
    from .operations import create_resolver, _final
    from .plan import _guid
    from .registry_publish import prepare_publication, verified_publication_images, publication_origin, verify_reused_import
    publication={**old_config,'manifest':manifest,'verified_attempt':previous,'config_sha256':a._sha(public_raw)}
    view=a._ParentView(records)
    prepare_publication(publication,manifest,publication['config_sha256'],view)
    images=verified_publication_images(view,verified_attempt=previous)
    bridge=view.values('provision_bridge_intent')[0]
    keys(bridge,('schema','publication_config_sha256','checked_at','input_sha256','code_sha',
                 'run_binding_digest','image_receipt_digests','output'))
    a._ref(bridge['output']);directory=old_config['recovery']['directory']
    path_type=PureWindowsPath if PureWindowsPath(directory).is_absolute() else PurePosixPath
    origin=publication_origin(view,verified_attempt=previous)
    need(type(bridge['schema']) is int and bridge['schema']==1
         and bridge['publication_config_sha256']==a._sha(public_raw)
         and bridge['code_sha']==old_config['frozen_head'] and bridge['run_binding_digest']==digest(binding)
         and bridge['input_sha256']==a._sha(inputs_raw)
         and bridge['output']=={'path':str(path_type(directory)/'provision-successor-v8-config.json'),'sha256':a._sha(provision_raw)}
         and bridge['image_receipt_digests']=={slot:digest(origin.latest(slot+'ImagePush')) for slot in ('guardian','runtime')})
    provision=a._json(provision_raw)
    need(compose_configuration(publication,view,a._json(inputs_raw),verify_local_node=False)==provision)
    allocations=view.values('allocation');need(len(allocations)==27);lookup={}
    for item in allocations:
        keys(item,('slot','id'));need(item['slot'] not in lookup and _guid(item['id'])==item['id'])
        lookup[item['slot']]=item['id']
    need(len(set(lookup.values()))==27);seen=set()
    def allocate(slot):
        need(slot in lookup and slot not in seen);seen.add(slot);return lookup[slot]
    core=_core_plan(publication,provision,bridge['checked_at'],allocate)
    need(len(seen)==14 and view.values('core_plan')==[core])
    resolver=create_resolver(core,manifest,old_config['authority_bundle'],provision['resource_bindings'],verified_attempt=previous)
    need(view.values('plan')==[resolver.initial_plan])
    verify_reused_import(view,resolver,provision['resource_bindings'],previous)
    need(view.values('provision_bridge_output')==[bridge]
         and view.values('provision_bridge_prepared')==[_prepared_record(view,bridge)])
    receipts={};operations={};intents=[];progress=[];last=parse(bridge['checked_at'])
    for number,slot in enumerate(SLOTS):
        offset=len(BASE_EVENTS)+number*5
        clock,allocated,intent_row,ack_row,final_row=records[offset:offset+5]
        intent,ack,final=intent_row['value'],ack_row['value'],final_row['value']
        keys(intent,('operation_id','request_digest','method','url','deadline','at','request_id'))
        operation=resolver.resolve(slot,receipts);checksum=digest(operation)
        need(intent['operation_id']==slot and intent['request_digest']==checksum
             and intent['method']==operation['method']=='PUT' and intent['url']==operation['url']
             and intent['deadline']==operation['deadline'] and set(clock['value'])=={'at'}
             and last<=parse(clock['value']['at'])<=parse(intent['at'])
             and allocated['value']=={'slot':'request_'+slot,'id':intent['request_id']}
             and lookup['request_'+slot]==intent['request_id'])
        seen.add('request_'+slot)
        need(ack['operation_id']==slot and ack['request_digest']==checksum
             and ack['object_id']==operation['expected']['resource_id'] and ack['state']=='pending'
             and ack['created_by_run'] is True and ack['write_terminal'] is True
             and ack['terminal'] is False and ack['readback_verified'] is False
             and type(ack['http']) is int and ack['http']==201 and 'operation_url' not in ack)
        a._hex(ack['initial_ack_digest']);_final(operation,final)
        _receipt_projection(operation,ack,final,manifest)
        need(type(final['http']) is int and final['http']==200
             and last<=parse(intent['at'])<=parse(ack['observed_at'])<=parse(final['observed_at'])
             and parse(previous.activation['windows']['guardian']['start'])<=parse(intent['at'])
             <parse(previous.activation['windows']['owner_input']['start'])
             and parse(intent['at'])<parse(operation['deadline']))
        last=parse(final['observed_at']);operations[slot]=operation;receipts[slot]=deepcopy(final)
        intents.append(deepcopy(intent));progress.extend((deepcopy(ack),deepcopy(final)))
    need(seen==set(lookup))
    return {'operations':operations,'receipts':receipts,'intents':intents,'progress':progress,
            'core':core,'plan':resolver.initial_plan,'last_observed_at':last.isoformat(),
            'bridge':bridge,'images':images}


def validate_proof(authority, ready, config, manifest, *, parent_journal_raw, parent_final_raw, now):
    from . import attempt as a
    from .journal import replay_control_budget
    from .unknown_identity_succession import decode_ready
    rule=authority['succession']
    keys(rule,('schema','kind','proof_sha256','child_name','phase_reallocation'))
    need(type(rule['schema']) is int and rule['schema']==9 and rule['kind']==KIND and rule['child_name']==CHILD_NAME)
    proof=ready.get('succession_proof')
    keys(proof,('schema','previous_authority_raw','previous_activation_raw','previous_publication_raw',
        'previous_provision_raw','previous_bridge_inputs_raw','previous_child_raw','previous_artifacts',
        'stop_guard_raw','stop_cleanup_raw','diagnostic_result_raw','diagnostic_history','counter_prefix_raw','image_compatibility'))
    need(type(proof['schema']) is int and proof['schema']==9 and digest(proof)==a._hex(rule['proof_sha256']))
    old_raw=raw(proof['previous_authority_raw']);old=a._json(old_raw)
    need(old.get('schema')==9 and old.get('approval')=='ISSUE148_LINKED_ATTEMPT_V9')
    public_raw=raw(proof['previous_publication_raw']);old_config=a._json(public_raw)
    need('authority_bundle' not in old_config and old_config['control_budget']==config['control_budget']
         and old_config['recovery']==config['recovery']
         and {k:v['sha256'] for k,v in old_config['sources'].items()}=={k:v['sha256'] for k,v in config['sources'].items()})
    old_config['authority_bundle']=config['authority_bundle']
    keys(proof['previous_artifacts'],a.ARTIFACTS)
    artifacts={k:decode_ready(v) if k=='local_ready' else raw(v) for k,v in proof['previous_artifacts'].items()}
    previous=a.verify_attempt(old_config,manifest,authority_raw=old_raw,activation_raw=raw(proof['previous_activation_raw']),
        parent_journal_raw=parent_journal_raw,parent_final_raw=parent_final_raw,artifacts=artifacts,
        trusted_authority_sha256=a._sha(old_raw),now=now)
    for name in ('owner_id','task_id','budget_binding_sha256','parent','retained_runtime','guardian_prior_digest',
        'catalog_options','unallocated','limit_amendment','image_build_head','tags','origin_manifest_sha256',
        'identity_disposition','unknown_identity_retention','manifest_sha256'):
        need(authority[name]==old[name])
    need(old['initial_forecast_yen']<=authority['initial_forecast_yen']<=4500
         and authority['head']!=old['head'] and authority['attempt_id']!=old['attempt_id']
         and parse(authority['publish_from'])>parse(old['publish_from'])
         and authority['inherited_guardian_end']==previous.activation['windows']['guardian']['end'])
    for slot in ('guardian','runtime'):need(authority['artifact_sha256'][slot+'_build']==old['artifact_sha256'][slot+'_build'])
    compatibility=proof['image_compatibility']
    keys(compatibility,('schema','local_head','image_build_head','runtime_tree_sha256','guardian_tree_sha256',
        'runtime_unchanged','guardian_unchanged','review_sha256'))
    need(type(compatibility['schema']) is int and compatibility['schema']==1
         and compatibility['local_head']==authority['head'] and compatibility['image_build_head']==old['image_build_head']
         and compatibility['runtime_unchanged'] is True and compatibility['guardian_unchanged'] is True)
    for field in ('runtime_tree_sha256','guardian_tree_sha256','review_sha256'):a._hex(compatibility[field])
    child_raw=raw(proof['previous_child_raw']);name,binding=a.journal_descriptor(old_config,previous)
    need(name=='trial-provision-successor-v8')
    records,tail=a._journal(child_raw,binding);need(tuple(r['event'] for r in records)==EVENTS and len(records)==87)
    foundation=_previous_foundation(old_config,manifest,previous,public_raw,raw(proof['previous_provision_raw']),
        raw(proof['previous_bridge_inputs_raw']),binding,records)
    counter_raw=raw(proof['counter_prefix_raw'])
    state=replay_control_budget(counter_raw,binding=config['control_budget']['binding'],seed=a.SEED,
        directory=config['control_budget']['directory'],verified=previous)
    need(state['rows'] in PREFIX_ROWS and len(state['transitions'])==8 and state['plan']==a.phase_plan(previous)
         and state['counts']==authority['counts_before'])
    caps,reserve,delta=allocation(state['plan'],state['used'],state['counts'])
    need(authority['phase_caps']==caps and authority['unallocated']==reserve and rule['phase_reallocation']==delta)
    # Both old stops remain raw references. A later observation cannot turn an
    # old UNKNOWN or first-page-only list into cleanup/adoption permission.
    guard=a._json(raw(proof['stop_guard_raw']));stop=a._json(raw(proof['stop_cleanup_raw']))
    need(guard['status']=='STOPPED_V8_GUARD_ABSENCE_UNCONFIRMED'
         and stop['status']=='STOPPED_V8_CLEANUP_REFERENCE_LIST_UNCONFIRMED'
         and guard['authority_sha256']==stop['authority_sha256']==a._sha(old_raw)
         and guard['guard_new_mutation_sent'] is False and stop['delete_sent'] is False
         and stop['cleanup_binding_written'] is False and stop['all_token_pools_closed'] is True
         and stop['old_unknown_reservations_retained'] is True
         and stop['counts']=={'owner_arm':377,'owner_control_blob':32,'heartbeat_blob':0}
         and stop['child']['sha256']==a._sha(child_raw) and stop['child']['rows']==87
         and stop['counter']['sha256']==a._sha(b''.join(counter_raw.splitlines(keepends=True)[:261]))
         and stop['counter']['rows']==261)
    diagnostic=a._json(raw(proof['diagnostic_result_raw']))
    from . import pim_diagnosis as diagnosis
    history=proof['diagnostic_history']
    keys(history,('grant_raw','marker_raw','prior_grant','prior_request','prior_result','prior_marker','direct_request'))
    diagnostic_evidence={k:raw(history[k]) for k in ('prior_grant','prior_request','prior_result','prior_marker','direct_request')}
    diagnostic_evidence.update(counter=b''.join(counter_raw.splitlines(keepends=True)[:266]),child=child_raw,
        authority=old_raw,manifest=config['authority_bundle']['manifest'],
        stop_guard=raw(proof['stop_guard_raw']),stop_cleanup=raw(proof['stop_cleanup_raw']))
    grant_raw=raw(history['grant_raw']);grant=a._json(grant_raw)
    verified_diagnosis=diagnosis.verify_grant(grant_raw,trusted_sha256=a._sha(grant_raw),evidence=diagnostic_evidence,
        source_digests=grant['source_digests'],now=parse(grant['start']))
    diagnosis.validate_counter(verified_diagnosis,counter_raw,['owner_token','http'])
    need(a._json(raw(history['marker_raw']))=={'kind':diagnosis.KIND,'grant_sha256':a._sha(grant_raw),
        'attempt':grant['attempt'],'counter_prefix_sha256':grant['evidence_sha256']['counter'],
        'targets_sha256':digest(grant['targets'])})
    need(diagnostic['schema']==1 and diagnostic['kind']==diagnosis.KIND
         and diagnostic['grant_sha256']==a._sha(grant_raw) and diagnostic['requests']==2
         and diagnostic['automatic_retry'] is False
         and parse(grant['start'])<=parse(diagnostic['observed_at'])<parse(grant['end'])
         and len(diagnostic['observations'])==1)
    observation=diagnostic['observations'][0]
    prior_observations=a._json(raw(history['prior_result']))['observations']
    need(observation['slot']==grant['targets'][0]['slot'] and observation['http']==400
         and observation['cause']=='license_requirement' and observation['cause_basis']=='known_code'
         and observation['error_code']=='AadPremiumLicenseRequired'
         and observation['body_sha256']==prior_observations[2]['body_sha256']==prior_observations[3]['body_sha256'])
    # The historical diagnostic is consumed evidence, never a live capability.
    need(diagnostic['counts']==state['counts'] and diagnostic['counter_rows']==state['rows']
         and diagnostic['counter_sha256']==a._sha(counter_raw) and diagnostic['child_sha256']==a._sha(child_raw)
         and diagnostic['old_unknown_preserved'] is True and diagnostic['adoption_authorized'] is False
         and diagnostic['deletion_authorized'] is False and diagnostic['restart_authorized'] is False
         and parse(foundation['last_observed_at'])<=parse(diagnostic['observed_at'])<=parse(authority['approved_at']))
    old_proof=a._proof(previous);source=old_proof['succession']
    return {**{k:deepcopy(source[k]) for k in ('docker_paths','origin_manifest','origin_sources',
        'unknown_identity_receipt','retained_published_runtime','inherited_readback_sha256','inherited_fresh_sha256',
        'retained_unknown_identity_receipt')},
        'child_name':name,'child_binding':binding,'child_sha256':a._sha(child_raw),'child_tail':tail,
        'previous_child_records':records,'previous_attempt':previous.binding_digest,'previous_plan':state['plan'],
        'previous_transitions':state['transitions'],'previous_verified_proof':old_proof,
        'previous_publication':a._json(public_raw),'previous_authority_sha256':a._sha(old_raw),
        'counter_prefix_sha256':a._sha(counter_raw),'counter_tail':state['tail'],'counter_rows':state['rows'],'counts':state['counts'],
        'phase_reallocation':delta,'proof_sha256':rule['proof_sha256'],'acknowledged_images':foundation['images'],
        'image_build_head':old['image_build_head'],'new_sources':{k:v['sha256'] for k,v in config['sources'].items()},
        'carried_operations':foundation['operations'],'carried_receipts':foundation['receipts'],
        'carried_intents':foundation['intents'],'carried_progress':foundation['progress'],
        'previous_core_plan':foundation['core'],'previous_initial_plan':foundation['plan'],
        'cleanup_already_consumed':3,'cleanup_remaining':117,'cleanup_original':120}


def _source(verified):
    from .attempt import _proof
    proof=_proof(verified);need(proof['authority']['schema']==10)
    source=proof['succession'];need(set(source['carried_operations'])==set(source['carried_receipts'])==set(SLOTS))
    return source


def carried_operations(verified):return deepcopy(_source(verified)['carried_operations'])
def carried_receipts(verified):return deepcopy(_source(verified)['carried_receipts'])
def inherited_allocation(verified):return deepcopy(_source(verified)['previous_core_plan']['allocation'])


def _semantic(operation):
    value=deepcopy(operation);value.pop('deadline')
    value['cleanup'].pop('deadline',None)
    return value


def inherit_resources(resources, verified):
    if verified is None or verified.authority['schema']!=10:return resources
    old=carried_operations(verified);result=[]
    for operation in resources:
        ident=operation['id']
        if ident in SLOTS:
            need(_semantic(operation)==_semantic(old[ident]));operation=old[ident]
        result.append(deepcopy(operation))
    need({op['id'] for op in result}.issuperset(SLOTS[:6]));return result


def inherit_core(result, verified):
    if verified is None or verified.authority['schema']!=10:return result
    source=_source(verified);old=source['previous_core_plan'];operations=carried_operations(verified)
    need(result['allocation']==old['allocation'])
    for slot in SLOTS[6:]:
        need(_semantic(result['operations'][slot])==_semantic(old['operations'][slot]))
        result['operations'][slot]=deepcopy(old['operations'][slot])
    for slot in SLOTS[:6]:
        need(result['prerequisites'][slot]['object_id']==operations[slot]['expected']['resource_id'])
        result['prerequisites'][slot]=deepcopy(old['prerequisites'][slot])
    return result


class _ContinuationJournal:
    """Origin-aware read view; no old intent/progress is appended to new chain."""
    def __init__(self,journal,verified):
        self._journal=journal;self._verified=verified;self._source=_source(verified)
    def __getattr__(self,name):return getattr(self._journal,name)
    def _check(self):
        for event in ('intent','progress'):
            need(not any(row.get('operation_id') in SLOTS for row in self._journal.values(event)))
    def values(self,event):
        self._check();current=self._journal.values(event)
        historical={'intent':'carried_intents','progress':'carried_progress'}
        return deepcopy(self._source[historical[event]])+current if event in historical else current
    def receipts(self):
        self._check();current=self._journal.receipts();need(not set(current).intersection(SLOTS))
        return {**carried_receipts(self._verified),**current}
    def latest(self,ident):
        self._check()
        return carried_receipts(self._verified)[ident] if ident in SLOTS else self._journal.latest(ident)
    def intent(self,op,at):
        need(op['id'] not in SLOTS);return self._journal.intent(op,at)
    def checkpoint(self,op,receipt):
        need(op['id'] not in SLOTS and receipt.get('operation_id') not in SLOTS)
        return self._journal.checkpoint(op,receipt)
    def append(self,event,value):
        need(event not in ('foundation_import',))
        need(not(event in ('intent','progress') and value.get('operation_id') in SLOTS))
        return self._journal.append(event,value)


def continuation_journal(journal, verified, *, initialize=False):
    if verified is None or verified.authority['schema']!=10:return journal
    if type(journal) is _ContinuationJournal:
        need(journal._verified.binding_digest==verified.binding_digest)
        journal._check();return journal
    source=_source(verified);binding=journal.values('binding');need(len(binding)==1)
    need(binding[0]['attempt']['binding_digest']==verified.binding_digest)
    expected={'schema':1,'kind':KIND,'attempt_binding_digest':verified.binding_digest,
        'origin_authority_sha256':source['previous_authority_sha256'],'origin_child_sha256':source['child_sha256'],
        'origin_child_tail':source['child_tail'],'proof_sha256':source['proof_sha256'],
        'operation_digests':{k:digest(v) for k,v in source['carried_operations'].items()},
        'receipt_digests':{k:digest(v) for k,v in source['carried_receipts'].items()},
        'intent_digests':{v['operation_id']:digest(v) for v in source['carried_intents']}}
    saved=journal.values('foundation_import')
    if not saved:
        need(initialize is True and len(journal.values('plan'))==1
             and not journal.values('intent') and not journal.values('progress'))
        journal.append('foundation_import',expected)
    else:need(saved==[expected])
    result=_ContinuationJournal(journal,verified);result._check();return result

# BEGIN GENERATED FROZEN RUNTIME COMPILER
import base64
import json
import re
from .resources import (build_resource_operations, POLICY_ENV, FORMAL_END, RETENTION_END, SOURCE,
    _require, _time, _receipt, public_trial_origin)

def build_continued_runtime_operations(manifest, authority_bundle, bindings, receipts, policy_environment, *, verify_policy, auth_operation, deadline, verified_attempt):
    """Install a verified signed policy without replacing either secret array.

    ``verify_policy`` must be the pinned existing trial verifier, not an HTTP
    assertion. Root supplies journal-authenticated receipts; this builder checks
    their exact request hashes. It neither creates nor signs a policy or key.
    """
    try:
        need(verified_attempt.authority['schema']==10)
        original = {op['id']:op for op in inherit_resources(build_resource_operations(manifest,authority_bundle,bindings),verified_attempt)}
        _require(set(policy_environment) == set(POLICY_ENV) and callable(verify_policy))
        _require(all(isinstance(x, str) and 0 < len(x.encode('utf-8')) <= 32768 for x in policy_environment.values()))
        signature = policy_environment['TRIAL_POLICY_SIGNATURE']
        _require(bool(re.fullmatch(r'[A-Za-z0-9+/]{86}==', signature)) and len(base64.b64decode(signature, validate=True)) == 64)
        public_key = policy_environment['TRIAL_POLICY_PUBLIC_KEY']
        public_match = re.fullmatch(r'-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----\r?\n?', public_key)
        _require(public_match is not None)
        der = base64.b64decode(''.join(public_match.group(1).split()), validate=True)
        _require(len(der) == 44 and der[:12] == bytes.fromhex('302a300506032b6570032100'))
        try:
            verified = verify_policy({'DEPLOYMENT_KIND': 'trial', **policy_environment})
        except Exception:
            raise Denied('resource_policy_unverified') from None
        policy = json.loads(policy_environment['TRIAL_POLICY_JSON'])
        _require(verified == policy and policy['schema'] == 1 and policy['approval'] == 'LIGHTWEIGHT_GROUP_TRIAL_V3')
        end = _time(deadline)
        _require(end <= _time(policy['endsAt']) <= _time(FORMAL_END) and _time(policy['startsAt']) < _time(policy['endsAt']))
        _require(policy['phase'] in ('initial', 'trial'))
        if policy['phase'] == 'initial':
            _require((_time(policy['endsAt']) - _time(policy['startsAt'])).total_seconds() <= 1800)
        else:
            _require(policy['startsAt'] == '2026-10-17T00:00:00Z' and policy['endsAt'] == FORMAL_END)
        _require(policy['retentionReviewAt'] == RETENTION_END and policy['image'] == bindings['runtime_image'])
        _require(policy['codeSha'] == bindings['code_sha'])
        _require(policy['jobResourceId'] == manifest['ids']['job'] and policy['environmentResourceId'] == manifest['existing']['environment'])
        web, worker = _receipt(original['webIdentity'], receipts), _receipt(original['workerIdentity'], receipts)
        app = _receipt(original['app'], receipts)
        _receipt(original['job'], receipts)
        _require(web['tenantId'] == worker['tenantId'] == manifest['owner']['tenant_id'])
        _require(policy['identity'] == {'webClientId': web['clientId'], 'workerClientId': worker['clientId']})
        _require(web['clientId'] != worker['clientId'] and web['principalId'] != worker['principalId'])
        auth = receipts['E1']
        _require(auth_operation.get('id') == 'E1' and auth.get('operation_id') == 'E1' and auth.get('request_digest') == digest(auth_operation))
        _require(all(auth.get(k) is True for k in ('terminal', 'write_terminal', 'created_by_run', 'readback_verified')) and auth.get('state') == 'succeeded')
        _require(policy['auth'] == {'tenantId': manifest['owner']['tenant_id'], 'ownerId': manifest['owner']['principal_id'],
                                  'clientId': auth['properties']['appId'], 'origin': public_trial_origin(manifest, app['defaultDomain'])})
        db = manifest['db']
        _require(policy['database']['database'] == db['name'] and policy['database']['webUser'] == db['web'] and policy['database']['workerUser'] == db['worker'])
        _require(policy['database']['host'] == manifest['existing']['db'].rsplit('/', 1)[-1] + '.postgres.database.azure.com' and policy['database']['port'] == 5432)
        _require(policy['storage'] == {'account': manifest['existing']['storage'].rsplit('/', 1)[-1],
            **{k: manifest['names'][k] for k in ('originals', 'artifacts', 'budget')}})
        _require(policy['ai']['resourceName'] == manifest['existing']['ai'].rsplit('/', 1)[-1])
        result = []
        for slot, role in (('job', 'worker'), ('app', 'web')):
            prior = original[slot]
            template = deepcopy(prior['body']['properties']['template'])
            env = template['containers'][0]['env']
            env.extend({'name': name, 'value': policy_environment[name]} for name in POLICY_ENV)
            env.append({'name': 'DATABASE_URL', 'secretRef': SOURCE[role]})
            op = deepcopy(prior)
            op.update(id=slot + 'Runtime', method='PATCH', body={'properties': {'template': template}}, deadline=deadline,
                      depends_on=[slot, 'webIdentity', 'workerIdentity', 'E1', 'trialDatabaseBootstrap'])
            op['expected'].update(before_absent=False,
                update_from={'operation_id': prior['id'], 'request_digest': digest(prior)},
                body_sha256=digest(op['body']))
            op['expected'].pop('secret_bindings', None)
            op['expected']['properties']['properties.template'] = template
            result.append(op)
        return result
    except (KeyError, TypeError, ValueError, OverflowError):
        raise Denied('resource_runtime_binding') from None
