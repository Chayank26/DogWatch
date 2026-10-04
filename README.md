# DogWatch

Autonomous AI QA for opted-in GitHub pull requests. This repository currently contains the Phase 1.4 foundation, shared contracts, and local data services, not a working QA service.

## Local setup

Use Node.js 24 LTS and npm 11.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000 for the website. The API health endpoint is http://127.0.0.1:4000/health. The worker prints its scaffold status; it does not consume jobs yet. The website/API scaffold still needs no credentials or data services. Local Postgres/Redis and migration tools are now available separately; follow [database setup](packages/database/README.md). API/worker environment-file loading is not implemented yet.

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
