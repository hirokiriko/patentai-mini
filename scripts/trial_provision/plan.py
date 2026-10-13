"""Pure compiler for the approved, finite trial IAM/Entra plan.

No files, credentials, clocks, allocation store or network are accessed here.
The caller owns protected persistence and must pin ``plan_sha256`` before I/O.
``allocate_id(slot)`` is a durable get-or-create callback, not a fresh-ID factory
on resume. Source values and returned plans are OWNER-private and must not be
logged. Exceptions deliberately contain classification codes only.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from uuid import UUID

ARM = "https://management.azure.com"
GRAPH = "https://graph.microsoft.com/v1.0"
API = "2022-04-01"
BLOB = "Microsoft.Storage/storageAccounts/blobServices/containers"
FORMAL_END = "2026-10-31T00:00:00Z"
AUTH_END = "2027-01-29T00:00:00Z"
OP_KEYS = frozenset(("id", "provider", "kind", "method", "url", "body",
                     "deadline", "depends_on", "expected", "cleanup"))
RESOURCE_SLOTS = ("webIdentity", "workerIdentity", "originals", "artifacts",
                  "budget", "journal", "job", "guard", "app")
ROLE_LABELS = ("fixed-rule-remover", "db-observer", "pg-lro-reader", "journal-rw",
               "trial-storage-rw", "trial-job-control", "ai-response-create")


class PlanError(ValueError):
    """A safe, non-sensitive validation classification."""


def _need(value: Any, code: str) -> None:
    if not value:
        raise PlanError(code)


def canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise PlanError("not_json") from None


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _keys(value: Any, required: set[str], optional: set[str] = frozenset()) -> None:
    _need(isinstance(value, dict) and required <= set(value)
          and set(value) <= required | optional, "unexpected_fields")


def _at(value: Mapping[str, Any], path: str) -> Any:
    try:
        for part in path.split("."):
            value = value[part]
        return value
    except (KeyError, TypeError):
        raise PlanError("missing_binding") from None


def _guid(value: Any) -> str:
    try:
        _need(isinstance(value, str) and str(UUID(value)) == value.lower(), "invalid_guid")
        _need(UUID(value).int != 0, "invalid_guid")
        return value.lower()
    except (ValueError, AttributeError, TypeError):
        raise PlanError("invalid_guid") from None


def _sha(value: Any) -> str:
    _need(isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value), "invalid_digest")
    return value.lower()


def _utc(value: Any, *, allow_fractional: bool = False) -> datetime:
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
        _need(result.tzinfo is not None and result.utcoffset().total_seconds() == 0,
              "non_utc_time")
        _need(allow_fractional or result.microsecond == 0, "fractional_time")
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError, AttributeError):
        raise PlanError("invalid_time") from None


def _stamp(value: Any) -> str:
    return _utc(value).strftime("%Y-%m-%dT%H:%M:%SZ")


def _window(value: Any, now: datetime, maximum: int) -> dict[str, str]:
    _keys(value, {"start", "end"})
    start, end = _utc(value["start"]), _utc(value["end"])
    _need(now <= start < end <= _utc(FORMAL_END), "window_bounds")
    _need((end - start).total_seconds() <= maximum, "window_too_long")
    return {"start": _stamp(start), "end": _stamp(end)}


def _load(raw: Any) -> tuple[dict, str]:
    _need(isinstance(raw, bytes) and 0 < len(raw) <= 4 * 1024 * 1024, "source_bytes")
    def pairs(items):
        result = {}
        for key, value in items:
            _need(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(PlanError("invalid_json")))
    except (UnicodeError, json.JSONDecodeError):
        raise PlanError("invalid_json") from None
    _need(isinstance(value, dict), "source_object")
    return value, hashlib.sha256(raw).hexdigest()


def _resource(value: Any, subscription: str, provider_type: str | None = None) -> str:
    _need(isinstance(value, str) and value.startswith(subscription + "/")
          and not any(c in value for c in ("?", "#", "\\", "%", "\r", "\n", "..")), "resource_scope")
    _need(re.fullmatch(r"/[A-Za-z0-9_./()-]+", value), "resource_syntax")
    if provider_type:
        _need(re.search(r"/providers/" + re.escape(provider_type) + r"/[^/]+$", value,
                        flags=re.IGNORECASE), "resource_type")
    return value


def _literal(value: Any) -> str:
    _need(isinstance(value, str) and value and len(value) <= 1024
          and not any(c in value for c in ("'", "\r", "\n", "*", "?", "\\")), "condition_literal")
    return value


def blob_condition(container: str, paths: list[str], start: str, end: str) -> str:
    """Exact read/write ABAC construction used by operatorBlobCondition."""
    container = _literal(container)
    _need(paths and len(paths) == len(set(paths)), "condition_paths")
    path_set = ", ".join("'" + _literal(p) + "'" for p in paths)
    read, write = BLOB + "/blobs/read", BLOB + "/blobs/write"
    scope = (f"@Resource[{BLOB}:name] StringEquals '{container}' AND "
             f"@Resource[{BLOB}/blobs:path] ForAnyOfAnyValues:StringEquals {{{path_set}}} AND "
             f"@Environment[UtcNow] DateTimeGreaterThan '{_stamp(start)}' AND "
             f"@Environment[UtcNow] DateTimeLessThan '{_stamp(end)}'")
    return (f"((!(ActionMatches{{'{read}'}} OR ActionMatches{{'{write}'}})) OR ({scope})) "
            f"AND (!(ActionMatches{{'{read}'}} AND SubOperationMatches{{'Blob.List'}})) "
            f"AND ((!ActionMatches{{'{read}'}}) OR (@Resource[{BLOB}/blobs:isCurrentVersion] BoolEquals true))")


def _ref(slot: str, key: str) -> dict:
    return {"$receipt": [slot, key]}


def build_plan(manifest: dict, authority_bundle: dict, bindings: dict,
               now: datetime | str, allocate_id: Callable[[str], str], *,
               verified_attempt=None) -> dict:
    """Compile 7 definitions, 18 assignments and E1-E4 without performing I/O.

    authority_bundle's manifest/annex/approval/latest/network_binding and
    network_approval are exact source bytes. Network approval fixes the G1
    delete-only child scope; it grants no network creation or IPv4 substitution.
    bindings contains two start/end windows and the nine prerequisite request
    digests; optional allocated_ids reuses already-persisted noncredential IDs.
    A sealed V6 narrows C7 to the manifest's fixed AI resource. Earlier plans
    retain their original bytes for immutable historical proof verification.
    """
    _keys(authority_bundle, {"manifest", "annex", "approval", "latest", "network_binding", "network_approval"})
    sources, hashes = {}, {}
    for name in ("manifest", "annex", "approval", "latest", "network_binding", "network_approval"):
        sources[name], hashes[name] = _load(authority_bundle[name])
    _need(sources["manifest"] == manifest, "manifest_bytes_mismatch")
    fixed_ai_scope = False
    if verified_attempt is not None:
        from .attempt import _proof
        proof = _proof(verified_attempt)
        _need(proof['manifest_digest'] == digest(manifest)
              and proof['authority']['manifest_sha256'] == hashes['manifest'],
              'attempt_manifest_binding')
        fixed_ai_scope = proof['authority']['schema'] == 6
    m, a, approved, latest = manifest, sources["annex"], sources["approval"], sources["latest"]
    for actual, expected in (
        (_at(a, "fixedManifestSha256"), hashes["manifest"]),
        (_at(approved, "boundProposalSha256"), hashes["annex"]),
        (_at(approved, "fixedManifestSha256"), hashes["manifest"]),
        (_at(latest, "priorApprovalSha256"), hashes["approval"]),
        (_at(latest, "originalProposalSha256"), hashes["annex"]),
        (_at(latest, "fixedManifestSha256"), hashes["manifest"]),
        (_at(sources["network_approval"], "networkOriginalBindingSha256"), hashes["network_binding"]),
    ):
        _need(_sha(actual) == expected, "authority_chain")
    for key, value in {"runtime": 10, "guardian": 6, "ownerData": 2, "armAssignments": 18,
                       "customRoles": 7, "entraOwnerAssignments": 1, "successors": 0}.items():
        _need(_at(a, "totals." + key) == value, "authority_counts")
    for key, value in {"plannedArmAssignments": 18, "customRoleDefinitions": 7,
                       "entraOwnerAssignments": 1, "maximumConcurrentAssignments": 18}.items():
        _need(_at(latest, "totals." + key) == value, "authority_counts")
    _need(_at(latest, "totals.preflightRemovedBeforePlannedAssignments") is True, "preflight_order")
    _need(_at(latest, "acr.role") == "AcrPull" and _at(latest, "acr.modeChange") is False
          and _at(latest, "acr.pushPermission") is False, "acr_authority")
    _need(_at(latest, "acr.registryWideReadRiskExplicitlyAccepted") is True
          and _at(latest, "acr.otherRuntimePermissionDeadlinesUnchanged") is True, "acr_authority")
    _need(_stamp(_at(latest, "acr.web.expiresAt")) == AUTH_END
          and _stamp(_at(latest, "acr.worker.expiresAt")) == FORMAL_END
          and _at(latest, "acr.guardian.maximumSeconds") == 28800, "acr_deadlines")
    auth = _at(a, "auth")
    for field in ("applicationRegistrations", "servicePrincipals", "ownerAppRoleAssignments", "credentials"):
        _need(_at(auth, field) == 1, "auth_counts")
    _need(_stamp(_at(auth, "expiresAt")) == AUTH_END
          and _stamp(_at(auth, "cleanupDeadline")) == AUTH_END
          and _at(auth, "renewal") is False, "auth_deadline")
    _need(_at(approved, "approved.clientSecrets") == 1
          and _at(approved, "approved.maximumOwnerGrantSeconds") == 3600
          and _at(approved, "approved.maximumGuardianAssignmentSeconds") == 28800, "approved_limits")

    _keys(bindings, {"guardian_window", "owner_window", "prerequisite_digests"}, {"allocated_ids"})
    current = _utc(now, allow_fractional=True)
    # Keep the observed instant for every admission check. Only serialized
    # preparation/credential starts use a conservative whole-second ceiling.
    # Approved windows and other source timestamps remain strictly whole seconds.
    compiled_at = current.replace(microsecond=0) + timedelta(seconds=bool(current.microsecond))
    _need(_utc(_at(latest, "approvedAt")) <= current < _utc(FORMAL_END), "approval_time")
    guardian = _window(bindings["guardian_window"], current, 28800)
    owner_window = _window(bindings["owner_window"], current, 3600)
    _need(_utc(guardian["start"]) <= _utc(owner_window["start"])
          and _utc(owner_window["end"]) <= _utc(guardian["end"]), "owner_window_order")
    _keys(bindings["prerequisite_digests"], set(RESOURCE_SLOTS))
    prereq_digests = {k: _sha(v) for k, v in bindings["prerequisite_digests"].items()}

    subscription = _at(a, "lro.fixedSubscriptionScope")
    _need(isinstance(subscription, str) and re.fullmatch(r"/subscriptions/[0-9a-fA-F-]{36}", subscription), "subscription")
    _guid(subscription.rsplit("/", 1)[1])
    owner, tenant = _guid(_at(m, "owner.principal_id")), _guid(_at(m, "owner.tenant_id"))
    _need(_guid(_at(a, "fixedOwner.principal_id")) == owner
          and _guid(_at(a, "fixedOwner.tenant_id")) == tenant, "owner_binding")
    ids = {k: _resource(_at(m, "ids." + k), subscription) for k in RESOURCE_SLOTS}
    _need(len(set(v.lower() for v in ids.values())) == len(ids), "resource_alias_collision")
    for name in ("webIdentity", "workerIdentity"):
        _resource(ids[name], subscription, "Microsoft.ManagedIdentity/userAssignedIdentities")
    for name in ("job", "guard"):
        _resource(ids[name], subscription, "Microsoft.App/jobs")
    _resource(ids["app"], subscription, "Microsoft.App/containerApps")
    for name in ("originals", "artifacts", "budget", "journal"):
        _need(re.search(r"/providers/Microsoft.Storage/storageAccounts/[^/]+/blobServices/default/containers/[^/]+$", ids[name], re.I), "container_scope")
    registry = _resource(_at(m, "existing.registry"), subscription, "Microsoft.ContainerRegistry/registries")
    database = _resource(_at(m, "existing.db"), subscription, "Microsoft.DBforPostgreSQL/flexibleServers")
    ai = _resource(_at(m, "existing.ai"), subscription, "Microsoft.CognitiveServices/accounts")
    _need(_at(latest, "acr.registryResourceId") == registry == _at(a, "acr.fixedRegistryResourceId"), "registry_binding")
    for latest_key, alias in (("web.identityResourceId", "webIdentity"), ("worker.identityResourceId", "workerIdentity"),
                              ("guardian.systemIdentityResourceId", "guard")):
        _need(_at(latest, "acr." + latest_key) == ids[alias], "pull_principal_binding")
    _need(_at(a, "auth.targetTrialAppResourceId") == ids["app"]
          and _at(a, "lro.fixedGuardianResourceId") == ids["guard"], "target_binding")
    network, network_approval = sources["network_binding"], sources["network_approval"]
    _need(_at(network, "target") == database == _at(network_approval, "target"), "network_server")
    rule_name = _at(network, "proposed_rule_name")
    _need(isinstance(rule_name, str) and re.fullmatch(r"[A-Za-z0-9_-]+", rule_name)
          and rule_name == _at(network_approval, "rule_name"), "network_rule")
    _need(_guid(_at(network_approval, "owner_id")) == owner, "network_owner")
    rule = database + "/firewallRules/" + rule_name

    alloc_keys = {"C5", "C6", "C7", "OWNER_APP_ROLE"} | {"R" + str(n) for n in range(1, 11)}
    allocated = bindings.get("allocated_ids", {})
    _need(isinstance(allocated, dict) and set(allocated) <= alloc_keys, "allocation_slots")
    # Source, scope and time validation precedes even the noncredential callback.
    allocation = {slot: _guid(allocated[slot] if slot in allocated else allocate_id(slot))
                  for slot in sorted(alloc_keys)}
    _need(len(set(allocation.values())) == len(allocation), "allocation_collision")
    rg = _at(m, "resourceGroupId")
    _need(isinstance(rg, str) and re.fullmatch(re.escape(subscription) + r"/resourceGroups/[^/]+", rg), "resource_group")
    role_ids = {}
    for index, name in enumerate(("rule", "observer", "async", "journal"), 1):
        value = _at(m, "guardRoleIds." + name)
        _resource(value, subscription, "Microsoft.Authorization/roleDefinitions")
        _guid(value.rsplit("/", 1)[1])
        role_ids["C" + str(index)] = value
    for slot in ("C5", "C6", "C7"):
        role_ids[slot] = subscription + "/providers/Microsoft.Authorization/roleDefinitions/" + allocation[slot]
    _need(len(set(role_ids.values())) == 7, "role_collision")
    for label, field in (("builtin.AcrPull", "acr.roleDefinitionGuid"),
                         ("builtin.StorageBlobDataReader", "globalLedger.roleDefinitionGuid")):
        role_ids[label] = subscription + "/providers/Microsoft.Authorization/roleDefinitions/" + _guid(_at(latest, field))
    _need(len(set(role_ids.values())) == 9, "builtin_collision")

    paths = list(_at(a, "operator.originalsKeys"))
    budget_paths = list(_at(a, "operator.budgetKeys"))
    _need(len(paths) == len(set(paths)) == 5 and budget_paths == ["trial-v1/state.json"], "owner_paths")
    journal_paths = _at(m, "guardJournalPaths")
    _need(isinstance(journal_paths, list) and all(isinstance(p, str) for p in journal_paths)
          and {"state.json", "rehearsal.json"} <= set(journal_paths)
          and len(journal_paths) == len(set(journal_paths)), "journal_paths")
    conditions = {}
    for alias, keys in (("originals", paths), ("budget", budget_paths)):
        _need(_at(a, "operator.scopeIds." + alias) == ids[alias], "owner_scope")
        condition = blob_condition(ids[alias].rsplit("/", 1)[1], keys, **{
            "start": owner_window["start"], "end": owner_window["end"]})
        template = _at(a, "operator.conditionTemplates." + alias)
        _need(isinstance(template, str) and "{GRANT_START_UTC}" in template
              and "{GRANT_END_UTC}" in template, "condition_template")
        # The approved saved annex uses double-braced placeholders. Replace the
        # complete token first; a single-brace fixture is supported as well.
        fixed = template.replace("{{GRANT_START_UTC}}", owner_window["start"]).replace("{{GRANT_END_UTC}}", owner_window["end"])
        fixed = fixed.replace("{GRANT_START_UTC}", owner_window["start"]).replace("{GRANT_END_UTC}", owner_window["end"])
        _need(condition == fixed, "condition_template_mismatch")
        conditions[alias] = fixed
    # The manifest also names MI-only recovery artifacts. The OWNER's G6 grant
    # is deliberately restricted to its two approved keys, never the whole list.
    conditions["journal"] = blob_condition(ids["journal"].rsplit("/", 1)[1],
                                            ["state.json", "rehearsal.json"], **guardian)
    app_name = ids["app"].rsplit("/", 1)[1]
    _need(re.fullmatch(r"[a-z][a-z0-9-]{1,50}", app_name), "app_name")
    role_permissions = [
        (["Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/read", "Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/delete"], []),
        (["Microsoft.DBforPostgreSQL/flexibleServers/read", "Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/read"], []),
        (["Microsoft.DBforPostgreSQL/locations/azureAsyncOperation/read", "Microsoft.DBforPostgreSQL/locations/operationResults/read"], []),
        ([], [BLOB + "/blobs/read", BLOB + "/blobs/write"]),
        ([BLOB + "/read"], [BLOB + "/blobs/read", BLOB + "/blobs/write"]),
        (["Microsoft.App/jobs/read", "Microsoft.App/jobs/start/action", "Microsoft.App/jobs/executions/read"], []),
        ([], ["Microsoft.CognitiveServices/accounts/OpenAI/responses/write"]),
    ]
    operations = {}
    def arm(slot, kind, resource_id, properties, deadline, dependencies):
        body = {"properties": properties}
        operations[slot] = {"id": slot, "provider": "Microsoft.Authorization", "kind": kind,
            "method": "PUT", "url": ARM + resource_id + "?api-version=" + API, "body": body,
            "deadline": deadline, "depends_on": dependencies,
            "expected": {"resource_id": resource_id, "api_version": API, "body_sha256": None,
                         "properties": {"properties." + k: v for k, v in properties.items()},
                         "created_by_run": True, "before_absent": True},
            "cleanup": {"created_only": True, "zero_reference_required": kind == "roleDefinitions",
                        "deadline": deadline}}
    for n, (actions, data_actions) in enumerate(role_permissions, 1):
        slot = "C" + str(n)
        props = {"roleName": app_name + "-" + ROLE_LABELS[n - 1], "type": "CustomRole",
                 "description": "Dedicated trial role; approved scope only.",
                 "permissions": [{"actions": actions, "notActions": [], "dataActions": data_actions, "notDataActions": []}],
                 "assignableScopes": [subscription if n == 3 else ai if n == 7 and fixed_ai_scope else rg]}
        arm(slot, "roleDefinitions", role_ids[slot], props, guardian["end"] if n <= 4 else FORMAL_END, [])

    specs = [
        ("R1", "webIdentity", ids["originals"], "C5", "originals"),
        ("R2", "webIdentity", ids["artifacts"], "C5", "artifacts"),
        ("R3", "webIdentity", ids["budget"], "C5", "budget"),
        ("R4", "workerIdentity", ids["originals"], "builtin.StorageBlobDataReader", "originals"),
        ("R5", "workerIdentity", ids["budget"], "C5", "budget"),
        ("R6", "webIdentity", ai, "C7", None), ("R7", "workerIdentity", ai, "C7", None),
        ("R8", "webIdentity", registry, "builtin.AcrPull", None),
        ("R9", "workerIdentity", registry, "builtin.AcrPull", None),
        ("R10", "webIdentity", ids["job"], "C6", "job"),
        ("G1", "guard", rule, "C1", None), ("G2", "guard", database, "C2", None),
        ("G3", "guard", subscription, "C3", None), ("G4", "guard", ids["journal"], "C4", "journal"),
        ("G5", "guard", registry, "builtin.AcrPull", None),
        ("G6", "OWNER", ids["journal"], "C4", "journal"),
        ("O1", "OWNER", ids["originals"], "C5", "originals"),
        ("O2", "OWNER", ids["budget"], "C5", "budget"),
    ]
    guardian_names = ("rule", "observer", "async", "journalMi", "pull", "journalOwner")
    assignment_ids = []
    for slot, principal, scope, role, target_alias in specs:
        if slot.startswith("R"):
            guid = allocation[slot]
        elif slot.startswith("G"):
            guid = _guid(_at(m, "guardAssignmentNames." + guardian_names[int(slot[1:]) - 1]))
        else:
            guid = _guid(_at(a, "operator.plannedAssignmentNames." + target_alias))
        assignment_ids.append(guid)
        dependencies = ([role] if role.startswith("C") else [])
        if principal != "OWNER":
            dependencies.append(principal)
        if target_alias:
            dependencies.append(target_alias)
        props = {"roleDefinitionId": role_ids[role], "principalId": owner if principal == "OWNER" else _ref(principal, "principalId"),
                 "principalType": "User" if principal == "OWNER" else "ServicePrincipal"}
        if principal == "OWNER":
            props.update(conditionVersion="2.0", condition=conditions[target_alias])
        deadline = AUTH_END if slot == "R8" else (guardian["end"] if slot.startswith("G") else
                                                    owner_window["end"] if slot.startswith("O") else FORMAL_END)
        resource_id = scope + "/providers/Microsoft.Authorization/roleAssignments/" + guid
        arm(slot, "roleAssignments", resource_id, props, deadline, dependencies)
    _need(len(set(assignment_ids)) == 18, "assignment_collision")

    graph_bodies = {
        "E1": {"displayName": app_name + "-auth", "signInAudience": "AzureADMyOrg",
               "web": {"redirectUris": [{"$callback": "app"}], "implicitGrantSettings": {
                   "enableIdTokenIssuance": True, "enableAccessTokenIssuance": False}},
               "requiredResourceAccess": [], "passwordCredentials": [],
               "appRoles": [{"id": allocation["OWNER_APP_ROLE"], "allowedMemberTypes": ["User"],
                             "description": "Dedicated trial OWNER", "displayName": "OWNER", "isEnabled": True, "value": "OWNER"}]},
        "E2": {"appId": _ref("E1", "appId"), "appRoleAssignmentRequired": True},
        "E3": {"principalId": owner, "resourceId": _ref("E2", "servicePrincipalObjectId"), "appRoleId": allocation["OWNER_APP_ROLE"]},
        "E4": {"passwordCredential": {"displayName": app_name + "-owner-login", "startDateTime": _stamp(compiled_at), "endDateTime": AUTH_END}},
    }
    urls = {"E1": GRAPH + "/applications", "E2": GRAPH + "/servicePrincipals",
            "E3": {"$graph_url": ["E2", "servicePrincipalObjectId", "servicePrincipals", "appRoleAssignedTo"]},
            "E4": {"$graph_url": ["E1", "applicationObjectId", "applications", "addPassword"]}}
    graph_names = ("applications", "servicePrincipals", "appRoleAssignedTo", "addPassword")
    graph_deps = {"E1": ["app", "R8"], "E2": ["E1"], "E3": ["E2"], "E4": ["E3", "app"]}
    for n, kind in enumerate(graph_names, 1):
        slot = "E" + str(n)
        body = graph_bodies[slot]
        operations[slot] = {"id": slot, "provider": "Microsoft.Graph", "kind": kind, "method": "POST",
            "url": urls[slot], "body": body, "deadline": owner_window["end"], "depends_on": graph_deps[slot],
            "expected": {"body_sha256": None, "properties": copy.deepcopy(body), "created_by_run": True},
            "cleanup": {"created_only": True, "zero_reference_required": slot in ("E1", "E2"),
                        "deadline": AUTH_END}}
    prerequisites = {slot: {"object_id": ids[slot], "request_digest": prereq_digests[slot], "tenant_id": tenant}
                     for slot in RESOURCE_SLOTS}
    result = {"schema": 1, "operations": operations, "prerequisites": prerequisites,
              "source_sha256": hashes, "allocation": allocation,
              "windows": {"guardian": guardian, "owner_input": owner_window},
              "counts": {"role_definitions": 7, "arm_assignments": 18, "entra_operations": 4, "entra_secrets": 1},
              "auth_binding": {"tenant_id": tenant, "owner_id": owner, "app_role_id": allocation["OWNER_APP_ROLE"],
                               "application_display_name": app_name + "-auth", "credential_display_name": app_name + "-owner-login",
                               "credential_expires_at": AUTH_END, "target_app_id": ids["app"],
                               "platform_secret_name": _at(auth, "platformSecretName")},
              "prepared_at": _stamp(compiled_at)}
    result["callback_binding"] = {"names": {"app": app_name}, "region": _at(m, "region")}
    result["plan_sha256"] = digest(result)
    return result


def _validate_plan(plan: dict) -> None:
    _need(isinstance(plan, dict), "plan_shape")
    frozen = {k: v for k, v in plan.items() if k != "plan_sha256"}
    _need(_sha(plan.get("plan_sha256")) == digest(frozen), "plan_changed")
    expected_ids = {"C" + str(n) for n in range(1, 8)} | {"R" + str(n) for n in range(1, 11)} | {
        "G" + str(n) for n in range(1, 7)} | {"O1", "O2", "E1", "E2", "E3", "E4"}
    _need(set(plan["operations"]) == expected_ids, "operation_counts")
    for slot, op in plan["operations"].items():
        _need(set(op) == OP_KEYS and op["id"] == slot, "operation_shape")


def materialize_operation(plan: dict, slot_id: str, receipts: dict) -> dict:
    """Resolve one op from terminal, exact-digest, readback-verified receipts.

    Partial/write-ack receipts stay in the caller journal for reconciliation;
    they never unlock a dependent operation. This does not evaluate a fresh
    wall clock: the controller must recheck ``deadline`` immediately before I/O.
    """
    _validate_plan(plan)
    _need(slot_id in plan["operations"] and isinstance(receipts, dict), "operation_unknown")
    cache: dict[str, dict] = {}
    visiting: set[str] = set()

    def get_receipt(slot):
        _need(slot in receipts and isinstance(receipts[slot], dict), "receipt_missing")
        r = receipts[slot]
        _need(r.get("operation_id") == slot and r.get("state") == "succeeded"
              and r.get("terminal") is True and r.get("write_terminal") is True and r.get("readback_verified") is True
              and r.get("created_by_run") is True, "receipt_not_final")
        _need(isinstance(r.get("properties"), dict), "receipt_properties")
        if slot in plan["prerequisites"]:
            expected = plan["prerequisites"][slot]
            _need(r.get("request_digest") == expected["request_digest"]
                  and r.get("object_id") == expected["object_id"], "prerequisite_binding")
            if slot in ("webIdentity", "workerIdentity", "guard"):
                _guid(r["properties"].get("principalId"))
                _need(_guid(r["properties"].get("tenantId")) == expected["tenant_id"], "principal_tenant")
        else:
            op = concrete(slot)
            _need(r.get("request_digest") == digest(op), "receipt_request_digest")
            if op["provider"] == "Microsoft.Authorization":
                _need(r.get("object_id") == op["expected"]["resource_id"], "receipt_object")
            else:
                property_key = {"E1": "applicationObjectId", "E2": "servicePrincipalObjectId",
                                "E3": "directoryAssignmentId", "E4": "keyId"}[slot]
                if slot == "E3":
                    opaque = r.get("object_id")
                    _need(isinstance(opaque, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", opaque)
                          and opaque == r["properties"].get(property_key), "graph_object")
                else:
                    _need(_guid(r.get("object_id")) == _guid(r["properties"].get(property_key)), "graph_object")
        return r

    def resolve(value):
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "$receipt" in value:
            _need(set(value) == {"$receipt"} and len(value["$receipt"]) == 2, "reference_shape")
            slot, key = value["$receipt"]
            return _guid(_at(get_receipt(slot), "properties." + key))
        if "$callback" in value:
            _need(value == {"$callback": "app"}, "callback_reference")
            return _callback_origin(plan, _at(get_receipt("app"), "properties.defaultDomain")) + "/.auth/login/aad/callback"
        if "$graph_url" in value:
            slot, key, collection, action = value["$graph_url"]
            _need((slot, key, collection, action) in (("E1", "applicationObjectId", "applications", "addPassword"),
                                                     ("E2", "servicePrincipalObjectId", "servicePrincipals", "appRoleAssignedTo")), "graph_url")
            return GRAPH + "/" + collection + "/" + _guid(_at(get_receipt(slot), "properties." + key)) + "/" + action
        _need(not any(k.startswith("$") for k in value), "unknown_reference")
        return {k: resolve(v) for k, v in value.items()}

    def concrete(slot):
        if slot in cache:
            return cache[slot]
        _need(slot in plan["operations"] and slot not in visiting, "dependency_cycle")
        visiting.add(slot)
        template = plan["operations"][slot]
        for dependency in template["depends_on"]:
            get_receipt(dependency)
        op = resolve(copy.deepcopy(template))
        op["expected"]["body_sha256"] = digest(op["body"])
        _need(set(op) == OP_KEYS and isinstance(op["url"], str), "operation_unresolved")
        visiting.remove(slot)
        cache[slot] = op
        return op

    return copy.deepcopy(concrete(slot_id))


def _callback_origin(plan, domain):
    """Use the same bound App/region FQDN rule as the resource builder.

    Only the fixed App's immediate ``internal`` label can be removed:
    https://learn.microsoft.com/en-us/azure/container-apps/connect-apps#external-and-internal-fqdns
    """
    from .resources import public_trial_origin
    from scripts.trial_guard.lifecycle import Denied
    try:
        return public_trial_origin(plan["callback_binding"], domain)
    except (Denied, KeyError, TypeError, ValueError):
        raise PlanError("callback_binding") from None


def build_arm_cleanup(create_op: dict, created_receipt: dict, deadline: str) -> dict:
    """Build an exact IAM DELETE from a verified creation, never a free target.

    Current-object and zero-reference evidence remain mandatory controller /
    provider gates. The deadline is the unchanged removal due time, not a
    reason to stop exact-owned cleanup after that time has elapsed.
    """
    _need(isinstance(create_op, dict) and set(create_op) == OP_KEYS, "cleanup_operation")
    _need(create_op["provider"] == "Microsoft.Authorization" and create_op["method"] == "PUT"
          and create_op["kind"] in ("roleDefinitions", "roleAssignments"), "cleanup_kind")
    expected = create_op["expected"]
    _need(isinstance(expected, dict) and expected.get("created_by_run") is True
          and expected.get("before_absent") is True
          and expected.get("api_version") == API
          and expected.get("body_sha256") == digest(create_op["body"]), "cleanup_expected")
    resource_id = expected.get("resource_id")
    _need(isinstance(resource_id, str) and re.fullmatch(
        r"/subscriptions/[a-fA-F0-9-]{36}/.+/providers/Microsoft.Authorization/" + create_op["kind"] + r"/[a-fA-F0-9-]{36}", resource_id)
        or (isinstance(resource_id, str) and re.fullmatch(
        r"/subscriptions/[a-fA-F0-9-]{36}/providers/Microsoft.Authorization/" + create_op["kind"] + r"/[a-fA-F0-9-]{36}", resource_id)), "cleanup_target")
    _need(create_op["url"] == ARM + resource_id + "?api-version=" + API, "cleanup_url")
    r = created_receipt
    _need(isinstance(r, dict) and r.get("operation_id") == create_op["id"]
          and r.get("request_digest") == digest(create_op) and r.get("object_id") == resource_id
          and r.get("state") == "succeeded" and all(r.get(k) is True for k in
          ("terminal", "write_terminal", "readback_verified", "created_by_run")), "cleanup_receipt")
    _need(_utc(deadline) == _utc(create_op["cleanup"].get("deadline", create_op["deadline"])), "cleanup_deadline")
    op = copy.deepcopy(create_op)
    op.update(id="cleanup_" + create_op["id"], method="DELETE", body=None,
              deadline=_stamp(deadline), depends_on=[create_op["id"]])
    op["expected"]["body_sha256"] = digest(None)
    return op
