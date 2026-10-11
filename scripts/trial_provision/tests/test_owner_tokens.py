"""Fictional credentials only. No AzureCredential, subprocess or network."""
import base64
from datetime import datetime, timedelta, timezone
import os
import unittest
from unittest.mock import Mock, patch

from scripts.trial_guard.adapters import Deadline, encoded
from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.owner_tokens import OwnerTokenPool
from scripts.trial_provision.tests.test_attempt import fixture, verify
from scripts.trial_provision.tests.test_attempt_accounting import budget_fixture, scope

ARM = 'https://management.azure.com/'
STORAGE = 'https://storage.azure.com/'


class Clock:
    def __init__(self):
        self.wall = datetime(2026, 10, 12, 1, tzinfo=timezone.utc)
        self.mono = 0
    def utc(self):
        return self.wall
    def monotonic(self):
        return self.mono
    def advance(self, seconds):
        self.wall += timedelta(seconds=seconds)
        self.mono += seconds


def jwt(claims):
    return 'fictional.' + base64.urlsafe_b64encode(encoded(claims)).decode().rstrip('=') + '.unsigned'


class OwnerTokenTests(unittest.TestCase):
    def setUp(self):
        self.budget, self.verified, self.args = budget_fixture(self)
        self.budget.begin_attempt(self.verified, initialize=True)
        self.scoped = scope(self.budget, self.verified, 'provision')
        self.clock = Clock()
        self.pool = OwnerTokenPool(self.verified, self.clock)
        self.addCleanup(self.pool.close)
        manifest = fixture()['manifest']
        self.raw = Mock(mode='owner', principal=manifest['owner']['principal_id'], tenant=manifest['owner']['tenant_id'])
        self.raw.token.side_effect = lambda audience, deadline: self.make_token(audience)
        self.credential = self.pool.bind(self.raw, self.scoped, self.verified)
    def make_token(self, audience=ARM, **changes):
        return jwt({'oid': self.raw.principal, 'tid': self.raw.tenant, 'aud': audience,
            'exp': self.clock.utc().timestamp() + 3600, **changes})
    def token(self, audience=ARM):
        return self.credential.token(audience, Deadline(10, self.clock.monotonic))

    def test_cache_miss_is_fsynced_once_before_credential_and_hit_is_free(self):
        events = []
        real_fsync = os.fsync
        def fsync(fd):
            real_fsync(fd)
            events.append('fsync')
        def acquire(audience, deadline):
            events.append('credential')
            self.assertEqual(self.budget.count('owner_arm'), 188)
            self.assertIn(b'"purpose":"owner_token"', self.budget.journal.path.read_bytes())
            return self.make_token(audience)
        self.raw.token.side_effect = acquire
        with patch('scripts.trial_provision.journal.os.fsync', side_effect=fsync):
            token = self.token()
            self.assertEqual(self.token(), token)
        self.assertEqual(events, ['fsync', 'credential'])
        self.assertEqual(self.raw.token.call_count, 1)
        self.assertNotIn(token.encode(), self.budget.journal.path.read_bytes())

    def test_audience_and_tenant_cache_entries_are_separate(self):
        arm = self.token()
        storage = self.token(STORAGE)
        self.assertNotEqual(arm, storage)
        self.assertEqual(self.token(), arm)
        other = Mock(mode='owner', principal=self.raw.principal, tenant='00000000-0000-0000-0000-000000000004')
        other.token.return_value = self.make_token(tid=other.tenant)
        bound = self.pool.bind(other, self.scoped, self.verified)
        self.assertEqual(bound.token(ARM, Deadline(10, self.clock.monotonic)), other.token.return_value)
        self.assertEqual(self.budget.count('owner_arm'), 190)
        self.assertEqual(self.raw.token.call_count, 2)
        self.assertEqual(other.token.call_count, 1)

    def test_cache_near_expiry_requires_fresh_charged_credential(self):
        self.raw.token.side_effect = lambda audience, deadline: self.make_token(audience, exp=self.clock.utc().timestamp() + 45)
        first = self.token()
        self.clock.advance(6)
        second = self.token()
        self.assertNotEqual(first, second)
        self.assertEqual(self.budget.count('owner_arm'), 189)

    def test_failed_credential_remains_counted_and_is_not_retried_or_cached(self):
        self.raw.token.side_effect = TimeoutError('fictional credential timeout')
        with self.assertRaises(TimeoutError):
            self.token()
        self.assertEqual(self.raw.token.call_count, 1)
        self.assertEqual(self.budget.count('owner_arm'), 188)
        self.raw.token.side_effect = lambda audience, deadline: self.make_token(audience)
        self.token()
        self.assertEqual(self.raw.token.call_count, 2)
        self.assertEqual(self.budget.count('owner_arm'), 189)

    def test_wrong_identity_or_expired_claims_are_charged_but_not_cached(self):
        for changes in ({'oid': 'wrong-owner'}, {'tid': 'wrong-tenant'}, {'exp': self.clock.utc().timestamp() + 10}, {'exp': True}):
            with self.subTest(changes=changes):
                self.raw.token.side_effect = lambda audience, deadline, changes=changes: self.make_token(audience, **changes)
                before = self.budget.count('owner_arm')
                for _ in range(2):
                    with self.assertRaisesRegex(Denied, 'owner_token_cache_binding'):
                        self.token()
                self.assertEqual(self.budget.count('owner_arm'), before + 2)

    def test_wrong_owner_mode_or_attempt_rejected_before_any_charge(self):
        for raw in (Mock(mode='guardian', principal=self.raw.principal, tenant=self.raw.tenant),
                Mock(mode='owner', principal='another-owner', tenant=self.raw.tenant)):
            with self.assertRaises(Denied):
                self.pool.bind(raw, self.scoped, self.verified)
        data = fixture()
        data['authority']['attempt_id'] = 'other-fictional-next'
        data['activation']['attempt_id'] = data['authority']['attempt_id']
        with self.assertRaises(Denied):
            self.pool.bind(self.raw, self.scoped, verify(data))
        self.assertEqual(self.budget.count('owner_arm'), 187)
        self.raw.token.assert_not_called()

    def test_closed_pool_and_disallowed_audience_never_use_cached_token(self):
        self.token()
        with self.assertRaisesRegex(Denied, 'owner_token_pool_unavailable'):
            self.token('https://evil.example/')
        with self.assertRaises(Denied):
            self.token()
        self.assertEqual(self.budget.count('owner_arm'), 188)
        self.assertEqual(self.raw.token.call_count, 1)

    def test_wall_or_monotonic_rollback_denies_cached_token(self):
        for field in ('wall', 'mono'):
            with self.subTest(field=field):
                clock = Clock()
                pool = OwnerTokenPool(self.verified, clock)
                self.addCleanup(pool.close)
                credential = pool.bind(self.raw, self.scoped, self.verified)
                credential.token(ARM, Deadline(10, clock.monotonic))
                before = self.budget.count('owner_arm')
                if field == 'wall':
                    clock.wall -= timedelta(seconds=1)
                else:
                    clock.mono -= 1
                with self.assertRaises(Denied):
                    credential.token(ARM, Deadline(10, clock.monotonic))
                self.assertEqual(self.budget.count('owner_arm'), before)

    def test_failed_fsync_never_invokes_credential(self):
        with patch('scripts.trial_provision.journal.os.fsync', side_effect=OSError('fictional durability failure')):
            with self.assertRaises(OSError):
                self.token()
        with self.assertRaises(Denied):
            self.token()
        self.raw.token.assert_not_called()

    def test_eleven_misses_stop_before_eleventh_credential_call(self):
        self.raw.token.side_effect = lambda audience, deadline: self.make_token(audience, exp=self.clock.utc().timestamp() + 20)
        for _ in range(10):
            self.token()
        with self.assertRaisesRegex(Denied, 'budget_purpose_exhausted'):
            self.token()
        self.assertEqual(self.raw.token.call_count, 10)
        self.assertEqual(self.budget.count('owner_arm'), 197)


if __name__ == '__main__':
    unittest.main()
