# Local release rehearsal — Phase 8.6

The selected target is a **local production-build rehearsal**. This is not a cloud
deployment or proof of the complete opted-in PR-to-report pipeline. The API,
dashboard and dispatcher run as separate Node processes. There is no production
QA worker service to enable yet.

## Rehearse

Install locked dependencies with `npm ci`, use Node 24, and have Docker running.
Stop other builds/dev servers in this checkout before running:

```sh
npm run release:verify
```

The command accepts no target overrides and does not use an existing application's
database/Redis. It creates a random `dogwatch-release-*` Compose project with
PostgreSQL 17 and Redis 7 on random loopback ports. The generated database password
is not written to the report. Redis is disposable, loopback-only and unauthenticated;
this is not production Redis configuration. Resource limits are applied to the
fixture containers, not the host Node processes.

It checks:

1. Production workspace build, with an explicit API proxy origin baked into Next.
2. Fresh database migrations, idempotent reapplication and migration status.
3. Separate API/dashboard startup; dashboard `/auth/me` reaches the actual API
   and returns 401 without a session; unconfigured webhook returns 503.
4. A seeded synthetic run/outbox is handed off by the compiled dispatcher to its
   own Redis queue, with committed publication and queued state.
5. Dispatcher restart retains one job and one dispatch attempt. API restart keeps
   the dashboard proxy working. No worker consumes or completes the queued run.
6. Graceful process shutdown, client closure, and removal of the generated
   containers/network/volumes. The prior dashboard build and generated declaration
   are restored, preventing a temporary proxy address from altering normal startup.

A lock under `.local/releases/rehearsal.lock` refuses concurrent rehearsals.
Dashboard environment files are refused to avoid accidentally loading real
credentials into the rehearsal. Service environments are explicit; OAuth values
are synthetic, and no OAuth/GitHub request is made. HTTP/metrics listen only on
loopback. Runtime logs are bounded in memory and not included in public evidence.
A forced shutdown or cleanup failure leaves a failed report and nonzero exit.
Next's conventional 143 exit after a requested SIGTERM is accepted as normal.

SIGINT/SIGTERM requests cleanup; an uncatchable kill or host failure can leave a
lock, backup build directory or generated resources. Inspect processes and the
exact random Compose project before manual cleanup. Never use the ordinary
`dogwatch` project name or delete unrelated volumes. Restore any saved
`*-previous-next` directory before removing a stale lock. The script uses temporary
build outputs in this checkout; do not build/develop concurrently outside its lock.

## Evidence

`.local/releases/rehearsal.json` records completed checks, cleanup status, Node
version, current commit/dirty state, tested entrypoint/lockfile/build-ID hashes and
rehearsal-source hashes. It does not include connection strings, tokens or raw
subprocess logs. [results.json](results.json) is the reviewed implementation-run
snapshot; it is not overwritten automatically by future rehearsals.

These fingerprints identify selected tested build inputs/entrypoints; they are
not a complete immutable distribution archive, signed image or reproducible-build
attestation. The rehearsal dashboard build is removed on cleanup and its previous
build restored. API/dispatcher/package dist outputs are rebuilt in place. A real
release must package the full dependency/artifact graph in an immutable, reviewed
deployment artifact and supply a stable build-time proxy origin.

## Deployment preparation and promotion checklist

| Service      | Configuration boundary                                                                                    | Remaining production work                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Dashboard    | `DOGWATCH_API_ORIGIN` at build time; `next start` binds loopback                                          | Stable private API origin, process supervisor, TLS/reverse proxy and resource policy                                     |
| API          | `API_PORT`, optional metrics; GitHub authorization/OAuth configuration and DB URL only in its environment | Managed secrets, live GitHub registration, approved public routes and auth-origin/TLS validation                         |
| Dispatcher   | DB URL, Redis URL, optional loopback metrics                                                              | Private authenticated/TLS data services, process supervision, availability and backlog monitoring                        |
| QA execution | Disabled; dispatcher is not a QA consumer                                                                 | Production orchestration, hostile-preview egress/isolation, scoped credentials, cancellation and usage/report settlement |
| Evidence     | Local private storage primitives only                                                                     | Hosted object storage, authorization, retention, encryption and restore verification                                     |

For an eventual deployment:

1. Select the provider/account/region/domain and review the unresolved security
   gates in [security validation](../../docs/security/VALIDATION.md). Define secrets,
   backup ownership, retention, quotas, availability and spend limits.
2. Build immutable reviewed artifacts from locked dependencies. Configure the
   stable `DOGWATCH_API_ORIGIN` **before** the dashboard build; changing only its
   runtime environment does not change the compiled rewrite.
3. Record the current app/schema versions and take verified coordinated backups.
   Test migrations against a staging restore. Apply additive migrations once via
   a dedicated migration task, not on every API/dispatcher start.
4. Start database-dependent services after migrations and validate dependency
   connectivity, auth boundaries and actual outbox progress. `/health` alone is
   process liveness, not database readiness. Restrict process listeners behind a
   reviewed proxy; do not expose metrics publicly.
5. Verify TLS, exact external `AUTH_ORIGIN`, secure session cookies, webhook
   signatures, OAuth callback, tenant access, alert delivery and operator recovery
   before any real repository opts in. No live wiring is established here.
6. Enable the missing QA/orchestration/artifact stages only after their security
   and end-to-end gates pass. The current release cannot claim a complete PR run.

## Rollback procedure (documented, not exercised against an older release)

Stop new ingress/dispatch if safe operation is uncertain; preserve evidence and
queued identities. Roll back application artifacts only when the prior version
is compatible with the current schema and persisted state. Never reverse
migrations by blindly dropping columns/tables or resetting outbox attempts.
For incompatible data changes, restore into a separate environment and reconcile
DB, Redis, artifacts, reporting journals and usage before switching traffic.
Follow the [recovery runbook](../recovery/README.md). The rehearsal tests restart
of the same build, not rollback to a previous version or production failover.
