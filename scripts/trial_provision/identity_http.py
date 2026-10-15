"""Local Identity transport preserving strict ACK header semantics.

Keep this outside the frozen guardian image closure. Like BoundedHttp, one
killable child performs one request under the caller's absolute deadline, with
no redirect or retry. Reject duplicate controls before converting to a dict.
"""
import http.client
import multiprocessing
import queue
import re
import threading
from urllib.parse import urlsplit

from scripts.trial_guard.lifecycle import Denied
from .providers import RESOURCE


def _identity_http_child(pipe, request):
    connection = None
    try:
        method, url, headers, body, seconds = request
        u = urlsplit(url)
        connection = http.client.HTTPSConnection(u.hostname, timeout=seconds)
        connection.request(method, u.path + '?' + u.query, body=body, headers=headers)
        response = connection.getresponse()
        response_headers = {}
        for key, value in response.getheaders():
            key = key.lower()
            if key in response_headers and key in ('location', 'azure-asyncoperation', 'operation-location'):
                raise ValueError('duplicate_control_header')
            response_headers[key] = value
        content = response.read(1048577)
        if len(content) > 1048576:
            raise ValueError('response_limit')
        pipe.send((response.status, response_headers, content))
    except Exception:
        # The write may have reached ARM; never reveal headers or retry it.
        pipe.send(None)
    finally:
        if connection:
            connection.close()
        pipe.close()


class IdentityHttp:
    def __call__(self, method, url, headers, body, deadline):
        u = urlsplit(url)
        if (method not in ('GET', 'PUT', 'DELETE') or u.scheme != 'https'
                or u.netloc != 'management.azure.com' or u.fragment
                or not re.fullmatch(RESOURCE['userAssignedIdentities'], u.path)
                or u.query != 'api-version=2023-01-31'
                or url != 'https://management.azure.com' + u.path + '?' + u.query):
            raise Denied('identity_http_target')
        deadline.remaining()
        ctx = multiprocessing.get_context('spawn')
        parent, child = ctx.Pipe(duplex=False)
        process = reader = None
        try:
            process = ctx.Process(target=_identity_http_child,
                args=(child, (method, url, headers, body, deadline.remaining())), daemon=True)
            deadline.remaining()
            process.start(); child.close()
            received = queue.Queue(maxsize=1)
            def receive():
                try:
                    received.put((True, parent.recv()))
                except Exception:
                    received.put((False, None))
            # Pipe.poll can signal just a frame prefix. A blocking recv on the
            # caller thread could then outlive the deadline on a partial frame.
            reader = threading.Thread(target=receive, daemon=True)
            reader.start()
            try:
                complete, value = received.get(timeout=deadline.remaining())
            except queue.Empty:
                raise TimeoutError('http_outcome_unknown') from None
            deadline.remaining()
            if not complete or value is None:
                raise OSError('http_outcome_unknown')
            status, response_headers, content = value
            return {'status': status, 'headers': response_headers, 'body': content}
        finally:
            if process is not None and process.pid:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=1)
                if process.is_alive():
                    process.kill(); process.join(timeout=1)
            parent.close(); child.close()
            if reader is not None:
                reader.join(timeout=1)
