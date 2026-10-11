"""UTC resolution differences must not renew deadlines or revoke safe work."""
from datetime import datetime, timedelta, timezone
import unittest

from scripts.trial_provision.controller import Controller
from scripts.trial_provision.rehearsal_cli import _Clock
from scripts.trial_guard.workflow import Workflow
from .test_rehearsal_cli import MemoryJournal
from . import test_rehearsal as rehearsal_fixture


class Observations:
    def __init__(self):
        self.wall = datetime(2026, 10, 11, tzinfo=timezone.utc)
        self.tick = 0
    def utc(self): return self.wall
    def monotonic(self): return self.tick


class ClockResolutionTests(unittest.TestCase):
    def clocks(self):
        for kind in ('publication_rehearsal', 'controller', 'db_workflow', 'rehearsal_adapter'):
            source, journal = Observations(), MemoryJournal()
            if kind == 'controller':
                clock = Controller(journal, source, None, [], {})
                observe = clock.now
                revoked = lambda: clock.clock_unsafe
            elif kind == 'db_workflow':
                clock = Workflow(None, None, None, None, source, None)
                observe = clock.now
                revoked = lambda: clock.closing
            elif kind == 'rehearsal_adapter':
                fixture = rehearsal_fixture.RehearsalTests('runTest')
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                source.wall = fixture.clock.utc()
                fixture.clock = source
                clock = fixture.make()
                observe = clock._now
                revoked = lambda: clock.unsafe
            else:
                clock = _Clock(journal, source)
                observe = clock.utc
                revoked = lambda: clock.unsafe
            yield kind, source, journal, observe, revoked

    def test_equal_raw_utc_ticks_keep_monotonic_deadline_without_revocation(self):
        for kind, source, journal, observe, revoked in self.clocks():
            with self.subTest(kind=kind):
                start = source.wall
                for tick in (.25, .5, 1, 2):
                    source.tick = tick
                    self.assertEqual(start + timedelta(seconds=tick), observe())
                self.assertFalse(revoked())
                # Raw UTC catches up partially; effective time cannot go back.
                source.wall += timedelta(seconds=1)
                source.tick = 3
                self.assertEqual(start + timedelta(seconds=3), observe())
                self.assertFalse(revoked())

    def test_real_raw_utc_rollback_is_still_permanently_revoked(self):
        for kind, source, journal, observe, revoked in self.clocks():
            with self.subTest(kind=kind):
                source.tick = .5
                high = observe()
                source.wall -= timedelta(microseconds=1)
                source.tick = 1
                self.assertGreaterEqual(observe(), high)
                self.assertTrue(revoked())
                source.wall += timedelta(seconds=10)
                source.tick = 2
                observe()
                self.assertTrue(revoked())

    def test_monotonic_rollback_cannot_reduce_effective_time(self):
        for kind, source, journal, observe, revoked in self.clocks():
            with self.subTest(kind=kind):
                source.tick = 1
                high = observe()
                source.tick = .5
                self.assertEqual(high, observe())
                self.assertTrue(revoked())

    def test_existing_revocation_is_never_cleared_on_restart(self):
        for kind, source, journal, observe, revoked in self.clocks():
            if kind not in ('controller', 'publication_rehearsal'):
                continue
            with self.subTest(kind=kind):
                source.wall -= timedelta(seconds=1)
                observe()
                source.wall += timedelta(seconds=10)
                if kind == 'controller':
                    restarted = Controller(journal, source, None, [], {})
                    self.assertTrue(restarted.clock_unsafe)
                else:
                    self.assertTrue(_Clock(journal, source).unsafe)
                self.assertEqual(1, len(journal.values('clock_revoked')))


if __name__ == '__main__': unittest.main()
