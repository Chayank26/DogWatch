# DogWatch

Autonomous AI QA for opted-in GitHub pull requests. This repository contains GitHub ingress, durable queue dispatch and callable Tier 0 analysis, smoke checks, base comparison and local evidence storage. Production customer QA execution is not enabled yet.

## Local setup

Use Node.js 24 LTS and npm 11.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000 for the website. The API health endpoint is http://127.0.0.1:4000/health. The worker dispatches saved runs to Redis when both service URLs are configured; otherwise it reports that dispatch is disabled. It does not execute QA jobs yet. The website/API scaffold still needs no credentials or data services. Local Postgres/Redis and migration tools are now available separately; follow [database setup](packages/database/README.md). API/worker environment-file loading is not implemented yet.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

After building, start applications independently with `npm run start -w @dogwatch/web` or `npm run start -w @dogwatch/api`.

## Phase workflow

Complete one small phase, update `tech.md`, `direction.md`, and `flow.md`, report verification and a suggested commit message, then wait for approval before the next phase. See `ROADMAP.md` for the implementation sequence.

## Architecture and security design

See the [architecture decisions](docs/architecture/README.md) for choices and alternatives, and the [threat model](docs/security/THREAT_MODEL.md) for trust boundaries, planned controls, and phase-specific verification. These documents distinguish existing behavior from future security requirements.

## Synthetic target and CI

Run `npm run fixture:dev` separately and open http://127.0.0.1:4100 for PawMart's disposable checkout. See the [fixture guide](apps/fixture/README.md) for healthy/fault modes and synthetic tokens. This is a testing target, not the DogWatch dashboard.

The [CI guide](docs/development/CI.md) explains the automated checks and local equivalents. GitHub-hosted execution begins after pushing the workflow; it has not been triggered by creating these local files.

## GitHub webhook foundation

The API now exposes a validation-only `/webhooks/github` endpoint. See [App setup and endpoint behavior](docs/github/APP_SETUP.md). No live App is registered, and verified deliveries do not yet create QA runs.

Authorization/event filtering can now be enabled separately with protected local policy and App credential files. See the [authorization guide](docs/github/AUTHORIZATION.md). Eligible decisions remain unqueued and unpersisted.

Durable acceptance is now available with explicit database configuration. See [deduplication and outbox setup](docs/github/DURABLE_ACCEPTANCE.md). Accepted runs are saved and can be queued by the configured background dispatcher.

## Queue dispatcher

With both DATABASE_URL and REDIS_URL exported, the runner now dispatches accepted outbox work to BullMQ. See the [queue guide](packages/queue/README.md). Real QA consumption remains disabled. Run `npm run queue:verify` to exercise the isolated local queue/database integration.

## Stop unfinished runs

With the authorized durable API configured, an allowed human actor can post `/dogwatch cancel` on a PR to cancel unfinished runs for its current SHA. Authorized `pull_request.synchronize` notifications supersede unfinished older heads without creating a new run. Redis jobs/history remain retained; production QA execution and abort propagation are future phases. See [current user flow](flow.md) and [decisions](direction.md) for scope and freshness limits.

## Preview readiness

An explicitly callable preparation stage now validates exact-SHA deployment bindings, polls bounded health checks, and saves readiness evidence while respecting stop signals. Normal startup still dispatches only; isolated QA consumption comes next. See [worker guide](apps/worker/README.md). Run `npm run preview:verify` against local Postgres to verify the disposable HTTP fixture.

## Worker isolation

`npm run sandbox:build` builds the trusted, digest-pinned offline diagnostic image. `npm run isolation:verify` checks actual Docker resource/security settings, restricted filesystem/network access, secret absence, and deadline/cancellation cleanup. See [worker guide](apps/worker/README.md). Production QA consumption remains disabled; this sandbox accepts no repository scripts or customer commands.

## Import and symbol analysis

Part 3.2 adds callable, bounded JS/TS snapshot analysis with symbols, module dependencies and conservative affected-module selection across merge-base/head commits. Unsupported or incomplete analysis produces explicit coverage gaps. See the [worker guide](apps/worker/README.md) for limits and caller responsibilities. Immutable source retrieval and isolated parsing orchestration remain pending; normal startup does not fetch or analyze customer source.

## Smoke journeys

Part 3.4 adds a bounded callable smoke runner and real Chromium verification against the disposable PawMart fixture. After `npx playwright install chromium`, run `npm run smoke:verify`. Healthy checkout and seeded failures are checked with a maximum 20-second execution budget. See the [worker guide](apps/worker/README.md) for outcomes and boundaries. Production customer-browser execution remains disabled; base comparison and durable artifact evidence come next.

## Base comparison and evidence

Part 3.5 compares compatible exact-SHA smoke records and persists private, scope-bound local evidence with sanitized traces and optional masked fixture screenshots. Run `npm run baseline:verify` after Chromium setup to verify new/pre-existing attribution and durable artifact readback. Missing or incompatible baselines remain explicit. See the [worker guide](apps/worker/README.md) for access, retention and production limitations.

## API contract validation

Part 4.1 adds callable validation of a bounded OpenAPI 3.0 JSON/YAML profile, including local schema references, operation parameters, JSON bodies/responses and security requirements. Unsupported contracts return explicit diagnostics and no operation inventory. The [contract guide](apps/worker/CONTRACTS.md) explains supported features and limits. Case generation and API execution follow in later phases; no customer requests are sent yet.

## Deterministic API cases

Part 4.2 adds seeded logical boundary-case plans with optional synthetic fixtures, operation priority/allowlists, deduplication and explicit count/payload limits. Valid and invalid inputs stay distinct; cases are not API verdicts or execution permission. See the [boundary case guide](apps/worker/BOUNDARY_CASES.md). Part 4.3 adds callable scoped execution with mutation grants, bounded HTTP serialization, rate/retry/deadline/byte limits and response observations. Run `npm run api:verify` against disposable local fixtures; see the [API execution guide](apps/worker/API_EXECUTION.md). Part 4.4 adds configured authentication probes with authenticated controls, missing/attested-invalid bearer contexts and shared execution budgets. Run `npm run authentication:verify`; see the [authentication probe guide](apps/worker/API_AUTHENTICATION.md). Part 4.5 adds read-only role/ownership probes with two verified synthetic identities and protected-response evidence. Run `npm run authorization:verify`; see the [authorization guide](apps/worker/API_AUTHORIZATION.md). Part 4.6 adds scoped disposable cleanup and metadata-only replay. Run `npm run lifecycle:verify`; see the [lifecycle guide](apps/worker/API_LIFECYCLE.md). Production consumption and durable crash recovery remain pending.

Part 5.1 adds bounded private browser observations and action-correlated diagnostics for synthetic fixtures. Run `npm run observation:verify`; see the [browser observation guide](apps/worker/BROWSER_OBSERVATION.md). Exploratory action execution and model integration remain pending.

Part 5.2 adds validated actions for disposable browser fixtures with accessible target grants, synthetic value references and request policy. Run `npm run actions:verify`; see the [browser action guide](apps/worker/BROWSER_ACTIONS.md). Model integration and production execution remain pending.
