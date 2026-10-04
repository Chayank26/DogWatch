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
