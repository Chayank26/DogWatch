# Reporting finding contract v2

Phase 6.1 adds `findingRecordSchema`, `findingArtifactSchema`, `findingScopeSchema`, the `FindingRecord` type and `validateFindingForContext`. Imports are available from `@dogwatch/contracts`. The original unversioned `findingSchema`/`Finding` remain unchanged for scaffold compatibility. There is no implicit conversion: legacy records lack enough scope/evidence metadata to safely upgrade automatically.

Every v2 record has `version: 2`, tenant/run/repository/PR/head SHA, a stable caller-supplied finding ID, tier, head deployment context, creation time, a typed target, expected/actual behavior, reproduction steps, private artifact references and baseline status. API targets identify exact method and path template; browser targets identify a journey; static targets identify a repository-relative source path and optional line. No deduplication key or merge policy is introduced yet.

Categories have different requirements:

- `confirmed_failure` requires confirmed confidence, non-informational severity, reproduction steps, evidence and a compatible basis reference. A validated observation requires a tier-compatible static/API/browser artifact. A reproduced basis requires a replay artifact.
- `possible_regression` requires probable/unconfirmed confidence, reproduction steps and evidence. It cannot claim established baseline attribution.
- `advisory` permits low/informational severity and probable/unconfirmed confidence, with evidence. This is not a universal UX score.
- `coverage_gap` is informational/unconfirmed with a fixed reason; evidence and reproduction steps may be empty. Missing work cannot become an application failure or pass.

Artifacts are references with UUID, tenant/run/repository/SHA/role, kind, content digest, byte length and expiry. Head evidence must match the finding's tenant/run/repository/head SHA and head role. Artifact IDs must be unique. A `new_regression` or `pre_existing` baseline claim is allowed only for a confirmed failure and requires a separate base SHA/run, matching base evidence and a head-scoped comparison artifact. All referenced evidence must outlive record creation.

`validateFindingForContext(record, trustedScope, now)` additionally enforces exact current scope, rejects future creation times and rejects evidence expired at the supplied time. It returns a detached parsed record. Callers must still check current run authority and load artifacts through an authorized storage adapter. Parsing does not prove that an artifact exists, its hash is correct, its content supports the assertion, or that base/head environments are comparable. A screenshot alone cannot establish the confirmation basis. Do not promote a replay record to a finding by inventing artifact IDs; persist and verify appropriate evidence first.

Optional metrics record attempted/completed/failed actions and elapsed milliseconds. Completed plus failed actions cannot exceed attempted actions; uncompleted work may remain. Metrics do not imply journey success, causality or a UX rating.

The required `contentPolicy: reviewed_redacted` is a trusted producer attestation, not a secret scanner. Text remains untrusted, and strict shape validation cannot remove credentials embedded in prose. Raw payload attachments, public URLs and unknown top-level fields are not accepted. Producers must review/redact narrative text; future renderers must escape it, and artifact access must remain private and scoped.

This phase defines and tests the contract only. It does not emit findings from worker results, create durable artifacts, persist records, publish comments, migrate the database or change normal dispatch. Deduplication, private artifact integration, Markdown/report publication and stale-result reconciliation follow in later phases. Tests use synthetic references to verify structure; they do not claim those test artifacts exist in storage.
