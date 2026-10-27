# Configuration and manual reruns

Phase 7.6 adds owner-only manual rerun controls to `/runs` details, backed by versioned repository settings and audit metadata. Apply the additive migration with `npm run db:migrate` before running the API. The existing login/onboarding configuration enables settings routes; reruns additionally require the complete existing GitHub authorization configuration so the API can resolve the current installation/repository/PR. Missing remote configuration returns unavailable without creating work.

## Scope

Settings consist of an enabled flag and the existing bounded budget fields: seconds, API requests, browser steps, model calls, tokens and cost cents. They default to disabled. These settings apply only to explicit manual owner requests; file-backed webhook policies are unchanged. Preview resolution, contracts, synthetic credentials, action grants, webhook labels/commands and repository registration are not edited here. Cancellation and bulk reruns are not added.

The UI shows controls only for owners, but the database independently enforces owner membership. Unsaved edits disable the rerun button. A successful request is described as accepted, not executed or passed. Normal QA consumption remains pending; the existing dispatcher can hand off the durable outbox record, and readiness/execution must apply their existing independent gates.

## API and transactions

Under `/auth/tenants/:tenantId/runs/:runId`:

- `GET /configuration` returns repository manual settings and revision.
- `POST /configuration` accepts strict `{ expectedRevision, enabled, budget }` JSON up to 4 KiB.
- `POST /rerun` accepts only `{ requestId }`, a UUID, up to 1 KiB.

All writes require exact configured Origin and a valid HttpOnly session. They reject caller-supplied head SHAs, roles or policy snapshots. Responses are no-store. The database locks current session/user/owner-membership rows and the owned repository. Cross-tenant source runs and revoked authority are refused. A settings update compares the expected revision, increments it and writes an audit event in the same transaction. Stale edits return conflict rather than overwriting another owner's update.

Reruns first read scoped configuration, then resolve current GitHub installation access and an open same-repository PR. Forks and identity mismatches fail closed. The commit rechecks local owner authority, repository identity, enabled status and configuration revision. Another active run for that repository/PR prevents new work. A new request atomically creates a received Run, immutable policy/budget snapshot, OutboxEvent and RunControlEvent. The source run and its evidence remain unchanged; preview readiness is not copied. The current head SHA is used, not the historical source SHA.

The globally unique request UUID is the idempotency key. Retries by the same actor for the same source run return the original run ID after current eligibility checks; conflicting reuse is refused. The browser retains the key for the current detail component, including network-error retries, but not across reloads. Another explicit request needs a fresh detail session and must wait until active work finishes. No claim of exactly-once execution is made.

Audit records retain actor numeric ID, tenant/repository, event kind, settings revision and source/result run IDs with timestamps. They do not contain secrets or full prior settings values. The control tables have repository/tenant foreign keys. Audit run IDs are historical references, not download authorization. Audit viewing/retention and quotas are later work.

## Trust and remaining limits

The persistence adapter is internal trusted code; only the service's GitHub-verified context should reach its commit method. GitHub head/access can change between lookup and commit, so worker stages and publication must revalidate current context. Owner authorization is independent of the old webhook actor allowlist: an explicit manual request is its own consent, with that owner's numeric identity captured in the new policy snapshot. No permission widening, App token persistence or customer endpoint call is performed by these controls.

Rate limits, global quotas, full configuration UI, automatic workers, cancellation and hosted execution remain pending. A settings revision controls acceptance only; disabling manual requests does not cancel accepted runs or alter webhook policy.

## Verification

Synthetic service tests cover current-head resolution and closed/suspended/forked/mismatched PR refusal. HTTP tests cover cookie/Origin/schema enforcement and accepted-not-executed responses. `npm run db:verify:run-controls` checks local PostgreSQL revision races, duplicate requests, one outbox/audit result, snapshot freshness, active-run refusal and local revocation, then removes its random fixtures. Chromium checks the production-built owner form using mocked API responses. Live GitHub requests and actual QA execution were not exercised.
