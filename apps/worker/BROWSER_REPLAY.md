# Browser failure replay

Phase 5.6 adds `replayFixtureFailure` over explicit chaos scripts. Run `npm run browser-replay:verify` for real Chromium against healthy PawMart and its seeded stuck-checkout mode. No model or customer endpoint is used.

A trusted caller supplies immutable scope, disposable browser policy, script, deployment ID, two distinct synthetic snapshot markers (failure and success), and a lifecycle provider. The runner performs two attempts by default, at most three. Each uses a new UUID namespace and fresh browser, with a separately prepared/reset backend fixture. Scope is checked on lifecycle receipts; independent ownership authorization, cleanup and a matching empty receipt are required after every attempted setup. Cancellation, stale authority, setup failures and unsettled setup cannot produce confirmed evidence. Unverified cleanup stops further attempts.

The first prepared fixture/dataset/identity fingerprint becomes the compatibility baseline. Later mismatches stop before browser execution and still clean up the namespace. A private configuration digest binds scope, policy, script, assertion and deployment. Replay does not accept arbitrary saved screenshots as proof. It reruns the explicit script using current authority and freshly prepared state.

Each attempt must complete its script, settle within the existing network wait, capture an observation and close the browser. The snapshot must contain exactly one of the caller's failure/success markers. Both or neither is inconclusive. Markers are a narrow trusted fixture assertion, not a generic semantic oracle: page text can spoof them, and a transient state observed at the capture boundary does not establish a root cause. Do not use untrusted customer assertions or infer bugs from injected network failures alone.

Classification requires the requested number of compatible, completely cleaned attempts:

- `reproduced`: every attempt observed the failure predicate.
- `not_reproduced`: every attempt observed the success predicate. This does not erase a historical failure.
- `unstable`: complete attempts observed a mixture of failure and success.
- `inconclusive`: any missing, ambiguous, incompatible, stopped or unclean attempt.

Repeated evidence confirms this predicate under this scenario and observation boundary. It does not establish severity, causality, general reliability or PR attribution. `attribution: unavailable` remains explicit; automatic base-preview comparison is not wired here. Earlier smoke comparison utilities remain separate.

Output contains scope, configuration/state digests, namespace IDs, fixed codes, cleanup status, observed outcomes and optional PNG hashes. Raw snapshots, PNGs, input values and assertion text are not returned or persisted by replay. Digests are private compatibility metadata, not encryption or authenticated evidence. Durable artifact storage and report integration remain later phases.

Replay has a total wall-clock bound (60 seconds by default, at most 120), at most 60 shared non-stop actions and 200 shared request reservations, plus existing per-browser limits. Attempts cannot reset the shared counters. Setup and independent cleanup each wait at most two seconds per attempt. Providers must fence aborted setup; timeout races cannot kill an arbitrary provider or browser startup. Production needs killable supervision and durable recovery.

The local lifecycle adapter now accepts a validated PawMart mode and fingerprints the mode, compiled server/browser code, HTML and CSS. Its seeded data/identity profiles remain deterministic. Cleanup discards complete in-memory state, including created resources whose IDs were lost. No remote reset endpoint is exposed. Verification demonstrates healthy controls, repeated stuck-checkout evidence, fresh namespaces, verified empty state and refusal of changed dataset attestations. Literal `.js`/`.css` policy paths are supported while dot-segment traversal stays rejected.
