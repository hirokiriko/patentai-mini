"""A single approved dispatch group's memory-only OWNER token cache.

No token is returned to a JSON result, written to disk or logged. The underlying
existing AzureCredential performs the normal identity/audience validation.
Each cache miss is durably charged before invoking that credential.
"""
import base64
import json
import threading
from scripts.trial_guard.lifecycle import Denied
from .attempt import _proof

AUDIENCES=frozenset(('https://management.azure.com/','https://storage.azure.com/','https://graph.microsoft.com/'))

class OwnerTokenPool:
    def __init__(self,verified,clock):
        proof=_proof(verified)
        self.attempt=verified.binding_digest
        self.owner=proof['authority']['owner_id'].lower()
        self.clock=clock;self._last_wall=clock.utc();self._last_mono=clock.monotonic()
        self._cache={};self._closed=False;self._lock=threading.RLock()
    def close(self):
        with self._lock:self._closed=True;self._cache.clear()
    def bind(self,credential,budget,verified):
        if verified.binding_digest!=self.attempt or credential.mode!='owner' or credential.principal!=self.owner:
            raise Denied('owner_token_pool_binding')
        return _PooledCredential(self,credential,budget)
    def _token(self,credential,budget,audience,deadline):
        with self._lock:
            now,mono=self.clock.utc(),self.clock.monotonic()
            if self._closed or now<self._last_wall or mono<self._last_mono or audience not in AUDIENCES:
                self.close();raise Denied('owner_token_pool_unavailable')
            self._last_wall,self._last_mono=now,mono
            key=(credential.principal,credential.tenant,audience)
            cached=self._cache.get(key)
            if cached and cached[1]>now.timestamp()+deadline.remaining()+30:return cached[0]
            # A failed CLI read remains a counted attempt, without refund/retry.
            budget.consume_owner_token()
            token=credential.token(audience,deadline)
            try:
                claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='));expiry=claims['exp']
                if type(expiry) not in (int,float) or not expiry>self.clock.utc().timestamp()+deadline.remaining():raise ValueError()
                if claims['oid'].lower()!=credential.principal or claims['tid'].lower()!=credential.tenant:raise ValueError()
            except (ValueError,TypeError,KeyError,IndexError,AttributeError):raise Denied('owner_token_cache_binding') from None
            self._cache[key]=(token,expiry);return token

class _PooledCredential:
    def __init__(self,pool,credential,budget):
        self._pool,self._credential,self._budget=pool,credential,budget
        self.mode,self.principal,self.tenant=credential.mode,credential.principal,credential.tenant
    def token(self,audience,deadline):return self._pool._token(self._credential,self._budget,audience,deadline)
