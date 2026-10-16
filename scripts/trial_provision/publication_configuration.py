"""Pre-publication private inputs, before any registry manifest digest exists.

Shares the normal authority/head/CI/OWNER/source/budget gates, but deliberately
does not accept resource_bindings, registry manifest digests or a resource
plan. It reads local executable metadata and protected build receipts only;
the publisher validates their semantic proof before any authenticated I/O.
"""
import hashlib
import re

from .configuration import (
    ConfigurationError, FORMAL_END, _json, _keys, _load_common_configuration,
    _need, _path, _read_ref, _sha, _time,
)
from .private_io import verify_owner_file


DOCKER_HOSTS = frozenset(('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine'))
SLOTS = frozenset(('guardian', 'runtime'))
MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024


def _executable(path, expected):
    """Hash an existing fixed Docker CLI only; never starts a subprocess."""
    value = _path(path)
    _need(value.name.lower() in ('docker', 'docker.exe'), 'publication_docker_path')
    _sha(expected)
    try:
        before = value.stat()
        _need(0 < before.st_size <= MAX_EXECUTABLE_BYTES, 'publication_docker_size')
        total, hasher = 0, hashlib.sha256()
        with value.open('rb') as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                _need(total <= MAX_EXECUTABLE_BYTES, 'publication_docker_size')
                hasher.update(chunk)
        after = value.stat()
        _need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
              (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
              and total == before.st_size and hasher.hexdigest() == expected, 'publication_docker_changed')
    except OSError:
        raise ConfigurationError('publication_docker_unavailable') from None


def load_publication_configuration(path, *, now, local_head, owner_context,
                                   local_source_digests=None, acl_check=verify_owner_file,trusted_attempt_authority=None):
    """Read the same common gates without inventing post-push image digests.

    A no-auth prepare may initialize the already-approved common budget once;
    this function itself never creates a journal/counter or resets a seed.
    Actual publication must recheck ``publish_until`` and live/source fences.
    Build receipt semantics (exact HEAD/build/source/context/image ID) remain
    the publisher's strict validation, not a claim made by this file reader.
    """
    result = _load_common_configuration(path, now=now, local_head=local_head,
        owner_context=owner_context, local_source_digests=local_source_digests,
        acl_check=acl_check, required_extra={'publication', 'code_sources'},trusted_attempt_authority=trusted_attempt_authority)
    _need(bool(result['code_sources']) and result['gates']['code_pins_checked'], 'publication_source_pins')
    publication = result['publication']
    _keys(publication, {'publish_until', 'slots'})
    until = _time(publication['publish_until'])
    _need(isinstance(publication['publish_until'], str)
          and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', publication['publish_until'])
          and until <= _time(FORMAL_END), 'publication_deadline')
    latest = _json(result['authority_bundle']['latest'])
    _need(until > _time(latest['approvedAt']), 'publication_deadline')
    _keys(publication['slots'], set(SLOTS))
    common_docker = None
    receipts = {}
    for slot in sorted(SLOTS):
        binding = publication['slots'][slot]
        _keys(binding, {'docker_path', 'docker_sha256', 'docker_host', 'local_image_id', 'build_receipt'})
        _need(isinstance(binding['docker_host'], str) and binding['docker_host'] in DOCKER_HOSTS,
              'publication_docker_host')
        _need(isinstance(binding['local_image_id'], str) and
              re.fullmatch('sha256:[a-f0-9]{64}', binding['local_image_id']), 'publication_local_image')
        current = (binding['docker_path'], binding['docker_sha256'], binding['docker_host'])
        if common_docker is None:
            _executable(binding['docker_path'], binding['docker_sha256'])
            common_docker = current
        else:
            _need(current == common_docker, 'publication_docker_binding')
        receipts[slot] = _json(_read_ref(binding['build_receipt'], acl_check))
    result['build_receipts'] = receipts
    result['gates']['publication_window_open'] = _time(now) < until
    if 'verified_attempt' in result:
        start=result['verified_attempt'].activation['windows']['publication']['start']
        result['gates']['publication_window_open']=_time(start)<=_time(now)<until
    return result
