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
