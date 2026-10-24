# Controlled browser chaos

Phase 5.5 adds trusted, deterministic request faults and explicit synthetic action scripts. Run `npm run chaos:verify` for real Chromium checks on a disposable local fixture. No model can configure faults, and no customer execution is enabled.

`runFixtureChaos(scope, policy, script, options)` requires disposable data, validates a script, creates a fresh restricted fixture browser, executes its explicit steps, waits for bounded network idleness, captures private observations when available, then closes the browser. Network idleness is a bounded observation aid, not proof of application completion. A deadline, interrupted navigation, unavailable capture or cleanup failure remains inconclusive.

Supported scenarios:

- Slow network: delay a specific authorized path/method by 1–1000 ms. This models latency before transport, not bandwidth, packet loss or a complete mobile-network profile.
- Offline: abort selected authorized requests with an internet-disconnected error. This is request-scoped failure, not a claim that every browser transport is offline.
- Navigation interruption: abort selected authorized GET navigation before dispatch. It does not simulate a partially transferred document.
- Refresh: explicitly navigate to the same allowed path again. This creates a fresh GET within the current browser; it is not cache bypass or a browser-history test.
- Repeated submission: explicitly click the same permitted target again. These are intentional script steps, not automatic retries. Disposable mutation permissions and action/request budgets still apply.
- Boundary input: fill/select a supplied synthetic value reference. The runner cannot invent input or access credentials.

Fault configuration binds exact path and method, a starting matching-request ordinal (1–100), and at most three injections. Navigation faults additionally require a navigation request. Routing permissions, current scope, request ceilings and shared ledger reservation are checked first. Delayed requests recheck current authority before dispatch. A fault cannot turn a forbidden endpoint into an allowed request or avoid request accounting. WebSocket, popup, download, upload and redirect restrictions remain unchanged.

`chaos()` returns detached planned settings, matching count and applied injection count. The count records injection entry; a delay cancelled partway through is still an attempted injection, not proof its full duration elapsed. Requests blocked before the injection point do not count as matched/applied faults. An unused configured fault is explicitly `fault_not_applied` when execution otherwise reaches evaluation.

The runner returns private scope/scenario metadata, a bounded action-kind/result trace, fault accounting and at most one final snapshot/PNG/diagnostic capture. Captures remain untrusted synthetic data and are not generally redacted. All results carry `confirmation: unconfirmed`; executed actions, HTTP failures and fault application alone do not establish an application bug. Refresh/submission scripts retain actual target grants from the caller; scenario labels do not add permissions.

Scripts have at most 20 actions. Existing session, action, request, capture and optional shared budgets remain enforced. Cleanup has a separate two-second wait; a failed wait does not prove resource removal. The caller owns synthetic server-state reset between runs; fresh browser contexts do not reset backend data. Factory startup, response buffering and process-kill guarantees still require production supervision.

Verification covers all six scenarios, real server dispatch counts, final private PNGs where available, and fault refusal on unauthorized requests. Failure replay, repeatability classification, base/head comparison, durable trace/artifact storage and confirmed findings belong to later phases. Normal worker startup remains dispatch-only.
