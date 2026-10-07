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
