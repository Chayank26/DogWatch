# Run and evidence views

Phase 7.5 adds `/runs` to the existing Next.js UI. With the same login and `/auth/*` proxy configuration as onboarding, members select a workspace, browse recent runs, load older pages and inspect run details. Loading, empty, signed-out, unavailable and inaccessible states are explicit. Switching workspaces clears old results/details; request generation checks prevent slower previous selections from replacing current content. Use refresh for current state; there is no background polling.

## Authorized reads

- `GET /auth/tenants/:tenantId/runs?after=<run UUID>` returns up to 50 rows and a nullable `nextCursor`.
- `GET /auth/tenants/:tenantId/runs/:runId` returns one scoped detail with an evidence-availability declaration.

Both use the HttpOnly login session. Owners and members can read; unknown/inaccessible tenants, runs and cursors return 404. Missing cookies return 401; an invalid or revoked session with a cookie is concealed as unavailable. Unexpected query fields and malformed identifiers are refused. All auth responses remain no-store. There are no mutation or download endpoints in this phase.

The database adapter validates scope and holds shared locks on the current session/user/membership rows through the read transaction. Every run query includes the tenant ID. Role removal, disablement and logout serialize with reads; already returned browser content cannot be recalled. The service database role remains privileged and no RLS policy is claimed.

Pagination sorts by descending creation time and UUID, using a tenant-scoped cursor lookup. Equal timestamps are stable and cannot skip or repeat rows in an unchanged dataset. Newly inserted runs appear on refresh; a removed or foreign cursor is rejected rather than used outside the tenant. Queries fetch at most 51 rows to detect another page.

## Data and evidence limits

Responses select only run ID, repository display name, PR number, immutable head SHA, lifecycle state, creation time and whether preview readiness was recorded. They omit policy/budget/preview snapshots, failure payloads, delivery identities, installation credentials and private artifact paths. Display strings render as React text, not HTML. Completed means the stored lifecycle state, not a successful QA verdict; recorded preview readiness is not live availability.

There is no durable finding/artifact catalog attached to Run yet. The detail therefore returns `evidence.status: not_cataloged` and explains that missing evidence does not mean zero findings. The evidence panel is an availability view, not a finding renderer or authenticated artifact download. It does not scan private directories, infer artifact scope from user input or expose private renderer output. Persisted finding summaries, independently authorized head/base references, expiry/integrity checks and reviewed content delivery are prerequisites for actual evidence browsing.

## Verification

`npm test` includes HTTP authorization/route tests. `npm run db:verify:run-views` uses local Compose and removes random fixtures after checking member access, 51-run pagination with identical timestamps, foreign tenant/run/cursor rejection, field omission and revocation. Chromium checks the production build with synthetic API responses for list/detail/evidence, empty and denied states, clearing old details on workspace switches and mobile overflow. Live OAuth, production proxy/TLS, real finding ingestion and artifact downloads remain unverified. No migration or dependency was added.
