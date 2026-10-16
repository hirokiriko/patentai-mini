"""Bounded OWNER-private configuration loading; no token or external I/O.

The caller observes normal AzureCliCredential identity and verifies local code
against Git HEAD. This module compares those observations with fixed approval
sources; it neither logs source bodies nor treats a local CI receipt as a new
remote observation. All writes and live dispatch remain controller decisions.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
from uuid import UUID

from scripts.trial_guard.adapters import digest
from .private_io import verify_owner_file


SOURCE_FILES = {
    'manifest': 'trial-cloud-manifest-20261010.local.json',
    'annex': 'additional-authority-concrete-20261010T182937Z.local.json',
    'approval': 'additional-approval-20261010T222452Z.local.json',
    'latest': 'additional-approval-20261010T233800Z.local.json',
    'network_binding': 'network-binding.local.json',
    'network_approval': 'additional-approval-20261010T130900Z.local.json',
}
FORMAL_END = '2026-10-31T00:00:00Z'
AUTH_END = '2027-01-29T00:00:00Z'
MAX_BYTES = 4 * 1024 * 1024
SEED = {'owner_arm': 128, 'owner_control_blob': 32, 'heartbeat_blob': 0}
SECRET_ALIASES = frozenset(('trial-web-database', 'trial-worker-database'))


class ConfigurationError(ValueError):
    """Non-sensitive classification only; never source values or file paths."""


def _need(ok, code):
    if not ok:
        raise ConfigurationError(code)


def _keys(value, required, optional=frozenset()):
    _need(isinstance(value, dict) and required <= set(value) <= required | optional, 'config_fields')


def _sha(value):
    _need(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'config_digest')
    return value


def _guid(value):
    try:
        _need(isinstance(value, str) and str(UUID(value)) == value.lower() and UUID(value).int != 0,
              'config_identity')
        return value.lower()
    except (ValueError, TypeError, AttributeError):
        raise ConfigurationError('config_identity') from None


def _time(value):
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace('Z', '+00:00'))
        _need(result.tzinfo is not None and result.utcoffset().total_seconds() == 0, 'config_time')
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise ConfigurationError('config_time') from None


def _json(raw):
    def pairs(items):
        value = {}
        for k, v in items:
            _need(k not in value, 'duplicate_config_key')
            value[k] = v
        return value
    def invalid(_):
        raise ConfigurationError('config_json')
    try:
        result = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeError):
        raise ConfigurationError('config_json') from None
    _need(isinstance(result, dict), 'config_json')
    return result


def _path(value, *, directory=False):
    _need(isinstance(value, (str, Path)), 'config_path')
    path = Path(value)
    try:
        _need(path.is_absolute() and path.exists() and path.resolve(strict=True) == path, 'config_path')
        for part in (path, *path.parents):
            attrs = getattr(part.lstat(), 'st_file_attributes', 0)
            _need(not part.is_symlink() and not attrs & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024),
                  'config_link')
        _need(path.is_dir() if directory else path.is_file(), 'config_path')
    except OSError:
        raise ConfigurationError('config_path') from None
    return path


def _read(path, acl_check):
    """Check fixed current-user ACL before and after a bounded stable-file read."""
    path = _path(path)
    try:
        acl_check(path)
        before = path.stat()
        _need(0 < before.st_size <= MAX_BYTES, 'config_file_size')
        with path.open('rb') as stream:
            raw = stream.read(MAX_BYTES + 1)
        after = path.stat()
        acl_check(path)
        _need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
              (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
              and len(raw) == after.st_size, 'config_file_changed')
        return raw
    except OSError:
        raise ConfigurationError('config_private_file') from None


def _file_ref(value):
    _keys(value, {'path', 'sha256'})
    _need(isinstance(value['path'], str) and Path(value['path']).is_absolute(), 'config_path')
    _sha(value['sha256'])


def _read_ref(value, acl_check):
    _file_ref(value)
    raw = _read(value['path'], acl_check)
    _need(hashlib.sha256(raw).hexdigest() == value['sha256'], 'config_source_changed')
    return raw


def _directory(value):
    _keys(value, {'directory', 'directory_digest'})
    _need(digest(str(_path(value['directory'], directory=True))) == value['directory_digest'], 'config_directory')


def _validate_windows(config):
    windows = config['plan_bindings']
    _keys(windows, {'guardian_window', 'owner_window'})
    for key, maximum in (('guardian_window', 28800), ('owner_window', 3600)):
        _keys(windows[key], {'start', 'end'})
        start, end = _time(windows[key]['start']), _time(windows[key]['end'])
        _need(start.microsecond == end.microsecond == 0 and 0 < (end - start).total_seconds() <= maximum
              and end <= _time(FORMAL_END), 'config_window')
    guardian, owner = windows['guardian_window'], windows['owner_window']
    _need(_time(guardian['start']) <= _time(owner['start']) < _time(owner['end']) <= _time(guardian['end']),
          'config_window')
    _need(config['runtime_deadline'] == FORMAL_END and config['auth_deadline'] == AUTH_END, 'config_deadline')
    expected = {'guardian': guardian['end'], 'owner_input': owner['end'], 'runtime': FORMAL_END, 'auth': AUTH_END}
    _need(config['cleanup_deadlines'] == expected, 'config_cleanup_due')


def _validate_ci(value, head, now):
    _keys(value, {'head_sha', 'status', 'conclusion', 'required_checks', 'source_url', 'checked_at'})
    _need(value['head_sha'] == head and value['status'] == 'completed'
          and value['conclusion'] == 'success', 'config_ci')
    checks = value['required_checks']
    _need(isinstance(checks, list) and len(checks) == 2, 'config_ci')
    for check in checks:
        _keys(check, {'name', 'status', 'conclusion'})
        _need(check['status'] == 'completed' and check['conclusion'] == 'success', 'config_ci')
    _need({c['name'] for c in checks} == {'ci', 'isolated-pg16'}, 'config_ci')
    _need(isinstance(value['source_url'], str) and re.fullmatch(
        r'https://github\.com/hirokiriko/patentai-mini/actions/runs/[0-9]+', value['source_url']), 'config_ci_source')
    _need(_time(value['checked_at']) <= now, 'config_ci_time')


def _load_common_configuration(path, *, now, local_head, owner_context,
                               local_source_digests=None, acl_check=verify_owner_file,
                               required_extra=frozenset(), optional_extra=frozenset(),trusted_attempt_authority=None):
    """Shared private authority/head/CI/source/budget gates; never allocates.

    Only fixed reviewed callers select additional schema fields. Publication
    uses this stage before actual registry digests exist; it cannot fabricate
    resource bindings in order to enter the normal provisioning loader.
    """
    raw_config = _read(path, acl_check)
    config = _json(raw_config)
    _keys(config, {'schema', 'sources', 'frozen_head', 'ci', 'recovery', 'control_budget'} | required_extra,
          {'live', 'code_sources','attempt','attempt_evidence'} | optional_extra)
    _need(type(config['schema']) is int and config['schema'] == 1, 'config_schema')
    _need(type(config.get('live', False)) is bool, 'config_live')
    config.setdefault('live', False)
    _need(isinstance(local_head, str) and re.fullmatch('[a-f0-9]{40}', local_head)
          and config['frozen_head'] == local_head, 'config_head')
    current = _time(now)
    _keys(config['sources'], set(SOURCE_FILES))
    sources, parsed, parents = {}, {}, set()
    for slot, basename in SOURCE_FILES.items():
        ref = config['sources'][slot]
        _file_ref(ref)
        source_path = Path(ref['path'])
        _need(source_path.name == basename, 'config_source_name')
        parents.add(source_path.parent)
        sources[slot] = _read_ref(ref, acl_check)
        parsed[slot] = _json(sources[slot])
    _need(len(parents) == 1, 'config_source_directory')
    hashes = {slot: hashlib.sha256(raw).hexdigest() for slot, raw in sources.items()}
    origin_manifest = hashes['manifest']
    if trusted_attempt_authority is not None and 'attempt_evidence' in config:
        preview_raw = _read_ref(config['attempt_evidence']['authority'], acl_check)
        _need(hashlib.sha256(preview_raw).hexdigest() == trusted_attempt_authority, 'attempt_trusted_authority')
        preview_authority = _json(preview_raw)
        if type(preview_authority.get('schema')) is int and preview_authority['schema'] in (7, 8, 9, 10):
            origin_manifest = _sha(preview_authority['origin_manifest_sha256'])
    # The V7 exception is usable only if full trusted succession verification
    # below succeeds. All unchanged source documents retain their old hashes.
    links = (('annex', 'fixedManifestSha256', 'manifest'), ('approval', 'boundProposalSha256', 'annex'),
             ('approval', 'fixedManifestSha256', 'manifest'), ('latest', 'priorApprovalSha256', 'approval'),
             ('latest', 'originalProposalSha256', 'annex'), ('latest', 'fixedManifestSha256', 'manifest'),
             ('network_approval', 'networkOriginalBindingSha256', 'network_binding'))
    for parent, field, child in links:
        _need(parsed[parent].get(field) == (origin_manifest if child == 'manifest' else hashes[child]), 'config_authority_chain')
    manifest = parsed['manifest']
    _keys(owner_context, {'mode', 'tenant_id', 'principal_id'})
    try:
        _need(owner_context['mode'] == 'AzureCliCredential'
              and all(_guid(owner_context[k]) == _guid(manifest['owner'][k])
                      for k in ('tenant_id', 'principal_id')), 'config_owner')
        _need(_time(parsed['latest']['approvedAt']) <= current, 'config_approval_time')
    except KeyError:
        raise ConfigurationError('config_binding') from None
    _validate_ci(_json(_read_ref(config['ci'], acl_check)), local_head, current)
    _directory(config['recovery'])
    control = config['control_budget']
    _keys(control, {'directory', 'directory_digest', 'binding', 'seed'})
    _directory({k: control[k] for k in ('directory', 'directory_digest')})
    _need(control['directory'] == config['recovery']['directory'], 'config_control_directory')
    _keys(control['binding'], {'manifest_sha256', 'owner_id', 'task_id', 'source_sha256'})
    _need(control['binding']['manifest_sha256'] == origin_manifest
          and _guid(control['binding']['owner_id']) == _guid(manifest['owner']['principal_id']), 'config_control_binding')
    _need(isinstance(control['binding']['task_id'], str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', control['binding']['task_id']),
          'config_control_binding')
    _sha(control['binding']['source_sha256'])
    _need(control['seed'] == SEED and all(type(v) is int for v in control['seed'].values()), 'config_control_seed')
    code = config.get('code_sources', {})
    _need(isinstance(code, dict), 'config_code_sources')
    _need(not config['live'] or bool(code), 'config_live_code_pins')
    for relative, value in code.items():
        _need(isinstance(relative, str) and not PurePosixPath(relative).is_absolute()
              and not PureWindowsPath(relative).drive and not PureWindowsPath(relative).root
              and ':' not in relative and '..' not in PurePosixPath(relative).parts
              and '\\' not in relative and relative not in ('', '.'), 'config_code_sources')
        _sha(value)
    if code:
        _need(local_source_digests == code, 'config_code_changed')
    result = deepcopy(config)
    result.update(manifest=manifest, authority_bundle=sources,
                  config_sha256=hashlib.sha256(raw_config).hexdigest(),
                  gates={'owner_matches': True, 'head_matches': True, 'ci_passed': True,
                         'source_hashes_match': True, 'code_pins_checked': bool(code)})
    if 'attempt' in config or 'attempt_evidence' in config:
        _need('attempt' in config and 'attempt_evidence' in config,'attempt_sources')
        from .attempt import ARTIFACTS,verify_attempt
        evidence=config['attempt_evidence'];_keys(evidence,{'authority','parent_final','artifacts'});_keys(evidence['artifacts'],set(ARTIFACTS))
        _file_ref(config['attempt'])
        parent_path=Path(config['recovery']['directory'])/'trial-provision.jsonl'
        result['verified_attempt']=verify_attempt(result,manifest,authority_raw=_read_ref(evidence['authority'],acl_check),
            activation_raw=_read_ref(config['attempt'],acl_check),parent_journal_raw=_read(parent_path,acl_check),
            parent_final_raw=_read_ref(evidence['parent_final'],acl_check),
            artifacts={key:_read_ref(evidence['artifacts'][key],acl_check) for key in ARTIFACTS},
            trusted_authority_sha256=trusted_attempt_authority,now=now)
    else:_need(trusted_attempt_authority is None,'attempt_not_configured')
    return result


def load_configuration(path, *, now, local_head, owner_context,
                       local_source_digests=None, acl_check=verify_owner_file,trusted_attempt_authority=None):
    """Load post-publication inputs; default live=False never starts transport.

    ``owner_context`` is caller-observed AzureCliCredential mode, tenant_id and
    principal_id. ``local_source_digests`` must already match Git HEAD/current
    files. No CLI/token/credential subprocess is invoked. Expired windows may
    load for exact-created cleanup; new writes need the fresh controller gate.
    """
    result = _load_common_configuration(path, now=now, local_head=local_head,
        owner_context=owner_context, local_source_digests=local_source_digests, acl_check=acl_check,
        required_extra={'plan_bindings', 'resource_bindings', 'runtime_deadline', 'auth_deadline',
                        'cleanup_deadlines', 'policy_verifier_node'}, optional_extra={'secret_sources'},trusted_attempt_authority=trusted_attempt_authority)
    _validate_windows(result)
    _path(result['policy_verifier_node'])
    resources = result['resource_bindings']
    _keys(resources, {'deadline', 'guardian_deadline', 'runtime_image', 'guardian_image', 'db_secret_digests', 'code_sha'})
    from .attempt import effective_image_head
    image_head = effective_image_head(result.get('verified_attempt'), local_head)
    _need(resources['code_sha'] == image_head and resources['guardian_deadline'] == result['plan_bindings']['guardian_window']['end'],
          'config_resource_binding')
    # Resource syntax/images/scopes receive full pure-builder validation when
    # root combines the nine resource operations with the core29 operations.
    _need(_time(resources['deadline']) <= _time(resources['guardian_deadline']), 'config_resource_binding')
    _need(isinstance(result.get('secret_sources', {}), dict), 'config_secret_sources')
    for alias, ref in result.get('secret_sources', {}).items():
        _need(alias in SECRET_ALIASES, 'config_secret_alias')
        _file_ref(ref)  # May not exist until approved DB bootstrap; do not read it.
        digest_key = 'web' if alias == 'trial-web-database' else 'worker'
        _need(ref['sha256'] == resources['db_secret_digests'].get(digest_key), 'config_secret_digest')
    return result


def require_execution_window(config, operation, now):
    """Gate new writes only. Exact-owned cleanup uses its controller route.

    Frozen due times are never extended by this function. A cleanup_* label
    alone does not authorize an expired operation through this entry point.
    """
    current = _time(now)
    slot = operation.get('id', '')
    _need(not slot.startswith('cleanup_') and operation.get('method') != 'DELETE'
          and not operation.get('kind', '').startswith('cleanup:')
          and not operation.get('expected', {}).get('auth_action', '').startswith('cleanup:'),
          'cleanup_requires_exact_controller_route')
    _need(current < _time(operation['deadline']), 'operation_expired')
    key = 'guardian_window' if slot in {'G' + str(i) for i in range(1, 7)} else 'owner_window' if slot in ('O1', 'O2') else None
    if key:
        window = config['plan_bindings'][key]
        _need(_time(window['start']) <= current < _time(window['end']), 'operation_window')
