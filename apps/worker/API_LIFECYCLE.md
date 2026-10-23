# API cleanup and reproducibility

Part 4.6 adds `runApiLifecycle` around one boundary, authentication, or authorization stage. Run `npm run lifecycle:verify`; the same tests are included in `api:verify` and `npm test`.

The caller supplies the existing immutable input and scoped credential callbacks, plus a trusted `ApiLifecycleProvider`. Each attempt allocates a fresh UUID namespace bound to tenant, run, repository, PR, SHA, deployment and origin. Setup must attest fixture, initial dataset and identity-profile digests. The provider must actually isolate requests to that namespace; a receipt alone does not create isolation. Input/grant/generator snapshots are detached before asynchronous work.

Setup and cleanup each have separate bounded deadlines (2 seconds by default, at most 10 seconds). Cleanup runs after every attempted setup, including setup failure, cancellation and exhausted request budgets. It checks independent namespace ownership through `canCleanup`, removes only that namespace and verifies a matching empty receipt. Cleanup authority must survive cancellation or a head change while retaining tenant/resource ownership checks. It never grants new test requests. Repeated cleanup must be idempotent.

An unsuccessful cleanup makes the overall result inconclusive while preserving execution observations. Unsettled setup cannot produce verified cleanup even if a provider reports empty. Providers must fence aborted setup to prevent late creation; racing a promise cannot kill arbitrary provider work. The returned namespace permits trusted compensating cleanup to be retried. There is no durable cleanup queue, process-crash recovery or remote-resource garbage collector yet.

## Local PawMart adapter

`createFixtureApiLifecycle(authority)` opens one literal-loopback server and returns `{ origin, lifecycle, close }`. Use that origin in the binding/grant and `fixture: true` in execution options. Always call `close()` in a `finally` block. The adapter supports one active namespace and at most 100 attempt receipts per server. Setup creates a fresh healthy PawMart app; cleanup discards its complete in-memory store, including resources whose response IDs were lost. No HTTP reset/delete endpoint is exposed. Old cleanup receipts cannot discard a newer active namespace. The trusted adapter hashes the compiled fixture source and versions its synthetic dataset and identity profile. Source changes invalidate replay. It supports healthy PawMart only; other providers must attest their own implementation and seed state.

## Replay

A completed execution plus verified cleanup produces a versioned metadata-only capsule. Application failures may be completed observations and remain replayable; incomplete coverage and cleanup failures produce no capsule. Persist capsules only in private scoped storage. They contain hashes, stage and version, with no credentials, request/response bodies or raw errors. Hashes are compatibility fingerprints, not encryption or authentication; the caller must provide trusted original configuration and a trustworthy provider.

Pass `replay: previous.capsule` with the same immutable configuration and freshly prepared state. A new run ID and namespace are allowed. Tenant, repository, PR, SHA, deployment, origin, contract, seed, generator fixtures, grants and limits must match. Configuration mismatch stops before setup; fixture/dataset/identity mismatch stops before test HTTP and still cleans up setup. Credentials are resolved afresh, not stored in the capsule.

`matched` means the ordered semantic observations (operation, probe/scenario/step, status, fixed code, HTTP status, evidence match and coverage gaps) match. Run-specific case IDs and usage counters are excluded. `different` records observed divergence; it does not claim deterministic behavior, root cause or PR regression attribution. A capsule alone cannot reconstruct private inputs or prove external state.

Each wrapper call owns one stage budget. Durable whole-run reservations, production namespace routing, killable isolation, customer lifecycle adapters, evidence persistence and dispatch integration remain future work. Normal worker startup remains dispatch-only.
