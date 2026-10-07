# DogWatch threat model

**Scope:** Part 1, Phase 1.3 design baseline, updated for Phase 1.4 local infrastructure. Update this document when new trust boundaries or capabilities are implemented. This is an implementation plan, not an assertion that DogWatch currently enforces all listed controls.

## What exists today

There is an informational local website, an API health endpoint, a worker scaffold, shared runtime contracts with tested pure opt-in rules, and local Postgres/Redis services. The initial migration enforces tenant-consistent foreign keys and run/outbox identity constraints. The database factory and rollback verification are available, and optionally configured ingress now persists authorized run/receipt/outbox records (Phase 2.3). A raw-body signature-verifying webhook endpoint now exists (Phase 2.1), but it only acknowledges and discards valid objects. Optional App installation/actor authorization and event filtering exist; there is no dashboard user authorization or queue consumer, browser agent, secret store, artifact service, or database row-level read policy. Runtime shape validation and foreign keys are not read authorization.

## Assets and actors

Protect GitHub installation tokens, preview test credentials, tenant configuration, repository source, run/finding records, screenshots and traces, service availability, and tenant budgets. Developers and organization owners are authorized only within their scope. Potential hostile inputs include external commenters, malicious PR authors (including forks), compromised previews, forged requests, and model-generated actions. An authenticated tenant member can still attempt access outside their role or organization.

The hosted MVP tests explicitly configured preview environments using disposable accounts and data. It does not execute arbitrary repository build scripts, test production by default, or certify that an application is secure. Cloud/platform compromise and sophisticated container escapes remain residual risks requiring appropriate deployment controls; a Docker image alone is not a security boundary guarantee.

## Trust boundaries in simple terms

1. **GitHub → ingress:** Check the messenger's signature, then separately check who may request work.
2. **Dashboard browser → control API:** A login identifies a person; server-side membership and roles determine which organization they may act for.
3. **Ingress → database/outbox → queue:** Save authorized scope durably. Neither valid JSON nor a queue record may invent new permissions.
4. **Dispatcher → worker:** Revalidate authoritative run ownership and lease before obtaining narrowly scoped credentials.
5. **Worker → source/preview/API:** Source and remote responses are hostile data. Approved targets still need isolation and budget enforcement.
6. **Browser observations → model → action executor:** The model recommends; executor code decides what is allowed.
7. **Evidence → storage/dashboard/GitHub:** Redact sensitive content, enforce audience-specific access, and render hostile text safely.

## Threats, planned controls, and proof required

| ID  | Threat and simple example                                                                    | Planned control                                                                                                | Verification / phase owner                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| T01 | Forged event: someone sends a fake request claiming Maya asked for QA.                       | Raw-byte HMAC verification, bounded body parsing, supported event validation.                                  | Invalid/tampered signatures create no work; Part 2.1.                                                          |
| T02 | Unauthorized or replayed trigger: an outsider comments repeatedly to spend Maya's budget.    | Trusted installation mapping, approved actor checks, delivery deduplication, rate limits and quotas.           | Unauthorized/repeated events do not create extra runs; Parts 2.2–2.4 and 7.7.                                  |
| T03 | Cross-tenant access: another customer guesses PawMart's run or artifact ID.                  | Server-side membership, tenant-scoped queries, database policies, authorized artifact access.                  | Read/write/download attempts fail across tenants; Parts 1.4, 6.3, 7.1–7.3.                                     |
| T04 | SSRF: a preview URL or redirect points at cloud credentials or an internal service.          | Approved public targets, scheme/port/address restrictions, connection-time DNS checks, network egress policy.  | Loopback/private/link-local/metadata, redirect and rebinding cases denied; Parts 2.6–2.7 and 8.5.              |
| T05 | Hostile repository: a PR adds an install script that reads worker secrets.                   | No repository script execution in MVP; bounded source parsing, isolated workspace, least-privilege runtime.    | No lifecycle script executes; parsing failure cannot compromise or stall ingress; Parts 2.7 and 3.1–3.2.       |
| T06 | Prompt injection: checkout tells the agent to upload its token elsewhere.                    | Untrusted observations, structured proposals, external action/target enforcement, no secrets in prompts.       | Injected instructions cannot bypass policy or disclose credentials; Parts 5.1–5.4 and 8.5.                     |
| T07 | Destructive test: repeated checkout clicks charge real cards or delete records.              | Designated previews, synthetic accounts, disposable data, explicit operation allowlists, cleanup.              | Forbidden mutation blocked; cleanup verified for enabled probes; Parts 4.3–4.6 and 5.2–5.5.                    |
| T08 | Evidence leak: a screenshot shows a token or a public comment reveals private customer data. | Secret minimization, redaction, private storage, audience-aware links, retention and deletion.                 | Canary secrets absent from prompts/logs/reports; unauthorized evidence retrieval fails; Parts 6.3–6.5 and 8.5. |
| T09 | Resource abuse: infinite agent loop, giant payload, or repeated retries.                     | Independent runtime/request/token/cost limits, resource ceilings, bounded retries and per-tenant reservations. | Budget exhaustion stops all active operations and charges actual use; Parts 2.4, 2.7, 4.3, 5.4, 7.7.           |
| T10 | Stale or duplicate verdict: an old worker marks a fixed PR as broken.                        | Immutable SHA, leases/checkpoints, conditional updates, publication reconciliation and supersession.           | Crash/retry and newer-head tests retain history without incorrect current verdicts; Parts 2.5 and 6.5–6.6.     |
| T11 | Misleading finding: a normal authentication denial is presented as a regression.             | Contract-aware expectations, confidence levels, reproduction and baseline disclosure.                          | Clean fixtures remain clean; known defects carry usable evidence; Parts 4–6 and 8.4.                           |
| T12 | Revoked access persists: an uninstalled App keeps using cached credentials.                  | Current installation/membership validation, short-lived tokens, revocation handling and cancellation.          | Removed/suspended access blocks new work and further privileged actions; Parts 2.2 and 7.1–7.3.                |
| T13 | Report/UI injection: page text adds hostile HTML or mass mentions to a report.               | Safe rendering, controlled Markdown formatting, neutralized mentions, no arbitrary remote embedding.           | Adversarial finding text cannot execute scripts or create unintended mentions; Parts 6.4–6.5 and 7.5.          |
| T14 | Untrusted fork receives parent-repository secrets.                                           | Explicit fork policy, separately trusted preview and credential grants; no automatic secret inheritance.       | Fork events cannot receive protected credentials by default; Parts 2.2, 2.6–2.7.                               |

## Data lifecycle and failure handling

Future ingress should retain only needed event metadata, not unlimited raw webhook bodies. Postgres holds tenant-scoped configuration, immutable run context, and redacted finding metadata. Redis carries run references and necessary dispatch data, not secret values. Workers resolve credential references just before permitted use and remove temporary workspaces after termination. Source and evidence must not be reused across tenants.

Provider prompts should contain only the minimum redacted observations needed. Selecting a model provider must establish its data handling and retention policy before real tenant data is transmitted. Store screenshots/traces privately, assign retention at onboarding, and implement expiration/deletion in storage and metadata. Concrete retention periods are intentionally undecided until product and hosting requirements are known.

Fail closed when authority or destination safety is uncertain. Treat unavailable infrastructure as an operational failure or bounded retry, not a passed test. Cancellation and revocation must stop active operations where possible; irreversible external side effects cannot be undone by merely deleting a run. Record enough redacted audit metadata to diagnose actions without exposing secrets.

## Review gates and unresolved choices

- Before real webhooks: verify raw-body authenticity, trusted scope resolution, supported actions, actor authorization, fork handling, and deduplication.
- Before external previews: select enforceable egress and execution policies, test destination resolution, define credential grants and disposable mutation scope.
- Before model use: implement executor restrictions, redact observations, select provider data terms, and measure cost ceilings.
- Before tenant evidence access: verify membership, row/artifact authorization, safe rendering, and retention/deletion.
- Before production: run the isolation and failure corpus, benchmark findings, review remaining risks, and document operational recovery.

Future architecture reviews must revisit private preview connectivity, model/provider retention, deployment runtime isolation, secret management, deletion/backups, and how installation revocation reaches in-flight jobs. Phase completion here means these risks and obligations are documented; the implementation gates remain ahead.

## Phase 2.2 implementation update

Optional operator-configured authorization now filters signed PR/comment candidates, checks approved actors, validates current installation access, and obtains repository-scoped read credentials for canonical PR lookup. The SDK adapter is tested with a synthetic transport, not a live App. No run persistence, deduplication, local lifecycle state, queue processing, dashboard membership, or artifact access control is implemented. Signature-only mode remains available and clearly returns verification-only status. Protected local configuration is a bootstrap authority store and must be reconciled with database tenant ownership before persistence.

## Phase 2.3 implementation update

Explicit database-backed acceptance now validates registered ownership, atomically saves run/receipt/outbox, and deduplicates delivery IDs and exact signed-body fingerprints. It retains approved actor IDs and policy metadata without raw bodies or credentials. Queue dispatch, membership/RLS, artifact storage, receipt retention, and cancellation remain future controls. A duplicate is still subject to current authorization before storage reconciliation. Real GitHub end-to-end behavior remains unverified.

## Phase 2.4 implementation update

The configured runner dispatches locked committed outbox work with durable backoff/attempt limits into retained BullMQ jobs containing UUID references only. Global queue concurrency is two; synthetic worker callbacks verify retries but no production QA consumer is launched. Worker authority revalidation, per-tenant limits, leases, cancellation, isolation, and retention/lost-Redis reconciliation remain future requirements. Queue schema validation is not execution authorization.

### Phase 2.6 implementation update

Readiness probes now enforce exact approved origins, forbid redirects/URL credentials/query parameters, reject private/special IPv4 and IPv6, and pin DNS-checked addresses in the HTTPS socket lookup. No response body or secret is stored. Loopback permission exists only as an explicit fixture harness code option. This controls only the readiness HTTP path; container/Playwright egress isolation remains Phase 2.7 work. An operator binding attests deployment SHA; health status alone cannot prove deployed code identity.
