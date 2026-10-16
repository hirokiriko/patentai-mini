"""Host-only bounded Job/reference-list GETs with nonsecret failure stages."""
import http.client
import multiprocessing
import queue
import re
import threading
from urllib.parse import urlsplit

from scripts.trial_guard.adapters import BoundedHttp
from scripts.trial_guard.lifecycle import Denied
from .read_observation import COLLECTIONS, CONTROLS, LIMIT, next_page


class ReadFailure(OSError):
    def __init__(self, stage, http=0):
        super().__init__('read_unverified')
        self.observation = {'validation': 'transport', 'transport_stage': stage, 'http': http}


def _read_child(pipe, request):
    connection, stage, status = None, 'connect', 0
    try:
        url, headers, seconds = request
        u = urlsplit(url)
        connection = http.client.HTTPSConnection(u.hostname, timeout=seconds)
        connection.request('GET', (u.path or '/') + ('?' + u.query if u.query else ''), headers=headers)
        stage = 'response_headers'
        response = connection.getresponse(); status = response.status
        response_headers = {}
        for key, value in response.getheaders():
            key = key.lower()
            if key in response_headers and key in CONTROLS:
                stage = 'duplicate_control_header'
                raise ValueError()
            response_headers[key] = value
        stage = 'response_body'
        content = response.read(LIMIT + 1)
        if len(content) > LIMIT:
            stage = 'response_limit'
            raise ValueError()
        pipe.send((True, status, response_headers, content))
    except Exception:
        # Never send a raw exception, response message or partial body.
        pipe.send((False, status, stage, None))
    finally:
        if connection:
            connection.close()
        pipe.close()


class ReadHttp:
    def _target(self, method, url, headers, body):
        from .providers import RESOURCE, RG, NAME
        u = urlsplit(url)
        if (method != 'GET' or body is not None or u.scheme != 'https'
                or u.netloc != 'management.azure.com' or u.fragment
                or type(headers) is not dict or any(type(k) is not str or type(v) is not str for k,v in headers.items())
                or url != 'https://management.azure.com' + u.path + '?' + u.query):
            raise Denied('read_http_target')
        fixed = (
            (RG + r'/providers/Microsoft\.ManagedIdentity/userAssignedIdentities', 'api-version=2023-01-31'),
            (RG + r'/providers/Microsoft\.Storage/storageAccounts/[a-z0-9]{3,24}/blobServices/default/containers', 'api-version=2023-05-01'),
            (RG + r'/providers/Microsoft\.CognitiveServices/accounts/' + NAME + r'/providers/Microsoft\.Authorization/roleDefinitions',
                'api-version=2022-04-01&$filter=type%20eq%20%27CustomRole%27'),
            (RG + r'/providers/Microsoft\.DBforPostgreSQL/flexibleServers/' + NAME + r'(?:/firewallRules)?', 'api-version=2024-08-01'),
        )
        matches = [query for pattern,query in fixed if re.fullmatch(pattern,u.path)]
        if matches:
            if matches != [u.query]: raise Denied('read_http_target')
        elif '/providers/Microsoft.App/' in u.path and (re.fullmatch(RESOURCE['jobs'], u.path) or re.fullmatch(RESOURCE['containerApps'], u.path)):
            if u.query != 'api-version=2025-07-01':
                raise Denied('read_http_target')
        else:
            collection = u.path.rsplit('/', 1)[-1]
            if collection not in dict(COLLECTIONS):
                raise Denied('read_http_target')
            next_page(url, 'https://management.azure.com' + u.path + '?api-version=' + dict(COLLECTIONS)[collection])

    def __call__(self, method, url, headers, body, deadline):
        self._target(method, url, headers, body)
        deadline.remaining()
        ctx = multiprocessing.get_context('spawn')
        parent, child = ctx.Pipe(duplex=False)
        process = reader = None
        try:
            process = ctx.Process(target=_read_child,
                args=(child, (url, headers, deadline.remaining())), daemon=True)
            deadline.remaining()
            process.start(); child.close()
            received = queue.Queue(maxsize=1)
            def receive():
                try:
                    received.put(parent.recv())
                except Exception:
                    received.put((False, 0, 'ipc_incomplete', None))
            # poll() alone cannot bound recv() after a partial frame arrives.
            reader = threading.Thread(target=receive, daemon=True); reader.start()
            try:
                complete, status, metadata, content = received.get(timeout=deadline.remaining())
            except queue.Empty:
                raise ReadFailure('deadline') from None
            deadline.remaining()
            if not complete:
                raise ReadFailure(metadata, status)
            return {'status': status, 'headers': metadata, 'body': content}
        finally:
            if process is not None and process.pid:
                if process.is_alive(): process.terminate()
                process.join(timeout=1)
                if process.is_alive(): process.kill(); process.join(timeout=1)
            parent.close(); child.close()
            if reader is not None: reader.join(timeout=1)


class AnonymousIpHttp(ReadHttp):
    """The two existing public-IP reads, without any authorization header."""
    def _target(self, method, url, headers, body):
        if (method != 'GET' or body is not None or headers != {}
                or url not in ('https://api.ipify.org','https://checkip.amazonaws.com')):
            raise Denied('read_http_target')


class JobHttp(BoundedHttp):
    """Only the fixed GET boundary changes; mutation semantics stay unchanged."""
    def __call__(self, method, url, headers, body, deadline):
        from .providers import RESOURCE
        # Provider-validated ACK polling URLs keep their existing route.
        if method == 'GET' and re.fullmatch(RESOURCE['jobs'], urlsplit(url).path):
            return ReadHttp()(method, url, headers, body, deadline)
        return super().__call__(method, url, headers, body, deadline)
