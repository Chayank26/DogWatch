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
