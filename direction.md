# Implementation decisions by phase

## Working agreement

Implement one small phase, update all three progress documents, verify the result, propose a commit message for all pending changes, and stop for approval. Never interpret completion of one phase as approval for the next.

## Part 1 · Phase 1.1 — Initial project setup

- Followed the user's initial-setup ordering and subdivided the original larger roadmap phases. An alternative was beginning with policy documentation only, but the user explicitly requested the project setup first.
- Separated `apps/api`, `apps/web`, and `apps/worker` so their future responsibilities and deployments remain clear. A single application would be quicker initially but would couple long-running jobs to request handling.
- Created only real entry points. Shared packages will be introduced when used; `packages/README.md` explains the reserved location. Creating empty contract/database packages now would imply settled designs before their phases.
- Built an honest informational page without fake login, run buttons, or sample results. A clickable mock dashboard was possible, but would obscure which behavior is implemented.
- Added only an API health endpoint and a worker startup message. The health endpoint indicates process availability, not database or queue readiness. The worker does not stay alive or process jobs until queue integration is implemented.
- Bound development servers to loopback and validated the API port. External hosting and environment-file loading remain future work.
- Initialized a local Git repository to enable phase review. No automatic commit, remote, or deployment is part of this phase.
- Used local checks and HTTP smoke verification rather than adding automated tests that mirror static scaffold content. Meaningful behavior tests begin with domain rules and webhook handling.

Next proposed phase: Part 1, Phase 1.2 — domain contracts and opt-in policies. It requires user approval before work begins.

### Verification completed

- Type checking, ESLint, formatting checks, and production builds passed for the initial workspace.
- The development command started the web, API, and worker entry points. Local HTTP checks returned the expected API health JSON and HTTP 200 with the expected page content. This verifies server responses, not visual browser behavior.
- The sandbox required approval to initialize Git, bind local server ports, and make localhost HTTP requests.
- Next.js generated `apps/web/AGENTS.md` and `CLAUDE.md` during development. These framework instructions are retained for future changes.

## Part 1 · Phase 1.2 — Domain contracts and opt-in policies

- Added documented runtime contracts before network integrations so later components agree on IDs, immutable PR versions, budgets, and evidence requirements. This package has no HTTP, database, or queue side effects.
- Chose exact, case-sensitive labels and whole-comment command matching. Trimming surrounding whitespace helps ordinary users; scanning arbitrary prose would risk running quoted instructions. Defaults are `dogwatch` and `/dogwatch run`.
- Require explicitly configured GitHub numeric actor IDs for every trigger. This is a conservative initial rule; resolving team membership or repository collaborator permissions dynamically is an alternative for the future GitHub authorization adapter.
- Match tenant, installation, and repository IDs together. These internal IDs must eventually come from verified installation records, not an untrusted webhook's claims. The evaluator alone does not authenticate callers.
- Separate completed run progress from passed/failed/skipped/inconclusive check outcomes. No state-transition engine was added; durable orchestration implements it later.
- Use finite budget defaults with hard upper bounds, including integer-cent model spend. Those numbers are starting policies, not benchmark results. Budget schemas validate configuration; future executors enforce consumption.
- Require evidence references and reproduction steps in findings. Actual evidence ownership, redaction, truth, and deduplication are deferred to storage and aggregation; valid JSON is not proof of a real bug.
- Kept the website unchanged because a configuration UI without persistence would misrepresent progress. API consumers and webhook routes arrive in their approved phases.
- Adopted the user's detailed-comment convention for new code. Explain intent, syntax where helpful, and constraints; avoid commentary on generated build output. JSON settings are documented separately.

Next proposed phase: Part 1, Phase 1.3 — threat model and architecture decisions. Stop for approval after this phase.

### Phase 1.2 verification

Eight behavior tests passed. All workspace production sources passed type checking; the existing applications built successfully, and the new contracts package built successfully after correcting its initial workspace dependency installation. ESLint and formatting checks passed. npm reported no known dependency vulnerabilities at installation time. Tests required permission because the sandbox blocked tsx's local IPC socket. No website interaction or GitHub integration is claimed by these checks.

The install also repaired an existing lockfile omission: Express was declared in the API manifest but its dependency tree was absent from the committed lockfile. This explains the larger lockfile diff and restores reproducible dependency resolution. Next.js refreshed its generated `next-env.d.ts` references from development paths to production-build paths; these generated declarations are not manually maintained.

## Part 1 · Phase 1.3 — Threat model and architecture decisions

- Wrote four linked architecture decision records and a threat model grounded in the current contracts and actual scaffold. Every record distinguishes accepted design from implemented controls, so documentation does not imply a working secure SaaS.
- Chose focused records for service boundaries, durable runs, authority/isolation, and agent/evidence handling. One large architecture document was an alternative, but separate records make later supersession and review easier.
- Linked each threat to a concrete verification obligation and implementation phase. A generic checklist would be quicker but would not tell the next implementer which boundary owns the behavior.
- Resolved the MVP boundary: inspect source without executing repository scripts; test user-provided previews with synthetic accounts. Automatic builds, private-network connectivity, and fork credential inheritance require explicit future designs.
- Defined the model as an action proposer, with executor code enforcing policy. Prompt instructions alone are not a control. Kept budgets, evidence confidence, and run completion distinct.
- Documented missing persistence snapshot fields, revocation handling, report reconciliation, and artifact audiences as future obligations rather than expanding code outside the approved phase.
- No source code was created; the detailed-comment convention remains in effect for future code. Markdown explains each decision, alternative, consequence, and verification gate directly.

Next proposed phase: Part 1, Phase 1.4 — local Postgres/Redis and migrations. Wait for approval before creating infrastructure or changing application data flow.

### Phase 1.3 verification

Checked all eight local documentation links across the README and six new design documents; every target exists. Prettier formatting and Git whitespace checks passed. Reviewed the records against the current contracts and phase roadmap, and confirmed that the diff contains documentation only. Runtime tests and builds were not repeated because no code, dependencies, or configuration changed.

## Part 1 · Phase 1.4 — Local Postgres/Redis and migrations

- Added infrastructure separately from the web/API/worker so the existing informational experience still runs without databases. Wiring persistence into ingress belongs to Part 2.
- Selected a small initial schema for tenancy relationships and durable run/outbox groundwork. Adding all future membership, evidence, usage, and lease models now would lock in untested requirements.
- Enforced tenant-consistent relationships through composite foreign keys. This does not authorize reads; row-level policies and least-privilege application roles need their own later implementation and tests before real multi-tenant deployment.
- Used named volumes and a non-destructive stop command. Automatic reset scripts were an alternative, but risk destroying local work. Used dedicated loopback ports to avoid common native service conflicts.
- Created an explicit connection factory rather than a global client. Future services control pool lifetime and credentials; the health route remains a process-only check.
- Made verification transactional and self-cleaning through rollback, without persistent seed data. A separate seeded environment is planned with the fixture/CI phase.
- Kept generated client code ignored; hand-maintained source carries detailed comments, and package JSON configuration is explained in Markdown.

Next proposed phase: Part 1, Phase 1.5 — CI and fixture application. Stop for approval before that work.

### Dependency review

npm audit reported four high-severity entries in Prisma 7.10.0's development CLI dependency chain (`prisma`, `@prisma/config`, `deepmerge-ts`, and `mysql2`). The reported risks involve recursive-object merging and MySQL protocol handling. DogWatch uses PostgreSQL and trusted local CLI configuration; the CLI is not exposed as an application endpoint. No forced major downgrade or unverified transitive-major override was applied. These advisories remain unresolved and must be revisited before deployment/toolchain exposure; advisory count does not represent four independent runtime defects.

`npm audit --omit=dev` also reports the same entries because Prisma CLI/config packages remain reachable in npm's workspace/peer dependency graph. They must not be described as a clean production dependency audit even though the CLI is not invoked by the application factory. Separating deployment artifacts and removing CLI tooling from runtime images is future deployment work.

### Phase 1.4 verification

Docker Postgres and Redis became healthy; Redis returned PONG. The initial migration applied and its history row was confirmed in Postgres. Database verification passed for atomic run/outbox writes, rollback cleanup, and cross-tenant foreign-key rejection. Eight existing contract tests, all workspace type checks/builds, ESLint, formatting, and Git whitespace checks passed. No row-level authorization, queue processing, or website persistence is claimed. The containers remain running locally; `npm run infra:down` stops them while preserving volumes. The dependency audit remains nonzero as documented above.

## Part 1 · Phase 1.5 — CI and fixture application

- Added two CI jobs: fast workspace verification and isolated local-service verification. Reusing Compose avoids drift and checks migrations twice without destructive reset commands. Kept permissions read-only, PR runs unprivileged, credentials absent, and timeouts bounded.
- Built PawMart as a separate fixture rather than modifying the DogWatch landing page. Product onboarding is still unavailable; the fixture provides testable behavior for future tiers.
- Used public synthetic tokens and in-memory orders. Real login/payment/database integration would introduce side effects irrelevant to a controlled QA target. Each process/test begins with deterministic ownership fixtures.
- Chose a healthy default and startup-only fault selection. An HTTP fault-toggle endpoint was an alternative, but would allow parallel tests or agents to silently change each other's expectations.
- Added two labeled faults only, rather than a broad fake benchmark. They cover a contract-visible server failure and a client-only stuck state. HTTP tests do not claim to verify the visual browser fault; Playwright coverage will follow in its phase.
- Kept browser validation disabled intentionally so malformed checkout data reaches the API. Explicit labels and a live status region make later accessibility snapshots useful.
- Used detailed comments in every authored code/config format that supports comments, and explained JSON in the fixture README. Dev builds once then watches compiled output; source editing requires a rebuild/restart, documented rather than pretending compilation is continuously watched.
- Added no deployment or GitHub App integration. The workflow must be pushed and run on GitHub before hosted CI can be called verified. Known Prisma dependency advisories remain documented and are not suppressed as a successful audit.

Next proposed phase: Part 2, Phase 2.1 — GitHub App configuration and raw-body webhook verification. Wait for approval before beginning it.

### Phase 1.5 verification

A fresh `npm ci --offline` succeeded from the committed lockfile using the local cache. This confirms installation reproducibility locally, not a refreshed vulnerability audit; the prior advisory limitation remains. Schema validation, all workspace type checks/builds, lint, formatting, and whitespace checks passed after resolving Prisma engine-cache sandbox permissions. Eleven behavior tests passed (three fixture HTTP groups and eight domain tests). The compiled fixture returned HTML, its module script, CSS, and OpenAPI successfully. Both repeated migration applications were no-ops, migration status was current, rollback/tenant verification passed, and Redis returned PONG. Local documentation links resolve.

No hosted GitHub Actions run, real-browser interaction, or autonomous QA execution was performed. Workflow YAML is syntactically checked by Prettier; job behavior was exercised through local command equivalents rather than an Actions emulator. The fixture server was stopped after verification; pre-existing data-service containers remain available.

## Part 2 · Phase 2.1 — GitHub App configuration and raw-body verification

- Split the listener from an importable app factory so HTTP tests inject synthetic secrets without starting the production entry point. Added detailed comments to the new files and updated entry point.
- Verify bounded raw bytes before JSON parsing; refuse compression, malformed digest syntax, and unequal-length comparisons. Re-serialized JSON and ordinary string comparison were rejected alternatives.
- Missing configuration fails closed for webhooks while health remains usable. Configured startup secrets require at least 32 characters; this validates shape, not entropy, so the guide uses secure random generation.
- Deliberately return a validation-only acknowledgment, not accepted-run status. Authorization, event normalization, tenant resolution, replay protection, persistence, and dispatch remain separate approved phases.
- Documented a minimal GitHub App registration plan rather than registering an App with fabricated URLs or requesting credentials unnecessarily. Live registration/delivery remains pending real owner and endpoint configuration; local verification is complete independently.
- Avoid logging webhook bodies or signatures and keep error responses generic. Body size limits do not replace future ingress rate limits or deployment request timeouts.

Next proposed phase: Part 2, Phase 2.2 — authorization and event filtering. Wait for approval before starting it.

### Phase 2.1 verification

All 16 tests passed: five webhook groups, three fixture groups, and eight domain tests. The official-vector test initially caught a mistyped expected digest; correcting it against GitHub's published value made the independent test pass. All workspace type checks, API compilation, lint, formatting, whitespace checks, and local documentation links passed. No dependencies changed, so unrelated application builds were not repeated. No live GitHub App registration, public endpoint, or GitHub-originated delivery was performed; those require real account/endpoint configuration.

## Part 2 · Phase 2.2 — Authorization and event filtering

- Connected signed events to the shared domain gate through a typed adapter rather than trusting webhook tenant IDs or duplicating opt-in rules. Current head SHA and PR state come from an installation-authorized API lookup, especially for issue-comment commands that contain no trustworthy PR head context.
- Used an operator-owned local policy file as a temporary authority store. Persistent policy onboarding is an alternative but requires schema/membership work beyond this phase. Partial configuration fails startup; signature-only development mode remains explicitly marked.
- Required approved human actor IDs, exact commands, matching scope, open PRs, and current labels for label triggers. Denied fork heads by default so they cannot inherit credential grants. Dynamic collaborator/team checks and explicit fork previews can be designed later.
- Recheck installation state and mint a read-only repository-restricted token per candidate. Merely reading public repository metadata could conceal missing installation access, so token scoping must succeed first. Remote failures do not become eligible decisions.
- Ignored unsupported events/actions and ordinary issues before API calls. Lifecycle events have no local state handler yet; current authority is verified on each candidate, and cancellation/revocation propagation stays with orchestration.
- Return `eligible_only` with `queued: false`, rather than implying a durable accepted run. Delivery deduplication, run/outbox persistence, dispatcher, and QA remain future phases.
- Handle SDK numeric/bigint IDs through safe conversion; reject values not representable by current numeric contracts rather than rounding. SDK requests have timeouts and retries disabled; overall latency/concurrency guarantees still need later tests.

Next proposed phase: Part 2, Phase 2.3 — delivery deduplication and transactional outbox. Wait for approval before implementation.

### Phase 2.2 verification

All 23 tests passed (12 API, three fixture, eight domain). New coverage checks normalized policy decisions, signed HTTP integration, current context/fork/revocation rejection, and actual Octokit request/auth behavior through an injected synthetic transport. All workspace type checks/builds, lint, formatting, local documentation links, and whitespace checks passed. A fresh offline lockfile install succeeded; its cached audit output is not a new online security assessment. Existing advisory documentation remains in place. No live App registration, installation, external credential use, database write, or queue dispatch occurred.

## Part 2 · Phase 2.3 — Delivery deduplication and transactional outbox

- Added an accepted-delivery receipt table rather than retaining whole webhook bodies. Fingerprints and metadata suffice for delivery reconciliation; raw comments/tokens would add needless storage and exposure.
- Used one transaction for receipt/run/outbox and awaited commit before acceptance. Do not label a queued event until the future dispatcher actually enqueues it.
- Combined delivery-ID and signed-body fingerprint uniqueness. Exact byte-identical legitimate notifications collapse while retained; this conservative tradeoff is documented. Semantic request deduplication and retention are distinct future choices.
- Reconcile concurrent uniqueness failures after rollback against committed records, preserving original SHA and policy. Changed bytes under an existing delivery ID are conflicts rather than updates to the old run.
- Revalidated policy and checked durable tenant/repository/installation relationships under a shared row lock. Operator registration is explicit; auto-creating ownership from webhook/local-file claims would obscure authority mismatches.
- DATABASE_URL explicitly enables persistence only with complete App authorization. Signature-only and eligibility-only local modes remain available; failed storage cannot silently downgrade an intended durable request.
- Expanded verification to real committed transactions with exact random-fixture cleanup, plus HTTP boundary tests. Hosted CI and real App delivery remain pending. No dispatcher, run state machine, row-level authorization, or onboarding UI was added.

Next proposed phase: Part 2, Phase 2.4 — queue dispatch and retries. Wait for approval before implementation.

### Phase 2.3 verification

The additive receipt migration applied successfully, and repeated deployment reported no pending migrations. Real Postgres verification passed for concurrent copies, changed-header fingerprint replay, immutable snapshots, conflicts, ownership mismatch, failure rollback, and exact fixture cleanup, including a rerun after adding the shared ownership lock. The previous database verification still passes. All 24 unit/HTTP tests, workspace type checks/builds, lint, formatting, local documentation links, and whitespace checks passed. Prisma initially required a schema uniqueness correction and workspace-relative migration path correction; both were resolved before applying the migration. No live GitHub App delivery or hosted CI run was performed. Queue dispatch is intentionally absent.

## Part 2 · Phase 2.4 — Queue dispatch and retries

- Added durable dispatcher attempt/due/error metadata rather than an in-memory retry counter. Outbox failure and publication updates survive restart.
- Selected one locked due row at a time and used SKIP LOCKED for multiple dispatcher processes. A lease protocol could avoid holding locks during network work but would add recovery state before throughput evidence requires it.
- Used run UUIDs as BullMQ job IDs and retained completed/failed jobs. Tested the crash window where Redis already contains a job but the outbox remains pending; cleanup/Redis data-loss reconciliation remains an explicit production obligation.
- Stored only tenant/run references in Redis, not snapshots or credentials. A future processor must revalidate database ownership and use idempotent stage operations rather than trusting those references as authority.
- Separated five dispatcher attempts from three processor attempts. Permanent identity conflicts and malformed jobs fail without burning transient retry budgets. Global concurrency is two; tenant limits/fairness remain future execution policy work.
- Replaced the runner scaffold with an optional dispatcher loop, while keeping production QA consumption disabled until preview readiness/isolation. A no-op real QA consumer would incorrectly signal completed testing, so only injected synthetic processors are used now.
- Scoped integration verification to a random queue/tenant, including dispatch selection; tests never pick up another tenant's pending work. The runner/database/queue lifecycle scripts build prerequisite packages on a clean checkout.

Next proposed phase: Part 2, Phase 2.5 — cancellation and stale-head supersession. Stop for approval before implementing it.

### Phase 2.4 verification

The additive outbox retry migration applied successfully. Real Postgres/Redis verification passed for the enqueue-before-commit crash window, concurrent dispatchers, bounded handoff retries, permanent identity conflicts, processor retry success/exhaustion, the concurrency ceiling, and invalid jobs. All 24 unit/HTTP tests, workspace type checks/builds, and lint passed. The first queue check exposed BullMQ's optional Redis driver requirement; adding ioredis explicitly resolved it and the integration check then passed. No production QA processor or hosted CI run was started.

## Part 2 · Phase 2.5 — Cancellation and stale-head supersession

- Added an authorized `/dogwatch cancel` comment for unfinished runs on the resolved current SHA. Repeated cancellation is harmless. Cancelling historical heads individually and dashboard controls wait for authenticated membership and run history.
- Treat synchronize notifications as stop-only requests. Pushing a commit invalidates unfinished older-head work without silently starting another QA run; users explicitly request a new run. The existing human actor allowlist, installation scope, enabled policy, and fork checks apply. Pushes from other actors are ignored under the current policy; execution must independently check current GitHub head before work/report publication in later phases.
- Acceptance of a different authorized SHA also supersedes unfinished older runs in the same transaction. Receipt conflicts roll back those changes so replay cannot revive cancelled work. Exclusive repository locks serialize database stop/create operations; dispatcher run locks serialize handoff with stopping.
- Preserve terminal outcomes and immutable snapshots. Kept queue jobs/outbox records instead of deleting evidence or treating Redis removal as cancellation. A job enqueued just before a stop is safe only when its eventual executor observes the database state. No production executor exists yet.
- Added a tenant-scoped execution eligibility check for future stage entry. It is not an execution lease or an atomic publication guard. GitHub can change after a lookup and before transaction commit; later execution/reporting must revalidate the head and use guarded transitions. Abort propagation, audit history, and completed-verdict freshness belong with those later stages.

Next proposed phase: Part 2, Phase 2.6 — preview readiness. Stop for approval before implementation.

### Phase 2.5 verification

All 25 unit/HTTP tests, workspace type checks/builds, lint, formatting, and whitespace checks passed. Real PostgreSQL verification covers new-head supersession, unauthorized stop rejection, repeated cancellation, tenant-scoped execution eligibility, stopped dispatch, and receipt replay without resurrection. The existing real Redis queue checks also passed. Initial verification found a synchronize classification error and an obsolete unsupported-action expectation; both were corrected. No live GitHub delivery, hosted CI, or production execution/abort was tested.

## Part 2 · Phase 2.6 — Preview readiness

- Chose explicit immutable deployment bindings rather than guessing preview URLs from branch names. Matching tenant, repository, PR, SHA, and deployment identity prevents mixing preview evidence across requests. A provider adapter could resolve deployment metadata automatically but needs provider-specific trust rules. The operator currently attests deployed source identity.
- Kept production consumption disabled until isolation. Added callable preparation orchestration and disposable integration verification rather than a consumer that could accidentally run unrestricted QA. Successful readiness remains `waiting_for_preview` with a timestamp; it never marks QA running or passed.
- Used a conditional queued-state claim and conditional finish to preserve cancellation/supersession during setup. Added current-head checks around probes. Future execution must add leases/crash recovery, whole-run accounting, abort propagation, and guarded stage/publication transitions; readiness checks are not those mechanisms.
- Denied redirects, query-bearing URLs, credential-bearing URLs, private/special IPv4, and IPv6. DNS addresses are checked and pinned before connection; HTTPS keeps the configured hostname for TLS. Following approved redirects or supporting IPv6 is possible later with equivalent checks, but is unnecessary for explicit final health endpoints.
- Capped polling by setup duration, per-request timeout, request count, and run-budget ceilings. Stored probe counts for future budget deduction. A healthy status is a setup observation; application assertions belong in smoke/API/browser tiers.
- Added only nullable additive setup fields to existing runs. Fixed failure codes avoid persisting raw errors or response data. No authentication, deployment service, or web controls were added.

Next proposed phase: Part 2, Phase 2.7 — worker isolation. Stop for approval before implementation.

### Phase 2.6 verification

The additive preview migration applied successfully. All 31 unit/HTTP tests, workspace type checks/builds, and real PostgreSQL/Redis acceptance/queue checks passed. Readiness integration passed for a temporary 503 followed by success, exact-SHA binding, persisted readiness evidence, repeat-claim prevention, redirects, stale heads, and cancellation before success recording. Local fixture data and its HTTP server were removed. Lint, formatting, and whitespace checks passed. No live customer preview, deployment provider, hosted CI run, or isolated production consumer was started.

## Part 2 · Phase 2.7 — Worker isolation

- Built a tiny trusted diagnostic image with a pinned Node base, not customer repository Dockerfiles or dependency installation. Resolved its local tag to an immutable image ID before each launch. This verifies an isolation foundation without exposing repository scripts to host credentials.
- Kept the control plane outside the sandbox. The trusted host uses Docker CLI argument arrays; the container receives only tenant/run references and a fixed diagnostic kind. No socket, mounts, credentials, customer-selected image, or shell command can be supplied by task JSON. A Docker API SDK was an alternative but would add a dependency without improving the fixed local supervisor scope.
- Chose zero egress with network=none. Readiness remains a separate restricted HTTP stage. An allowlisted egress gateway will be needed for real API/browser execution; a browser proxy flag alone would not prevent direct sockets or alternative protocols. No unrestricted consumer was connected.
- Enforced non-root, read-only root, fresh bounded tmpfs, dropped capabilities, default seccomp, no-new-privileges, CPU/memory/process/file-descriptor limits, and no core dumps. Stronger kernel separation can be evaluated before hostile-code production use.
- Bound execution and diagnostic output, disabled persistent Docker logs, and returned fixed codes/validated booleans. A timeout kills the attachment then removes the exact random container; killing only the client would leave the workload running. Cleanup has its own bounded deadline.
- Verified actual Docker settings and in-container boundaries, host-secret absence, fresh workspaces, timeout/cancellation, and container absence afterward. Host/daemon failure can still leave an orphan; lease-based recovery and identity-scoped operational reconciliation remain future work. No product run is marked tested by this diagnostic.

Next proposed phase: Part 3, Phase 3.1 — immutable diff retrieval. Stop for approval before implementation.

### Phase 2.7 verification

The small sandbox image built successfully, then rebuilt successfully with its verified base digest pinned. Real Docker verification passed twice, including engine CPU/memory/process/mount/security settings, non-root/capability/read-only/socket/metadata restrictions, host-canary absence, fresh workspaces, bounded timeout/cancellation, and removal of all four exact diagnostic containers. All 35 unit/HTTP tests, workspace type checks/builds, lint, formatting, and whitespace checks passed. Initial lint identified Node globals in the standalone runtime; explicit imports resolved it. No customer runs, source execution, external preview access, production QA consumer, or hosted CI run was performed.

## Part 3 · Phase 3.1 — Immutable diff retrieval

Added a callable comparison adapter accepting independently resolved base/head commits and a currently authorized repository-scoped token. No public route or auto-consumer was added. Preserve rename/deletion metadata and merge-base context; drop patch bodies from returned metadata to minimize source retention. Pagination ceilings produce coverage gaps. Token minting, tenant/current-head checks and durable orchestration remain caller responsibilities; import/symbol parsing and source retrieval belong to Phase 3.2. Next phase: Part 3, Phase 3.2 — import and symbol graph. Stop for approval.

### Phase 3.1 verification

All 38 unit/HTTP tests, workspace type checks/builds, lint, formatting, and whitespace checks passed. Synthetic GitHub transport tests verify immutable endpoints, redirects disabled, rename metadata, incorrect heads, unsafe paths, oversized responses, authorization failures, and explicit provider-limit gaps. No live GitHub credentials, customer source, durable comparison persistence, or automated QA consumer was used.

## Part 3 · Phase 3.2 — Import and symbol graph

- Completed the pending in-memory graph implementation using the existing TypeScript parser. No compiler host, customer tsconfig, plugins, package installation or source execution is used. TypeScript is a runtime worker dependency because the built worker imports its parser.
- Bound analysis to tenant/repository and immutable commits. Base analysis must represent the comparison merge base. Reverse edges from both snapshots preserve consumers of renamed/deleted modules and terminate safely through cycles.
- Prefer explicit ambiguity/gaps over guessing resolution. Incomplete graphs widen to every supplied module; absent repository files remain unknown. This supports conservative prioritization without claiming complete repository-wide coverage or QA success.
- Corrected namespace re-export names, duplicate default exports and namespace coverage reporting during review. Added focused regression cases alongside the existing graph tests.
- This phase accepts caller-supplied source snapshots. An authenticated immutable source retrieval adapter, enforced process/container limits around the parser, durable orchestration and automatic consumption remain pending integration work. The AST traversal limit does not bound the parser itself; production callers must not parse hostile source in the control-plane process.

Next proposed phase: Part 3, Phase 3.3 — route impact mapping. Stop for approval before implementation.

### Phase 3.2 verification

All 46 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Eight graph tests exercise immutable synthetic snapshots without executing source. No live GitHub source retrieval, hostile-source container parsing, database migration or production consumer was performed.

## Part 3 · Phase 3.3 — Route impact mapping

- Chose explicit operator-owned mappings rather than framework route discovery. Maps route paths, API operations and named journeys to module dependencies at each immutable snapshot. Configuration completeness is caller-attested; unknown frameworks and missing targets cannot be inferred automatically.
- Reused conservative module impact and independently validated mapping tenant/repository/SHA identity. Duplicate IDs and unsafe paths are rejected. Critical targets remain selected even when their modules are unaffected.
- Preserve base and head selections separately so removed or renamed routes remain comparison context rather than silently becoming runnable head URLs. Every selected target includes reasons and directly matched modules.
- Incomplete graph/comparison/mapping coverage, unknown mapped modules or unmapped affected modules widen to all supplied targets. Missing targets remain a coverage limitation; widening is not proof of complete application coverage. Operators should map relevant dependencies as well as entry modules to avoid unnecessary fallback.
- Added fixture tests for transitive impact, critical journeys, conservative fallback, old/new target labels, scope mismatches and unsafe configuration. No public route, automatic consumer, framework loader, network request or QA verdict was added.

Next proposed phase: Part 3, Phase 3.4 — smoke journeys. Stop for approval before implementation.

### Phase 3.3 verification

All 51 unit/HTTP tests and the full workspace production build passed. Worker type checking passed. Initial lint flagged a control-character regex; equivalent character-code validation fixed it. Final lint, focused impact regression tests and the worker build passed. Formatting and whitespace checks passed. No customer requests, source retrieval, database changes or production QA execution were performed.

## Part 3 · Phase 3.4 — Smoke journeys

- Added a strict callable journey runner with navigation, synthetic account value references, core interactions and assertions. Bounds execution at 20 seconds separately from setup; enforces a total step count and checks caller-supplied current authority before actions and after journeys. Cleanup is separately bounded and cannot silently turn failure into success.
- Classifies application observations separately from context failure, stale authority, cancellation and budget exhaustion. Dependent journeys skip after non-passing prerequisites. Metadata evidence includes immutable context, fixed codes, step counts and console/page/server/network counters, without raw diagnostics or credentials.
- Added an explicit Playwright adapter for trusted disposable loopback fixtures. It uses fresh browser state and denies redirects, other origins, service workers, WebSockets, popups and downloads. Browser interception is not sufficient for untrusted preview isolation, so normal startup stays dispatch-only and the Docker sandbox remains offline. Customer/hostile content must not use this adapter.
- Chose a trusted driver interface so the bounded orchestration can later use an isolated executor without embedding browser or network authority in customer plan JSON. The future caller must enforce ownership, deployment identity, remaining whole-run budgets, network request ceilings and killable process cleanup. The current runner is not a production consumer or execution lease.
- Verified synthetic identity selection, checkout and seeded defects using real Chromium. This is not a live authentication-provider test. Base attribution stays unavailable; matching base checks and durable screenshot/trace evidence belong to Phase 3.5. No claim that an observed defect was introduced by the PR is made.
- Dependency audit reports existing Prisma/config/deepmerge/mysql2 and concurrently/shell-quote findings (four high, two critical); neither added Playwright package appears in that audit. Left unrelated dependency migrations unchanged.

Next proposed phase: Part 3, Phase 3.5 — base comparison and evidence. Stop for approval before implementation.

### Phase 3.4 verification

All 57 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Real Chromium verification passed for healthy PawMart checkout, seeded server 500 and stuck-checkout failures, console/page errors, missing navigation, redirect denial and dependent skips; each smoke execution stayed within 20 seconds. Unit tests cover deadline, cancellation, stale/unavailable authority, step budgets, cleanup failure and unsafe plans. Initial checks found missing DOM typing in the browser callback and lint issues; these were corrected. Local servers and browsers were closed. No customer preview, real authentication provider, production isolated consumer, durable evidence upload or hosted CI run was exercised.

The additional redirect regression initially exposed that browser routing alone did not intercept the redirect chain. The fixture adapter now fetches each approved response with `maxRedirects: 0`, rejects 3xx before browser fulfillment, and disposes fetched responses. The complete real-browser verifier then passed, including redirect denial. The worker was rebuilt and lint passed after this correction.

## Part 3 · Phase 3.5 — Base comparison and evidence

- Added versioned smoke evidence with exact tenant/run/repository/SHA and base/head roles, a scenario/executor/journey/budget compatibility digest, expiry and sanitized action-kind trace. Scenario IDs attest versioned data/account roles and browser/environment configuration; actual credentials and preview URLs are excluded. The operator must independently confirm that both deployments and environments match this context.
- Classify observed head failures against compatible passing base checks as new regressions. Matching configured failure kind/step and diagnostic categories can establish a pre-existing check failure, not shared root cause. Aggregate browser-error counters alone are insufficient and stay inconclusive. Missing baseline, different failures, changed scenarios/plans, expired evidence and stopped/inconclusive checks cannot fabricate regression attribution.
- Added one optional masked final-state screenshot for trusted synthetic fixtures. Capture shares the bounded cleanup window and has a 1 MiB ceiling. Failed capture is explicitly unavailable. It masks inputs/selects/textareas and explicitly marked sensitive nodes; arbitrary echoed text is outside this guarantee, so customer/hostile captures remain disabled. Use a sanitized structured trace instead of raw Playwright ZIPs containing network/body/credential material.
- Added a local private POSIX artifact adapter with opaque references, 0700/0600 checks, scope checks, no-follow reads, byte/count ceilings, corruption hashes, seven-day expiry and explicit scoped pruning. Exclusive writes/fsync/non-replacing publication prevent partially visible bundles. Writer crashes fail closed with an operational lock requiring identity-scoped reconciliation. Parent directory and OS-user trust remain explicit. No account authorization endpoint, cloud storage, scheduled cleanup or public artifact links were added.
- Paired browser verification uses a labeled synthetic render defect to test attribution independently from resource-error logging. The existing PawMart checkout verifier continues covering its real API/UI fault modes. Verified masked-field stability, private persistence/readback and comparison through stored artifact references. Base execution still needs separately authorized setup and whole-run budget reservation; startup stays dispatch-only.

Next proposed phase: Part 4, Phase 4.1 — contract validation. Stop for approval before implementation.

### Phase 3.5 verification

All 69 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Paired real Chromium verification passed for observed-new/pre-existing/unavailable/incompatible-base classifications, synthetic-field screenshot masking, durable private bundle readback and comparison through artifact references. The verifier closed browsers/servers and removed its temporary evidence root. Unit tests cover scope/SHA/role mismatches, expiry/pruning, corruption, symlinks, permissions, byte/count limits, absent capture and conservative attribution. Initial strict-schema checks caught extra scope fields in a fixture and an internal reference projection; both were corrected without weakening external schemas. No live customer preview, hosted object storage, database migration, production consumer or hosted CI run was performed.

## Part 4 · Phase 4.1 — Contract validation

- Added callable validation for OpenAPI 3.0.0–3.0.4 JSON/YAML contracts, bound to trusted tenant/repository/head context and the original byte digest. No contract loader, public endpoint or automatic consumer was added.
- Compile only the bundled trusted OpenAPI document schema with Ajv draft-04. Explicit semantic/profile normalization preserves schema constraints, local references, required path bindings, operation parameter overrides, JSON body/response metadata and inherited/overridden security alternatives. General file/HTTP dereferencing and customer-schema compilation were rejected for this ingestion boundary.
- Return an operation inventory only for the fully supported profile. Malformed/contradictory documents are invalid; unsupported versions/features or resource ceilings are explicit; internal failures are unavailable. Fixed diagnostic codes omit parser/Ajv details and source values. Unsupported content cannot leak a partial inventory into later execution.
- Bound UTF-8 size, AST nodes/depth/scalars, component/path/operation counts, parameter lists, schema/reference expansion and normalized output. Aliases, tags, unsafe keys and non-finite/unsafe integers are refused. These are input/output limits, not a production CPU/memory sandbox; hostile document parsing still needs a killable isolated supervisor.
- Ignore contract server URLs, descriptions, examples/defaults and vendor instructions. Security metadata preserves required AND/OR/anonymous semantics without minting credentials or authorizing a request. Enum/pattern/path constraints remain untrusted and potentially sensitive data, not a universal redaction format. Matching arbitrary regexes and response payload validation are not performed here.
- Used the real PawMart YAML plus focused synthetic contracts to verify normalization, semantic checks, external/cyclic ref refusal, safe metadata omission and resource ceilings. New YAML/Ajv/schema dependencies are explicitly declared at worker runtime; no unrelated dependency upgrade or automatic vulnerability fix was performed.

Next proposed phase: Part 4, Phase 4.2 — deterministic boundary cases. Stop for approval before implementation.

### Phase 4.1 verification

All 88 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Nineteen contract tests include the actual PawMart YAML, supported JSON constraints, local refs, inherited/overridden parameters and security, unsupported versions/features, parser failures, unsafe refs and expansion limits. Initial checks caught CommonJS constructor typing and diagnostic-precedence expectations; both were corrected. No API requests, browser run, database mutation, case generation, customer document ingestion or hosted CI run was performed. Dependency installation reported four high-severity findings in the overall workspace; unrelated fixes were not applied in this phase.

## Part 4 · Phase 4.2 — Deterministic boundary cases

- Added callable seeded case planning that reuses validated immutable contract text. Select exact operations with a repository-policy allowlist and independently scoped impact priorities. Feasible baselines are emitted first, followed by round-robin mutations so one operation cannot consume all mutation capacity before other baselines are considered.
- Generate required omissions, wrong types, nulls, malformed JSON, extra properties, enum outsiders, string/numeric boundaries and bounded array cases. Classify each full logical request after mutation, keeping valid boundaries/optional omissions distinct from invalid inputs. Case labels are not HTTP verdicts; schema validity does not prove business validity, resource existence or successful authentication.
- Use a bounded value interpreter rather than customer-schema compilation. Exact decimal arithmetic avoids multipleOf tolerance errors. Only a finite set of fixed regex implementations is modeled; unknown patterns and unsolved baselines yield explicit gaps. Optional synthetic fixture values can identify existing disposable resources without inheriting raw contract examples/defaults or live credentials.
- Bind case IDs to scope, source contract digest, generator version, seed, operation and canonical payload. Deduplicate equivalent requests within each operation and detach emitted data snapshots. Explicit case/per-operation/total-byte/work limits prevent silent boundary truncation. Coverage diagnostics are capped and missing work never becomes an application pass.
- Skip effective API-key parameter overlaps rather than accidentally treating credential metadata as ordinary fuzz input. Plans declare executionAuthorized:false and contain no target origin or credential grant. The future executor must independently authorize writes, enforce isolated egress/rate/wire limits, reserve whole-run budgets, revalidate case identity and clean up disposable state.
- Added tests using PawMart's real contract, with independent Ajv verification of trusted-fixture body labels, deterministic replay, scope/ranking, limits, nullable/nested/array behavior and snapshot independence. No new dependency, HTTP client, public route or production consumer was added.

Next proposed phase: Part 4, Phase 4.3 — request execution and limits. Stop for approval before implementation.

### Phase 4.2 verification

All 105 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Seventeen new tests cover reproducible scope-bound IDs, automatic and fixture baselines, independent trusted-fixture Ajv body labels, valid versus invalid boundaries, limits, priority/allowlists, nested arrays/enums, unknown patterns, decimal multiples, UTF-8 accounting and detached request snapshots. No generated case was executed, no customer API/credential was accessed, and no database migration, browser run or hosted CI run was performed. No dependency was added.

## Part 4 · Phase 4.3 — Request execution and limits

- Added callable execution that independently validates exact tenant/run/repository/PR/SHA/deployment/origin scope and operation grants. Mutations require explicit per-operation permission and disposable data. Cases are regenerated from immutable contract bytes rather than trusting externally mutable plans.
- Added bounded canonical HTTP serialization with explicit request-line/header/body accounting and conservative primitive parameter handling. Unsafe routing headers, path traversal, unrepresentable inputs and conversions that change logical validity remain explicit coverage limitations.
- Reused checked public IPv4 resolution with per-connection address pinning and HTTPS. Requests have no redirects, cookie jar, proxy integration or decompression. Literal loopback HTTP remains a code-level disposable-fixture mode only. Shared resolution now rejects bracketed IPv6 literals before lookup.
- Enforce sequential count/rate/deadline/per-request and aggregate byte ceilings, including safe-method-only bounded transport retries. Preserve failed-attempt reservations, stop on response overflow, rate limiting, cancellation or stale/unavailable authority, and revalidate context after rate waits and responses. Mutation attempts are never automatically retried.
- Use one trusted scoped bearer context for ordinary authenticated requests; missing/unsupported credentials and 401/403 remain inconclusive. Authentication-negative, role and ownership probes remain later phases. Validate declared responses through the existing bounded interpreter, distinguishing documented business rejections from server/schema failures and invalid inputs accepted with 2xx.
- Results contain fixed metadata, deterministic case IDs, digest and seed without retaining bodies, tokens or raw errors. Production orchestration, killable isolation/outbound broker, durable leases/whole-run budget reservations, state setup/cleanup and base attribution remain pending. Normal worker startup stays dispatch-only and the Docker diagnostic stays offline.

Next proposed phase: Part 4, Phase 4.4 — authentication probes. Stop before implementation.

### Phase 4.3 verification

All 120 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Fifteen new tests include real generated PawMart requests against healthy and seeded missing-address-500 servers, response schema/media/status failures, documented rejection handling, exact scope/mutation grants, missing credentials and metadata omission, request/body/aggregate limits, redirect denial, retries/rate spacing, callback/socket deadlines, cancellation and stale authority. An initial test syntax error and a direct-resolver IPv6 assertion were corrected; the full suite then passed. `npm run api:verify` exposes the same focused fixture suite, and CI's existing test step includes it. Fixture servers and in-memory state were discarded. No customer endpoint, real token, database migration, browser run, production consumer or hosted CI run was exercised. No dependency was added.

## Part 4 · Phase 4.4 — Authentication probes

- Added `executeApiAuthentication` through the existing bounded executor, preserving one shared budget for authenticated controls and negative requests. Exact run/deployment/origin/operation authority, disposable mutation grants, checked transport, cancellation and current-head checks remain required.
- Operation policy explicitly configures successful control statuses and a documented 401/403 rejection. A control must satisfy both the configured success status and response schema before missing or optional attested-invalid bearer credentials are tested. Business/setup failures suppress negatives; unrelated 400/404 responses never establish authentication enforcement.
- Added baseline-only planning without boundary mutations, preserving baseline IDs and baseline/schema/payload limits. Probe IDs separately bind the baseline, run/deployment/origin, expectation and probe kind. Returned metadata identifies control/missing/invalid variants without retaining credentials, headers, bodies or raw exceptions.
- Scoped trusted callbacks supply valid and optionally attested-invalid synthetic credentials. Invalid tokens identical to the control are refused. No token minting, JWT validity guessing, password guessing or real provider integration was added. Public/anonymous operations and unsupported scheme combinations do not execute probes; query/header/cookie parameter baselines remain conservative coverage gaps.
- Added a disposable PawMart `authentication-bypass` mode that treats API callers as Alice. Real generated GET/POST probes distinguish healthy 401 rejection from four accepted negative requests in the seeded defective target. POST controls and probes retain mutation/disposable-data permission and never automatically retry.
- Expanded `api:verify` and added `authentication:verify`; the existing CI workspace test step includes both suites. Normal startup remains dispatch-only and diagnostic Docker isolation remains offline. Customer orchestration/isolation, durable leases/whole-run reservations, cleanup/replay and role/ownership comparisons remain pending.

Next proposed phase: Part 4, Phase 4.5 — role and ownership probes. Stop before implementation.

### Phase 4.4 verification

All 135 unit/HTTP tests, workspace type checks and production builds, lint, formatting and whitespace checks passed. Fourteen new authentication tests exercise paired controls/negatives, seeded PawMart bypass detection, exact configured/schema-valid rejections, failed controls, anonymous/unsupported/ungranted operations, unavailable/unsafe/identical credentials, metadata omission, shared budgets, deadlines, cancellation/stale authority, redirects/rate limits, scope mismatches and mutation retry denial. A baseline-only regression test verifies unchanged deterministic baseline IDs without mutation gaps. An initial syntax error in a test fixture was corrected before the successful full test runs. Local servers and their disposable in-memory state were closed. No customer service, live credential, external identity provider, browser run, database migration, production consumer or hosted CI run was exercised. No dependency was added.

## Part 4 · Phase 4.5 — Role and ownership probes

- Added a callable GET/read-access authorization stage with independently scoped endpoint grants, explicit synthetic identity/role declarations and known resource/evidence bindings. Every identity and target endpoint must be granted; optional generator allowlists only narrow that authority. Mutations remain explicit unsupported gaps pending independent state readback/reset controls.
- Require two distinct scoped credentials, target-confirmed subject/role responses and successful allowed-access controls before a forbidden request. Ownership checks establish both subjects' own-resource bindings before cross-access; role checks establish protected content under the permitted role. Missing resources, unavailable credentials and failed controls cannot become passing authorization observations.
- Validate protected response schema and bounded configured evidence rather than treating bare 2xx as proof. A matching protected object returned with a denial status still establishes observed disclosure. Configured schema-valid 403/404 rejections pass only without proven disclosure. Other status/coverage outcomes remain explicit; no comprehensive audit or PR attribution is claimed.
- Extracted the existing attempt loop into shared `ApiRuntime` so boundary, authentication and authorization stages retain the same count/rate/wire/body/retry/deadline/current-authority rules. Controls and forbidden requests consume one stage budget. Caller contract/generator inputs are captured before asynchronous work; scope/grants are parsed into detached snapshots.
- Evidence output contains deterministic scoped scenario/case/baseline IDs, fixed codes, real statuses and match booleans. Tokens, subjects, roles, resource values, headers and response bodies are absent from returned evidence. Policy/fixture state remains necessary for replay; no durable finding or payload artifact is published.
- Added the public synthetic administrator, identity endpoint, protected report, separate authorization contract, and independently seeded role/ownership failures to PawMart. Extended the original order-owner response enum to keep administrator-created orders contract-valid. Added `authorization:verify` and included the new suite in `api:verify` and normal CI tests.
- Normal startup remains dispatch-only and the diagnostic Docker sandbox stays offline. Production isolation/outbound control, durable leases/whole-run reservations, customer identity providers, mutation verification and durable cleanup/evidence integration remain pending.

Next proposed phase: Part 4, Phase 4.6 — cleanup and reproducibility. Stop before implementation.

### Phase 4.5 verification

Verified 153 unit/HTTP tests: the full 152-test suite passed, then all 128 worker tests passed after the final immutable-input regression was added. Workspace type checks and production builds passed; the worker was rebuilt after that correction. Lint, formatting and whitespace checks passed. Eighteen new authorization tests cover healthy and seeded role/ownership failures, deterministic IDs, protected data under denial/alternate statuses, missing or mismatched evidence, identity/credential/resource scope, policy gaps, unsafe paths, mutation refusal, shared budgets, deadlines, cancellation/stale authority, redirects/rate limits, administrator response-contract consistency and caller mutation during async execution. Local fixtures were closed and their in-memory state discarded. No customer endpoint, real credential, external identity provider, database migration, browser run, production consumer or hosted CI run was exercised. No dependency was added.

## Part 4 · Phase 4.6 — Cleanup and reproducibility

- Added a callable lifecycle wrapper for each API stage, with detached input snapshots, unique scoped namespaces, provider-attested fixture/dataset/identity fingerprints, and bounded setup.
- Cleanup runs independently of execution cancellation and budgets, requires separate ownership authorization, and verifies an exact empty namespace receipt. Failed or unsettled cleanup prevents completion while preserving observations. Providers must fence aborted setup; durable crash recovery remains pending.
- Added an actual loopback PawMart adapter that resets the entire in-memory app, bounds ownership receipts, supports idempotent cleanup and prevents old namespaces from deleting newer state. It exposes no remote reset endpoint.
- Added private metadata-only replay capsules. Compatibility checks reject configuration or initial-state drift before test requests; fresh runs compare ordered semantic observations without retaining payloads or credentials. Divergence is explicit and does not imply PR attribution.
- Added lifecycle verification to the API suite and normal tests. No dependency, migration, production consumer or customer endpoint was introduced. Each call still owns a single-stage budget; whole-run reservations and production namespace adapters remain pending.

Next proposed phase: Part 5, Phase 5.1 — browser observation. Stop before implementation.

### Phase 4.6 verification

All 164 unit/HTTP tests passed, including eleven new lifecycle tests. Verification covers fresh-run replay, incompatible configuration and dataset fingerprints, outcome divergence, real created-order disposal and mutation replay, idempotent cleanup, cross-namespace protection, setup failure/mismatched receipts, cancellation, exhausted request budgets, denied/nonempty/timed-out cleanup and unsettled setup. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Local fixtures were closed. No customer request, live credential, database migration, browser run, production consumer or hosted CI run was performed. No dependency was added.

## Part 5 · Phase 5.1 — Browser observation

- Followed the small-phase table: this increment collects observations; the validated action executor remains Phase 5.2. The larger narrative combines these topics, but does not override the agreed small-phase ordering.
- Added a scoped callable observer with accessibility-oriented snapshots, masked viewport PNGs, monotonic capture times and diagnostic sequence numbers associated with trusted internal action IDs. Console errors, page exceptions, failed requests and 4xx/5xx responses retain fixed metadata without raw messages or URLs.
- Bounded capture count, UTF-8/PNG output bytes, diagnostic retention and combined capture deadlines. Missing or oversized captures and dropped events are explicit gaps. Cancellation, stale authority and failed authority checks withhold captures and close observation; concurrent captures are refused.
- Used the installed Playwright locator snapshot API and added a trusted page instrumentation hook to the existing restricted local smoke driver. No model action, new navigation grant or production consumer was introduced.
- Captures remain private, untrusted, in-memory synthetic fixture data. Masking is not general redaction; production isolation, durable artifact integration and whole-run budgets remain pending. Action markers show temporal correlation rather than proof of causation.
- Added unit coverage and real Chromium verification, with an observation verification script and CI integration after the existing browser install.

Next proposed phase: Part 5, Phase 5.2 — validated action executor. Stop before implementation.

### Phase 5.1 verification

All 171 unit/HTTP tests passed, including seven new observer tests. Real Chromium verification passed for accessible snapshots, viewport PNG capture, updated checkout state and action-correlated console errors, page exceptions, failed requests and 404/500 responses. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Initial sandbox runs could not bind local servers; verification succeeded with the required local execution permission. Browser, observer and server cleanup completed. No customer preview, live credential, model call, database migration or hosted CI run was exercised; no dependency was added.

## Part 5 · Phase 5.2 — Validated action executor

- Added strict navigate/click/fill/select/scroll/stop proposals with explicit immutable scope, accessible target/action grants and synthetic value references. Unknown fields, selectors, scripts, uploads and coordinates are rejected; coordinate execution remains unsupported rather than bypassing target policy.
- Added a disposable loopback Playwright executor that requires exact unique role/name or label matches. Destructive targets require explicit permission and disposable data. Network mutation grants are independent of target grants.
- Enforced exact request path/method/origin grants, top-level navigation allowlists, current authority and request counts. Redirects, subframe navigation, WebSockets, popups, dialogs, file inputs and downloads stop execution. Browser hooks remain fixture controls, not production egress isolation.
- Added sequential action/observation access, action and session deadlines, action limits, cancellation and browser cleanup. Uncertain actions close the session without retries. A completed interaction does not imply application success; asynchronous requests may fail later and stop the session.
- Added unit policy checks, real Chromium verification, scripts and CI integration. No model adapter, customer execution, dependency or migration was added.

Next proposed phase: Part 5, Phase 5.3 — model adapter and loop. Stop before implementation.

### Phase 5.2 verification

All 176 unit/HTTP tests passed, including five new policy tests. Real Chromium verification passed for accessible navigation/fill/select/scroll/click, observed created state, invalid and destructive proposals, denied mutation requests, redirect refusal, upload refusal, action budgets, stale authority, scope mismatch, cancellation and an action deadline with a stalled authority callback. The initial browser check exposed a fixture select-label mismatch; explicit label association corrected it without weakening exact matching. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Browser and local server cleanup completed. No customer endpoint, live credential, model call, migration or hosted CI run was exercised. No dependency was added.

## Part 5 · Phase 5.3 — Model adapter and loop

- Added a provider-neutral JSON model adapter with strict structured action/usage replies and bounded response text. No provider default, external model call, credential access or SDK dependency is introduced.
- Added a callable synthetic observation–proposal–validation–execution loop over the existing executor. It bootstraps a trusted initial path, verifies scope/current authority, passes private synthetic snapshots/images as untrusted input, accepts only an exact finite action menu or stop, and relies on the executor for independent permissions.
- Reserved full token ceilings before calls, capped calls and repeated exact actions, and bounded execution and cleanup waits. Unknown/unused reservations are not refunded. Provider-specific token enforcement and accurate usage remain trusted transport obligations, not claims of a verified vendor spend ledger.
- Executor ownership transfers to the loop, which closes it even after invalid configuration, cancellation or failures. Model stop is not application success; failed cleanup and incomplete work remain inconclusive. Returned records exclude model/page content and raw errors.
- Added unit failure coverage and real Chromium verification using a deterministic offline transport, plus scripts and CI integration. No claim of live-model reasoning quality or production isolation is made.

Next proposed phase: Part 5, Phase 5.4 — personas and budgets. Stop before implementation.

### Phase 5.3 verification

All 191 unit/HTTP tests passed, including fifteen new loop/adapter tests. Real Chromium with an offline deterministic transport verified observe → permitted checkout → changed-state observation → stop and browser cleanup. Tests cover malformed/oversized replies, invalid usage, ungranted proposals, repetitions, token/call limits, stale authority, cancellation, timeout, mismatched observations, unavailable observation, failed cleanup and invalid configuration cleanup. Workspace type checks, production builds, lint, formatting and whitespace checks passed. No live model/provider, customer capture, real credential, migration or hosted CI run was exercised. No dependency was added.

## Part 5 · Phase 5.4 — Personas and budgets

- Added explicit novice, impatient and unusual-input synthetic profiles to the loop. The impatient profile narrows time/call/repetition limits; unusual-input selection remains restricted to configured synthetic value references. Profiles do not grant actions or guarantee human-like behavior.
- Recognized keyboard-only requests as an explicit unsupported coverage gap without browser setup. The current executor lacks keyboard/focus actions; mouse substitution and accessibility claims are refused.
- Added a scope-bound process-local ledger shared by sequential fresh persona executors. Calls reserve full token/cost ceilings atomically; actions and network requests reserve before side effects. Failed/uncertain attempts retain reservations. Stop and cleanup do not consume action capacity.
- Added a shared wall-clock deadline spanning setup and persona execution, and caller-supplied estimated cost ceilings with no built-in provider prices. Persistent cross-worker budgets and verified provider billing remain pending.
- Added suite orchestration with detached configuration, current-authority checks, cancellation, fresh executor ownership and late factory cleanup. The trusted factory must wire the supplied ledger/signal into its executor; arbitrary ignored cancellation cannot be forcibly terminated in process.
- Added unit tests, real Chromium verification with offline transport, scripts and CI integration. No dependency, customer request, live model or migration was added.

Next proposed phase: Part 5, Phase 5.5 — controlled chaos. Stop before implementation.

### Phase 5.4 verification

All 201 unit/HTTP tests passed, including ten new persona/ledger tests. Real Chromium with an offline adapter verified two fresh persona sessions, the explicit keyboard-only gap, and exact shared request/action/token/estimated-cost reservations. Unit coverage includes atomic failed reservations, scope binding, detached counters, each capacity dimension, deadline expiry, cross-persona exhaustion, distinct profiles, impatient repetition limits, cancellation and invalid persona lists. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Browser and local server cleanup completed. No live model/provider billing, customer capture, real credential, migration or hosted CI run was exercised; no dependency was added.

## Part 5 · Phase 5.5 — Controlled chaos

- Added trusted exact-path/method request faults with matching ordinals, bounded injection counts and bounded delay. Faults run after authorization and shared request reservation; delayed requests recheck authority. Request-scoped offline and pre-dispatch navigation interruption do not weaken normal endpoint grants.
- Added validated explicit scripts for slow network, offline, navigation interruption, refresh navigation, repeated submission and synthetic boundary inputs. Repetition and refresh require matching target/path steps; no automatic mutation retry or model fault authority was introduced.
- Added a disposable fixture runner with fresh browser state, bounded network settling, final private capture, fixed action trace and planned/applied fault accounting. It closes the browser on every execution exit and reports cleanup failure. Server-state reset remains the caller's responsibility.
- All observations remain explicitly unconfirmed. Fault-induced errors are not application bug findings, and unused configured faults remain visible. Replay, repeatability and base/head attribution remain Phase 5.6 and later integration.
- Added unit plan tests, real Chromium checks for all six scenarios, scripts and CI integration. No dependency, live model, customer request or migration was added.

Next proposed phase: Part 5, Phase 5.6 — failure replay. Stop before implementation.

### Phase 5.5 verification

All 205 unit/HTTP tests passed, including four new fault-plan/script tests. Real Chromium verified bounded delay, request-scoped offline behavior, pre-dispatch navigation interruption, repeated same-path navigation, repeated submission and synthetic boundary values. Checks include actual server dispatch counts, final PNG capture where execution remains available, fresh browser cleanup and unchanged authorization for denied requests. Workspace type checks, production builds, lint, formatting and whitespace checks passed after removing an unused initialization; the worker was rebuilt afterward. No customer endpoint, live model, real credential, migration or hosted CI run was exercised. Results remain explicitly unconfirmed pending replay. No dependency was added.

## Part 5 · Phase 5.6 — Failure replay

- Added bounded repeated execution of explicit chaos scripts with fresh browsers and scoped lifecycle namespaces. Setup receipts must match scope and fixture/dataset/identity fingerprints; incompatible state stops before another browser attempt.
- Required independent authorized backend cleanup and matching empty receipts after every attempted setup. Unsettled setup, lost authority, incomplete captures and failed cleanup prevent confirmation and stop further replay.
- Added explicit trusted failure/success snapshot predicates and classifications for reproduced, not reproduced, unstable and inconclusive observations. Repeated predicate evidence does not imply causal or PR attribution; base attribution remains unavailable.
- Bound shared replay action/request reservations and total elapsed time across attempts. Returned metadata includes configuration/state digests, namespace IDs, outcomes and PNG hashes without page contents or assertion values. Durable artifacts and cross-worker recovery remain pending.
- Extended the PawMart lifecycle adapter to validated fault modes and browser/server/HTML/CSS fingerprints. Real replay exposed the need for literal asset paths; `.js`/`.css` paths now validate while dot-segment traversal remains forbidden.
- Added unit coverage, real healthy/seeded Chromium replay, changed-state refusal, scripts and CI integration. No dependency, customer execution, live model or migration was added.

Next proposed phase: Part 6, Phase 6.1 — finding schema. Stop before implementation.

### Phase 5.6 verification

All 214 unit/HTTP tests passed, including eight replay tests and a literal-asset/traversal regression. Real Chromium verified healthy PawMart controls, repeated seeded stuck-checkout observations, distinct fresh namespaces, verified backend cleanup and incompatible dataset refusal before the next browser run. Unit coverage includes mixed/incomplete classifications, setup failure, mismatched receipts, denied/nonempty/wrong-scope cleanup, unsettled setup and invalid assertions/policy scope. Workspace type checks, production builds, lint, formatting and whitespace checks passed. A lint-driven cleanup refactor was followed by all eight replay tests and a worker rebuild. No live model, customer capture, real credential, migration or hosted CI run was exercised. No dependency was added. PR attribution remains unavailable.

## Part 6 · Phase 6.1 — Finding schema

- Added an explicit v2 reporting contract while retaining the original unversioned scaffold schema. No unsafe automatic conversion fills missing legacy scope or evidence metadata.
- Separated confirmed failures, possible regressions, advisory observations and coverage gaps with distinct confidence/severity/reproduction/evidence requirements. Typed static/API/journey targets bind findings to their producing tier.
- Bound head evidence to tenant/run/repository/SHA/role, required unique private artifact references, and required compatible confirmation basis kinds. Baseline attribution requires independent base scope and a comparison artifact; other categories cannot claim established attribution.
- Added current-context validation for exact tenant/run/PR/SHA and evidence expiry, detached parse results, and bounded observed metrics with count consistency. Raw payload fields and unknown/public-URL attachment fields remain outside the contract.
- Explicitly documented that redaction attestations and artifact references are not proof of content, ownership or truth. Storage verification, finding emission, deduplication and publication remain later phases; no fabricated evidence is emitted from current replay results.
- Added contract tests and documentation. No dependency, migration, production consumer or external action was added.

Next proposed phase: Part 6, Phase 6.2 — deduplication. Stop before implementation.

### Phase 6.1 verification

Verified 223 distinct unit/HTTP tests: the full 222-test suite passed, followed by all nine finding-contract tests after the final evidence-tier regression was added. Coverage includes category distinctions, required confirmation evidence, cross-scope/duplicate references, expiry/current context, independent baseline evidence, contradictory metrics, strict fields, tier/target/basis consistency and detached parse results. Workspace type checks, production builds, lint, formatting and whitespace checks passed. No browser run was needed for these pure contracts. Test artifact references are synthetic and were not asserted to exist in storage. No customer data, external publication, migration or hosted CI run was exercised; no dependency was added.

## Part 6 · Phase 6.2 — Deduplication

- Added deterministic conservative grouping of v2 findings after current-context and evidence-expiry validation. Observation identity includes scope, environment, target, category, confidence/severity, narrative, ordered reproduction, basis kind and baseline scope; IDs, timestamps, reference ordering and metrics do not define observation identity.
- Collapsed exact repeated input IDs while retaining distinct equivalent records as sorted members. Conflicting finding-ID content or artifact-reference metadata rejects the entire batch. Full evidence, metrics, timestamps and reproduction details remain available; there is no lossy merge or confidence promotion.
- Added stable versioned group hashes, representative IDs, sorted evidence unions and category counts. Empty batches remain zero observations rather than passing verdicts. Metrics are retained, not summed across potentially overlapping records.
- Added explicit shared-evidence relationships across otherwise distinct groups without inferring causation or merging API/browser tiers. Fuzzy semantic correlation remains unsupported.
- Bounded input count and normalized bytes with explicit refusal rather than truncation. Outputs are detached from caller input. Added tests for ordering, retries, conflicts, scope/expiry, coverage gaps, evidence relationships and limits.
- No dependency, migration, artifact access, worker consumption or publication was introduced. Artifact truth/ownership verification remains a storage integration responsibility.

Next proposed phase: Part 6, Phase 6.3 — private artifacts. Stop before implementation.

### Phase 6.2 verification

All 232 unit/HTTP tests passed, including nine new deduplication tests. Coverage includes deterministic permutations, exact retries, evidence-order normalization, reproduction-order preservation, semantic/category/environment separation, finding/artifact ID conflicts, cross-tier shared evidence, retained metrics and coverage gaps, current scope/expiry, detached outputs, empty batches and explicit count/byte limits. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Tests use synthetic artifact references and do not claim storage verification. No browser run, customer data, migration, external publication or hosted CI run was needed; no dependency was added.

## Part 6 · Phase 6.3 — Private artifacts

- Added a separate local v2 artifact adapter with finding-compatible scoped references and reviewed-redacted JSON/PNG content envelopes. Earlier smoke artifacts retain their existing format and location.
- Enforced private directory/file permissions, no-follow exclusive temporary writes, non-replacing synced publication, per-run writer locks, size/complexity limits, seven-day maximum retention and a 50-artifact quota. Payload snapshots are captured before asynchronous writes.
- Added exact scoped reads that verify persisted bytes, digest, kind, expiry and all supplied reference metadata. Unsafe directories, symlink files, tampering, expired references and conflicting lookup metadata fail closed.
- Added authorized finding-reference verification, including independent checks for base-run evidence. It explicitly reports storage/reference verification without claiming semantic evidence truth or promoting finding confidence.
- Added scoped expiry pruning that only removes validated matching records and leaves other scope data untouched. Operator-private storage assumptions, crash reconciliation and redaction limitations remain documented.
- Added real-filesystem tests and documentation. No public URLs, hosted storage, database catalog, automatic deletion scheduler, production consumer or dependency was introduced.

Next proposed phase: Part 6, Phase 6.4 — Markdown report. Stop before implementation.

### Phase 6.3 verification

All 241 unit/HTTP tests passed, including nine new real-filesystem tests. Coverage includes private permissions, detached writes, persistent roundtrips, every scope dimension, forged references, payload tampering, symlink/permissive-file refusal, JSON/PNG/size/expiry constraints, writer locks, publication quota, scoped expiry pruning, missing artifacts and independent head/base authorization for findings. Workspace type checks, production builds, lint, formatting and whitespace checks passed. Temporary test storage was removed. No customer payload, hosted storage, public endpoint, browser run, migration or hosted CI run was exercised; no dependency was added. Semantic evidence verification remains explicitly unperformed.

## Part 6 · Phase 6.4 — Markdown report

- Added a callable private Markdown renderer over v2 finding deduplication and authorized artifact-reference verification. All records are verified even when output limits omit their groups; missing, expired, cross-scope or unauthorized evidence prevents rendering.
- Included immutable review context, reported progress, category counts, coverage/unaccounted checks, usage estimates, reproduction, expected/actual behavior, baseline status, retained member details and private evidence metadata. Empty findings or completed progress do not become passing verdicts.
- Rendered narrative fields as dynamically delimited literal code spans and flattened control/newline/directional characters. No raw payload, artifact URL, local path or inline image is emitted. Redaction and semantic truth remain producer/aggregator obligations, stated in the report.
- Ordered groups deterministically by category/severity/ID and bounded group count and UTF-8 output. Whole-section omissions yield explicit partial reports and omitted group IDs rather than silent truncation.
- Added cancellation/current-authority/expiry rechecks, a bounded verification wait, and real-artifact integration tests. No public publication, GitHub check, browser interaction, database mutation or dependency was added.

Next proposed phase: Part 6, Phase 6.5 — GitHub comments and checks. Stop before implementation.

### Phase 6.4 verification

All 249 unit/HTTP tests passed, including eight Markdown-report tests backed by real temporary artifact storage. Coverage includes deterministic retained groups/reproduction, literal hostile text, empty/missing coverage, group/byte omissions, verification of omitted records, unauthorized/missing references, cancellation/stale authority, invalid scope/counters and explicit usage estimates. Workspace type checks and production builds passed. Lint flagged control-character regex syntax; replacing it with explicit code-point checks preserved behavior, and all eight report tests, lint, formatting, whitespace checks and a worker rebuild passed afterward. Temporary artifact storage was removed. No customer data, public report, GitHub API call, browser run, migration or hosted CI run was exercised; no dependency was added.

## Part 6 · Phase 6.5 — GitHub comments and checks

- Added an explicitly callable GitHub App reporter with scoped repository tokens, canonical repository resolution and current open same-repository PR/SHA checks. Existing ingress tokens remain read-only; no normal worker or public endpoint invokes publication.
- Required separate publication approval for reviewed Markdown, monotonic revisions, phase transitions and explicit success-coverage/blocking-failure policy. Private report generation does not imply approval to publish.
- Added owned marker/external-ID reconciliation and tracked comment/check updates. Remote scans are bounded; foreign-App markers, ambiguous matches and changed tracked identities cannot be adopted or overwritten.
- Added a private synced local journal with intended revision/digest, remote IDs and pending creates. Lost create responses reconcile or remain uncertain without blind POST retries; concurrent local writers serialize. Tokens and report bodies are absent from the journal.
- Checked current GitHub API documentation and verified real Octokit request/auth paths with synthetic transport. No live GitHub mutation was performed. Distributed leases, production consumers, live permission verification and stale-result repair remain pending.
- Preserved the pre-existing generated web type declaration change while implementing API-only behavior. No dependency or database migration was added.

Next proposed phase: Part 6, Phase 6.6 — stale-result handling. Stop before implementation.

### Phase 6.5 verification

All 257 tests passed, including eight new synthetic-transport GitHub reporting tests. Coverage includes lifecycle updates, identical retries, lost create responses, uncertain delivery, foreign-App ownership, stale authority/SHA, publication policy, revision conflicts and concurrent local writers. Workspace type checks, production builds, lint, formatting and whitespace checks passed. The pre-existing generated web declaration change was restored after the build. No live GitHub mutation, customer data, browser run, database migration or hosted CI run was exercised; no dependency was added. Production wiring and stale-result repair remain pending.
