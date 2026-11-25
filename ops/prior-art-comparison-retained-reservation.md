# OWNER-limited comparison with an unchanged held reservation

The successor limited-release contract preserves a known failed operation and an independently isolated, outcome-unknown operation. It does not resume either operation, release their reservations, classify an unknown request as a failure, or permit arbitrary additional comparisons.

`PRIOR_ART_COMPARISON_CASE104_RELEASE` retains the existing strict V1 contract. V2 uses `CASE104_LIMITED_RELEASE_V2`, a subsequent signed activation authority, and `retainedUnknown: { evidence, isolationEvidenceSHA256 }`. An authorized release producer must verify the signed management chain, authenticated readback and removal of temporary permissions, matching OWNER/source/image, actual held-row evidence, and independent isolation evidence before configuring the value. The application does not turn an unverified draft into a signed authority.

The evidence has schema `CASE104_HELD_UNKNOWN_RESERVATION_EVIDENCE_V1`, case/operation/selection digests and exactly two row fingerprints. Each row is bound to its result ID, document/claim keys and the complete original serialized comparison field. Marker/audit digests are additional checks. Every unknown row remains `reserved` without an invented terminal failure. Missing, duplicated, moved, changed or reclassified rows fail closed. Other unrecognized operations retain the existing rejection behavior.

A new designated development operation may reserve once under the existing transaction and per-operation capability. Server-owned send/cost limits remain in force. Its normal saved result is required before the separate practitioner operation can be admitted. The practitioner phase pins the new development snapshot and keeps both predecessor reservations unchanged. Neither repeated POST nor application restart rearms a consumed reservation.

## Read-only fingerprint preparation

On the existing OWNER-authenticated analyze GET, the sole query `preservedOperationId=<designated held operation>` returns fingerprints only. For a historical V1 configuration, the designated operation is its development operation; for V2, it is the retained-unknown operation. The fixed case and complete original selection must match. Configuration expiry is ignored only for this non-dispatch read path, and does not enable comparison admission or spend authorization. It therefore works while comparison intake is OFF using the existing, structurally valid historical release value.

Two independent SELECT observations must agree. The response is `{ evidence, historicalReadOnly: true, aiSends: 0, rowWrites: 0 }`; it contains no comparison text, source documents, serialized raw rows, credentials or authenticated URLs. The consumer must separately retain the authenticated response and bind its actual digest to the reviewed management evidence. Fingerprints alone do not prove process termination, isolation, settled provider charges or permission cleanup.

The feature ships with the normal reviewed product image. It needs no new service, extra image solely for fingerprint collection, migration, new database permission or custom server. Deployment, shared-replica settings, infrastructure budget and actual execution remain separate release operations. Previously signed packages and saved records must not be edited to fit a new release.

## Validation

Tests use fictional selections and in-memory database seams. They cover unchanged predecessors, one-shot successor reservation, strict authority/isolation requirements, missing/extra/changed unknown rows, historical OWNER fingerprints with intake OFF, expiry separation, concurrent snapshot changes, and practitioner snapshot binding. No test dispatches a provider request or accesses a production database.
