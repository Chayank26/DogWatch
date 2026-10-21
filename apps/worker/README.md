# Worker and preview readiness

`npm run dev -w @dogwatch/worker` runs the optional outbox dispatcher when DATABASE_URL and REDIS_URL are set. It does not start a production QA consumer. Phase 2.6 adds an explicitly callable preparation stage; Phase 2.7 must connect it to isolated execution and recovery.

## What setup does

`preparePreview(database, identity, bindings, options)` loads the tenant-scoped queued run, matches exactly one operator-approved deployment binding, and conditionally claims `waiting_for_preview`. Its caller supplies an independently authorized current-head resolver. Only the caller who wins the conditional claim polls the URL. Missing or ambiguous bindings fail setup. Cancellation/supersession wins over late success.

A successful setup records `previewReadyAt` and immutable deployment context plus probe count. The run stays `waiting_for_preview`; it does not claim that tests started or passed. A failed setup stores a fixed `setupFailureCode`, never response bodies, exception messages, or credentials. Historical code/policy/budget snapshots remain intact.

Bindings must come from an operator-owned file or trusted deployment adapter; this phase exposes no public configuration endpoint. The operator attests that the deployment contains the specified SHA. An HTTP 2xx is only a readiness signal and cannot verify which source commit is deployed, or prove that checkout works. Provider-specific deployment adapters are future work.

Example deployment binding (documentation only):

```json
{
  "tenantId": "7ad2f4a4-2d31-42d8-9853-23164ab19d53",
  "repositoryId": 20,
  "pullRequestNumber": 42,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "deploymentId": "pawmart-pr42-commit-a",
  "url": "https://pr42.preview.example.com/health",
  "allowedOrigins": ["https://pr42.preview.example.com"],
  "maxWaitSeconds": 60,
  "maxRequests": 20,
  "pollIntervalMs": 1000
}
```

Tenant/repository/PR/SHA fields bind the deployment to one immutable run target; deploymentId identifies its deployment. URL names the approved final health endpoint; allowedOrigins is an exact scheme/hostname/port allowlist. Limits bound total setup duration, network attempts, and polling frequency. Setup limits are capped by run budgets, and probe counts are recorded so later stages can deduct them. Whole-run elapsed accounting is implemented with future execution, not reset or silently granted by this setup helper.

## Destination rules

Production setup permits HTTPS with normal certificate verification, no URL credentials, query strings, or fragments, and no redirects. Configure the final health URL. Each attempt resolves DNS anew, rejects private/special IPv4 and all IPv6 answers, and pins the approved address in Node's socket lookup callback. Host/TLS identity remains the original hostname. Response bodies are discarded after headers. Per-attempt timeout is two seconds; setup has its own deadline and request ceiling. Errors in current-head resolution produce a setup failure instead of treating an unknown head as current.

`fixture: true` is a code-level verification option that permits only literal `http://127.0.0.1` loopback, not a JSON configuration switch. Customer execution must not enable it. IPv6-only previews are unsupported in this initial transport. These checks protect readiness HTTP requests; they are not a container firewall or Playwright egress policy. Isolation and browser egress controls belong to Phase 2.7.

The state claim prevents simultaneous setup, but is not an execution lease: a process crash can leave a waiting run requiring future lease/recovery handling. Waiting/ready runs are not automatically consumed. Current-head checks occur before probes and after success; external GitHub state can still change after a check, so future stage transitions and publication must revalidate it.

## Verification

`npm test` includes synthetic readiness tests without external requests. `npm run preview:verify` needs local Postgres and opens an ephemeral loopback HTTP readiness fixture. It tests real polling, exact SHA matching, persisted evidence, repeat claims, redirects, stale heads, and cancellation races; it removes only its random tenant and ephemeral server. `npm run queue:verify` separately verifies dispatch. CI runs both integration checks after migrations.

New worker scripts are JSON because npm requires that format: `test` runs Node's test runner through tsx; `preverify:preview` builds dependency exports before `verify:preview`; root `preview:verify` delegates to that workspace. Contracts and Zod are declared dependencies because preparation validates run budgets and deployment JSON at runtime. No new deployment provider or browser runtime is installed here.

## Phase 2.7 — Offline execution sandbox

Build with `npm run sandbox:build` and verify with `npm run isolation:verify`. Docker must be running. The build context is only `apps/worker/sandbox`; its allowlist excludes the workspace, local secrets, and customer source. The Node base image is digest-pinned. The launcher resolves the trusted local image tag to a content ID before creation; it never pulls a customer-selected image.

`runIsolatedProbe` is a trusted host-side supervisor for fixed diagnostic tasks. It uses `execFile` argument arrays rather than shell commands. Task JSON accepts only tenant/run UUID references and the `probe` or `timeout_probe` diagnostic kind. It does not accept commands, images, environment variables, source paths, or mounts, and is not an authorization endpoint. A future product executor must validate tenant ownership, current head, and durable cancellation before calling sandbox operations.

Every invocation creates a unique container with these enforced settings:

| Boundary             | Setting and purpose                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| User                 | UID/GID 10001, independent of the host user                                                                                              |
| Privileges           | All Linux capabilities dropped; no-new-privileges; Docker's default seccomp remains enabled                                              |
| Root filesystem      | Read-only; no repository or host volume mounts                                                                                           |
| Scratch data         | Fresh 16 MiB tmpfs at `/tmp`, noexec/nosuid/nodev; removed with the container                                                            |
| CPU/memory/processes | 0.5 CPU, 128 MiB memory with no extra swap, 32 processes, bounded file descriptors and no core dumps                                     |
| Network              | `none`: no preview, database, Redis, provider, or metadata connectivity                                                                  |
| Secrets              | No host environment injection, stdin credentials, or Docker socket                                                                       |
| Output               | 16 KiB attachment ceiling, validated boolean diagnostic evidence, fixed failure codes; Docker log storage disabled                       |
| Lifetime             | At most 60 seconds, including image lookup/create/attach; separate bounded forced cleanup after success, error, timeout, or cancellation |

The host supervisor needs a trusted Docker daemon. The container never receives the daemon socket. Containers share the daemon's kernel: these controls are an MVP isolation foundation, not a hardened hostile-code or production tenant certification. A process/host crash or daemon outage can prevent cleanup; `sandbox_cleanup_failed` must stop orchestration and an operator must reconcile orphaned `dogwatch.managed=sandbox` containers by identity before production recovery. Automatic orphan sweeping/leases and container escape testing are future operational work.

This phase intentionally permits no outbound network at all. Readiness remains the separately restricted host HTTP stage. The sandbox does not yet run API probes or Playwright; those stages need an external enforced destination gateway and equivalent browser egress controls before network access can be introduced. It also does not install or run repository scripts, inject synthetic-account credentials, create artifacts, or mark product runs running/completed. Future short-lived credentials must be granted only to the required stage; this current diagnostic needs none.

The real Docker verifier inspects engine resource/mount/security settings, tests non-root/capability/root-write/socket/metadata boundaries inside the container, checks that host canaries are absent, runs two fresh workspaces, and proves forced removal after timeout/cancellation. It creates only random diagnostic containers and no database runs. Unit tests reject extra task fields and unsafe image/name arguments. CI builds the same trusted context and runs the same verifier. The Docker controls follow the [official container runtime documentation](https://docs.docker.com/engine/containers/run/).

The new npm scripts delegate the small image build and explicit verification to the worker workspace; ordinary development startup remains dispatch-only. No Docker daemon access is added to the API, website, Postgres, or Redis services.

## Immutable comparison retrieval

`retrieveImmutableDiff` accepts trusted repository coordinates, resolved immutable base/head SHAs and an ephemeral repository-scoped token. It calls only GitHub's fixed API origin, rejects redirects, and limits response bytes and time. The output is change metadata with merge-base context, rename/deletion information and completeness gaps; raw patches and credentials are discarded. It is callable only and does not mint tokens, authorize tenants, persist data, fetch source, or start a QA consumer. Callers must independently check ownership, current installation/head and cancellation. The [GitHub comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) limits changed files to 300; this adapter also limits commit metadata to its first 250-entry page. Boundary results explicitly remain incomplete.

## Import and symbol graph

`buildModuleGraph(snapshot)` accepts tenant/repository/SHA-bound source strings and returns top-level symbols, exports, relative dependency edges and coverage gaps. `affectedModules(base, head, comparison)` walks reverse dependencies from both graphs; the base graph must match `mergeBaseSha` when provided. Renames and deletions preserve old consumers. Gaps widen selection to all supplied modules, including when the comparison is incomplete.

Inputs are limited to 100 files, 256 KiB per file and 2 MiB total UTF-8 source. Traversal stops after 50,000 nodes per file. Only JS/TS variants are analyzed; aliases, external imports, dynamic/CommonJS imports, namespaces, syntax errors, generated/declaration files and resolution ambiguity remain explicit gaps. No repository tsconfig, filesystem resolution or source execution occurs. The parser itself needs enforced process/container memory and time limits before handling hostile source; the current diagnostic sandbox does not run it. The caller must obtain and authorize immutable source snapshots; no source fetcher, persistence or consumer is added here. Run the graph fixtures with the worker test suite.

## Route impact mapping

`mapRouteImpact(baseGraph, headGraph, comparison, baseMapping, headMapping)` selects configured route, API and journey targets using conservative graph impact. Each mapping includes tenantId, repositoryId, sha, complete and entries. Entries contain a unique id, target, module paths and an optional critical flag (defaults to false). Target shapes are `{kind: 'route', path: '/checkout'}`, `{kind: 'api', method: 'POST', path: '/api/orders'}` or `{kind: 'journey', name: 'login'}`. Supply parsed `ImpactMapping` values; validation also runs inside the adapter.

Map relevant dependencies as well as entry modules. Unmapped affected modules, unknown mapped modules or incomplete mappings widen to all configured targets. Critical entries are always selected. Results retain base/head labels, SHAs, matched modules and selection reasons; base targets are comparison context and must not automatically run against the head. Up to 200 entries with 100 module paths each are accepted per snapshot. This configuration is operator-owned and does not grant destination access. Absolute URLs, protocol-relative paths, queries, fragments and traversal paths are rejected. Dynamic path patterns remain labels requiring later trusted parameter substitution. No requests, framework discovery, persistence or production consumption occur.

## Phase 3.4 — Bounded smoke journeys

`runSmoke(plan, driver, {isCurrent, signal})` executes operator-configured navigation, fill/select, click, visibility and text assertions. A plan binds tenant/run/repository/head SHA, a maximum execution duration (20 seconds), a total step budget (default 30, maximum 200) and up to 20 journeys of 50 steps each. Dependencies must refer to earlier journey IDs; failed/inconclusive prerequisites skip dependent journeys. Invalid plans throw before execution; callers retain ownership of any prepared driver until validation succeeds.

The driver is an internal trusted capability, not user JSON. Its caller must authorize ownership and preview identity, cap remaining budgets, resolve synthetic-account value references, and supply current-head/cancellation checks. Authority is checked before each step and after each journey. The deadline includes these checks and all actions, excluding prior preview/browser setup. Cleanup has a separate three-second wait; failure to confirm cleanup produces an inconclusive outcome and requires supervisor reconciliation. Real production execution still needs a killable isolated driver with enforced network/request limits and crash recovery. The generic runner does not provide those controls itself.

Results contain fixed outcome codes, completed step counts and bounded console/page/server/network/blocked-request counters. They contain no DOM text, console messages, values, request bodies or exception diagnostics. Assertion/navigation/interaction failures and observed browser errors fail a journey; unavailable context, stale authority, cancellation, time/step exhaustion, forbidden requests and cleanup failures are inconclusive. Console errors are blocking smoke observations, so expected-error API scenarios belong in later contract tests. Base attribution is explicitly `unavailable`; matching base comparison and durable screenshot/trace evidence belong to Phase 3.5. Results are returned to the caller, not stored or published. Synthetic identity selection in PawMart does not verify a real login provider.

`createFixtureSmokeDriver` is a Playwright adapter exclusively for trusted literal `http://127.0.0.1` fixtures. It launches a fresh headless Chromium context, blocks service workers, redirects, other origins, WebSockets, popups and downloads, and closes its browser after each run. Browser interception is defense in depth for this disposable target, not a production firewall; the adapter must never load hostile/customer content. It accepts ephemeral fill/select values by reference and never saves them. Playwright recommends blocking service workers when routing requests: [BrowserContext documentation](https://playwright.dev/docs/api/class-browsercontext#browser-context-route).

Install the fixture browser with `npx playwright install chromium` (`--with-deps` on Linux CI), then run `npm run smoke:verify`. The verifier builds PawMart, opens temporary loopback servers, and verifies healthy checkout, seeded API 500 and stuck checkout defects, browser errors, failed navigation, redirect denial and dependent skips within the execution budget. It closes browsers and servers. Unit tests additionally cover deadline, cancellation, authority loss, step budgets, invalid plans and cleanup failure. CI installs Chromium and runs the same browser verifier. Normal startup remains dispatch-only; no Docker/network policy is relaxed and no customer run is consumed.

## Phase 3.5 — Base comparison and private local evidence

`runSmokeWithEvidence(plan, driver, {role, scenarioId, isCurrent, signal})` wraps the existing smoke runner and produces a versioned evidence record. Use the same accepted run/tenant/repository for base and head, with separately authorized immutable SHAs and explicit `base`/`head` roles. The caller must verify deployed source identity, authority, synthetic account scope and comparable setup. Base execution has its own at-most-20-second smoke budget; the supervisor must reserve both runs within the overall run ceiling. No orchestration starts automatically.

`scenarioId` must version the non-secret test-data/account-role profile, browser/container build, locale, feature flags and relevant environment configuration. Change it whenever that compatibility changes. A compatibility digest also binds the executor version, normalized journey definitions, dependencies and execution/step limits. It deliberately excludes SHAs, run IDs, preview origins and actual credential values. The adapter cannot independently verify the operator's environment attestation. Do not compare runs with unknown compatibility. Bump the executor fingerprint when changing smoke semantics.

`compareSmokeEvidence(context, head, base?)` validates independently supplied expected scope and exact SHAs. A failed head check with a matching passing base is `new_regression` (an observed difference, not proof of code causality). A matching configured assertion/navigation/interaction failure on both snapshots is `pre_existing`; different failures, skipped/inconclusive checks, stopped runs, expired records and incompatible scenarios/configuration stay inconclusive. Aggregate browser-error counters alone cannot prove the same pre-existing defect. An absent base is `unavailable`; passing head checks are `no_failure`. These classifications never upgrade skipped work to passed work and do not publish GitHub verdicts.

Evidence includes per-journey action kinds, completed step counts, outcomes and bounded diagnostic counters. It omits selector strings, expectations, value references/values, DOM, raw exceptions, console text, headers and response bodies. The existing trusted-fixture driver can capture one viewport PNG at end of smoke, masking `input`, `textarea`, `select` and `[data-dogwatch-secret]`. This is final-state context, not a per-failure screenshot. Capture is optional, capped at 1 MiB and 750 ms inside the existing three-second cleanup allowance; missing/oversized/failed capture is explicitly unavailable. It cannot change smoke success into a claim that visual evidence exists. Raw Playwright trace ZIPs are deliberately not persisted because they can contain credentials and request payloads. The sanitized structured trace is the replay index into the versioned operator journey configuration.

Screenshot masking is only verified on trusted synthetic fixtures. It cannot guarantee removal of arbitrary text echoed elsewhere on a page, so customer/hostile content and real credentials must not use this capture adapter. Screenshot bytes remain sensitive and private after masking. No generic secret-redaction guarantee or production screenshot upload is introduced.

### Local storage and access

`persistSmokeEvidence(root, authorizedScope, record)` atomically publishes a private local JSON bundle and returns an opaque artifact UUID, byte count, SHA-256 digest, scope and expiry. `readSmokeEvidence(root, authorizedScope, artifactId)` enforces that scope, file/directory privacy, integrity, byte limits and expiry before returning data. `compareStoredSmokeEvidence(root, context, headId, baseId?)` performs those lookups and returns classifications with the exact artifact references. An explicitly supplied invalid/expired reference fails the lookup; it is not silently treated as a passing or absent baseline.

The root and scope are internal operator/supervisor inputs, never HTTP request fields. The supervisor must authenticate/authorize them using trusted tenant/run records. UUIDs and file permissions are not a replacement for account authorization. There is no public artifact route or signed URL. This POSIX local adapter is not shared hosted storage, database registration or the later production artifact service. Prepare an operator-owned private root with an existing parent (for example `.local/evidence`); every evidence directory must be mode 0700 and every file 0600. Symlink descendants/files and permissive permissions are rejected. Parent directories and the local OS account are trusted.

Bundles have a 2 MiB read/write ceiling, a 50-artifact per-run ceiling and a seven-day maximum lifetime. Writes use exclusive temporary files, fsync, atomic non-replacing hard-link publication and directory fsync. Readers see a complete bundle or no bundle. A per-run directory lock serializes writers across processes. A crashed writer can leave a lock/temp file or an already published artifact requiring identity-scoped operator reconciliation; the adapter never steals locks, sweeps arbitrary paths or claims exactly-once persistence. Hashes detect corruption, not edits by a malicious process running as the same OS user.

`pruneSmokeEvidence(root, authorizedScope)` explicitly removes validated expired bundles for that scope only; reads deny expired data even before pruning. No background retention scheduler is started. The filesystem root must support the POSIX operations used here. Keep it outside served web directories and Git; `.local/` is already ignored.

### Verification

Run `npm run baseline:verify` after installing Chromium. It creates paired disposable loopback pages with a labeled render assertion, confirms new/pre-existing/unavailable/incompatible-base classifications, verifies that different synthetic field values yield identical masked screenshots, persists/reloads records and compares their artifact references. It removes its exact temporary evidence directory and closes browsers/servers. The separate `smoke:verify` retains the real PawMart checkout and seeded API/UI defect checks. CI runs both. Unit tests cover scope/SHA/role mismatches, changed plans, expiry, corruption, symlinks, permission checks, byte/count limits, capture failure and conservative attribution.

## Phase 4.1 — Contract validation

`validateApiContract(context, text)` validates the supported OpenAPI 3.0 JSON/YAML profile and normalizes operation, parameter, JSON schema and security metadata. Unsupported or invalid inputs return no operations and fixed diagnostics. It resolves local components only and never uses contract server URLs, loads external refs or sends requests. See the [contract guide](CONTRACTS.md) for supported constructs, limits and caller responsibilities. Case generation comes next; customer execution remains disabled.
