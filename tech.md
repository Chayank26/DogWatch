# Technology decisions by phase

## Part 1 · Phase 1.1 — Initial project setup

| Technology                          | What it does now                                                                   | Why selected / alternatives                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js 24 and TypeScript           | Run the API and worker; check application types.                                   | One language across the stack. Python could serve the agent, but adds a second toolchain before it is needed.                                                            |
| npm workspaces and lockfile         | Install dependencies and run app scripts from the root.                            | npm is already installed. Replaces the proposed pnpm default to avoid an extra setup prerequisite; pnpm remains an option if workspace scale justifies migration.        |
| Express                             | Serve `/health` on the local API.                                                  | Matches the master architecture and gives direct control over future raw webhook bodies. Fastify is a reasonable alternative, but is unnecessary for this foundation.    |
| Next.js and React                   | Serve an informational web page with metadata and responsive CSS.                  | Establish the planned dashboard framework. Vite would make a smaller client-only shell, but would need separate decisions for future authenticated routes and rendering. |
| Plain CSS                           | Style the initial page.                                                            | This small page does not need a utility framework yet. Tailwind remains proposed for the expanded dashboard.                                                             |
| tsx and concurrently                | Reload TypeScript entry points and run all three app development processes.        | Avoid building before each edit. Separate terminals are possible; one command makes local setup simpler.                                                                 |
| ESLint, Prettier, TypeScript checks | Check code issues, consistent formatting, and types.                               | Complementary checks rather than application tests that merely repeat this scaffold.                                                                                     |
| Git and `.gitignore`                | Prepare local version tracking and exclude dependencies, builds, and secret files. | No commit or remote was created.                                                                                                                                         |

No database, Redis, browser automation, model API, authentication, or GitHub integration is installed in this phase. Those enter when a phase implements their first real use. Exact dependency versions are recorded in `package-lock.json`.

## Part 1 · Phase 1.2 — Domain contracts and opt-in policies

| Technology                | What it does in this phase                                                                                                   | Why selected / alternatives                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod                       | Validates repository policy, normalized trigger events, budgets, run requests, and findings; derives their TypeScript types. | TypeScript alone cannot validate incoming JSON. Ajv fits OpenAPI/schema validation later, but Zod keeps application types and validation together with less duplication now. |
| Shared TypeScript package | Gives future API and worker consumers one vocabulary and a pure opt-in evaluator.                                            | Duplicating definitions in each app risks disagreements. It is not yet wired into either app.                                                                                |
| Node test runner with tsx | Runs behavior tests for opt-in authorization, scope, commands, and contract validation.                                      | These synchronous unit tests do not need Vitest-specific mocking or a browser environment. Vitest remains an option when application testing needs justify it.               |

JSON cannot contain comments, so package and compiler configuration is explained in `packages/README.md`. New source and test files include detailed comments. Generated JavaScript is build output, not a second source to edit manually.

## Part 1 · Phase 1.3 — Threat model and architecture decisions

No new runtime tool or dependency was added. Markdown decision records explain how the existing Express/Next.js/worker separation will grow, why Postgres plus a BullMQ/Redis outbox is planned, and why runtime Zod validation must be combined with actual authorization. Alternatives include a single server, GitHub Actions execution, Redis-only persistence, dynamic collaborator checks, and unrestricted model automation; their tradeoffs are recorded rather than introducing them prematurely.

A Markdown threat matrix links risks to implementation phases and required evidence. A separate security tracking service could manage these requirements later, but repository documentation is easy to review alongside this project's code. Containers, private object storage, secret management, and network enforcement remain planned controls, not installed capabilities. The documents add no requests, storage, or UI behavior.

## Part 1 · Phase 1.4 — Local Postgres/Redis and migrations

| Technology                       | Current purpose                                                                                      | Why this choice / alternatives                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose                   | Starts two local data services with health checks, loopback ports, and persistent named volumes.     | Avoids machine-specific native database installs. Managed services are suitable later but would require accounts and remote credentials now. |
| PostgreSQL 17                    | Stores the initial tenant/installation/repository/run/outbox relations and enforces constraints.     | Relational transactions support the planned durable outbox; SQLite would not exercise the intended Postgres behavior or future policies.     |
| Redis 7                          | Provides a local health-checked future BullMQ backend, with append-only persistence and no eviction. | Matches the master queue architecture. An in-memory array would not model queue recovery. Queue execution itself is still deferred.          |
| Prisma 7, PostgreSQL adapter, pg | Generate typed access and manage versioned SQL migrations; provide an explicit client factory.       | Matches the roadmap. Direct SQL offers control but requires manually maintaining query types; custom constraints remain explicit SQL.        |
| dotenv                           | Loads the root local environment file for database CLI and verification only.                        | Consistent file resolution regardless of workspace working directory. Shell-only exports work too, but are less convenient for local setup.  |

Configuration follows the [official Prisma 7 setup](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction). New TypeScript, Prisma, SQL, and Compose files explain their intent inline; JSON settings are explained in the database README. Local credentials are fixtures, not deployable secrets. No runtime connection was added to the website.

## Part 1 · Phase 1.5 — CI and fixture application

| Technology                    | What it does now                                                                           | Why selected / alternatives                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions                | Defines read-only verification and disposable data-service jobs on pushes/PRs.             | Matches the repository workflow. Jenkins or another CI service would add hosting/account setup without a need in this project. Hosted execution is pending push. |
| Existing Docker Compose       | Gives CI the same Postgres/Redis definitions as local development.                         | Separate service definitions are supported but could drift; a hosted runner can use Compose directly.                                                            |
| Express and TypeScript        | Serve the synthetic shop, API, process-selected fault modes, and typed browser handler.    | Reuses existing dependencies. Another Next.js application would be heavier for a deliberately small target.                                                      |
| Native HTML/CSS/browser fetch | Provide labeled checkout controls, same-origin requests, and live status feedback.         | Avoids dependencies or CDN traffic in a deterministic fixture. React is useful for the product dashboard, but unnecessary for this target.                       |
| Node test runner and fetch    | Exercise real fixture HTTP requests, validation boundaries, authentication, and ownership. | No extra HTTP testing library is necessary. Real-browser Playwright assertions remain part of later browser phases.                                              |
| OpenAPI YAML                  | Defines healthy request/response expectations for later API fuzzing.                       | A contract is more useful than guessing endpoints. The document covers the order API, not fixture setup/static routes.                                           |

No runtime dependency was added: the fixture uses the existing Express version. Root workspace/lockfile metadata now includes it. Source, HTML, CSS, workflow, and contract files include explanatory comments; JSON settings are documented in the fixture guide. CI choices follow [setup-node](https://github.com/actions/setup-node) and [GitHub's container guidance](https://docs.github.com/en/actions/tutorials/use-containerized-services).

## Part 2 · Phase 2.1 — GitHub App configuration and raw-body verification

| Technology                 | Current role                                                                    | Why chosen / alternative                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node crypto                | HMAC-SHA256 and constant-time digest comparison.                                | Built-in primitives suffice for this narrow boundary. Octokit webhooks is an alternative once dispatch/auth integration needs justify it; no extra dependency is needed now. |
| Express raw middleware     | Captures original bounded JSON bytes before parsing; rejects compressed bodies. | Re-serializing parsed JSON changes whitespace/encoding and can break signatures. Route-local parsing protects the future app from middleware ordering mistakes.              |
| Node test runner and fetch | Tests the independent official vector and real HTTP rejection paths.            | Reuses the existing toolchain and tests behavior rather than merely the crypto formula.                                                                                      |
| GitHub App setup guide     | Specifies minimal initial grants, endpoint setup, and deferred permissions.     | Registration cannot be truthfully automated without account/endpoint configuration. A guide makes the result concrete without inventing external state.                      |

No new dependencies were installed. The API uses a shell-provided webhook secret, distinct from App private keys; automatic environment-file loading is still deferred. The verifier follows [GitHub's official guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
