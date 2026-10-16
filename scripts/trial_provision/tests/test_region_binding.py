"""Regression for the approved display region, using fictional authority only."""
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import unittest

from scripts.trial_guard.lifecycle import Denied, parse
from scripts.trial_provision.plan import PlanError, build_plan
from scripts.trial_provision.tests.test_plan import fixture as plan_fixture, guid
from scripts.trial_provision.operations import create_resolver
from scripts.trial_provision.providers import _validate
from scripts.trial_provision.resources import build_resource_operations, public_trial_origin
from scripts.trial_provision.tests.test_resources import fixture
from scripts.trial_provision.tests.test_operations import fixture as operation_fixture
from scripts.trial_provision.tests import test_publication_bridge as bridge_fixture


class DisplayRegionTests(unittest.TestCase):
    def test_display_region_has_identical_wire_operations_without_source_changes(self):
        manifest, authority, bindings = fixture()
        expected = build_resource_operations(manifest, authority, bindings)
        manifest['region'] = 'Japan East'
        authority['manifest'] = json.dumps(manifest).encode()
        before = deepcopy((manifest, authority, bindings))
        actual = build_resource_operations(manifest, authority, bindings)
        self.assertEqual(expected, actual)
        self.assertEqual(before, (manifest, authority, bindings))
        for op in actual:
            self.assertEqual(op, _validate(op))

    def test_display_alias_does_not_erase_approved_bytes_mismatch(self):
        manifest, authority, bindings = fixture()
        manifest['region'] = 'Japan East'
        with self.assertRaises(Denied):
            build_resource_operations(manifest, authority, bindings)

    def test_unapproved_display_names_and_malformed_regions_are_rejected(self):
        for region in ('Japan West', 'JAPAN EAST', 'Japan  East', ' Japan East',
                       'Japan East ', 'Japan\tEast', 'Japan East\n', None, [], 1):
            with self.subTest(region=region):
                manifest, authority, bindings = fixture()
                manifest['region'] = region
                authority['manifest'] = json.dumps(manifest).encode()
                with self.assertRaises(Denied):
                    build_resource_operations(manifest, authority, bindings)

    def test_actual_region_fqdn_is_bound_to_exact_app_and_region(self):
        manifest, _, _ = fixture()
        manifest['region'] = 'Japan East'
        expected = 'https://trial-app.fictional.japaneast.azurecontainerapps.io'
        for label in ('', 'internal.'):
            self.assertEqual(expected, public_trial_origin(manifest,
                'trial-app.' + label + 'fictional.japaneast.azurecontainerapps.io'))
        for name in ('trial-app.fictional.japanwest.azurecontainerapps.io',
                     'other-app.fictional.japaneast.azurecontainerapps.io',
                     'trial-app.fictional.japaneast.azurecontainerapps.io.evil.example'):
            with self.assertRaises(Denied):
                public_trial_origin(manifest, name)

    def test_full_authority_compiler_and_resolver_keep_raw_manifest(self):
        core, manifest, authority, bindings = operation_fixture(region='Japan East')
        before = deepcopy((manifest, authority, bindings))
        resolver = create_resolver(core, manifest, authority, bindings)
        self.assertEqual('japaneast', resolver._auth_binding['location'])
        self.assertEqual('Japan East', resolver._manifest['region'])
        self.assertEqual(before, (manifest, authority, bindings))

    def test_real_bridge_and_provider_readback_accept_display_region(self):
        case = bridge_fixture.PublicationBridgeTests('runTest')
        self.addCleanup(case.doCleanups)
        case.set_up_fixture(region='Japan East')
        before = {key: Path(ref['path']).read_bytes()
                  for key, ref in case.config['sources'].items()}
        case.test_live_output_reaches_fixed_resource_create_with_real_provider_and_controller()
        after = {key: Path(ref['path']).read_bytes()
                 for key, ref in case.config['sources'].items()}
        self.assertEqual(before, after)
        self.assertEqual('Japan East', json.loads(after['manifest'])['region'])


class RealClockBridgeTests(unittest.TestCase):
    def case(self):
        case = bridge_fixture.PublicationBridgeTests('runTest')
        self.addCleanup(case.doCleanups)
        case.set_up_fixture(region='Japan East')
        return case

    def test_real_clock_fraction_is_preserved_and_compiler_uses_ceiling(self):
        case = self.case()
        observed = parse('2026-10-11T00:59:00Z') + timedelta(microseconds=123456)
        case.clock.utc.return_value = observed
        self.assertEqual('provision_prepared', case.bind()['status'])
        intent = case.values('provision_bridge_intent')[0]
        self.assertEqual(observed.isoformat(), intent['checked_at'])
        self.assertEqual('2026-10-11T00:59:01Z', case.values('core_plan')[0]['prepared_at'])
        self.assertEqual('2026-10-11T00:59:01Z', case.values('core_plan')[0]['operations']['E4']['body']['passwordCredential']['startDateTime'])
        case.assert_prepared_once()
        core = case.values('core_plan')
        raw = case.output.read_bytes()
        case.clock.utc.return_value = observed + timedelta(seconds=1)
        self.assertTrue(case.bind()['replayed'])
        self.assertEqual(core, case.values('core_plan'))
        self.assertEqual(raw, case.output.read_bytes())

    def test_fraction_just_before_start_remains_admissible(self):
        case = self.case()
        start = parse(case.plan_bindings['guardian_window']['start'])
        case.clock.utc.return_value = start - timedelta(microseconds=1)
        self.assertEqual('provision_prepared', case.bind()['status'])
        self.assertEqual(case.plan_bindings['guardian_window']['start'], case.values('core_plan')[0]['prepared_at'])
        case.assert_prepared_once()

    def test_fraction_after_start_cannot_round_back_into_admission(self):
        case = self.case()
        case.clock.utc.return_value = parse(case.plan_bindings['guardian_window']['start']) + timedelta(microseconds=1)
        with self.assertRaises(PlanError):
            case.bind()
        self.assertEqual([], case.values('provision_bridge_intent'))
        self.assertFalse(case.output.exists())
        case.assert_no_external_calls()


    def test_rounding_cannot_admit_time_before_approval(self):
        manifest, authority, bindings = plan_fixture()
        before = parse(json.loads(authority['latest'])['approvedAt']) - timedelta(microseconds=1)
        with self.assertRaisesRegex(PlanError, 'approval_time'):
            build_plan(manifest, authority, bindings, before, lambda _: guid(1000))

    def test_fractional_approved_windows_remain_invalid(self):
        manifest, authority, bindings = plan_fixture()
        bindings['guardian_window']['start'] = '2026-10-11T01:00:00.000001Z'
        with self.assertRaises(PlanError):
            build_plan(manifest, authority, bindings, '2026-10-11T01:00:00.000001Z', lambda _: guid(1000))


if __name__ == '__main__':
    unittest.main()
