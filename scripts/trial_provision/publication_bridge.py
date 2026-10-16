"""Local-only bridge from verified image publication to normal preparation.

No credential, HTTP request, image push, deadline renewal or secret read occurs
here. The caller releases the publication journal and budget before completion
enters the existing normal CLI. An interrupted exact output is reconciled by
its recorded hash; a different input or any unowned output is never replaced.
"""
from copy import deepcopy
import hashlib
import os
from pathlib import Path,PurePosixPath,PureWindowsPath
import uuid

from scripts.trial_guard.adapters import digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from .configuration import (AUTH_END, FORMAL_END, SECRET_ALIASES, _file_ref,
                            _json, _path, _validate_windows)
from .journal import Journal
from .operations import create_resolver
from .plan import build_plan
from .private_io import create_owner_file, verify_owner_directory, verify_owner_file
from .registry_publish import (verified_publication_images, publication_origin,
                              reuses_acknowledged_images, reused_image_preparation)
from .resources import build_resource_operations


OUTPUT_NAME = 'provision-config.json'
INPUT_KEYS = {'schema', 'publication_config_sha256', 'plan_bindings', 'deadline',
              'secret_sources', 'policy_verifier_node'}


def need(value):
    if not value:
        raise Denied('publication_bridge_unconfirmed')


def _output_bytes(reference):
    path = Path(reference['path'])
    verify_owner_file(path)
    before = path.stat()
    need(0 < before.st_size <= 2 * 1024 * 1024)
    with path.open('rb') as stream:
        raw = stream.read(2 * 1024 * 1024 + 1)
    after = path.stat()
    verify_owner_file(path)
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
         and len(raw) == after.st_size
         and hashlib.sha256(raw).hexdigest() == reference['sha256'])
    return raw


def compose_configuration(publication, journal, inputs, *, verify_local_node=True):
    """Use explicit approved windows and only acknowledged registry digests."""
    need(isinstance(inputs, dict) and set(inputs) == INPUT_KEYS
         and type(inputs['schema']) is int and inputs['schema'] == 1
         and inputs['publication_config_sha256'] == publication['config_sha256'])
    images = verified_publication_images(journal,verified_attempt=publication.get('verified_attempt'))
    verified=publication.get('verified_attempt')
    from .attempt import effective_image_head
    image_head=effective_image_head(verified,publication['frozen_head'])
    origin=publication_origin(journal,verified_attempt=verified)
    preparation = origin.values('publication_preparation')[0]
    origin_sources = {key: value['sha256'] for key, value in publication['sources'].items()}
    if verified is not None and verified.authority['schema'] in (7, 8, 9, 10):
        from .attempt import _proof
        origin_sources = _proof(verified)['succession']['origin_sources']
    need(preparation['code_sha'] == image_head
         and preparation['source_sha256'] == origin_sources)
    if reuses_acknowledged_images(verified):
        preparation=reused_image_preparation(journal,verified)
        need(preparation['configuration_sha256']==publication['config_sha256'])
    refs = inputs['secret_sources']
    need(isinstance(refs, dict) and set(refs) == SECRET_ALIASES)
    for ref in refs.values():
        _file_ref(ref)  # Reference syntax only; never opens a credential file.
    node = inputs['policy_verifier_node']
    need(type(verify_local_node) is bool)
    if verify_local_node:executable = _path(node)
    else:
        # Historical closed-attempt verification is pure. Its signed path is
        # syntax-checked without consulting today's filesystem or invoking it.
        need(type(node) is str and not any(ord(c)<32 for c in node))
        executable = PureWindowsPath(node) if PureWindowsPath(node).is_absolute() else PurePosixPath(node)
        need(executable.is_absolute() and '..' not in executable.parts)
    need(executable.name.lower() in ('node', 'node.exe'))
    common = {'schema', 'sources', 'frozen_head', 'ci', 'recovery', 'control_budget'}
    need(common <= set(publication) and type(publication.get('live', False)) is bool)
    config = {key: deepcopy(publication[key]) for key in common}
    if 'attempt' in publication:
        config.update({key:deepcopy(publication[key]) for key in ('attempt','attempt_evidence')})
        verified=publication['verified_attempt'];w=verified.activation['windows']
        need(inputs['plan_bindings']=={'guardian_window':w['guardian'],'owner_window':w['owner_input']})
    if 'code_sources' in publication:
        config['code_sources'] = deepcopy(publication['code_sources'])
    windows = deepcopy(inputs['plan_bindings'])
    need(isinstance(windows, dict) and set(windows) == {'guardian_window', 'owner_window'})
    # Preserve the exact already-pinned mode. This bridge itself never sends;
    # a prepared live configuration still needs the ordinary per-action gates.
    config.update(live=publication.get('live', False), plan_bindings=windows, runtime_deadline=FORMAL_END,
                  auth_deadline=AUTH_END, policy_verifier_node=node,
                  cleanup_deadlines={'guardian': windows['guardian_window']['end'],
                      'owner_input': windows['owner_window']['end'],
                      'runtime': FORMAL_END, 'auth': AUTH_END},
                  secret_sources=deepcopy(refs), resource_bindings={**images,
                      'code_sha': image_head, 'deadline': inputs['deadline'],
                      'guardian_deadline': windows['guardian_window']['end'],
                      'db_secret_digests': {'web': refs['trial-web-database']['sha256'],
                                           'worker': refs['trial-worker-database']['sha256']}})
    _validate_windows(config)
    # These are the approved IAM windows (guardian <=8h, OWNER <=1h),
    # validated above. The main Job's independent runtime stays at 1800s.
    need(parse(preparation['publish_until']) <= parse(windows['owner_window']['end'])
         and parse(windows['owner_window']['start']) < parse(inputs['deadline'])
         <= parse(windows['owner_window']['end']))
    # Refuse invalid resource scopes before freezing any output or intent.
    build_resource_operations(publication['manifest'], publication['authority_bundle'],
                              config['resource_bindings'])
    return config


def _require_record(journal, event, expected, *, optional=False):
    saved = journal.values(event)
    need(saved == [expected] or (optional and not saved))
    return bool(saved)


def _core_plan(publication, config, checked_at, allocate):
    resources = build_resource_operations(publication['manifest'], publication['authority_bundle'],
                                           config['resource_bindings'])
    bindings = {**config['plan_bindings'],
                'prerequisite_digests': {operation['id']: digest(operation) for operation in resources}}
    return build_plan(publication['manifest'], publication['authority_bundle'],
                      bindings, checked_at, allocate,
                      verified_attempt=publication.get('verified_attempt'))


def prepare_bridge(publication, journal, reference, *, now):
    """Persist the exact immutable draft while the publication lock is held."""
    from .cli import private_bytes
    _file_ref(reference)
    inputs = _json(private_bytes(reference))
    config = compose_configuration(publication, journal, inputs)
    directory = Path(publication['recovery']['directory'])
    verify_owner_directory(directory)
    from .attempt import journal_descriptor
    child_name, _ = journal_descriptor(publication,publication.get('verified_attempt'))
    output = directory / {'trial-provision':OUTPUT_NAME,
        'trial-provision-next':'provision-next-config.json',
        'trial-provision-successor':'provision-successor-config.json',
        'trial-provision-successor-v3':'provision-successor-v3-config.json',
        'trial-provision-successor-v4':'provision-successor-v4-config.json',
        'trial-provision-successor-v5':'provision-successor-v5-config.json',
        'trial-provision-successor-v6':'provision-successor-v6-config.json',
        'trial-provision-successor-v7':'provision-successor-v7-config.json',
        'trial-provision-continuation-v7r1':'provision-continuation-v7r1-config.json',
        'trial-provision-successor-v8':'provision-successor-v8-config.json',
        'trial-provision-continuation-v8r1':'provision-continuation-v8r1-config.json'}[child_name]
    raw = encoded(config)
    need(0 < len(raw) <= 2 * 1024 * 1024)
    previous = journal.values('provision_bridge_intent')
    need(len(previous) <= 1)
    checked_at = previous[0]['checked_at'] if previous else now.isoformat()
    # Full authority/core validation must precede every durable allocation or
    # immutable output. Ephemeral IDs are used only for this no-I/O validation.
    preview_core = _core_plan(publication, config, checked_at,
        lambda key: str(uuid.uuid5(uuid.NAMESPACE_URL, 'publication-bridge-preview:' + key)))
    create_resolver(preview_core, publication['manifest'], publication['authority_bundle'],
                    config['resource_bindings'],verified_attempt=publication.get('verified_attempt'))
    origin=publication_origin(journal,verified_attempt=publication.get('verified_attempt'))
    binding = {'schema': 1, 'publication_config_sha256': publication['config_sha256'],
               'checked_at': checked_at,
               'input_sha256': reference['sha256'], 'code_sha': publication['frozen_head'],
               'run_binding_digest': digest(journal.values('binding')[0]),
               'image_receipt_digests': {slot: digest(origin.latest(slot + 'ImagePush'))
                                       for slot in ('guardian', 'runtime')},
               'output': {'path': str(output), 'sha256': hashlib.sha256(raw).hexdigest()}}
    if previous:
        need(previous == [binding])
    else:
        # Even identical bytes cannot make an earlier, unowned file ours.
        need(not output.exists() and not output.is_symlink()
             and not journal.values('core_plan') and not journal.values('plan'))
        journal.append('provision_bridge_intent', binding)
    # Reuse this exact preparation time after close/reopen or process failure.
    # Normal prepare consumes this core; it does not renew already-fixed windows.
    core = _core_plan(publication, config, checked_at, journal.allocate_id)
    saved_core = journal.values('core_plan')
    need(not saved_core or saved_core == [core])
    if not saved_core:
        journal.append('core_plan', core)
    if output.exists() or output.is_symlink():
        need(_output_bytes(binding['output']) == raw)
    else:
        # Exclusive creation, never truncate/replace an existing output.
        fd = create_owner_file(output)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        need(_output_bytes(binding['output']) == raw)
    saved = journal.values('provision_bridge_output')
    need(not saved or saved == [binding])
    if not saved:
        journal.append('provision_bridge_output', binding)
    return binding


def _journal(publication):
    from .attempt import journal_descriptor
    recovery = publication['recovery']
    name,binding=journal_descriptor(publication,publication.get('verified_attempt'))
    return Journal(recovery['directory'], recovery['directory_digest'],
                   binding,name=name,require_existing=True)


def _prepared_record(journal, binding):
    core = journal.values('core_plan')
    plans = journal.values('plan')
    imports = journal.values('publication_import')
    need(len(core) == len(plans) == len(imports) == 1)
    return {'binding_digest': digest(binding), 'plan_digest': digest(plans[0]),
            'core_plan_digest': digest(core[0]),
            'publication_import_digest': digest(imports[0])}


def _summary(binding, repeated):
    return {'status': 'provision_prepared', 'cloud_calls': 0,
            'config_file': Path(binding['output']['path']).name,
            'config_sha256': binding['output']['sha256'], 'replayed': repeated}


def complete_bridge(publication, binding, *, clock,trusted_attempt_authority=None):
    """Call the real normal entry only after all publication locks are closed."""
    with _journal(publication) as journal:
        _require_record(journal, 'provision_bridge_intent', binding)
        _require_record(journal, 'provision_bridge_output', binding)
        _output_bytes(binding['output'])
        saved = journal.values('provision_bridge_prepared')
        if saved:
            need(saved == [_prepared_record(journal, binding)])
            return _summary(binding, True)
    from .cli import run_command
    kwargs={} if trusted_attempt_authority is None else {'trusted_attempt_authority':trusted_attempt_authority}
    result = run_command({'action': 'prepare', 'config': binding['output']['path']}, clock=clock,**kwargs)
    need(result.get('status') == 'prepared' and result.get('cloud_calls') == 0)
    with _journal(publication) as journal:
        _require_record(journal, 'provision_bridge_intent', binding)
        _require_record(journal, 'provision_bridge_output', binding)
        _output_bytes(binding['output'])
        record = _prepared_record(journal, binding)
        if not _require_record(journal, 'provision_bridge_prepared', record, optional=True):
            journal.append('provision_bridge_prepared', record)
    return _summary(binding, False)
