# Queue and outbox dispatch — Phase 2.4

BullMQ uses Redis to hold durable run references. The current runner dispatches work only: it does not consume real QA jobs, open browsers, or call a model. The reusable worker harness is exercised by synthetic tests and is reserved for later isolated execution.

## Start dispatch

With infrastructure running and migrations applied, export DATABASE_URL and REDIS_URL in the runner's shell, then run:

```sh
npm run dev -w @dogwatch/worker
```

The runner does not load `.env` automatically. Neither URL set means the dispatcher is disabled; supplying only one fails startup. Stop with Ctrl+C; it finishes the current bounded iteration before closing connections. API acceptance remains independent of Redis and returns queued:false; a dispatcher later moves received runs to queued. Unconfigured `npm run dev` still starts the product shells with dispatch disabled.

## Reliable handoff

The dispatcher locks one due outbox row and its received run using PostgreSQL `FOR UPDATE ... SKIP LOCKED`. Concurrent dispatchers select different unlocked work. Redis receives only `{ runId, tenantId }`; the job ID is the run UUID. On successful add, Postgres atomically records publication and queued progress. Locks are held across the bounded network handoff, a deliberate simple initial approach; leased claims would reduce lock duration if throughput requires that later.

A crash after Redis add but before database commit leaves the instruction pending. Redis retains the stable ID, so retry reconciles/adds that same job rather than producing another. A timeout may have occurred after Redis accepted the write; the next retry uses the same reconciliation. Payload conflicts against an existing job identity are terminal. Jobs are retained after success/failure to preserve identity; a retention and lost-Redis reconciliation policy is required before production. No Redis flush, queue auto-removal, or automatic replay of previously published history is implemented.

Dispatcher failures have up to five total attempts with scheduled delays of 1, 2, 4, and 8 seconds before the final attempt. Restart preserves attempts and next due time. A permanent identity conflict fails immediately. Exhaustion records a fixed error code, failed timestamp, and failed run progress. Published or terminal instructions are not selected again. Manual recovery/reset is not exposed yet. Invalid kinds/terminal run states are excluded from normal dispatch rather than executed.

## Processor retry and concurrency primitives

Queue jobs receive three total attempts with exponential 1-second seed backoff. The injected worker callback throws ordinary errors for transient failures; malformed jobs/names throw BullMQ UnrecoverableError. Stalled processing has one allowed recovery before failure. Redis global concurrency is set to two during enqueue, and each worker has a validated local ceiling (default two).

These primitives do not authorize a job, isolate repository execution, or guarantee exactly-once side effects. The future processor must resolve authoritative Postgres state/ownership, use stage checkpoints/leases, enforce budgets, and update run progress. Per-tenant execution limits and fair scheduling remain future policy work; production QA workers are deliberately not started in this phase. Synthetic processor completion does not mark a product run completed.

Producer Redis requests have a two-second command/connect timeout and one request retry. Worker Redis connections use unlimited reconnect-compatible request retries as required for blocking consumption. TLS URLs are supported. Connection failures are logged as fixed diagnostics, never raw credential-bearing errors. A network partition or Redis data loss still requires explicit reconciliation; healthy Redis persistence is an operating assumption, not proof of recovery from all outages.

## Verification

`npm run queue:verify` tests real Postgres and Redis using one random queue and tenant. It checks duplicate handoff after the enqueue/commit crash window, two concurrent dispatchers, persistent attempt exhaustion, permanent conflicts, processor retries and exhaustion, bounded concurrency, and malformed jobs. Cleanup removes only that queue and exact random fixture rows. Interrupted verification may leave fixture data; it never drains production jobs or resets Redis. CI runs this command in its data-services job.

## Files and configuration

`src/index.ts` explains payload validation, Redis connection policy, enqueue reconciliation, and the worker factory. `packages/database/src/dispatch.ts` owns transactional selection/state; `apps/worker/src/index.ts` owns the polling lifecycle. All authored source and migration/config formats carry comments.

The private ESM queue workspace's package.json exposes compiled JavaScript/types; build/typecheck use strict root settings and emit declarations from src to ignored dist. It depends on BullMQ, its Redis driver ioredis, and Zod. Runner lifecycle hooks build database/queue output before dev, build, typecheck, or integration verification; JSON settings are documented here because JSON cannot contain comments.

Implementation follows BullMQ's official [connection guidance](https://docs.bullmq.io/guide/connections), [retry behavior](https://docs.bullmq.io/guide/retrying-failing-jobs), and [job identity rules](https://docs.bullmq.io/guide/jobs/job-ids).

Database transaction timeouts and database outages roll back dispatch bookkeeping. The dispatcher retries those operational failures on its next loop; only handoff failures successfully recorded in Postgres count toward the five-attempt limit.
