# Usage ledger and quotas

Phase 7.7 adds durable reservations, trusted settlement and `/usage`. Apply migrations before starting the API/dispatcher. No worker telemetry is fabricated; records distinguish reserved budgets from actual usage reported by a trusted supervisor.

## Reservation and limits

Webhook acceptance and manual rerun acceptance reserve capacity inside the run/outbox transaction. A tenant row lock serializes admissions across repositories and API instances. A quota refusal rolls back the new run, receipt/audit/outbox records and any attempted supersession. An exact webhook retry can return its existing run even at capacity. The dispatcher also reserves older received runs before handing them to Redis; quota-blocked legacy handoffs defer for 30 seconds without consuming a transport retry attempt.

Default limits are two unsettled reservations, 100 accepted runs per UTC day and 10,000 model cost cents per UTC acceptance day. These are local product defaults, not provider pricing or billing estimates. Operators can set a `TenantQuota` row with validated database bounds. There is no public limit-increase endpoint. Administrative updates must lock the tenant row in the same transaction to coordinate with admission. Lowering limits never cancels or silently releases existing reservations.

The daily run count includes failed/cancelled settled runs: actual attempted work is not erased. Daily model-cost commitments use reserved maximum cost for unsettled runs and reported actual cost for settled runs. Reservations retain their original UTC acceptance-day cohort after settlement, including late usage. This is admission accounting, not wall-clock daily provider spend. Concurrency counts unsettled reservations across all dates, so midnight cannot free active/unknown work. Redis's existing worker concurrency ceiling remains separate.

Full per-run budgets are retained, including duration, API requests, browser steps, model calls/tokens/cost. Executors must still enforce those limits. Tenant daily API/token/storage quotas are not added; artifact bytes and runtime counters are reported measurements rather than storage occupancy or retention policy.

## Settlement is a trusted operation

`settleRunUsage(database, tenantId, runId, actual)` is an internal supervisor operation, never an HTTP endpoint. Actual usage must explicitly supply run seconds, browser seconds, API requests, browser steps, model calls, tokens, model cost cents and artifact bytes. Partial, negative, non-integer or unknown fields are refused.

The supervisor must verify that execution has stopped and that the measurements are complete before calling it. The database additionally requires a terminal run state and matching tenant reservation. Terminal state alone is not proof that a cancelled process stopped. No zero-usage inference is made from failed, cancelled, superseded or completed status. Unknown outcomes retain capacity until reconciled. A run known never to have executed can be explicitly settled with measured zero counters by the trusted supervisor.

Settlement locks the tenant and records actual usage while releasing the reservation hold. Identical retries are no-ops; conflicting measurements are rejected. Reported overruns are retained, even above the reservation, and block subsequent admissions when limits are exceeded. No automatic refund, deletion or downward clamping occurs. Correction workflows, a production settlement consumer and abandoned-run recovery remain pending.

## User view and HTTP behavior

`GET /auth/tenants/:tenantId/usage` validates the login session and fresh membership, holds authorization locks through a tenant-consistent read and returns limits, UTC-day totals and up to 50 latest reservations. It is no-store and exposes no private snapshots, credentials or artifact paths. Owners and members can read; unavailable/foreign scope is concealed.

The `/usage` page is linked from Runs. Pending measurements remain explicitly unknown. Recent settled counters are shown as reported usage, not an invoice. The server computes the UTC day; client timezone does not change quota boundaries. Quota refusals return HTTP 429 with fixed codes `quota_concurrent`, `quota_daily_runs` or `quota_daily_model_cost`. Manual rerun UI explains those outcomes. No Retry-After is invented for capacity that requires settlement.

Historical runs already queued/running before migration are not automatically backfilled or relabeled as measured zero. Operators must reconcile those runs before relying on the ledger as a complete capacity account. Existing received outbox work is gated at dispatch. Direct privileged DB/queue writes remain outside the public acceptance boundary; RLS and production-consumer enforcement remain separate work.

## Verification

`npm run db:verify:usage` uses local Compose with random self-cleaning fixtures. It checks concurrent cross-repository quota races, duplicate acceptance at capacity, transaction rollback, active/foreign settlement refusal, identical/conflicting settlement, overrun retention, original UTC cohorts, pending holds, legacy dispatcher gates and membership-scoped reads. Existing acceptance and manual-rerun verification also pass. HTTP/schema tests and mocked Chromium checks cover authorized usage display and unknown measurements. No live model, customer preview, billing provider, actual QA run or hosted deployment was used.
