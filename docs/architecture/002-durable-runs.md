# ADR 002 — Persist accepted work before dispatching it

**Status:** Accepted design; local schema/migration and authorized run/receipt/outbox persistence implemented through Phase 2.3; dispatch remains planned.

**Phase:** Part 1, Phase 1.3.

## Problem

GitHub can redeliver messages. Queue dispatch or report publication can fail after earlier work succeeds. A database write followed by an unrelated queue write can leave an accepted run without a job.

## Decision

Postgres is the durable source of truth for delivery identity, run context, progress, findings, and publication identifiers. Save an eligible run and its outbox instruction in one transaction before acknowledging acceptance. The dispatcher publishes that instruction to BullMQ/Redis using a stable job identity.

Assume at-least-once delivery throughout. Database uniqueness constraints, conditional state updates, execution leases, and idempotent stage/report operations must handle duplicate attempts. A stable queue ID alone is insufficient once queue records expire or a worker crashes after a side effect. External API writes require reconciliation before replay when their result is ambiguous.

Snapshot the tested SHA, effective policy version, budgets, and preview/deployment identity when resolved. The current run-request contract includes SHA and budgets but not every future persistence field; extend it deliberately when storage is added. Validate permitted transitions in orchestration rather than permitting arbitrary status updates.

Distinguish `completed` progress from check outcomes. A completed run can contain bugs. Mark obsolete runs `superseded`, preserve their historical evidence, and prevent late publication from becoming the current verdict. Retry only transient failures with bounded backoff. Cancellation must propagate to active operations and cleanup, not merely update a database label.

## Alternatives

Writing directly to Redis is simpler but would make application history and recovery depend on queue retention. Writing to the database and queue without an outbox leaves a handoff failure window. Performing tests synchronously avoids dispatch plumbing but cannot meet fast webhook acknowledgment or isolate long workloads. Claiming exactly-once delivery would conceal real crash and duplicate-message cases.

## Consequences and verification

The outbox needs a dispatcher, retry metadata, observability, and cleanup. Test crashes before and after enqueue, duplicate deliveries, worker termination, out-of-order state writes, and report timeouts. Acknowledge accepted events only after durable storage succeeds; ignored events can be acknowledged without creating a run. The under-10-second acknowledgment objective requires a defined load test later.
