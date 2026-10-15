"""Local schema-9 runtime/secret delivery; no new image or credential path."""
from copy import deepcopy

from scripts.trial_guard.adapters import digest
from scripts.trial_guard.lifecycle import parse
from .auth import EasyAuthAdapter, AuthDenied, build_auth_operations, completed, progress, ready
from .providers import _input_matches

PROFILE = 'closed_runtime_secret_v8'


def combined_operations(binding, receipts, deadline, source, runtime):
    """Only canonical builder outputs enter here, after resolver DB/policy proof."""
    if (source['id'] != 'app' or runtime['id'] != 'appRuntime'
            or runtime['expected']['update_from'] != {'operation_id': 'app', 'request_digest': digest(source)}
            or source['url'] != runtime['url']):
        raise AuthDenied('combined_runtime_source')
    due = min(parse(deadline), parse(runtime['deadline'])).isoformat().replace('+00:00', 'Z')
    operations = build_auth_operations(binding, receipts, due, 'app')
    delivery, _, ingress = operations
    delivery['body']['properties']['template'] = deepcopy(runtime['body']['properties']['template'])
    delivery['expected']['properties'] = deepcopy(runtime['expected']['properties'])
    delivery['expected']['body_sha256'] = digest(delivery['body'])
    delivery['depends_on'] = list(dict.fromkeys(delivery['depends_on'] + runtime['depends_on'] + ['jobRuntime']))
    ingress['expected']['update_from']['request_digest'] = digest(delivery)
    return operations


class CombinedRuntimeAuthAdapter(EasyAuthAdapter):
    """One callback PATCH; initial template -> signed target, ingress stays shut.

    The resolver supplies the canonical source, runtime and delivery operation.
    An unknown ACK never permits redelivery. A known ACK permits only the same
    strict target readback, including when the original write window has ended.
    """
    def __init__(self, *args, context, **kwargs):
        super().__init__(*args, **kwargs)
        self.context = context
        if self.arm_provider is None:
            raise AuthDenied('combined_provider_required')

    def _context(self, op):
        source, target, delivery = self.context()
        if op != delivery or source['id'] != 'app' or target['id'] != 'appRuntime':
            raise AuthDenied('combined_operation_binding')
        return source, target

    def _source_match(self, source, value):
        self.arm_provider._match(source, value)
        if 'error' in value or 'error' in value.get('properties', {}):
            raise AuthDenied('combined_source_changed')

    def _target_match(self, source, target, value, retained_digest):
        expected = deepcopy(source['body'])
        expected['properties']['template'] = deepcopy(target['body']['properties']['template'])
        names = self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']]
        expected['properties']['configuration']['secrets'] = [{'name': n} for n in names]
        retained = deepcopy(value['properties']['configuration'])
        retained.pop('secrets', None)
        self.arm_provider._match(target, value)
        return ('error' not in value and 'error' not in value.get('properties', {}) and _input_matches(expected, value)
                and digest(retained) == retained_digest)

    def deliver(self, op, secret, credential_receipt, before_send, checkpoint, app_receipt):
        self._validate(op, 'Microsoft.App', ('containerApps',))
        source, target = self._context(op)
        if (not ready(credential_receipt) or credential_receipt['properties'].get('kind') != 'addPassword'
                or op['expected']['credentialOperationId'] != credential_receipt['operation_id']
                or not ready(app_receipt) or app_receipt.get('write_terminal') is not True
                or app_receipt.get('operation_id') != source['id']
                or app_receipt.get('request_digest') != digest(source)
                or app_receipt.get('object_id') != self.binding['target_app_id']
                or not isinstance(secret, str) or not 16 <= len(secret) <= 256):
            raise AuthDenied('combined_dependency')
        receipt = progress(op)
        wire_body = None
        try:
            names = self.binding['runtime_secret_names']
            first, _ = self._app(op, names)
            self._source_match(source, first)
            current, headers = self._app(op, names)
            self._source_match(source, current)
            if digest(first) != digest(current):
                raise AuthDenied('auth_concurrent_change')
            retained = deepcopy(current['properties']['configuration'])
            retained.pop('secrets', None)
            receipt = progress(op, self.binding['target_app_id'], {
                'kind': 'authPlatformSecret', 'secretName': self.binding['platform_secret_name'],
                'credentialOperationId': credential_receipt['operation_id'],
                'retainedConfigurationDigest': digest(retained),
                'runtimeOperationDigest': digest(target), 'sourceOperationDigest': digest(source)})
            wire_body = deepcopy(op['body'])
            wire_body['properties']['configuration']['secrets'] = self._runtime_values() + [
                {'name': self.binding['platform_secret_name'], 'value': secret}]
            response = self._request('PATCH', self.app_url, wire_body, op, before_send,
                {'If-Match': headers['etag']} if headers.get('etag') else {},
                after_intent=lambda: checkpoint(deepcopy(receipt)))
            receipt = self._write_ack(op, response, receipt)
            checkpoint(deepcopy(receipt))
            if receipt.get('write_terminal') is True:
                receipt = self.readback(op, receipt)
                checkpoint(deepcopy(receipt))
            return receipt
        except Exception:
            return receipt
        finally:
            if wire_body is not None:
                for item in wire_body['properties']['configuration']['secrets']:
                    item.pop('value', None)
            secret = None

    def readback(self, op, receipt):
        self._validate(op, 'Microsoft.App', ('containerApps',), readback=True)
        source, target = self._context(op)
        result = deepcopy(receipt)
        if not self._readback_ack(op, result, lro=True):
            return result
        if (result.get('object_id') != self.binding['target_app_id']
                or result['properties'].get('runtimeOperationDigest') != digest(target)
                or result['properties'].get('sourceOperationDigest') != digest(source)):
            raise AuthDenied('combined_readback_binding')
        try:
            if result.get('write_terminal') is not True:
                props = deepcopy(result['properties'])
                result = self.arm_provider.poll(op, result)
                result['properties'] = props
                if result.get('state') != 'failed':
                    result.update(state='pending', terminal=False, readback_verified=False)
            if result.get('write_terminal') is not True:
                return result
            after, _ = self._app(op, self.binding['runtime_secret_names'] + [self.binding['platform_secret_name']],
                                 recovery_receipt=result)
            if self._target_match(source, target, after, result['properties']['retainedConfigurationDigest']):
                return completed(result)
            return result
        except Exception:
            return result
