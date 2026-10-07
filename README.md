# DogWatch

Autonomous AI QA for opted-in GitHub pull requests. This repository currently contains the completed Part 1 foundation, shared contracts, local data services, CI, and a synthetic QA fixture, not a working QA service.

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
