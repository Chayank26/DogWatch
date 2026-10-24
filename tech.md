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

## Part 2 · Phase 2.2 — Authorization and event filtering

| Technology                                 | Current role                                                                                                              | Why selected / alternatives                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Octokit and @octokit/auth-app              | Authenticate as the App, check installation state, create a repository-restricted read token, and resolve the current PR. | Matches the planned GitHub integration and avoids handwritten JWT/token protocol code. Direct fetch is possible but would duplicate authentication handling.       |
| Shared contracts workspace                 | Reuses trusted policy validation and the existing opt-in evaluator inside ingress.                                        | Avoids implementing a second set of eligibility rules. API lifecycle hooks build its ignored generated output before consumers run.                                |
| Zod in the API                             | Parses the needed GitHub payload subset, safe numeric IDs, and operator policy arrays.                                    | GitHub payloads contain extra fields, so remote objects are stripped rather than using strict internal-schema rejection. Ad-hoc casts would miss malformed inputs. |
| Protected local JSON/PEM files             | Bootstrap explicit tenant/repository/actor policy and App authentication without a fake onboarding UI.                    | A database-backed policy service is the eventual direction; creating its whole UI/storage lifecycle would cross the current phase boundary.                        |
| Injected resolver/transport and Node tests | Exercise authorization and real SDK request behavior without credentials or external calls.                               | Live GitHub tests require account setup and can be brittle; mocks here assert scope and permission behavior, while live validation remains pending.                |

All new code includes detailed comments; example JSON is explained in the authorization guide. Real private keys and local policy files are ignored by Git. [GitHub's installation authentication documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) describes the underlying credential flow.

## Part 2 · Phase 2.3 — Delivery deduplication and transactional outbox

| Technology                           | Current role                                                                      | Why chosen / alternative                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres transactions/unique indexes | Commit a receipt, run, and outbox together; arbitrate concurrent delivery copies. | In-memory locks fail across processes/restarts. Redis-only deduplication would not share an atomic transaction with persistent run records.                                 |
| Prisma with parameterized SQL        | Provide typed writes and a shared repository-row lock for ownership consistency.  | Existing ORM avoids duplicate access code; a tagged SQL query handles the explicit lock that ordinary reads do not provide.                                                 |
| Node SHA-256                         | Fingerprint authenticated raw bytes independently of unsigned delivery headers.   | Delivery-ID uniqueness alone allows changing a header to replay a captured body. Exact-body hashing is conservative and does not replace HMAC or semantic request identity. |
| Database integration verification    | Test real concurrency, rollback, conflicts, ownership, and replay behavior.       | Unit mocks alone cannot establish Postgres uniqueness/transaction behavior. HTTP tests separately verify the acknowledgment boundary.                                       |

No third-party runtime package was added. API now consumes the database workspace, whose lifecycle scripts build shared contract output. The additive SQL migration and new source files carry comments. Redis remains unused by ingress until dispatch is implemented.

## Part 2 · Phase 2.4 — Queue dispatch and retries

| Technology                         | Current role                                                                                | Why selected / alternatives                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ and ioredis                 | Store stable run jobs in Redis with processor backoff, retention, and concurrency controls. | Matches the master specification; a custom Redis queue would duplicate scheduling/lock/retry logic. The installed BullMQ requires its optional ioredis driver explicitly.               |
| PostgreSQL locked outbox selection | Divide due work across dispatchers and persist success/attempt metadata.                    | SKIP LOCKED avoids an in-memory leader. Holding a bounded network call inside the transaction is simpler initially than a lease/reclaim protocol, with throughput tradeoffs documented. |
| Zod UUID reference schema          | Limit queue data to tenant/run identity and reject malformed jobs.                          | Credentials/source in job data would widen exposure; valid IDs still require future authoritative worker checks.                                                                        |
| Integration verification           | Exercise actual Redis/Postgres crash-window handoff, retries, and concurrency.              | Pure mocks cannot establish queue identity, locks, and delayed retry behavior.                                                                                                          |

New code and SQL contain detailed comments. Queue defaults follow [BullMQ connection](https://docs.bullmq.io/guide/connections) and [retry documentation](https://docs.bullmq.io/guide/retrying-failing-jobs). Production execution remains disabled; only dispatch now runs when configured.

## Part 2 · Phase 2.5 — Cancellation and supersession

Postgres stores the stop signal in the existing RunState enum. Prisma conditional updates restrict stopping to unfinished states and the owning repository, PR, and SHA. Repository row locks serialize acceptance with stop operations; Redis-only cancellation would lose this authority on queue recovery. No schema migration or new dependency is needed. Zod validates direct service callers as well as webhook inputs. Signed GitHub comments supply cancellation until authenticated dashboard controls exist; a browser button without membership authentication would be premature.

The API fetches current GitHub context for synchronize notifications rather than trusting the SHA in a delayed webhook. Synchronize is a stop-only operation and does not add a new opt-in trigger. The worker integration verifies that stopped outbox records are not enqueued. Queued records remain retained; a future executor must check durable state before stages and poll it to abort ongoing browser/HTTP operations.

## Part 2 · Phase 2.6 — Preview readiness

| Tool                        | Purpose in this phase                                                                                              | Why this choice over alternatives                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node HTTP/HTTPS and DNS     | Probe approved health URLs with checked, pinned IPv4 destinations, TLS identity verification, and discarded bodies | Explicit socket lookup permits address pinning; a bare fetch wrapper would need a custom dispatcher to enforce the same DNS boundary. No browser is necessary for readiness. |
| Zod                         | Validate immutable deployment bindings and forbid credential/query-bearing URLs before persistence                 | TypeScript alone cannot validate operator JSON. Reuses our existing schema library.                                                                                          |
| AbortSignal and timers      | Bound setup and individual attempts; respond to stop signals                                                       | Fixed unbounded polling can hang workers or exhaust a budget.                                                                                                                |
| Prisma/Postgres             | Claim setup conditionally and record deployment context, readiness timestamp, probe count, and fixed failure codes | Redis-only readiness evidence would weaken durable history and stop coordination.                                                                                            |
| Node tests and HTTP fixture | Test destination boundaries and real polling/database stop races                                                   | No live preview provider credentials or brittle external DNS are needed for reproducible verification.                                                                       |

The customer dashboard stays unchanged. Readiness is an explicitly callable worker stage until isolated consumption is implemented. Public IPv4 HTTPS only is the current production transport scope; redirects and IPv6 are denied. This is not a replacement for container/browser egress restrictions. See [worker guide](apps/worker/README.md) for configuration fields and runtime limits.

## Part 2 · Phase 2.7 — Worker isolation

| Tool/control                          | Purpose                                                                                                                           | Why this choice over alternatives                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Digest-pinned Node Docker image       | Package a trusted, dependency-free diagnostic runtime in a tiny allowlisted build context                                         | A full monorepo image would unnecessarily include credentials/configuration and control-plane code. Customer Dockerfiles are not trusted build inputs.                                 |
| Docker resource/security flags        | Enforce non-root execution, dropped capabilities, read-only root, fresh bounded tmpfs, CPU/memory/process limits, and zero egress | Child processes alone share host files and networking. Kubernetes/gVisor could provide later operational or stronger isolation but add platform scope before the first QA tier exists. |
| Node execFile                         | Start fixed Docker argv and force exact-container cleanup with bounded deadlines/output                                           | Shell strings allow argument interpolation and injection. No customer commands are accepted.                                                                                           |
| Zod                                   | Reject extra task fields and require verified boolean isolation evidence                                                          | Type annotations cannot validate stdin/output or reject command/env/image overrides.                                                                                                   |
| Docker inspection plus runtime probes | Verify actual engine settings, restricted writes, metadata denial, secret absence, and timeout/cancellation cleanup               | Merely checking the argument array would not prove the daemon applied the controls.                                                                                                    |

The website stays unchanged. This sandbox is offline and runs diagnostics only; no QA consumer, Playwright network access, repository scripts, or secret injection is enabled. The host has Docker authority; the container has no socket. Outbound API/browser stages require a future enforced destination gateway rather than broad network access. See [worker guide](apps/worker/README.md) for limits and recovery obligations.

## Part 3 · Phase 3.1 — Immutable diff retrieval

Uses native fetch and Zod for a fixed GitHub API origin, immutable SHA parameters, strict change metadata, a five-second deadline and a 2 MiB streaming ceiling. A git clone would add checkout/script and disk scope; the existing token-minting authority remains with trusted callers. No new dependency is needed. GitHub comparison limits are exposed rather than interpreted as complete coverage.

## Part 3 · Phase 3.2 — Import and symbol graph

Uses the TypeScript compiler parser as a worker runtime dependency to analyze supplied immutable JS/TS snapshots without executing source, reading repository configuration, or installing dependencies. Extracts top-level symbols, export names, relative import/re-export edges, and reverse dependency impact across merge-base and head snapshots. Zod validates tenant/repository/SHA scope, paths and input budgets. Node tests cover transitive consumers, barrels, cycles, renamed/deleted modules, merge-base identity, ambiguity, syntax gaps and unsafe inputs.

Limits: 100 files, 256 KiB per file, 2 MiB total source, and 50,000 visited AST nodes per file. Unsupported languages, aliases/external imports, dynamic/CommonJS dependencies, namespaces, generated files and incomplete snapshots produce explicit gaps and widen impact to all supplied modules. This is a syntactic module approximation, not a semantic call graph. Source retrieval, process-level parser isolation, persistence and execution orchestration remain pending; no customer source is automatically fetched or parsed.

## Part 3 · Phase 3.3 — Route impact mapping

Added `mapRouteImpact` and strict Zod schemas for operator-owned, tenant/repository/SHA-bound mappings to route paths, API method/path pairs and named critical journeys. Uses Phase 3.2 reverse dependency impact from merge-base/head graphs. Results preserve both snapshot identities and explain selection with matched modules, critical-baseline and coverage-widening reasons. Uses existing Zod and Node tests; no framework discovery or new dependency is needed.

Maps up to 200 targets per snapshot with up to 100 module paths each. Incomplete mappings, unknown mapped modules and affected modules without a mapping widen selection to all supplied targets and retain explicit gaps. Paths are test-selection labels only; they do not authorize requests, instantiate dynamic route parameters or configure preview destinations. No source fetching, browser execution or persistence is added.

## Part 3 · Phase 3.4 — Smoke journeys

| Tool                                  | Purpose and choice                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright Chromium                   | Real disposable browser navigation, interaction and assertions against PawMart; a DOM mock would miss browser/server failures. Installed as a worker runtime dependency, with browsers explicitly installed for verification/CI. |
| Zod                                   | Strict journey/action schema, immutable run scope, safe navigation labels and finite execution/step limits. No scripts or arbitrary evaluation are accepted in plan JSON.                                                        |
| AbortController                       | Bounds all actions and current-authority callbacks by at most 20 seconds, excluding preview/browser setup; cleanup uses a separate three-second deadline.                                                                        |
| Node tests and local fixture verifier | Reproducible healthy/seeded failure behavior, dependencies, diagnostic counters and stop/setup distinctions without live credentials or customer requests.                                                                       |

The runner returns metadata evidence and explicit unavailable-baseline attribution. Raw diagnostics, credentials and DOM/response bodies are not returned. Fill/select steps reference ephemeral driver-owned values. A fixture-only browser adapter blocks service workers, redirects and other origins; this is not a production egress boundary. Production isolated browser execution, enforced request accounting, durable artifacts and baseline comparison remain pending. Added root/workspace smoke verification scripts and CI browser installation/verification.

## Part 3 · Phase 3.5 — Base comparison and evidence

| Tool/control                          | Purpose and choice                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod evidence schemas                  | Validate exact snapshot/run scope, sanitized trace consistency, bounded screenshots, version and expiry before attribution/storage. Existing library avoids adding another validation format.               |
| SHA-256 plan/content digests          | Bind compatible journey/scenario configuration and detect local artifact corruption. Digests are not authorization or proof that a deployment matches source.                                               |
| Playwright masked viewport screenshot | Retain final synthetic fixture UI context without persisting raw browser traces, request payloads or account fields. A screenshot remains sensitive; arbitrary echoed text is not generically redacted.     |
| Node filesystem primitives            | Local private evidence bundles, 0700/0600 permissions, exclusive writes, fsync and atomic non-replacing publication. No cloud account or public hosting is needed to verify durable evidence in this phase. |
| Node tests and real Chromium          | Check conservative new/pre-existing attribution, scope isolation, retention, file integrity, screenshot masking and persisted readback using disposable fixtures.                                           |

The comparator uses operator-attested scenario compatibility and the normalized executor/journey/budget fingerprint. Matching base success permits observed-regression attribution; matching configured failures permit pre-existing-check classification, while aggregate browser counters alone remain inconclusive. Absent or incompatible baseline context never becomes a pass. Evidence stores action kinds/counts and fixed diagnostics rather than raw selectors, values, DOM or HTTP content. Added `baseline:verify` to root/worker scripts and CI; no new dependency, database migration, customer source retrieval, hosted artifact service or production consumer was added.

## Part 4 · Phase 4.1 — Contract validation

| Tool                         | Purpose and choice                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML 2                       | Parse JSON and YAML 1.2 with duplicate-key diagnostics; inspect the bounded syntax tree before conversion and reject aliases/tags. JSON.parse alone silently accepts duplicate keys and cannot read the existing fixture YAML.               |
| Ajv 8 and ajv-draft-04       | Compile a trusted static OpenAPI document schema, with first-error checking and metadata formats disabled. Customer Schema Objects are data; no async schema loading or customer validation code is compiled.                                |
| @apidevtools/openapi-schemas | Use the bundled OpenAPI 3.0 document structure instead of hand-maintaining its full grammar. Profile/semantic checks remain explicit in our normalizer. A general dereferencer was avoided because this phase must never read URLs or files. |
| Zod and SHA-256              | Validate immutable caller context and bind the normalized inventory to the original contract bytes. Neither grants ownership, source provenance or network access.                                                                           |
| Node unit tests              | Verify the real PawMart contract and malformed/unsupported synthetic documents without a server, browser, database or credentials.                                                                                                           |

Added strict all-or-nothing normalization for operations, parameter inheritance, local refs, JSON request/response schemas and supported security requirements. Schema/operation expansion has explicit bounds. Servers/examples/defaults/descriptions are omitted; fixed diagnostics never return raw source/errors. Regex syntax is checked without executing matches. This profile does not imply complete OpenAPI conformance or schema satisfiability. Case generation, ranking, request/response execution, credentials and isolated hostile-document processing remain later work. See [contract guide](apps/worker/CONTRACTS.md).

## Part 4 · Phase 4.2 — Deterministic boundary cases

| Tool/technique                              | Purpose and choice                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing OpenAPI validator                  | Revalidate immutable source text and obtain a supported inventory before generating cases; no unchecked public inventory input is accepted.                            |
| Bounded value interpreter                   | Check modeled JSON constraints without compiling customer schemas or running arbitrary regexes. Unknown semantics produce coverage gaps instead of guessed validity.   |
| Canonical JSON and SHA-256                  | Deterministic seeded values, per-operation request deduplication and context/contract-bound case IDs. Each emitted request is detached from shared baseline data.      |
| BigInt decimal arithmetic / adjacent floats | Check JSON-number multiples exactly and generate numeric boundaries without epsilon-based false-valid labels.                                                          |
| Existing Zod and Node tests                 | Validate policy/fixture options and test the actual PawMart contract, including independent trusted-fixture Ajv checks. No new runtime package or service is required. |

Added baseline-first, round-robin case planning for scoped priority/allowlisted operations. Covers omitted required input, types, nulls, malformed JSON, extra properties, enums, lengths, numeric boundaries and bounded array cases. Count/work/payload ceilings are explicit, including skipped oversized boundaries. Plans carry no execution authority; actual wire encoding, response checks, credentials, rate/request limits and cleanup remain later phases. See [boundary case guide](apps/worker/BOUNDARY_CASES.md).

## Part 4 · Phase 4.3 — Request execution and limits

Added a trusted Node HTTP/HTTPS client and callable executor with no new dependency. Node request options provide AbortSignal cancellation, explicit headers, custom DNS lookup and response-header limits; checked IPv4 resolution is shared with preview readiness and pinned per connection. A sequential executor simplifies independent count, rate, retry and byte accounting. Built-in requests were chosen for exact redirect, serialization and streaming control rather than introducing a general client with implicit retries or cookie state.

Zod validates independent run/deployment/operation grants and hard-capped limits. Generated plans are recreated internally from immutable contract bytes, preventing an external caller from mutating a previously issued case ID. The existing bounded schema interpreter checks responses without compiling customer schemas. Real local HTTP fixtures exercise actual serialization, cancellation, transport failures, budget exhaustion and seeded PawMart regressions. Production isolation, durable orchestration/reservations, richer credentials, auth probes and cleanup remain integration work; see [API execution](apps/worker/API_EXECUTION.md).

## Part 4 · Phase 4.4 — Authentication probes

Extended the existing callable HTTP executor rather than creating a second request loop. Authenticated controls, missing credentials and optional attested-invalid bearer credentials share every request/rate/byte/deadline/cancellation limit. Operator grants explicitly configure success and rejection statuses; contract security metadata alone grants no probe authority. Baseline-only deterministic planning keeps boundary mutations out of authentication comparisons while preserving schema and payload ceilings.

Trusted scoped credential callbacks provide synthetic valid/invalid context without token minting, JWT parsing or guessing. The executor validates controls and configured rejection response schemas using the existing bounded interpreter. Fixed private metadata ties probe variants to the baseline, run, deployment and expectation without retaining secret values. Added a local PawMart authentication-bypass fault and real HTTP verification, with no new dependency or production entry point. See [authentication probe semantics and limitations](apps/worker/API_AUTHENTICATION.md).

## Part 4 · Phase 4.5 — Role and ownership probes

Added a callable read-access runner using explicit operator role/ownership scenarios, two scoped synthetic identity credentials and an identity endpoint that confirms subject/role assertions. Ownership checks require successful reads of each subject's known resource before cross-access; role checks require an allowed-role control and configured protected JSON evidence. Fixed bounded own-property traversal compares evidence without compiling expressions or retaining payloads. Denial status alone cannot hide a matching protected object.

Extracted `ApiRuntime` from the existing executor so boundary, authentication and authorization stages share the same attempt/rate/byte/deadline/cancellation implementation. All prior tests exercise the refactored path. Added separate fixture role/ownership faults and an authorization contract, retaining the original boundary endpoints and extending the order-owner response enum for the synthetic administrator. No new dependency was added. Mutations require state readback/reset proof beyond this read-only profile and remain explicit gaps. See [role and ownership probes](apps/worker/API_AUTHORIZATION.md).

## Part 4 · Phase 4.6 — Cleanup and reproducibility

Zod validates scoped setup/empty receipts and versioned replay capsules. Node crypto supplies unique attempt namespaces and SHA-256 compatibility/outcome fingerprints. Independent AbortControllers bound setup and compensation, allowing cleanup after cancellation without granting further API execution. The existing stage runtimes retain request limits. Provider methods are bound to preserve class-backed adapters.

A trusted in-process PawMart adapter recreates and discards the complete Express fixture state. This handles unknown created IDs and avoids adding privileged HTTP reset routes. Its bounded ownership receipts make cleanup idempotent and prevent cross-namespace deletion. Hashes bind compiled fixture code and synthetic seed/profile revisions. This is local fixture isolation; durable remote leases, crash recovery and whole-run budgeting are not implemented. See [API lifecycle](apps/worker/API_LIFECYCLE.md).

## Part 5 · Phase 5.1 — Browser observation

The existing Playwright dependency supplies `locator.ariaSnapshot` and masked viewport screenshots. A small source interface separates browser collection from scoped capture limits and authority checks. Zod validates limits, scope and fixed diagnostic metadata; monotonic timestamps and sequence numbers correlate observations with trusted action markers. AbortSignals bound waiting and withhold captures after authority loss. They do not replace a killable browser supervisor.

No new dependency was added. Private observations are returned in memory; persistent artifact storage and model integration are deferred. [Browser observation](apps/worker/BROWSER_OBSERVATION.md) documents data sensitivity, output limits, non-atomic capture and event-correlation limitations.

## Part 5 · Phase 5.2 — Validated action executor

Zod validates strict proposals and detached trusted policy snapshots. Existing Playwright exact role/label locators avoid accepting arbitrary selectors or scripts. Route interception uses explicit method/path grants and redirect-free fetches; observer instrumentation correlates interactions with private diagnostics. AbortSignal, action/session timers and browser closure stop uncertain execution without retries. Synthetic fixture policies distinguish destructive targets and mutation requests; these controls do not infer arbitrary page side effects or replace production network/process isolation. No dependency was added. See [browser actions](apps/worker/BROWSER_ACTIONS.md).

## Part 5 · Phase 5.3 — Model adapter and loop

A provider-neutral injected JSON transport keeps external SDKs, credentials and model selection out of the browser executor. Zod validates bounded structured replies and scoped observations. The existing strict action vocabulary and executor retain independent permissions; a finite menu further narrows proposals. Local token reservations charge full per-call ceilings before transport, and AbortSignals bound waiting with independent cleanup. Real Chromium plus deterministic transport verifies the integration without sending private captures to a third party. Live provider billing/token enforcement, durable budgets and process supervision remain unverified. See [browser loop](apps/worker/BROWSER_LOOP.md).

## Part 5 · Phase 5.4 — Personas and budgets

Fixed profile instructions and Zod-validated persona IDs keep behavior configuration separate from action authority. A scope-bound synchronous reservation ledger shares model calls, full token ceilings, estimated cost, actions, requests and elapsed time across fresh sequential browsers. It uses monotonic time and detached usage snapshots; failed reservations are atomic and uncertain attempts are never refunded. Cost estimates must be supplied explicitly rather than embedding provider pricing. AbortSignals carry the suite deadline through factories, loops and browser request execution. This is process-local accounting, not a durable multi-worker spend ledger. Keyboard-only execution remains unsupported until the action vocabulary supports it. See [personas and budgets](apps/worker/BROWSER_PERSONAS.md).

## Part 5 · Phase 5.5 — Controlled chaos

Existing Playwright routing applies bounded delay or explicit request abort only after policy and budget checks. An immutable validated fault plan tracks exact matching ordinals and injection attempts. Explicit action scripts reuse the existing executor and synthetic value references; no separate unsafe action vocabulary is added. A bounded network-idle wait precedes the final observation where possible, without claiming business completion. Fresh browser state and independent cleanup keep fixture attempts separate; backend fixture reset, production isolation and durable evidence remain external obligations. See [controlled chaos](apps/worker/BROWSER_CHAOS.md).

## Part 5 · Phase 5.6 — Failure replay

The callable replay runner composes existing scoped lifecycle receipts, restricted Playwright scripts and a shared process-local budget. SHA-256 fingerprints bind policy/script/assertion configuration and attested fixture state; image hashes identify captures without returning raw artifacts. Fixed predicate outcomes determine repeatability only after browser and backend cleanup. The local adapter fingerprints compiled server/browser code plus static assets and mode, ensuring UI changes affect compatibility. Independent two-second setup/cleanup waits cannot substitute for killable production supervision. See [browser replay](apps/worker/BROWSER_REPLAY.md).
