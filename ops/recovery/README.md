# Recovery drills and operator runbooks (Phase 8.3)

## Repeat the local drill

From the repository root, with Docker available:

```sh
docker compose up -d --wait postgres redis
npm run recovery:verify
```

The command accepts no target overrides. It uses Compose PostgreSQL on loopback
5433 and Redis on 6380, creates two random `dogwatch_recovery_*` databases, migrates
only the source database, and creates a random `dogwatch-recovery-*` queue. It
never dispatches the application queue, restores over `dogwatch`, resets shared
Redis, or stops shared services. It removes its databases, queue and temporary
0600 backup in a private directory after execution. If interrupted externally,
inspect leftover generated names before removing only those fixture resources.
Do not run this command against production infrastructure.

The JSON result reports checks and observed local restore/total milliseconds.
These are measurements for a tiny synthetic fixture, not a production RTO or SLA.
The command exits nonzero on a failed assertion or failed cleanup.

| Scenario                    | Injection                                                                             | Required outcome                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Dispatcher termination      | Child process exits immediately after Redis acknowledgement, before PostgreSQL commit | Run remains received; outbox attempts/publication and quota reservation roll back; stable Redis job remains |
| PostgreSQL restore          | Custom-format dump restored transactionally into an empty database                    | Tenant/install/repository, run, outbox and reservation/quota snapshots match                                |
| Restart/reconciliation      | Two dispatchers race on restored pending work with an existing Redis identity         | One publication, one idle result, one retained job per run, one reservation per run                         |
| Transient transport outage  | Enqueue callback rejects once                                                         | Durable retry then publication; reservation not duplicated                                                  |
| Persistent transport outage | Enqueue rejects through its attempt budget                                            | Explicit failed run; no automatic replay; unknown usage remains reserved                                    |
| Published Redis job loss    | Remove one waiting job in the isolated queue                                          | Dispatcher stays idle for published/queued work; no silent replay or fabricated completion                  |

Transport failures are injected at the enqueue boundary; the shared Redis service
is not interrupted. Process termination covers the dispatcher, not an active QA
worker or browser. Existing `npm run queue:verify` covers processor retries and
exhaustion. `npm test` additionally covers provider request/stage timeouts, GitHub
reporting lost-response reconciliation, artifact corruption and writer-lock refusal.
Those are local fixture/unit checks, not live provider outage certification.

## Triage and recover

1. Record incident time, service/instance, tenant/run and observed alert. Inspect
   sanitized logs and metrics. `/health` proves process availability only.
2. Pause affected dispatch/execution before cross-store recovery. Preserve the
   original DB, Redis persistence, artifact files and reporting journals. Never
   flush Redis, bulk-reset run states or delete retained job identities to retry.
3. Use `inspect.sql` through an operator read-only connection with explicit
   `tenant_id` and `run_id` variables. It selects operational state only and joins
   on tenant plus run. Inspect the matching queue job's ID, tenant/run references,
   state and attempt count through trusted operator tooling.
4. Apply the decision table below. Recheck current authority, installation,
   repository, SHA and cancellation/supersession before any new work.
5. Resume only the affected service after verifying the dependency, DB state,
   retained queue identity and telemetry. Record evidence and unresolved gaps.

| Durable/queue state                                | Operator action                                                                                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Received, unpublished, due; job absent or matching | Restore the dependency and resume normal dispatcher retries. Stable identity handles an acknowledged job whose DB transaction rolled back. Quota deferrals require capacity, not retry-count resets.                                      |
| Received, unpublished; wrong-tenant/job identity   | Isolate and investigate. Identity conflict is terminal; do not overwrite or reuse the conflicting job.                                                                                                                                    |
| Failed run or exhausted outbox                     | Diagnose first. Do not clear failedAt, lower attempts or call queue.retry blindly. An owner-authorized fresh rerun can create a new run only after current-PR/configuration/quota checks and reconciliation of prior side effects.        |
| Queued/published; missing job                      | Stop affected execution and preserve evidence. This phase detects the gap but implements no automatic requeue. Redis loss cannot establish whether execution already occurred; require a reviewed recovery plan and idempotency evidence. |
| Completed/failed Redis job with nonterminal DB run | Do not infer durable completion or zero usage. Reconcile execution evidence and reporting/usage state; production orchestration is still disabled.                                                                                        |
| Cancelled/superseded run                           | Keep stopped. Never resurrect it by changing DB state or resetting a queue job.                                                                                                                                                           |
| Reservation without measured settlement            | Keep it reserved until trusted complete measurements can use the existing settlement contract. A failure is not proof of zero cost.                                                                                                       |
| Missing/corrupt artifacts or report journal        | Preserve originals; restore a matching trusted backup and verify integrity, scope and permissions. Do not remove writer locks blindly, manufacture findings or publish a report with unverified evidence.                                 |

## Backup and restore procedure

For a production deployment, an operator must first define a backup schedule,
retention, encryption/access control, restore destination, measured RPO/RTO and
responsible on-call owner. None is provisioned by this local phase.

Take a custom-format PostgreSQL backup using a supported client, retaining the
schema/migration version and backup timestamp. PostgreSQL `pg_dump` snapshots one
database; it does not include cluster roles or external Redis/artifact data.
Restore into a new isolated database with `pg_restore --exit-on-error
--single-transaction --no-owner --no-acl`; inspect errors and compare scoped
records before switching any service. The drill demonstrates this path with
synthetic data. See the official [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) references.

A PostgreSQL restore alone is not a DogWatch system restore. Capture coordinated
Redis persistence, private artifacts, report journals and protected configuration
while writers are paused, or document the cross-store reconciliation window.
Retained Redis IDs may refer to runs newer than the DB backup. Restored reservations
may predate costs or terminal updates. Compare tenant/run/SHA and side-effect
history before resuming; an older backup is not authority to repeat execution.

Do not use the drill's fixture cleanup commands as an operational repair tool.
Full-cluster loss, Redis AOF restore, point-in-time recovery, real provider outages,
active QA worker interruption and production failover remain deployment exercises.
