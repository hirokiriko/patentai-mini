"""Offline proposal and real-consumer counting, with fictional external I/O.

Durable consumer fixtures use newly created temporary directories only. They
cannot read the actual stopped counter. No Cloud, Docker, CLI credential, Node
or database is used. The optional Local preflight fixture is not shipped to CI;
its absence is an explicit skip, not equivalent to a verified live admission.
"""
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.trial_provision import restart_budget as target
from scripts.trial_provision.tests import test_workflow_contract as workflow
from scripts.trial_provision.tests import test_rehearsal as rehearsal


def row(stage, purpose, count, outcome='observed'):
    return {'stage': stage, 'purpose': purpose, 'attempts': count, 'outcome': outcome}


@contextmanager
def local_v6_modules():
    helpers = Path(__file__).resolve().parents[3].parent / 'output/issue148/local-v6-20261014/offline-prep'
    if not (helpers / 'local_docker_preflight.py').is_file():
        raise unittest.SkipTest('Local V6 helpers are not shipped to CI')
    old_path = list(sys.path)
    with patch.dict(sys.modules):
        try:
            sys.path.insert(0, str(helpers))
            for name in ('offline_config', 'offline_files', 'source_inventory', 'measure_images',
                         'local_docker_preflight', 'attempt_launcher', 'main_preflight'):
                sys.modules.pop(name, None)
            import offline_config
            import local_docker_preflight
            import main_preflight
            yield offline_config, local_docker_preflight, main_preflight
        finally: sys.path[:] = old_path


def full_trace(tokens=0, polls=0):
    values = [row('rehearsal_start', 'http', 2)]
    if tokens: values.append(row('rehearsal_start', 'owner_token', tokens))
    if polls: values.append(row('rehearsal_start', 'known_poll_http', polls))
    return values + [row(stage, 'http', count) for stage, count in
                     tuple(target.NORMAL_RUN_HTTP.items())[1:]]


class ProposalTests(unittest.TestCase):
    def test_schema_six_floor_uses_actual_prior_debits_and_legacy_is_unchanged(self):
        expected = {'rehearsal_start': (0, 28), 'rehearsal_poll': (2, 27),
                    'rehearsal_seed': (2, 26), 'rehearsal_verify': (4, 24),
                    'main_preflight': (5, 23), 'main': (12, 16)}
        for stage, (before, floor) in expected.items():
            self.assertEqual(target.required_run_requests(6, stage, http_used=before, owner_token_used=0), floor)
            self.assertEqual(target.required_run_requests(6, stage, http_used=before, owner_token_used=3), floor-3)
        for schema in range(1, 6):
            for stage, floor in {'rehearsal_start': 30, 'rehearsal_poll': 27, 'rehearsal_seed': 31,
                                 'rehearsal_verify': 32, 'main_preflight': 25, 'main': 18}.items():
                self.assertEqual(target.required_run_requests(schema, stage, http_used=0, owner_token_used=0), floor)
        for args in ((True, 'main', 12, 0), (7, 'main', 12, 0), (6, 'main', 11, 0),
                     (6, 'main', 17, 0), (6, 'main', 12, 9), (6, 'main', 12, True),
                     (6, 'rehearsal_start', 1, 0), (6, 'rehearsal_poll', 6, 0), (6, 'unlisted', 0, 0)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                target.required_run_requests(args[0], args[1], http_used=args[2], owner_token_used=args[3])

    def test_fixed_lifetime_and_cleanup_without_authority_or_scope_reduction(self):
        p = target.proposed_budget()
        self.assertEqual(p['proposed_caps'], {
            'fresh_read': 24, 'publication': 8, 'provision': 145, 'run': 32, 'cleanup': 120})
        self.assertEqual(302 + sum(p['proposed_caps'].values()), 631)
        self.assertEqual(sum(p['delta'].values()), 0)
        self.assertEqual(p['acceptance_scope'], {'cases': 4, 'passes': 2, 'normal_runs': 8,
            'artifact_versions': 16, 'pdf_csv_files': 32, 'artifact_gets': 64, 'artifact_displays': 32})
        self.assertFalse(p['execution_permitted']); self.assertFalse(p['live_admission_compatible'])
        self.assertTrue(p['approval_required']); self.assertTrue(p['integration_gaps'])
        self.assertEqual(p['refunds'], 0); self.assertEqual(p['ledger_writes'], 0)
        self.assertFalse(p['paid_limits_and_retained_holds_changed'])
        self.assertFalse(p['old_unknown_reinterpreted'])
        p['proposed_caps']['cleanup'] = 0
        self.assertEqual(target.proposed_budget()['proposed_caps']['cleanup'], 120)

    def test_extra_observations_use_slack_not_cleanup_or_refunds(self):
        for extra in range(5):
            p = target.proposed_budget(additional_readbacks=extra)
            self.assertEqual(sum(p['proposed_caps'].values()), 329)
            self.assertEqual(p['proposed_caps']['publication'], 8 + extra)
            self.assertEqual(p['run']['known_poll_http_allowance'], 4 - extra)
            result = target.assess_run_trace(full_trace(8, 4-extra), additional_readbacks=extra, complete=True)
            self.assertEqual(result['run_remaining'], 0)
            self.assertEqual(result['cleanup_preserved'], 120)
        for bad in (True, False, -1, 5, 1.0, '1', None):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                target.proposed_budget(additional_readbacks=bad)

    def test_normal_twenty_http_and_explicit_token_poll_allowances(self):
        result = target.assess_run_trace(full_trace(8, 4), complete=True)
        self.assertEqual((result['normal_http'], result['owner_token_attempts'], result['known_poll_http']), (20, 8, 4))
        self.assertEqual(result['run_spent'], 32); self.assertFalse(result['execution_permitted'])
        for trace in (full_trace(9), full_trace(0, 5), full_trace()[:-1],
                      [row('main', 'http', 8)], [row('rehearsal_start', 'http', 3)]):
            with self.assertRaises(ValueError): target.assess_run_trace(trace, complete=True)

    def test_unknown_is_counted_and_cannot_be_reclassified_or_followed(self):
        records = [row('rehearsal_start', 'owner_token', 1), row('rehearsal_start', 'http', 1, 'unknown')]
        result = target.assess_run_trace(records)
        self.assertEqual(result['run_spent'], 2); self.assertEqual(result['status'], 'stopped_unknown')
        self.assertEqual(result['cleanup_preserved'], 120)
        with self.assertRaisesRegex(ValueError, 'unknown_no_continuation'):
            target.assess_run_trace(records + [row('rehearsal_start', 'http', 1)])
        with self.assertRaises(ValueError): target.assess_run_trace(records, complete=True)

    def test_strict_trace_shape_order_and_unchanged_legacy_admission_gap(self):
        for bad in ({}, {'stage': 'main'}, {**row('rehearsal_start', 'http', 1), 'approved': True},
                    row('rehearsal_start', 'http', True), row('rehearsal_start', 'http', 1, 'succeeded'),
                    row('rehearsal_start', 'known_poll_http', 1), row('cleanup', 'http', 1)):
            with self.subTest(bad=bad), self.assertRaises(ValueError): target.assess_run_trace([bad])
        before_verify = [row('rehearsal_start', 'http', 2), row('rehearsal_seed', 'http', 2)]
        assessed = target.assess_run_trace(before_verify)
        self.assertEqual(assessed['run_remaining'], 28)
        self.assertLess(assessed['run_remaining'], target.LEGACY_REHEARSAL_FLOORS['rehearsal_verify'])
        self.assertEqual(assessed['remaining_normal_http'], 16)
        # This lower arithmetic floor is only a proposal. No launcher gate is patched.
        self.assertEqual(16 + assessed['remaining_token_allowance'] + assessed['remaining_known_poll_allowance'], 28)


class ExistingConsumerTests(unittest.TestCase):
    def test_local_v6_docker_plan_requires_sealed_old_image_head_and_preserves_legacy(self):
        from scripts.trial_guard.adapters import encoded
        from scripts.trial_guard.lifecycle import Denied
        from scripts.trial_provision.tests import test_attempt as legacy
        from scripts.trial_provision.tests import test_acknowledged_image_succession as successor
        with local_v6_modules() as (fixed, docker, _):
            data = successor.fixture(); verified = successor.verify(data)
            def config_and_files(base):
                config = deepcopy(base['config']); config['live'] = True
                manifest_path = str(fixed.ROOT / 'fictional-memory-only' / 'manifest.json')
                raws = {manifest_path: encoded(base['manifest'])}
                config['sources']['manifest']['path'] = manifest_path
                for slot in ('guardian', 'runtime'):
                    item = config['publication']['slots'][slot]
                    item['docker_path'] = str(fixed.DOCKER)
                    item['build_receipt']['path'] = str(fixed.ROOT / 'fictional-memory-only' / (slot+'.json'))
                    raws[item['build_receipt']['path']] = base['artifacts'][slot+'_build']
                def raw(reference):
                    value = raws[reference['path']]; self.assertEqual(docker.sha(value), reference['sha256']); return value
                return config, SimpleNamespace(raw=raw)
            config, files = config_and_files(data['new'])
            with patch.object(fixed, 'HEAD', data['new']['authority']['head']), \
                 patch.object(fixed, 'HOST', config['publication']['slots']['guardian']['docker_host']), \
                 patch.object(docker, 'file_hash', return_value='e'*64):
                rows = docker.plan(config, files, verified_attempt=verified)
                self.assertEqual(len(rows), 2)
                self.assertTrue(all(r['image_ref'].endswith(data['old'].authority['head'][:12]) for r in rows))
                with self.assertRaises(ValueError): docker.plan(config, files)
                for fake in ({'schema': 6, 'image_build_head': data['old'].authority['head']}, True,
                             SimpleNamespace(authority=verified.authority)):
                    with self.subTest(fake=type(fake).__name__), self.assertRaises(Denied):
                        docker.plan(config, files, verified_attempt=fake)
            old = legacy.fixture(); old_verified = legacy.verify(old); config, files = config_and_files(old)
            with patch.object(fixed, 'HEAD', old['authority']['head']), \
                 patch.object(fixed, 'HOST', config['publication']['slots']['guardian']['docker_host']), \
                 patch.object(docker, 'file_hash', return_value='e'*64):
                self.assertEqual(docker.plan(config, files), docker.plan(config, files, verified_attempt=old_verified))

    def test_local_main_worker_old_image_pin_requires_actual_v6_seal_before_collect(self):
        from scripts.trial_guard.adapters import encoded
        from scripts.trial_guard.lifecycle import Denied
        from scripts.trial_provision.tests import test_acknowledged_image_succession as successor
        from unittest.mock import Mock
        with local_v6_modules() as (fixed, _, main):
            data = successor.fixture(); verified = successor.verify(data)
            worker = {'node': '/fictional/node', 'script': '/fictional/catalog', 'artifact_pin':
                {'head': data['old'].authority['head']}, 'payload': {}, 'mode': 'catalog_then_bootstrap_v1'}
            reference = {'path': str(fixed.OUTPUT / 'session-catalog-worker.json'), 'sha256': 'e'*64}
            entry = SimpleNamespace(verified=verified, approved_worker=Mock(), services=SimpleNamespace(
                files=SimpleNamespace(raw=lambda _: encoded(worker)), api=SimpleNamespace(validate_catalog_payload=Mock())))
            request = {'phase': 'prepare-main', 'config': {'path': '/fictional/config', 'sha256': 'd'*64}, 'worker': reference}
            class ReachedCollector(Exception): pass
            with patch.object(fixed, 'HEAD', data['new']['authority']['head']), \
                 patch.object(main, 'collect', side_effect=ReachedCollector) as collect:
                with self.assertRaises(ReachedCollector): main.prepare(entry, request)
                collect.assert_called_once(); collect.reset_mock()
                worker['artifact_pin']['head'] = data['new']['authority']['head']
                with self.assertRaises(ValueError): main.prepare(entry, request)
                collect.assert_not_called()
                worker['artifact_pin']['head'] = data['old'].authority['head']
                entry.verified = SimpleNamespace(authority=verified.authority)
                with self.assertRaises(Denied): main.prepare(entry, request)
                collect.assert_not_called()

    def test_local_v6_admission_reads_actual_phase_counts_and_preserves_global_cleanup(self):
        repo = Path(__file__).resolve().parents[3]
        helpers = repo.parent / 'output' / 'issue148' / 'local-v6-20261014' / 'offline-prep'
        source = helpers / 'attempt_launcher.py'
        if not source.is_file(): self.skipTest('Local V6 launcher fixture is not shipped to CI')
        old_path = list(sys.path)
        with patch.dict(sys.modules):
            try:
                sys.path.insert(0, str(helpers))
                for name in ('offline_config', 'offline_files', 'source_inventory', 'local_docker_preflight', 'attempt_launcher'):
                    sys.modules.pop(name, None)
                spec = importlib.util.spec_from_file_location('restart_budget_v6_launcher', source)
                entry = importlib.util.module_from_spec(spec); sys.modules[spec.name] = entry; spec.loader.exec_module(entry)
                class Budget:
                    def __init__(inner, http, token, count):
                        inner.total = count
                        values = [{'event': 'request', 'value': {'attempt': 'a'*64, 'phase': 'run',
                            'kind': 'owner_arm', 'purpose': purpose}} for purpose, n in (('http', http), ('owner_token', token)) for _ in range(n)]
                        # Historical requests remain in the global count, not
                        # in the new attempt's purpose usage.
                        values.append({'event': 'request', 'value': {'attempt': 'b'*64, 'phase': 'run', 'kind': 'owner_arm', 'purpose': 'http'}})
                        inner.journal = SimpleNamespace(records=values)
                    def __enter__(inner): return inner
                    def __exit__(inner, *args): return False
                    def begin_attempt(inner, verified): pass  # Numerical-consumer seam only; no authority issuance.
                    def count(inner, kind): self.assertEqual(kind, 'owner_arm'); return inner.total
                def launcher(http, tokens, count, schema=6):
                    fake = Budget(http, tokens, count)
                    value = SimpleNamespace(services=SimpleNamespace(api=SimpleNamespace(ControlBudget=lambda *a, **k: fake)),
                        loaded={'control_budget': {'directory': '/fictional', 'directory_digest': 'c'*64, 'binding': {}, 'seed': {}}},
                        verified=SimpleNamespace(binding_digest='a'*64, authority={'schema': schema,
                            'phase_caps': {'owner_arm': {'run': 32 if schema == 6 else 42}}}))
                    value.run_remaining = lambda minimum=0, **kwargs: entry.Launcher.run_remaining(value, minimum, **kwargs)
                    return value
                with patch('scripts.trial_provision.attempt.effective_limits', return_value={'owner_arm': 631}):
                    for stage, h, t in (('rehearsal_start', 0, 0), ('rehearsal_seed', 2, 1),
                                       ('rehearsal_verify', 4, 1), ('main_preflight', 5, 1), ('main', 12, 1)):
                        value = launcher(h, t, 302+h+t)
                        self.assertEqual(entry.Launcher.run_admission(value, stage), 32-h-t)
                    # All four extra observations can be consumed, but a fifth
                    # known poll cannot take a normal main request or cleanup.
                    value = launcher(5, 2, 309)
                    self.assertEqual(entry.Launcher.run_admission(value, 'rehearsal_poll'), 25)
                    with self.assertRaises(ValueError): entry.Launcher.run_admission(launcher(6, 2, 310), 'rehearsal_poll')
                    with self.assertRaises(ValueError): entry.Launcher.run_admission(launcher(12, 9, 323), 'main')
                    with self.assertRaises(ValueError): entry.Launcher.run_admission(launcher(12, 1, 500), 'main')
                    self.assertEqual(entry.Launcher.run_admission(launcher(12, 1, 450, 5), 'main'), 29)
            finally: sys.path[:] = old_path

    def test_real_rehearsal_known_poll_costs_one_extra_and_unknown_cannot_restart(self):
        f = rehearsal.RehearsalTests('runTest'); f.setUp(); self.addCleanup(f.doCleanups)
        location = rehearsal.ARM + '/subscriptions/' + rehearsal.SUB + '/providers/Microsoft.App/jobs/fictional-guard/operationResults/' + rehearsal.OWNER + '?api-version=' + rehearsal.VERSION
        f.wire.start_response = rehearsal.response(202, headers={'Location': location, 'Retry-After': '1'})
        _, started = f.adapter.start(); f.clock.seconds = 1
        f.wire.modify = lambda method, url, headers, body: rehearsal.response(200, {'id': rehearsal.EXECUTION}) if url == location else None
        polled = f.adapter.poll_start(started)
        self.assertTrue(polled['write_terminal']); self.assertFalse(polled['terminal'])
        seed_op, seed = f.adapter.initialize(polled); f.wire.finish()
        _, verified = f.adapter.verify(polled, seed_op, seed)
        self.assertTrue(verified['terminal'])
        arm = [(m, u) for m, u, *_ in f.wire.calls if u.startswith(rehearsal.ARM + '/')]
        self.assertEqual(len(arm), 6); self.assertEqual(sum(m == 'POST' for m, _ in arm), 1)
        self.assertEqual(sum(u == location for _, u in arm), 1)
        self.assertFalse(any('/executions?' in u for _, u in arm))
        result = target.assess_run_trace(full_trace(polls=1), complete=True)
        self.assertEqual(result['normal_http'] + result['known_poll_http'], 21)
        with self.assertRaises(rehearsal.Denied): f.adapter.start()

    def test_real_workflow_rehearsal_main_and_full_provision_owner_auth_counts(self):
        f = workflow.WorkflowContractTests('runTest'); f.setUp(); self.addCleanup(f.doCleanups)
        f.publish_and_prepare(); f.provision(all_permissions=True)
        def counts():
            rows = [json.loads(raw) for raw in (f.root / 'trial-control-budget.jsonl').read_bytes().splitlines()]
            return Counter((r['value']['phase'], r['value']['kind'], r['value']['purpose'])
                for r in rows if r['event'] == 'request' and 'phase' in r['value'])
        before = counts(); f.rehearse(); rehearsed = counts()
        self.assertEqual(rehearsed['run', 'owner_arm', 'http'] - before['run', 'owner_arm', 'http'], 5)
        self.assertEqual(rehearsed['run', 'owner_arm', 'owner_token'] - before['run', 'owner_arm', 'owner_token'], 1)
        f.guardian_execute(); main = counts()
        self.assertEqual(main['run', 'owner_arm', 'http'] - rehearsed['run', 'owner_arm', 'http'], 8)
        self.assertEqual(main['run', 'owner_arm', 'owner_token'] - rehearsed['run', 'owner_arm', 'owner_token'], 0)
        f.bind_and_deploy(); f.enable_owner_auth(); final = counts()
        self.assertEqual(final['provision', 'owner_arm', 'http'], 135)
        self.assertEqual(final['provision', 'owner_arm', 'owner_token'], 1)
        # This repo fixture does not call the Local main-preflight helper. Its
        # actual seven requests are tested separately below when available.
        self.assertEqual(final['run', 'owner_arm', 'http'], 13)
        self.assertEqual(final['run', 'owner_arm', 'owner_token'], 1)
        self.assertGreater(final['run', 'owner_control_blob', 'http'], 0)
        self.assertEqual(f.trace[-1], 'owner_auth_enabled')

    def test_local_real_preflight_seven_owner_arm_requests_when_fixture_available(self):
        repo = Path(__file__).resolve().parents[3]
        helpers = repo.parent / 'output' / 'issue148' / 'local-v5-20261013' / 'offline-prep'
        source = helpers / 'test_main_preflight.py'
        if not source.is_file(): self.skipTest('Local reviewed preflight helper fixture is not shipped to CI')
        # Only source imports and the fixture's isolated temporary artifacts.
        # No production main/Services construction or protected-input read.
        old_path = list(sys.path)
        with patch.dict(sys.modules):
            try:
                sys.path.insert(0, str(helpers))
                spec = importlib.util.spec_from_file_location('restart_budget_local_preflight_fixture', source)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                f = module.PreflightTests('runTest'); f.setUp()
                try:
                    f.test_real_snapshot_and_fixed_fresh_rehearsal_to_main_24_maximum()
                    result = module.parse(f.files.raw(f.files.reference(f.output / 'attempt-main-preflight.result.json')))
                    self.assertEqual(result['http_attempts']['run'], 7)
                    self.assertEqual(sum(e['purpose'] == 'run' for e in result['request_evidence']), 7)
                finally: f.doCleanups()
            finally: sys.path[:] = old_path


if __name__ == '__main__':
    def no_external(event, args):
        if event.startswith('socket.') or event in ('subprocess.Popen', 'os.system'):
            raise AssertionError('external capability forbidden in offline budget tests')
    sys.addaudithook(no_external)
    unittest.main()
