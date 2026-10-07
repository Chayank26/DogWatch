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
