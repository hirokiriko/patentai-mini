"""Fictional-only compiler tests: no files, credentials, or Azure requests."""
import copy
import hashlib
import json
import unittest
from uuid import UUID

from scripts.trial_provision.plan import (
    AUTH_END, FORMAL_END, OP_KEYS, RESOURCE_SLOTS, PlanError, blob_condition,
    build_plan, build_arm_cleanup, canonical_json, digest, materialize_operation,
)


def guid(n):
    return str(UUID(int=n))


def fixture():
    sub = "/subscriptions/" + guid(1)
    rg = sub + "/resourceGroups/fictional-test-only"
    def resource(kind, name):
        return rg + "/providers/" + kind + "/" + name
    storage = resource("Microsoft.Storage/storageAccounts", "fictionalstore")
    ids = {name: storage + "/blobServices/default/containers/" + name
           for name in ("originals", "artifacts", "budget", "journal")}
    ids.update({"webIdentity": resource("Microsoft.ManagedIdentity/userAssignedIdentities", "web-mi"),
                "workerIdentity": resource("Microsoft.ManagedIdentity/userAssignedIdentities", "worker-mi"),
                "guard": resource("Microsoft.App/jobs", "guard"),
                "job": resource("Microsoft.App/jobs", "worker"),
                "app": resource("Microsoft.App/containerApps", "fictional-trial-app")})
    m = {"ids": ids, "region": "region", "owner": {"principal_id": guid(2), "tenant_id": guid(3)}, "resourceGroupId": rg,
         "existing": {"registry": resource("Microsoft.ContainerRegistry/registries", "fictionalacr"),
                      "db": resource("Microsoft.DBforPostgreSQL/flexibleServers", "fictionalpg"),
                      "ai": resource("Microsoft.CognitiveServices/accounts", "fictionalai")},
         "guardRoleIds": {k: sub + "/providers/Microsoft.Authorization/roleDefinitions/" + guid(10 + n)
                          for n, k in enumerate(("rule", "observer", "async", "journal"))},
         "guardAssignmentNames": {k: guid(30 + n) for n, k in enumerate(
             ("rule", "observer", "async", "journalMi", "pull", "journalOwner"))},
         "guardJournalPaths": ["state.json", "fictional-mi-only-a.json", "fictional-mi-only-b.json",
                               "rehearsal.json", "fictional-mi-only-c.json"]}
    original_paths = ["packages/fictional.zip"] + ["samples/" + str(n) + ".xml" for n in range(1, 5)]
    start, end = "2026-10-11T02:00:00Z", "2026-10-11T03:00:00Z"
    templates = {}
    for alias, paths in (("originals", original_paths), ("budget", ["trial-v1/state.json"])):
        templates[alias] = blob_condition(alias, paths, start, end).replace(start, "{{GRANT_START_UTC}}").replace(end, "{{GRANT_END_UTC}}")
    a = {"fixedOwner": copy.deepcopy(m["owner"]), "totals": {"runtime": 10, "guardian": 6,
         "ownerData": 2, "armAssignments": 18, "customRoles": 7, "entraOwnerAssignments": 1, "successors": 0},
         "lro": {"fixedSubscriptionScope": sub, "fixedGuardianResourceId": ids["guard"]},
         "acr": {"fixedRegistryResourceId": m["existing"]["registry"]},
         "operator": {"originalsKeys": original_paths, "budgetKeys": ["trial-v1/state.json"],
                      "scopeIds": {k: ids[k] for k in ("originals", "budget")},
                      "conditionTemplates": templates, "plannedAssignmentNames": {"originals": guid(40), "budget": guid(41)}},
         "auth": {"applicationRegistrations": 1, "servicePrincipals": 1, "ownerAppRoleAssignments": 1,
                  "credentials": 1, "expiresAt": AUTH_END, "cleanupDeadline": AUTH_END, "renewal": False,
                  "targetTrialAppResourceId": ids["app"], "platformSecretName": "fictional-owner-auth"}}
    approved = {"approved": {"clientSecrets": 1, "maximumOwnerGrantSeconds": 3600,
                              "maximumGuardianAssignmentSeconds": 28800}}
    latest = {"approvedAt": "2026-10-10T23:38:00Z", "totals": {"plannedArmAssignments": 18,
              "customRoleDefinitions": 7, "entraOwnerAssignments": 1, "maximumConcurrentAssignments": 18,
              "preflightRemovedBeforePlannedAssignments": True},
              "acr": {"role": "AcrPull", "roleDefinitionGuid": guid(50), "modeChange": False,
                      "pushPermission": False, "registryWideReadRiskExplicitlyAccepted": True,
                      "otherRuntimePermissionDeadlinesUnchanged": True, "registryResourceId": m["existing"]["registry"],
                      "web": {"identityResourceId": ids["webIdentity"], "expiresAt": AUTH_END},
                      "worker": {"identityResourceId": ids["workerIdentity"], "expiresAt": FORMAL_END},
                      "guardian": {"systemIdentityResourceId": ids["guard"], "maximumSeconds": 28800}},
              "globalLedger": {"roleDefinitionGuid": guid(51)}}
    network = {"target": m["existing"]["db"], "proposed_rule_name": "fictional-approved-rule"}
    network_approval = {"target": network["target"], "rule_name": network["proposed_rule_name"], "owner_id": guid(2)}
    raw = {}
    def save(key, value):
        raw[key] = canonical_json(value)
        return hashlib.sha256(raw[key]).hexdigest()
    mh = save("manifest", m)
    a["fixedManifestSha256"] = mh
    ah = save("annex", a)
    approved.update(boundProposalSha256=ah, fixedManifestSha256=mh)
    ph = save("approval", approved)
    latest.update(priorApprovalSha256=ph, originalProposalSha256=ah, fixedManifestSha256=mh)
    save("latest", latest)
    network_approval["networkOriginalBindingSha256"] = save("network_binding", network)
    save("network_approval", network_approval)
    bindings = {"guardian_window": {"start": "2026-10-11T01:00:00Z", "end": "2026-10-11T09:00:00Z"},
                "owner_window": {"start": start, "end": end},
                "prerequisite_digests": {slot: digest({"fictional_resource_op": slot}) for slot in RESOURCE_SLOTS}}
    return m, raw, bindings


class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.authority, self.bindings = fixture()
        self.allocations = {}
        self.calls = []
        def allocator(slot):
            self.calls.append(slot)
            return self.allocations.setdefault(slot, guid(1000 + len(self.allocations)))
        self.allocator = allocator
        self.now = "2026-10-11T01:00:00Z"

    def build(self):
        return build_plan(self.manifest, self.authority, self.bindings, self.now, self.allocator)

    def receipt(self, operation, object_id, properties):
        return {"operation_id": operation["id"], "state": "succeeded", "terminal": True,
                "write_terminal": True, "readback_verified": True, "created_by_run": True,
                "request_digest": digest(operation), "object_id": object_id, "properties": properties}

    def prerequisites(self, plan):
        result = {}
        for n, (slot, value) in enumerate(plan["prerequisites"].items()):
            properties = {"principalId": guid(2000 + n), "tenantId": guid(3)} if slot in ("webIdentity", "workerIdentity", "guard") else {}
            if slot == "app":
                properties = {"defaultDomain": "fictional-trial-app.environment.region.azurecontainerapps.io"}
            result[slot] = {"operation_id": slot, "state": "succeeded", "terminal": True,
                            "write_terminal": True, "readback_verified": True, "created_by_run": True,
                            "request_digest": value["request_digest"], "object_id": value["object_id"], "properties": properties}
        return result

    def auth_receipts(self, plan):
        receipts = self.prerequisites(plan)
        r8 = materialize_operation(plan, "R8", receipts)
        receipts["R8"] = self.receipt(r8, r8["expected"]["resource_id"], {})
        e1 = materialize_operation(plan, "E1", receipts)
        receipts["E1"] = self.receipt(e1, guid(3000), {"applicationObjectId": guid(3000), "appId": guid(3001)})
        e2 = materialize_operation(plan, "E2", receipts)
        receipts["E2"] = self.receipt(e2, guid(3002), {"servicePrincipalObjectId": guid(3002), "appId": guid(3001)})
        e3 = materialize_operation(plan, "E3", receipts)
        receipts["E3"] = self.receipt(e3, "opaque-assignment_123", {"directoryAssignmentId": "opaque-assignment_123",
            "principalId": guid(2), "resourceId": guid(3002), "appRoleId": plan["allocation"]["OWNER_APP_ROLE"]})
        return receipts

    def test_exact_counts_and_no_external_behavior(self):
        plan = self.build()
        self.assertEqual(len(plan["operations"]), 29)
        self.assertEqual(len(self.calls), 14)
        self.assertEqual(len(plan["allocation"]), 14)
        for op in plan["operations"].values():
            self.assertEqual(set(op), OP_KEYS)
        self.assertEqual(plan["operations"]["R8"]["deadline"], AUTH_END)
        self.assertEqual(plan["operations"]["R9"]["deadline"], FORMAL_END)
        self.assertEqual(plan["operations"]["G5"]["deadline"], self.bindings["guardian_window"]["end"])
        for slot in ("E1", "E2", "E3", "E4"):
            self.assertEqual(plan["operations"][slot]["deadline"], self.bindings["owner_window"]["end"])
            self.assertEqual(plan["operations"][slot]["cleanup"]["deadline"], AUTH_END)
        self.assertEqual(plan["operations"]["E4"]["body"]["passwordCredential"]["endDateTime"], AUTH_END)

    def test_resume_reuses_allocations_without_calling_allocator(self):
        first = self.build()
        self.bindings["allocated_ids"] = first["allocation"]
        self.calls.clear()
        second = self.build()
        self.assertEqual(first, second)
        self.assertEqual(self.calls, [])

    def test_source_byte_tamper_fails_before_allocation(self):
        self.authority["annex"] += b" "
        with self.assertRaisesRegex(PlanError, "authority_chain"):
            self.build()
        self.assertEqual(self.calls, [])

    def test_manifest_dict_cannot_disagree_with_bound_bytes(self):
        self.manifest["owner"]["principal_id"] = guid(999)
        with self.assertRaisesRegex(PlanError, "manifest_bytes_mismatch"):
            self.build()

    def test_unapproved_alternate_binding_rejected(self):
        self.bindings["alternate_scope"] = "fictional"
        with self.assertRaisesRegex(PlanError, "unexpected_fields"):
            self.build()

    def test_overlong_owner_window_rejected(self):
        self.bindings["owner_window"]["end"] = "2026-10-11T03:00:01Z"
        with self.assertRaisesRegex(PlanError, "window_too_long"):
            self.build()

    def test_overlong_guardian_window_rejected(self):
        self.bindings["guardian_window"]["end"] = "2026-10-11T09:00:01Z"
        with self.assertRaisesRegex(PlanError, "window_too_long"):
            self.build()

    def test_duplicate_new_ids_rejected(self):
        with self.assertRaisesRegex(PlanError, "allocation_collision"):
            build_plan(self.manifest, self.authority, self.bindings, self.now, lambda _: guid(10000))

    def test_missing_future_receipt_blocks_only_dependent_op(self):
        plan = self.build()
        c1 = materialize_operation(plan, "C1", {})
        self.assertEqual(c1["kind"], "roleDefinitions")
        with self.assertRaisesRegex(PlanError, "receipt_missing"):
            materialize_operation(plan, "R8", {})

    def test_partial_creation_ack_is_not_dependency_success(self):
        plan = self.build()
        receipts = self.prerequisites(plan)
        receipts["webIdentity"]["readback_verified"] = False
        with self.assertRaisesRegex(PlanError, "receipt_not_final"):
            materialize_operation(plan, "R8", receipts)
        self.assertIn("object_id", receipts["webIdentity"])

    def test_cross_tenant_identity_rejected(self):
        plan = self.build()
        receipts = self.prerequisites(plan)
        receipts["webIdentity"]["properties"]["tenantId"] = guid(9999)
        with self.assertRaisesRegex(PlanError, "principal_tenant"):
            materialize_operation(plan, "R8", receipts)

    def test_wrong_prerequisite_request_digest_rejected(self):
        plan = self.build()
        receipts = self.prerequisites(plan)
        receipts["webIdentity"]["request_digest"] = "0" * 64
        with self.assertRaisesRegex(PlanError, "prerequisite_binding"):
            materialize_operation(plan, "R8", receipts)

    def test_definition_body_is_bounded_and_digest_bound(self):
        plan = self.build()
        op = materialize_operation(plan, "C3", {})
        props = op["body"]["properties"]
        self.assertEqual(len(props["permissions"][0]["actions"]), 2)
        self.assertEqual(props["permissions"][0]["dataActions"], [])
        self.assertEqual(op["expected"]["body_sha256"], digest(op["body"]))
        self.assertEqual(props["assignableScopes"], ["/subscriptions/" + guid(1)])

    def test_owner_assignment_has_exact_paths_time_and_list_denial(self):
        plan = self.build()
        receipts = self.prerequisites(plan)
        c5 = materialize_operation(plan, "C5", {})
        receipts["C5"] = self.receipt(c5, c5["expected"]["resource_id"], {})
        op = materialize_operation(plan, "O1", receipts)
        condition = op["body"]["properties"]["condition"]
        self.assertIn("Blob.List", condition)
        self.assertIn("DateTimeLessThan '2026-10-11T03:00:00Z'", condition)
        self.assertIn("BoolEquals true", condition)
        self.assertNotIn("{{GRANT_", condition)
        self.assertNotIn("blobs/delete", canonical_json(op).decode())
        self.assertEqual(op["body"]["properties"]["principalType"], "User")

    def test_graph_dependency_chain_and_secret_metadata_only(self):
        plan = self.build()
        receipts = self.auth_receipts(plan)
        op = materialize_operation(plan, "E4", receipts)
        self.assertTrue(op["url"].endswith("/" + guid(3000) + "/addPassword"))
        self.assertEqual(set(op["body"]), {"passwordCredential"})
        self.assertEqual(op["body"]["passwordCredential"]["endDateTime"], AUTH_END)
        self.assertNotIn("before_absent", op["expected"])
        self.assertNotIn("secretText", canonical_json(plan).decode())

    def test_owner_journal_does_not_inherit_other_manifest_paths(self):
        plan = self.build()
        condition = plan["operations"]["G6"]["body"]["properties"]["condition"]
        self.assertIn("{'state.json', 'rehearsal.json'}", condition)
        self.assertNotIn("fictional-mi-only", condition)
        self.assertNotIn("condition", plan["operations"]["G4"]["body"]["properties"])

    def test_callback_comes_only_from_exact_app_receipt(self):
        plan = self.build()
        receipts = self.auth_receipts(plan)
        op = materialize_operation(plan, "E1", receipts)
        self.assertEqual(op["body"]["web"]["implicitGrantSettings"], {
            "enableIdTokenIssuance": True, "enableAccessTokenIssuance": False})
        receipts["app"]["properties"]["defaultDomain"] = "evil.example"
        with self.assertRaisesRegex(PlanError, "callback_binding"):
            materialize_operation(plan, "E1", receipts)

    def test_receipt_from_different_graph_request_rejected(self):
        plan = self.build()
        receipts = self.auth_receipts(plan)
        receipts["E2"]["request_digest"] = "1" * 64
        with self.assertRaisesRegex(PlanError, "receipt_request_digest"):
            materialize_operation(plan, "E3", receipts)

    def test_closed_internal_app_callback_targets_same_external_app(self):
        plan = self.build()
        receipts = self.prerequisites(plan)
        r8 = materialize_operation(plan, "R8", receipts)
        receipts["R8"] = self.receipt(r8, r8["expected"]["resource_id"], {})
        receipts["app"]["properties"]["defaultDomain"] = "fictional-trial-app.internal.environment.region.azurecontainerapps.io"
        op = materialize_operation(plan, "E1", receipts)
        self.assertEqual(op["body"]["web"]["redirectUris"], [
            "https://fictional-trial-app.environment.region.azurecontainerapps.io/.auth/login/aad/callback"])
        receipts["app"]["properties"]["defaultDomain"] = "other-app.environment.region.azurecontainerapps.io"
        with self.assertRaisesRegex(PlanError, "callback_binding"):
            materialize_operation(plan, "E1", receipts)

    def test_plan_mutation_rejected_and_concrete_result_is_detached(self):
        plan = self.build()
        op = materialize_operation(plan, "C1", {})
        op["body"]["properties"]["permissions"][0]["actions"].append("*")
        fresh = materialize_operation(plan, "C1", {})
        self.assertNotIn("*", fresh["body"]["properties"]["permissions"][0]["actions"])
        plan["operations"]["C1"]["body"]["properties"]["permissions"][0]["actions"].append("*")
        with self.assertRaisesRegex(PlanError, "plan_changed"):
            materialize_operation(plan, "C1", {})

    def test_digest_matches_other_provision_modules_with_non_ascii(self):
        from scripts.trial_guard.adapters import digest as shared_digest
        self.assertEqual(digest({"label": "完全架空"}), shared_digest({"label": "完全架空"}))

    def test_cleanup_is_bound_to_verified_create(self):
        op = materialize_operation(self.build(), "C1", {})
        receipt = self.receipt(op, op["expected"]["resource_id"], {})
        cleanup = build_arm_cleanup(op, receipt, op["deadline"])
        self.assertEqual(cleanup["method"], "DELETE")
        self.assertEqual(cleanup["url"], op["url"])
        self.assertIsNone(cleanup["body"])
        self.assertEqual(cleanup["expected"]["body_sha256"], digest(None))
        self.assertTrue(cleanup["cleanup"]["zero_reference_required"])
        receipt["readback_verified"] = False
        with self.assertRaisesRegex(PlanError, "cleanup_receipt"):
            build_arm_cleanup(op, receipt, op["deadline"])

    def test_cleanup_refuses_changed_target_or_extended_deadline(self):
        op = materialize_operation(self.build(), "C1", {})
        receipt = self.receipt(op, op["expected"]["resource_id"], {})
        with self.assertRaisesRegex(PlanError, "cleanup_deadline"):
            build_arm_cleanup(op, receipt, AUTH_END)
        op["url"] += "unapproved"
        with self.assertRaisesRegex(PlanError, "cleanup_url"):
            build_arm_cleanup(op, receipt, op["deadline"])

    def test_all_25_iam_operations_match_actual_provider_contract(self):
        from scripts.trial_provision.providers import _validate
        plan = self.build()
        receipts = self.prerequisites(plan)
        for slot, template in plan["operations"].items():
            if template["provider"] != "Microsoft.Authorization":
                continue
            op = materialize_operation(plan, slot, receipts)
            with self.subTest(slot=slot):
                self.assertEqual(_validate(op), op)
            receipts[slot] = self.receipt(op, op["expected"]["resource_id"], {})
            cleanup = build_arm_cleanup(op, receipts[slot], op["deadline"])
            with self.subTest(cleanup=slot):
                self.assertEqual(_validate(cleanup), cleanup)


if __name__ == "__main__":
    unittest.main()
