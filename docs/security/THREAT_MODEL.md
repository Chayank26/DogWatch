# DogWatch threat model

**Scope:** Design baseline and historical implementation notes through Phase 8.5. Update this document when trust boundaries or capabilities change. Planned controls are not assertions of current enforcement; consult the linked validation matrix for evidence and remaining gates.

## What exists today

DogWatch now has optional authorized GitHub ingress, tenant-scoped persistence,
outbox dispatch, login/membership and owner controls, private local evidence,
bounded callable QA stages, reporting primitives and operational telemetry.
The production QA consumer remains disabled. Hosted artifact delivery, customer
browser egress/credential isolation, production RLS and live provider integration
are not established by local tests. See [Phase 8.5 validation](VALIDATION.md) for
current evidence and unresolved release gates. The implementation updates below
are historical snapshots; earlier “not implemented” statements describe their
respective phases, not the current feature set.

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

### Phase 2.7 implementation update

A trusted host supervisor can now create an offline, non-root, read-only Docker diagnostic container with dropped capabilities, no-new-privileges, default seccomp, bounded tmpfs/CPU/memory/processes, no mounts/socket/env-secret injection, and no network. The image build context is a strict small allowlist with a digest-pinned base. Actual engine/runtime controls, host-secret absence, and timeout/cancellation removal are verified locally. No arbitrary source scripts, browser/API outbound traffic, customer authentication secrets, or QA verdicts are enabled. An enforced egress gateway, execution authority/leases, credential grants, orphan recovery, and production escape/failure testing remain obligations before those workloads are introduced.

### Phase 3.5 implementation update

Callable base comparison requires exact tenant/run/repository/SHA/role identity and compatible versioned journey/scenario context. Operator attestation still owns deployment source identity and comparable environment/account/data settings. Missing, expired, stopped or incompatible baselines do not imply new regressions; aggregate diagnostic counters cannot identify matching browser defects. No report is published or database verdict mutated.

Local evidence has private POSIX directory/file modes, fixed schema/byte/count ceilings, integrity hashes, atomic complete-file publication, scoped lookup, expiry denial and explicit scoped pruning. Its root's parent and OS user are trusted; this is not adversarial same-user storage or hosted multi-user authorization. Callers must independently authorize scopes. Crashed writers may leave locks/temporary files for operator reconciliation. No public route, signed links, hosted storage or retention daemon exists.

Only trusted synthetic fixtures capture masked screenshots. Masking form controls cannot remove arbitrary echoed secrets elsewhere. Raw Playwright traces, headers, bodies, DOM and console messages are not persisted. Final screenshots remain sensitive after masking. Customer previews, live credentials and hostile content must not use the fixture adapter; production capture needs isolated execution, enforced egress, account-safe redaction and artifact authorization.

### Phase 4.1 implementation update

Contract ingestion treats OpenAPI JSON/YAML as untrusted data. Duplicate/non-string keys, YAML aliases/tags, prototype/merge keys, remote/file references and unsupported constructs cannot produce a partially accepted operation inventory. Only a bundled trusted document schema is compiled; customer schemas/regexes are not run against payloads. Byte, tree, reference-expansion and normalized-output limits apply. These do not replace enforced parser CPU/memory isolation before hostile production use.

Contract servers, examples, descriptions and vendor instructions grant no authority and are omitted from normalized metadata. Security requirements remain metadata; no credentials or requests are created. Fixed diagnostics omit source values and raw errors. Normalized constraints may still contain sensitive enum/pattern/path data and must not be treated as redacted public reports. The caller must independently authorize the immutable source and future preview destination. No request execution, public ingress, artifact upload or production consumption was enabled.

### Phase 4.2 implementation update

Boundary-case generation is an offline planning capability. It revalidates immutable contract source and checks scoped operation priorities/allowlists. Generated plans contain no origin, live credential grant or execution authority. Security API-key parameter overlaps are skipped so normal input fuzzing cannot implicitly become credential probing. Fixtures must be synthetic; generated enum/parameter/body data remains potentially sensitive and is not safe public report content.

Customer schemas are interpreted through a bounded subset rather than compiled. Unknown patterns are never executed, exact decimal checks avoid tolerance-based validity mistakes, and positive baselines must satisfy modeled constraints before mutations are emitted. Case/work/payload limits and explicit gaps prevent oversized boundaries from being silently truncated. These are logical-data limits, not network-byte, process isolation or authorization controls. The future executor must enforce wire serialization, target/actor authority, request/rate/time budgets, case integrity and cleanup before any customer request.

### Phase 4.3 implementation boundary

API execution is callable only, with independent exact run/deployment/origin/operation grants and explicit disposable mutation permission. Requests use checked/pinned public IPv4, HTTPS, no redirects/cookie jar, conservative parameter serialization and bounded attempts/rates/deadlines/request bytes/streamed response bodies. Scoped bearer credentials are supplied only by trusted callbacks and never retained in results. Cancellation/current authority is checked around attempts; callers must propagate an AbortSignal for immediate in-flight durable cancellation. Real verification uses fresh loopback fixtures and public synthetic tokens. The client is not a container/network firewall: customer execution still requires an isolated supervisor/outbound broker, durable lease/whole-run budget reservations and cleanup. Diagnostic Docker networking and production startup remain unchanged. See [executor boundaries](../../apps/worker/API_EXECUTION.md).

### Phase 4.4 implementation boundary

Callable authentication probes require an explicit scoped operation policy, a passing authenticated control and a documented configured 401/403 expectation. Missing credentials and optionally attested-invalid synthetic bearer credentials reuse the same request/rate/byte/deadline and cancellation controls. Other 4xx responses do not establish enforcement. Tokens identical to the control are refused as invalid probes; providers remain trusted and independently scoped. Public/anonymous requirements and unmodeled credential combinations do not execute negative probes. Fresh PawMart fixtures demonstrate healthy rejection and a seeded authentication bypass without retaining secrets or payloads. This proves configured response observations, not role/ownership safety, PR attribution or customer readiness. No production consumer, external identity provider, egress firewall or cleanup integration was added; see [authentication scope](../../apps/worker/API_AUTHENTICATION.md).

### Phase 4.5 implementation boundary

Read-only role/ownership probes require exact scoped endpoint grants, two distinct scoped synthetic credentials and target-confirmed subject/role controls. Ownership probes confirm both known own-resource bindings before cross-access; role probes confirm protected content under the allowed role. A security observation requires the successful response schema plus configured object/content evidence, even if returned with a denial status. Bare 2xx, missing resources and unavailable controls do not prove access. Bounded property checks retain only booleans and deterministic metadata, never raw responses or tokens. Shared `ApiRuntime` preserves the existing transport, budget and cancellation boundary. Writes are refused before execution because unauthorized mutation requires additional state proof. Live identity providers, customer orchestration, isolated outbound enforcement and durable evidence/cleanup remain pending. See [authorization profile](../../apps/worker/API_AUTHORIZATION.md).

## Phase 8.5 implementation update

A repeatable local security command now runs the complete application suite and
real PostgreSQL/Docker boundary checks. Added adversarial prompt proposals,
canonicalized SSRF destinations and telemetry canary tests. The report records
source provenance, gate status, test counts and explicit unvalidated production
surfaces. No new runtime authority or customer QA execution is enabled. Consult
[the validation matrix and limitations](VALIDATION.md) before using these results
as release evidence.
