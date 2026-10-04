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
