"""One standard Docker push per approved runtime/guardian slot, never a build.

The caller holds the provisioning Journal/ControlBudget locks and has verified
the private source/authority bundle. Existing OWNER credentials are exchanged
for one repository-scoped short-lived ACR token. Only our exact temporary
config.json contains it; no login, credential helper, default Docker config,
new grant, image retag, retry, registry enumeration or layer uploader is used.

Control HTTP/credential attempts debit the existing 600 pool. Docker's image
data traffic is recorded separately; this is not a wire-byte billing cap.
Contracts: https://github.com/Azure/acr/blob/main/docs/AAD-OAuth.md
https://docs.docker.com/reference/cli/docker/image/push/
https://github.com/docker/cli/blob/master/cli/config/config.go
"""
import base64
from copy import deepcopy
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from urllib.parse import urlencode

from scripts.trial_guard.adapters import Deadline, digest, encoded
from scripts.trial_guard.lifecycle import Denied, parse
from .journal import CountedControlHttp
from .private_io import create_owner_file, verify_owner_file, verify_owner_directory, _owner_security_attributes
from .registry import _binding, HEX, MAX_BODY, ACCEPT
from .rehearsal_cli import _Clock

IDENT = 'guardianImagePush'
VERSION = '2021-07-01'
NULL_USER = '00000000-0000-0000-0000-000000000000'
DOCKER_HOSTS = ('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine')


def need(value):
    if not value: raise Denied('registry_publish_unconfirmed')


def sha(raw): return hashlib.sha256(raw).hexdigest()


def _identity(path):
    value = path.lstat()
    need(not path.is_symlink() and not getattr(value,'st_file_attributes',0)&1024)
    return [value.st_dev, value.st_ino]


def _mkdir(path, *, directory=False):
    if os.name != 'nt':
        path.mkdir(mode=0o700)
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, wintypes.LPVOID]
    kernel.CreateDirectoryW.restype = wintypes.BOOL
    with _owner_security_attributes(directory=directory) as attributes:
        if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())


def _config_path(journal, slot="guardian", *, probe=False):
    need(slot in ("guardian", "runtime"))
    return journal.path.parent / ('trial-' + slot + ('-docker-probe-' if probe else '-docker-') + digest(journal.values('binding')[0])[:16])


def cleanup_docker_config(journal, slot="guardian", *, probe=False):
    """Local-only recovery: remove just our recorded file/directory, no recurse."""
    path = _config_path(journal,slot,probe=probe)
    prefix = slot + ('_docker_probe' if probe else '_docker')
    values = journal.values(prefix + '_config')
    dirs = journal.values(prefix + '_directory')
    need(len(values) <= 1 and len(dirs) <= 1)
    if not dirs:
        need(not os.path.lexists(path))
        return True
    need(dirs[0]['path_digest'] == digest(str(path)))
    if os.path.lexists(path):
        need(path.is_dir() and _identity(path) == dirs[0]['identity'])
        if probe: verify_owner_directory(path)
        file = path / 'config.json'
        if os.path.lexists(file):
            need(len(values) == 1 and values[0]['identity'] == _identity(file))
            verify_owner_file(file)
            file.unlink()
        # An unexpected file is never enumerated or recursively deleted.
        path.rmdir()
    need(not os.path.lexists(path) and not os.path.lexists(path / 'config.json'))
    if not journal.values(prefix + '_config_absent'):
        journal.append(prefix + '_config_absent', {'path_digest': digest(str(path)), 'absent': True})
    return True


def _write_empty_probe(journal, slot):
    """One exclusive empty config, with durable ownership before file bytes.

    Existing paths/history are never adopted, even if they appear empty. A
    partial creation can only use local cleanup; it cannot authorize a resend.
    """
    path = _config_path(journal,slot,probe=True)
    prefix = slot + '_docker_probe'
    need(not os.path.lexists(path) and not any(journal.values(prefix + suffix)
        for suffix in ('_directory','_config','_config_absent','_result')))
    _mkdir(path,directory=True)
    journal.append(prefix + '_directory', {'path_digest':digest(str(path)), 'identity':_identity(path)})
    verify_owner_directory(path)
    file = path / 'config.json'
    fd = create_owner_file(file)
    try:
        journal.append(prefix + '_config', {'identity':_identity(file)})
        with os.fdopen(fd,'wb') as stream:
            fd = None
            stream.write(encoded({'auths':{}})); stream.flush(); os.fsync(stream.fileno())
        verify_owner_file(file)
    finally:
        if fd is not None: os.close(fd)
    return path


def _docker_environment(config):
    environment = {k:os.environ[k] for k in ('SYSTEMROOT','WINDIR','TEMP','TMP') if k in os.environ}
    environment.update(DOCKER_CONFIG=str(config), PATH='')
    return environment


def _write_config(journal, host, token, slot):
    path = _config_path(journal,slot)
    need(not os.path.lexists(path) and not journal.values(slot + '_docker_directory'))
    _mkdir(path)
    journal.append(slot + '_docker_directory', {'path_digest': digest(str(path)), 'identity': _identity(path)})
    file = path / 'config.json'
    fd = create_owner_file(file)
    try:
        # Persist cleanup identity before a single credential byte reaches disk.
        journal.append(slot + '_docker_config', {'identity': _identity(file)})
        value = {'auths': {host: {'auth': base64.b64encode((NULL_USER + ':' + token).encode()).decode()}}}
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(encoded(value)); stream.flush(); os.fsync(stream.fileno())
        verify_owner_file(file)
        return path
    finally:
        if fd is not None: os.close(fd)


def docker_command(argv, *, timeout, environment):
    """Direct bounded child; private stdout in memory only, stderr discarded."""
    need(timeout > 0)
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, shell=False, env=environment,
        creationflags=0x08000000 if os.name == 'nt' else 0)
    output, read_error = bytearray(), threading.Event()
    def drain():
        try:
            while True:
                chunk = child.stdout.read(4096)
                if not chunk: break
                output.extend(chunk)
                # Keep a bounded stdout tail while draining all progress. This
                # is not an image size or wire cap and cannot stop a large push
                # merely because Docker printed many layer progress lines.
                if len(output) > 65536: del output[:-65536]
        except Exception: read_error.set()
    reader = threading.Thread(target=drain, daemon=True); reader.start()
    try:
        code = child.wait(timeout=timeout)
        reader.join(timeout=2)
        need(not reader.is_alive() and not read_error.is_set())
        return code, bytes(output)
    finally:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=2)
        child.stdout.close()


def prepare_publication(config, manifest, configuration_sha256, journal):
    """No I/O except the same Journal: call only after strict private validation.

    Registry manifest digests intentionally do not exist at this phase. Exact
    local build proof bytes and source identity are fixed before any upload.
    """
    from .configuration import SOURCE_FILES, FORMAL_END
    from .attempt import effective_slot
    from .registry_retention import check_attempt
    verified=config.get('verified_attempt');check_attempt(journal,verified)
    if reuses_acknowledged_images(verified):
        return _prepare_reused_images(config,manifest,configuration_sha256,journal)
    source = {k:config['sources'][k]['sha256'] for k in SOURCE_FILES}
    need(all(re.fullmatch(HEX,v) for v in source.values()) and re.fullmatch(HEX,configuration_sha256))
    need(re.fullmatch('[a-f0-9]{40}',config['frozen_head']))
    need(parse(config['publication']['publish_until']) <= parse(FORMAL_END))
    slots = {}
    for key,repo,tag in (('guardian','cleanupImageRepository','cleanupImageTag'),('runtime','imageRepository','imageTag')):
        local = config['publication']['slots'][key]
        slots[key] = {**effective_slot(manifest,config['frozen_head'],key,verified), 'local_image_id':local['local_image_id'],
            'docker_sha256':local['docker_sha256'],'docker_path_sha256':sha(local['docker_path'].encode()),
            'docker_host':local['docker_host'],'build_receipt_sha256':local['build_receipt']['sha256']}
    event = {'schema':1,'configuration_sha256':configuration_sha256,'manifest_sha256':source['manifest'],
        'source_sha256':source,'code_sha':config['frozen_head'],'run_binding_digest':digest(journal.values('binding')[0]),
        'registry_id':manifest['existing']['registry'],'login_server':manifest['registry']['loginServer'],
        'tenant_id':manifest['owner']['tenant_id'],'owner_id':manifest['owner']['principal_id'],'slots':slots,
        'publish_until':config['publication']['publish_until']}
    old = journal.values('publication_preparation')
    need(not old or old == [event])
    if not old: journal.append('publication_preparation',event)
    return event


def _verified_images(journal,slots,verified_attempt):
    """Actual acknowledged/read-verified digests only; never local image IDs."""
    from .registry_retention import check_attempt,verify_retention
    check_attempt(journal,verified_attempt)
    if reuses_acknowledged_images(verified_attempt):
        images=_verified_reused_images(journal,verified_attempt)
        return {slot+'_image':images[slot+'_image'] for slot in slots}
    preparations = journal.values('publication_preparation');need(len(preparations) == 1)
    prep = preparations[0];images = {}
    for slot in slots:
        ident = slot+'ImagePush';receipt=journal.latest(ident);fixed=prep['slots'][slot]
        if verified_attempt is not None:need(prep['code_sha']==verified_attempt.authority['head'] and fixed['tag']==verified_attempt.authority['tags'][slot])
        need(isinstance(receipt,dict) and receipt.get('operation_id') == ident and receipt.get('state') == 'succeeded'
            and receipt.get('ack_kind') == 'docker_exit0_digest'
            and all(receipt.get(k) is True for k in ('terminal','write_terminal','created_by_run','readback_verified')))
        p=receipt['properties'];actual=p.get('manifest_digest','')
        need(re.fullmatch('sha256:'+HEX,actual) and p == {'registry_id':prep['registry_id'],
            'login_server':prep['login_server'],'repository':fixed['repository'],'manifest_digest':actual,'purpose':slot})
        prefix='https://'+prep['login_server']+'/v2/'+fixed['repository']+'/manifests/'
        need(receipt['object_id'] == prefix+actual+'?api-version='+VERSION)
        intents=[v for v in journal.values('intent') if v['operation_id'] == ident]
        need(len(intents) == 1 and intents[0]['request_digest'] == receipt['request_digest']
            and intents[0]['method'] == 'PUT' and intents[0]['url'] == prefix+fixed['tag']+'?api-version='+VERSION)
        need(parse(intents[0]['at'])<parse(prep['publish_until']) and parse(intents[0]['deadline'])==parse(prep['publish_until'])
            and parse(receipt['observed_at'])>=parse(intents[0]['at']))
        namespace=journal.values(slot+'_image_namespace')
        need(len(namespace)==1)
        if verified_attempt is not None and slot=='runtime':
            verify_retention(journal,prep,namespace[0],intents[0],receipt,verified_attempt)
        else:need(namespace[0]['publication_preparation_digest'] == digest(prep)
            and namespace[0]['run_binding_digest'] == prep['run_binding_digest']
            and namespace[0]['push_request_digest'] == receipt['request_digest']
            and namespace[0]['authenticated'] is True and namespace[0]['http'] == 404
            and namespace[0]['error_code'] == 'NAME_UNKNOWN'
            and namespace[0]['method'] == 'GET' and namespace[0]['push_operation_id'] == ident
            and all(namespace[0][k] == prep[k] for k in ('registry_id','login_server'))
            and namespace[0]['repository'] == fixed['repository']
            and namespace[0]['url'] == 'https://'+prep['login_server']+'/acr/v1/'+fixed['repository']+'?api-version='+VERSION
            and re.fullmatch(HEX,namespace[0]['response_sha256'])
            and 0 <= (parse(intents[0]['at'])-parse(namespace[0]['observed_at'])).total_seconds() <= 30
            and parse(intents[0]['at']) < parse(prep['publish_until'])
            and parse(intents[0]['deadline']) == parse(prep['publish_until'])
            and parse(receipt['observed_at']) >= parse(intents[0]['at']))
        images[slot+'_image']=prep['login_server']+'/'+fixed['repository']+'@'+actual
    return images

def verified_publication_images(journal,*,verified_attempt=None):
    return _verified_images(journal,('guardian','runtime'),verified_attempt)

def verified_publication_image(journal,slot,*,verified_attempt=None):
    need(slot in ('guardian','runtime'))
    return _verified_images(journal,(slot,),verified_attempt)[slot+'_image']


def bind_publication(journal, resolver, resource_bindings,*,verified_attempt=None):
    """Second phase: bind both actual images into the compiled provision plan."""
    if reuses_acknowledged_images(verified_attempt):
        event=_reused_import(journal,resolver,resource_bindings,verified_attempt)
        old=journal.values('publication_import');need(not old or old==[event])
        if not old:journal.append('publication_import',event)
        return event
    images=verified_publication_images(journal,verified_attempt=verified_attempt);prep=journal.values('publication_preparation')[0]
    need(all(resource_bindings[k] == v for k,v in images.items())
        and prep['source_sha256'] == resolver.initial_plan['source_sha256']
        and prep['code_sha'] == resource_bindings['code_sha']
        and resolver.initial_plan['resource_bindings'] == resource_bindings)
    event={'schema':1,'initial_plan_digest':resolver.plan_digest,'publication_preparation_digest':digest(prep),
        'run_binding_digest':digest(journal.values('binding')[0]),
        'push_receipt_digests':{k:digest(journal.latest(k+'ImagePush')) for k in ('guardian','runtime')}}
    old=journal.values('publication_import');need(not old or old == [event])
    if not old:journal.append('publication_import',event)
    return event


class _Publisher:
    def __init__(self, bundle, manifest, journal, credential, wire, budget, clock, runner,verified_attempt=None):
        from .registry_retention import check_attempt
        from .attempt import effective_slot
        check_attempt(journal,verified_attempt);self.verified_attempt=verified_attempt
        need(not reuses_acknowledged_images(verified_attempt))
        need(isinstance(bundle, dict) and set(bundle) == {'schema','slot','docker_path','docker_sha256','docker_host','local_image_id','deadline'})
        need(type(bundle['schema']) is int and bundle['schema'] == 1 and bundle['slot'] in ('guardian','runtime'))
        self.slot = bundle['slot']; self.ident = self.slot + 'ImagePush'
        executable = Path(bundle['docker_path'])
        need(executable.is_absolute() and executable.is_file() and not executable.is_symlink()
            and str(executable.resolve()) == str(executable)
            and executable.name.lower() == ('docker.exe' if os.name == 'nt' else 'docker')
            and sha(executable.read_bytes()) == bundle['docker_sha256']
            and bundle['docker_host'] in DOCKER_HOSTS
            and re.fullmatch('sha256:' + HEX, bundle['local_image_id']) is not None)
        self.bundle, self.journal, self.runner = deepcopy(bundle), journal, runner
        self.clock = _Clock(journal, clock)
        self.credential, self.budget = credential, budget
        preparations = journal.values('publication_preparation')
        need(len(preparations) == 1)
        prep = preparations[0]
        self.preparation = digest(prep)
        self.run_digest = digest(journal.values('binding')[0])
        need(prep['run_binding_digest'] == self.run_digest and prep['owner_id'] == manifest['owner']['principal_id']
            and prep['tenant_id'] == manifest['owner']['tenant_id']
            and prep['registry_id'] == manifest['existing']['registry']
            and prep['login_server'] == manifest['registry']['loginServer']
            and prep['publish_until'] == bundle['deadline'])
        slot = prep['slots'][self.slot]
        need(slot['local_image_id'] == bundle['local_image_id'] and slot['docker_sha256'] == bundle['docker_sha256']
            and slot['docker_path_sha256'] == sha(bundle['docker_path'].encode()) and slot['docker_host'] == bundle['docker_host'])
        repo_key, tag_key = ('cleanupImageRepository','cleanupImageTag') if self.slot == 'guardian' else ('imageRepository','imageTag')
        host, repo = manifest['registry']['loginServer'], manifest[repo_key]
        ids = [manifest['ids'][k] for k in ('app','job','guard')]
        self.binding = _binding({'registry_id':manifest['existing']['registry'], 'login_server':host,
            'repository':repo, 'tenant_id':manifest['owner']['tenant_id'], 'authorized_resource_ids':ids,
            'exclusivity_evidence_digest':'0'*64})
        need(self.binding['registry_id'] == manifest['registry']['id'] and manifest['cleanupImageRepository'] != manifest['imageRepository']
            and getattr(credential,'mode',None) == 'owner'
            and getattr(credential,'principal',None) == manifest['owner']['principal_id']
            and getattr(credential,'tenant',None) == manifest['owner']['tenant_id'])
        tag = effective_slot(manifest,prep['code_sha'],self.slot,verified_attempt)['tag']
        need(isinstance(tag,str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',tag))
        self.tag, self.base = host + '/' + repo + ':' + tag, 'https://' + host
        need(slot['repository'] == repo and slot['tag'] == tag)
        self.image_digest = None
        self.recovery = False
        self.http = CountedControlHttp(wire,budget,registry_host=host)
        self.url = self.base + '/v2/' + repo + '/manifests/' + tag + '?api-version=' + VERSION
        self.op = {'id':self.ident,'provider':'AzureContainerRegistry','kind':'dockerImagePush','method':'PUT',
            'url':self.url,'body':{'fixed_tag':self.tag,'local_image_id':bundle['local_image_id']},
            'deadline':bundle['deadline'],'depends_on':[],
            'expected':{'publication_preparation_digest':self.preparation,'run_binding_digest':self.run_digest,'docker_sha256':bundle['docker_sha256'],'docker_host':bundle['docker_host']},
            'cleanup':{'created_only':True,'purpose':self.slot,'retained':self.slot == 'runtime'}}
        self.access = None; self.exp = 0

    def time(self):
        if self.recovery:
            self.clock.utc()
            return 30
        remaining = (parse(self.bundle['deadline']) - self.clock.utc()).total_seconds()
        need(remaining > 0 and not self.clock.unsafe)
        return remaining

    def _wire(self, method, url, body=None, token=None):
        self.time()
        d = Deadline(min(30,self.time()),self.clock.monotonic)
        headers = {'Accept':ACCEPT if '/manifests/' in url else 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        if body is not None: headers['Content-Type'] = 'application/x-www-form-urlencoded'
        digest_url = self.base+'/v2/'+self.binding['repository']+'/manifests/'+(self.image_digest or 'unresolved')+'?api-version='+VERSION
        allowed = {self.url, digest_url, self.base + '/v2/' + self.binding['repository'] + '/manifests/' + self.tag.rsplit(':',1)[1] + '?api-version=' + VERSION,
            self.base + '/acr/v1/' + self.binding['repository'] + '?api-version=' + VERSION}
        if self.verified_attempt is not None and self.slot=='runtime':
            from .registry_retention import urls
            allowed.update(urls(self.journal.values('publication_preparation')[0],self.verified_attempt).values())
        need((method == 'GET' and url in allowed) or (method == 'POST' and url in (self.base+'/oauth2/exchange',self.base+'/oauth2/token')))
        self.journal.append('clock_observation',{'at':self.clock.utc().isoformat()})
        def send(*args):
            self.time(); d.remaining()
            return self.http.wire(*args)
        counted = CountedControlHttp(send,self.budget,registry_host=self.binding['login_server'])
        r = counted(method,url,headers,body,d)
        d.remaining(); self.time()
        need(isinstance(r,dict) and type(r.get('status')) is int and isinstance(r.get('body'),bytes)
            and len(r['body']) <= MAX_BODY and isinstance(r.get('headers'),dict))
        h = r['headers']; need(all(isinstance(k,str) and isinstance(v,str) for k,v in h.items()))
        h = {k.lower():v for k,v in h.items()}
        need(len(h) == len(r['headers']) and not {'location','azure-asyncoperation','www-authenticate'} & set(h)
            and len(encoded(h)) <= 32768 and not 300 <= r['status'] < 400)
        return {**r,'headers':h}

    def _claims(self, token, refresh=False, *, actions=('pull','push')):
        need(isinstance(token,str) and 0 < len(token) <= 32768 and len(token.split('.')) == 3)
        value = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
        json.dumps(value,allow_nan=False)
        now = self.clock.utc().timestamp()
        need(value.get('aud') == self.binding['login_server'] and type(value.get('exp')) in (int,float)
            and value['exp'] > now + 60 and type(value.get('nbf')) in (int,float) and value['nbf'] <= now)
        if refresh:
            need(value.get('tenant') == self.binding['tenant_id'] and value.get('grant_type') == 'refresh_token')
        else:
            access = value.get('access')
            need(isinstance(access,list) and len(access) == 1 and access[0].get('type') == 'repository'
                and access[0].get('name') == self.binding['repository']
                and isinstance(access[0].get('actions'),list) and len(access[0]['actions']) == len(actions)
                and set(access[0]['actions']) == set(actions))
        return value['exp']

    def authenticate(self):
        self.time()
        if self.verified_attempt is None:self.budget.consume('owner_arm',600)
        aad = self.credential.token('https://management.azure.com/',Deadline(min(30,self.time()),self.clock.monotonic))
        r = self._wire('POST',self.base+'/oauth2/exchange',urlencode({'grant_type':'access_token',
            'service':self.binding['login_server'],'tenant':self.binding['tenant_id'],'access_token':aad}).encode())
        need(r['status'] == 200)
        refresh = json.loads(r['body']).get('refresh_token'); self._claims(refresh,True)
        r = self._wire('POST',self.base+'/oauth2/token',urlencode({'grant_type':'refresh_token',
            'service':self.binding['login_server'],'scope':'repository:'+self.binding['repository']+':pull,push',
            'refresh_token':refresh}).encode())
        need(r['status'] == 200)
        self.access = json.loads(r['body']).get('access_token'); self.exp = self._claims(self.access)

    def base_receipt(self):
        return {'operation_id':self.ident,'request_digest':digest(self.op),'object_id':None,
            'state':'unknown','terminal':False,'write_terminal':False,'created_by_run':True,
            'readback_verified':False,'observed_at':self.clock.utc().isoformat(),'properties':{}}

    def readback(self, receipt):
        need(receipt.get('request_digest') == digest(self.op))
        if receipt.get('write_terminal') is not True: return receipt
        if receipt.get('terminal') is True: return receipt
        self.image_digest = receipt['properties']['manifest_digest']
        need(isinstance(self.image_digest,str) and re.fullmatch('sha256:'+HEX,self.image_digest)
            and receipt['properties'] == {**{k:self.binding[k] for k in ('registry_id','login_server','repository')},
                'manifest_digest':self.image_digest,'purpose':self.slot})
        digest_url = self.base+'/v2/'+self.binding['repository']+'/manifests/'+self.image_digest+'?api-version='+VERSION
        need(receipt.get('object_id') == digest_url and receipt.get('ack_kind') == 'docker_exit0_digest')
        # Both fixed tag and digest must resolve to the acknowledged manifest.
        tagurl = self.base+'/v2/'+self.binding['repository']+'/manifests/'+self.tag.rsplit(':',1)[1]+'?api-version='+VERSION
        for url in (tagurl,digest_url):
            r = self._wire('GET',url,token=self.access)
            need(r['status'] == 200 and r['headers'].get('docker-content-digest') == self.image_digest
                and 'sha256:'+sha(r['body']) == self.image_digest)
        manifest = json.loads(r['body'])
        need(manifest.get('schemaVersion') == 2 and isinstance(manifest.get('layers'),list))
        need(manifest.get('config',{}).get('digest') == self.bundle['local_image_id'])
        rows = [manifest['config']] + manifest['layers']
        need(all(isinstance(x,dict) and type(x.get('size')) is int and x['size'] >= 0
            and re.fullmatch('sha256:'+HEX,x.get('digest','')) for x in rows))
        if not self.journal.values(self.slot + '_image_measurement'):
            self.journal.append(self.slot + '_image_measurement',{'request_digest':digest(self.op),
                'manifest_bytes':len(r['body']),'compressed_content_bytes':sum(x['size'] for x in rows),
                'layer_count':len(manifest['layers']),'wire_billing_cap':False})
        if self.verified_attempt is not None and self.slot=='runtime':
            from .registry_retention import observe_after
            need(self.image_digest!=self.verified_attempt.authority['retained_runtime']['digest'])
            observe_after(self,receipt)
        result = {**receipt,'state':'succeeded','terminal':True,'readback_verified':True,
            'observed_at':self.clock.utc().isoformat()}
        self.journal.checkpoint(self.op,result)
        return result

    def command(self, config, args):
        # No default context, DOCKER_* override, plugin directory or helper PATH.
        return self.runner([self.bundle['docker_path'],'--config',str(config),'--host',self.bundle['docker_host'],*args],
            timeout=min(self.time(),self.exp-self.clock.utc().timestamp()-5),environment=_docker_environment(config))

    def push_digest(self, config):
        """Classify a failed command without persisting output or manufacturing ACK."""
        classification = 'process_error'
        try:
            code, output = self.command(config,['image','push',self.tag])
            need(type(code) is int)
            classification = 'nonzero_exit'
            need(code == 0)
            classification = 'missing_or_ambiguous_ack'
            need(type(output) is bytes)
            matches = re.findall(r'^' + re.escape(self.tag.rsplit(':',1)[1]) +
                r': digest: (sha256:[a-f0-9]{64}) size: ([0-9]+)\s*$',output.decode('utf8'),re.MULTILINE)
            need(len(matches) == 1)
            return matches[0][0]
        except Exception as error:
            if isinstance(error,(subprocess.TimeoutExpired,TimeoutError)):
                classification = 'timeout'
            # This event explains a missing ACK only. It is never a receipt,
            # remote absence evidence, or permission to dispatch again. The
            # runner's stderr remains discarded and stdout stays in memory.
            self.journal.append(self.slot + '_docker_push_failure', {'schema':1,
                'operation_id':self.ident,'request_digest':digest(self.op),
                'publication_preparation_digest':self.preparation,'run_binding_digest':self.run_digest,
                'classification':classification,'additional_control_http_requests':0,
                'automatic_retry':False})
            raise Denied('docker_push_' + classification) from None

    def local_preflight(self):
        """Exact local image check before the first credential or HTTP request."""
        reason = 'local_config'
        try:
            config = _write_empty_probe(self.journal,self.slot)
            reason = 'process'
            code, output = self.runner([self.bundle['docker_path'],'--config',str(config),
                '--host',self.bundle['docker_host'],'image','inspect','--format','{{json .Id}}',self.tag],
                timeout=min(20,self.time()),environment=_docker_environment(config))
            reason = 'exit_code'; need(type(code) is int and code == 0)
            reason = 'image_id'; need(json.loads(output) == self.bundle['local_image_id'])
            self.time()
            reason = 'verified'
        except Exception as error:
            # Store classifications only; subprocess output may contain private
            # paths/registry names and is never copied into the journal.
            if isinstance(error,subprocess.TimeoutExpired): reason = 'timeout'
            elif isinstance(error,OSError): reason = 'process_unavailable'
            raise Denied('docker_local_preflight_' + reason) from None
        finally:
            cleanup_docker_config(self.journal,self.slot,probe=True)
            self.journal.append(self.slot + '_docker_probe_result', {'schema':1,
                'publication_preparation_digest':self.preparation,'run_binding_digest':self.run_digest,
                'docker_sha256':self.bundle['docker_sha256'],'docker_host':self.bundle['docker_host'],
                'tag_sha256':sha(self.tag.encode()),'local_image_id':self.bundle['local_image_id'],
                'empty_config_sha256':sha(encoded({'auths':{}})),
                'checked_at':self.clock.utc().isoformat(),'status':reason,
                'temporary_config_absent':True,'new_owner_token_calls':0,'new_http_requests':0,
                'automatic_retry':False})

    def run(self):
        intents = [v for v in self.journal.values('intent') if v['operation_id'] == self.ident]
        if intents:
            need(len(intents) == 1 and intents[0]['request_digest'] == digest(self.op))
            cleanup_docker_config(self.journal,self.slot)
            receipt = self.journal.latest(self.ident) or self.base_receipt()
            if receipt.get('write_terminal') is not True or receipt.get('terminal') is True: return receipt
            self.recovery = True
            self.authenticate()
            try: return self.readback(receipt)
            except Exception: return receipt
        need(not self.journal.values(self.slot + '_image_namespace'))
        # Fail before authentication on any previous first-publication history.
        # Cleanup/absence does not grant another attempt or another token pair.
        need(not any(self.journal.values(self.slot + suffix) for suffix in
            ('_docker_directory','_docker_config','_docker_config_absent',
             '_docker_probe_directory','_docker_probe_config','_docker_probe_config_absent','_docker_probe_result')))
        # Validate the existing budget object's integrity without spending.
        from .attempt import effective_limits
        limit=effective_limits(self.verified_attempt)['owner_arm'] if self.verified_attempt is not None else 600
        need(self.budget.count('owner_arm') < limit)
        self.local_preflight()
        self.authenticate()
        try:
            config = _write_config(self.journal,self.binding['login_server'],self.access,self.slot)
            code, output = self.command(config,['image','inspect','--format','{{json .Id}}',self.tag])
            need(code == 0 and json.loads(output) == self.bundle['local_image_id'])
            if self.verified_attempt is not None and self.slot=='runtime':
                from .registry_retention import observe_namespace
                event=observe_namespace(self);at=min(row['observed_at'] for row in event['checks'].values())
            else:
                url = self.base+'/acr/v1/'+self.binding['repository']+'?api-version='+VERSION
                response = self._wire('GET',url,token=self.access)
                errors = json.loads(response['body']).get('errors')
                need(response['status'] == 404 and isinstance(errors,list) and len(errors) == 1 and errors[0].get('code') == 'NAME_UNKNOWN')
                at = self.clock.utc().isoformat()
                event = {'publication_preparation_digest':self.preparation,'run_binding_digest':self.run_digest,
                    **{k:self.binding[k] for k in ('registry_id','login_server','repository')},
                    'method':'GET','url':url,'http':404,'error_code':'NAME_UNKNOWN','authenticated':True,
                    'response_sha256':sha(response['body']),'observed_at':at,'push_operation_id':self.ident,'push_request_digest':digest(self.op)}
            self.journal.append(self.slot + '_image_namespace',event)
            self.time(); need((self.clock.utc()-parse(at)).total_seconds() <= 30)
            self.journal.intent(self.op,self.clock.utc().isoformat())
            receipt = self.base_receipt(); self.journal.checkpoint(self.op,receipt)
            try:
                self.time(); need((self.clock.utc()-parse(at)).total_seconds() <= 30)
                # Docker's positive process result plus its reported digest is
                # the ACK. A later GET alone can never manufacture this fact.
                self.image_digest = self.push_digest(config)
                receipt.update(state='pending',write_terminal=True,ack_kind='docker_exit0_digest',
                    object_id=self.base+'/v2/'+self.binding['repository']+'/manifests/'+self.image_digest+'?api-version='+VERSION,
                    properties={**{k:self.binding[k] for k in ('registry_id','login_server','repository')},
                        'manifest_digest':self.image_digest,'purpose':self.slot},
                    observed_at=self.clock.utc().isoformat())
                self.journal.checkpoint(self.op,receipt)
                self.recovery = True
                receipt = self.readback(receipt)
            except Exception:
                # Preserve any already-fsynced positive process ACK.
                receipt = self.journal.latest(self.ident) or receipt
            return receipt
        finally:
            cleanup_docker_config(self.journal,self.slot)


def run_registry_publish(bundle, manifest, journal, credential, raw_wire, budget, clock, *, runner=docker_command,verified_attempt=None):
    """Caller validates protected input/source; never call during offline review."""
    publisher = _Publisher(bundle,manifest,journal,credential,raw_wire,budget,clock,runner,verified_attempt)
    receipt = publisher.run()
    return {'status':receipt.get('state','unknown'),'terminal':receipt.get('terminal') is True,
        'push_verified':receipt.get('state') == 'succeeded' and receipt.get('readback_verified') is True,
        'temporary_config_absent':not _config_path(journal,publisher.slot).exists()}


def registry_cleanup_bundle(manifest, journal, resolver,*,verified_attempt=None):
    """Derive cleanup authority only from this same Journal's real publisher."""
    origin=publication_origin(journal,verified_attempt=verified_attempt)
    if reuses_acknowledged_images(verified_attempt):
        verify_reused_import(journal,resolver,resolver.initial_plan['resource_bindings'],verified_attempt)
    namespace = origin.values('guardian_image_namespace')
    push = origin.latest(IDENT)
    need(len(namespace) == 1 and push is not None and push.get('state') == 'succeeded'
        and all(push.get(k) is True for k in ('terminal','write_terminal','created_by_run','readback_verified')))
    ids = [manifest['ids'][k] for k in ('app','job','guard')]
    proof = {'schema':1,'initial_plan_digest':resolver.plan_digest,'run_binding_digest':digest(journal.values('binding')[0]),
        'authorized_resource_ids':ids,'namespace_receipt_digest':digest(namespace[0])}
    binding = {'registry_id':manifest['existing']['registry'],'login_server':manifest['registry']['loginServer'],
        'repository':manifest['cleanupImageRepository'],'tenant_id':manifest['owner']['tenant_id'],
        'authorized_resource_ids':ids,'exclusivity_evidence_digest':digest(proof)}
    return {'binding':_binding(binding),'push_receipt':deepcopy(push),'scope_proof':proof}


def reuses_acknowledged_images(verified):
    """Only a sealed V6 capability can select the historical-image contract."""
    if verified is None:return False
    from .attempt import _proof
    return _proof(verified)['authority']['schema'] in (6,7)


def _reuse_source(journal,verified):
    from .attempt import _proof,_ParentView
    from .acknowledged_image_succession import previous_verified_attempt
    from .registry_retention import check_attempt
    need(reuses_acknowledged_images(verified));check_attempt(journal,verified)
    proof=_proof(verified);origin_verified=verified
    if proof['authority']['schema']==7:
        from .attempt import VerifiedAttempt,_SEAL
        parent_proof=proof['succession']['previous_verified_proof']
        need(parent_proof['authority']['schema']==6)
        origin_verified=VerifiedAttempt(parent_proof,_SEAL)
    source=_proof(origin_verified)['succession']
    previous=previous_verified_attempt(origin_verified)
    origin=_ParentView(source['previous_child_records'])
    images=verified_publication_images(origin,verified_attempt=previous)
    preparations=origin.values('publication_preparation')
    need(len(preparations)==1 and preparations[0]==source['publication_preparation']
        and images==source['acknowledged_images']
        and source['image_build_head']==proof['authority']['image_build_head']==previous.authority['head'])
    # New child records can contain neither an invented ACK nor an old push.
    need(not journal.values('publication_preparation')
        and not any(row.get('operation_id') in ('guardianImagePush','runtimeImagePush')
            for event in ('intent','progress') for row in journal.values(event)))
    return source,origin,images


def publication_origin(journal,*,verified_attempt=None):
    """Read-only ownership source. It never imports old writes into this run."""
    if not reuses_acknowledged_images(verified_attempt):return journal
    return _reuse_source(journal,verified_attempt)[1]


def _reuse_event(journal,verified,configuration_sha256):
    from .attempt import _proof
    source,origin,_=_reuse_source(journal,verified);proof=_proof(verified)
    prep=source['publication_preparation'];old=source['previous_publication']
    need(isinstance(configuration_sha256,str) and re.fullmatch(HEX,configuration_sha256))
    need(prep['source_sha256']=={k:v['sha256'] for k,v in old['sources'].items()})
    event = {'schema':1,'kind':'acknowledged-image-reuse','configuration_sha256':configuration_sha256,
        'source_sha256':deepcopy(prep['source_sha256']),'manifest_sha256':prep['manifest_sha256'],
        'local_code_sha':proof['authority']['head'],'image_build_head':source['image_build_head'],
        'run_binding_digest':digest(journal.values('binding')[0]),'attempt_binding_digest':verified.binding_digest,
        'previous_verified_proof_sha256':digest(source['previous_verified_proof']),
        'previous_child_records_sha256':digest(source['previous_child_records']),
        'previous_publication_sha256':digest(old),'publication_preparation_sha256':digest(prep),
        'push_receipt_digests':{k:digest(origin.latest(k+'ImagePush')) for k in ('guardian','runtime')},
        **{k:deepcopy(prep[k]) for k in ('registry_id','login_server','tenant_id','owner_id','slots')},
        'publish_from':proof['activation']['windows']['publication']['start'],
        'publish_until':proof['activation']['windows']['publication']['end']}
    if proof['authority']['schema']==7:
        new_sources=proof['succession']['new_sources'];origin_sources=proof['succession']['origin_sources']
        need(origin_sources==event['source_sha256'])
        event.update(schema=2,origin_source_sha256=deepcopy(origin_sources),
            source_sha256=deepcopy(new_sources),manifest_sha256=proof['authority']['manifest_sha256'])
    return event


def _prepare_reused_images(config,manifest,configuration_sha256,journal):
    verified=config['verified_attempt'];event=_reuse_event(journal,verified,configuration_sha256)
    need(config['frozen_head']==event['local_code_sha']
        and {k:v['sha256'] for k,v in config['sources'].items()}==event['source_sha256']
        and config['publication']['publish_until']==event['publish_until']
        and manifest['existing']['registry']==manifest['registry']['id']==event['registry_id']
        and manifest['registry']['loginServer']==event['login_server']
        and manifest['owner']['tenant_id']==event['tenant_id'] and manifest['owner']['principal_id']==event['owner_id'])
    for slot in ('guardian','runtime'):
        actual=config['publication']['slots'][slot];old=event['slots'][slot]
        need(all(actual[k]==old[k] for k in ('local_image_id','docker_sha256','docker_host'))
            and sha(actual['docker_path'].encode())==old['docker_path_sha256']
            and actual['build_receipt']['sha256']==old['build_receipt_sha256'])
    saved=journal.values('image_reuse_preparation');need(not saved or saved==[event])
    if not saved:journal.append('image_reuse_preparation',event)
    return event


def reused_image_preparation(journal,verified):
    saved=journal.values('image_reuse_preparation');need(len(saved)==1)
    expected=_reuse_event(journal,verified,saved[0].get('configuration_sha256'))
    need(saved==[expected]);return expected


def _reuse_intent(prep):
    return {'schema':1,'preparation_sha256':digest(prep),'run_binding_digest':prep['run_binding_digest'],
        'attempt_binding_digest':prep['attempt_binding_digest'],'automatic_retry':False}


def _verified_reused_images(journal,verified):
    prep=reused_image_preparation(journal,verified)
    source,_,images=_reuse_source(journal,verified)
    need(journal.values('image_reuse_readback_intent')==[_reuse_intent(prep)]
        and not journal.values('image_reuse_readback_failure'))
    saved=journal.values('image_reuse_readback');need(len(saved)==1);event=saved[0]
    need(isinstance(event,dict) and set(event)=={'schema','preparation_sha256','run_binding_digest','attempt_binding_digest',
        'automatic_retry','checks'} and {k:v for k,v in event.items() if k!='checks'}==_reuse_intent(prep)
        and isinstance(event['checks'],dict) and set(event['checks'])=={'guardian','runtime'})
    for slot in ('guardian','runtime'):
        row=event['checks'][slot];fixed=prep['slots'][slot];image_digest=images[slot+'_image'].rsplit('@',1)[1]
        need(isinstance(row,dict) and set(row)=={'slot','url','http','manifest_digest','response_sha256','image_id',
            'manifest_bytes','compressed_content_bytes','layer_count','observed_at'}
            and row['slot']==slot and type(row['http']) is int and row['http']==200
            and row['url']=='https://'+prep['login_server']+'/v2/'+fixed['repository']+'/manifests/'+image_digest+'?api-version='+VERSION
            and row['manifest_digest']==image_digest and 'sha256:'+row['response_sha256']==image_digest
            and row['image_id']==fixed['local_image_id']==source['previous_build_artifacts'][slot]['image_id']
            and all(type(row[k]) is int for k in ('manifest_bytes','compressed_content_bytes','layer_count'))
            and 0<row['manifest_bytes']<=MAX_BODY and row['compressed_content_bytes']>=0 and 0<=row['layer_count']<=4096
            and parse(prep['publish_from'])<=parse(row['observed_at'])<parse(prep['publish_until']))
    return images


def _reused_import(journal,resolver,resources,verified):
    images=_verified_reused_images(journal,verified);prep=reused_image_preparation(journal,verified)
    need(all(resources[k]==v for k,v in images.items())
        and resolver.initial_plan['source_sha256']==prep['source_sha256']
        and resources['code_sha']==prep['image_build_head']
        and resolver.initial_plan['resource_bindings']==resources)
    return {'schema':2,'kind':'acknowledged-image-reuse','initial_plan_digest':resolver.plan_digest,
        'image_reuse_preparation_digest':digest(prep),'image_reuse_readback_digest':digest(journal.values('image_reuse_readback')[0]),
        'run_binding_digest':prep['run_binding_digest'],'push_receipt_digests':deepcopy(prep['push_receipt_digests'])}


def verify_reused_import(journal,resolver,resources,verified):
    event=_reused_import(journal,resolver,resources,verified)
    need(journal.values('publication_import')==[event]);return event


class _ReuseReadback:
    """One pull-only, digest-only observation; no Docker or write capability."""
    def __init__(self,journal,credential,wire,budget,clock,verified,source_guard):
        self.journal,self.credential,self.budget=journal,credential,budget
        self.verified_attempt,self.source_guard=verified,source_guard
        self.prep=reused_image_preparation(journal,verified)
        self.images=_reuse_source(journal,verified)[2]
        need(credential.mode=='owner' and credential.principal==self.prep['owner_id'] and credential.tenant==self.prep['tenant_id'])
        self.clock=_Clock(journal,clock)
        self.http=CountedControlHttp(wire,budget,registry_host=self.prep['login_server'])
        self.base='https://'+self.prep['login_server']

    def time(self):
        from .attempt import check_window
        now=self.clock.utc();need(not self.clock.unsafe)
        check_window(self.verified_attempt,'publication',now)
        return (parse(self.prep['publish_until'])-now).total_seconds()

    def request(self,method,url,body=None,access=None):
        self.time();deadline=Deadline(min(30,self.time()),self.clock.monotonic)
        need((method=='POST' and url in (self.base+'/oauth2/exchange',self.base+'/oauth2/token'))
            or (method=='GET' and url==self.url))
        headers={'Accept':ACCEPT if method=='GET' else 'application/json'}
        if body is not None:headers['Content-Type']='application/x-www-form-urlencoded'
        if access is not None:headers['Authorization']='Bearer '+access
        self.journal.append('clock_observation',{'at':self.clock.utc().isoformat()})
        def before_send():
            self.source_guard();self.time();deadline.remaining()
        response=self.http.send_guarded(method,url,headers,body,deadline,before_send=before_send)
        deadline.remaining();self.time()
        need(isinstance(response,dict) and type(response.get('status')) is int and response['status']==200
            and isinstance(response.get('body'),bytes) and len(response['body'])<=MAX_BODY
            and isinstance(response.get('headers'),dict))
        headers=response['headers'];need(all(isinstance(k,str) and isinstance(v,str) for k,v in headers.items()))
        lower={k.lower():v for k,v in headers.items()}
        need(len(lower)==len(headers) and len(encoded(lower))<=32768
            and not {'location','azure-asyncoperation','www-authenticate'}&set(lower))
        return {**response,'headers':lower}

    def observe(self,slot):
        fixed=self.prep['slots'][slot];image_digest=self.images[slot+'_image'].rsplit('@',1)[1]
        self.binding={k:self.prep[k] for k in ('login_server','tenant_id')};self.binding['repository']=fixed['repository']
        self.url=self.base+'/v2/'+fixed['repository']+'/manifests/'+image_digest+'?api-version='+VERSION
        self.source_guard();self.time()
        aad=self.credential.token('https://management.azure.com/',Deadline(min(30,self.time()),self.clock.monotonic))
        response=self.request('POST',self.base+'/oauth2/exchange',urlencode({'grant_type':'access_token',
            'service':self.prep['login_server'],'tenant':self.prep['tenant_id'],'access_token':aad}).encode())
        refresh=json.loads(response['body']).get('refresh_token');_Publisher._claims(self,refresh,True)
        response=self.request('POST',self.base+'/oauth2/token',urlencode({'grant_type':'refresh_token',
            'service':self.prep['login_server'],'scope':'repository:'+fixed['repository']+':pull','refresh_token':refresh}).encode())
        access=json.loads(response['body']).get('access_token');_Publisher._claims(self,access,actions=('pull',))
        response=self.request('GET',self.url,access=access)
        need(response['headers'].get('docker-content-digest')==image_digest and 'sha256:'+sha(response['body'])==image_digest)
        manifest=json.loads(response['body']);need(isinstance(manifest,dict) and type(manifest.get('schemaVersion')) is int
            and manifest['schemaVersion']==2 and isinstance(manifest.get('config'),dict)
            and manifest['config'].get('digest')==fixed['local_image_id']
            and isinstance(manifest.get('layers'),list) and len(manifest['layers'])<=4096)
        rows=[manifest['config']]+manifest['layers']
        need(all(isinstance(row,dict) and type(row.get('size')) is int and 0<=row['size']<=2**53-1
            and isinstance(row.get('digest'),str) and re.fullmatch('sha256:'+HEX,row['digest']) for row in rows))
        return {'slot':slot,'url':self.url,'http':200,'manifest_digest':image_digest,'response_sha256':sha(response['body']),
            'image_id':fixed['local_image_id'],'manifest_bytes':len(response['body']),
            'compressed_content_bytes':sum(row['size'] for row in rows),'layer_count':len(manifest['layers']),
            'observed_at':self.clock.utc().isoformat()}

    def run(self):
        intent=_reuse_intent(self.prep);existing=self.journal.values('image_reuse_readback_intent')
        if existing:
            need(existing==[intent])
            if self.journal.values('image_reuse_readback'):
                _verified_reused_images(self.journal,self.verified_attempt)
                return {'status':'reused_images_verified','verified_images':2,'automatic_retry':False,'replayed':True}
            return {'status':'unknown','verified_images':0,'automatic_retry':False,'replayed':True}
        need(not self.journal.values('image_reuse_readback') and not self.journal.values('image_reuse_readback_failure'))
        self.source_guard();self.time()
        self.journal.append('image_reuse_readback_intent',intent)
        try:
            checks={slot:self.observe(slot) for slot in ('guardian','runtime')}
            self.time();self.journal.append('image_reuse_readback',{**intent,'checks':checks})
            _verified_reused_images(self.journal,self.verified_attempt)
            return {'status':'reused_images_verified','verified_images':2,'automatic_retry':False,'replayed':False}
        except Exception:
            # No partial observation can replace the old ACK or permit resend.
            # A failed fsync leaves the intent as the permanent stop boundary.
            self.journal.append('image_reuse_readback_failure',{'schema':1,'intent_sha256':digest(intent),
                'classification':'unconfirmed','automatic_retry':False})
            return {'status':'unknown','verified_images':0,'automatic_retry':False,'replayed':False}


def verify_reused_images(journal,credential,wire,budget,clock,*,verified_attempt,source_guard):
    return _ReuseReadback(journal,credential,wire,budget,clock,verified_attempt,source_guard).run()
