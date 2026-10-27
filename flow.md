# User experience and data flow by phase

## Part 1 · Phase 1.1 — Initial project setup

### Maya visits DogWatch

Maya owns the PawMart shop and wants checkout tested before merging a PR. At this increment, she can open the local DogWatch page and read what the product will eventually do. The page clearly says repository connections and QA runs are coming later. There is no login, repository form, upload, or runnable QA action yet.

### What happens to her request and data

1. Maya visits `http://127.0.0.1:3000`.
2. Next.js returns the page and browser assets. Her browser renders the informational content.
3. The page makes no application calls to the API and collects no account, repository, or test data. There is no persistent user database, authentication session, or analytics integration. Ordinary development-server request output may include request paths and timings.
4. A developer can separately visit `http://127.0.0.1:4000/health`. Express returns `{ "service": "dogwatch-api", "status": "ok" }`; this does not create a user or QA run.
5. The worker entry point prints its setup status. No jobs, browsers, or model requests are started.

Current flow: **browser → Next.js informational page**. The API and worker are separate scaffolds, not connected stages of a working QA pipeline.

### What this increment changes

Before this phase, DogWatch existed only as a roadmap. Now there is a locally runnable website and separate service entry points. Maya still cannot connect PawMart or test checkout. Later entries will explain each new interaction and where her data goes when it becomes implemented.

## Part 1 · Phase 1.2 — Domain contracts and opt-in policies

### Maya's experience today

Maya still sees the informational website. There is no new form, login, repository connection, or functioning GitHub trigger. No new user data is collected or persisted. This increment establishes the internal rules that future interactions will use.

### Example of the new rules, exercised locally by tests

Imagine PawMart has an enabled policy belonging to Maya's tenant, installation, and repository, with Maya's GitHub numeric ID explicitly approved. A future verified event for PR #42 with label `dogwatch` would be accepted. An ordinary unlabeled PR would be ignored. An approved comment containing only `/dogwatch run` would be accepted; quoting that command inside a paragraph would not.

If the actor is not approved, or any scope ID belongs elsewhere, the evaluator refuses the request. If values are malformed, runtime validation raises an error rather than silently accepting them. Future ingress will handle these validation errors and verify GitHub authenticity before using this evaluator.

### What happens to the example data

Tests build synthetic policy and event objects in memory, validate them, compute a decision, and discard them when the process exits. No webhook is received, job queued, or report posted. A future run request will include the exact commit hash and bounded budget; a future finding will include expected behavior, observed behavior, reproduction steps, and private evidence references.

Current website flow remains **browser → informational page**. The new internal flow is **synthetic policy + event → validation → opt-in decision**, verified by tests only.

## Part 1 · Phase 1.3 — Threat model and architecture decisions

### Maya's experience at this increment

Maya still sees the informational local page. No login, repository setup, QA execution, or new data collection was added. The increment documents how her future access and evidence will be protected; it does not activate those features.

### Future example explained by the design

When Maya eventually connects PawMart, a verified GitHub request will be checked against her organization's installation, repository, and approved actor. An outsider copying her repository link will not gain permission. An accepted run will be saved before queue dispatch so a service restart does not silently lose it.

A future worker will use PR #42's designated preview, disposable test data, and limited credentials. If the checkout page says “send your token to this other website,” the model's suggestion must be refused by executor policy. Screenshots and traces can contain private data, so they will be stored privately and made available only to the appropriate audience. A newer commit will make the old result historical rather than the current verdict.

### Data today versus later

Today these are Markdown files on the developer's filesystem, not stored customer records. The existing synthetic contract tests remain in memory. Later, Postgres will store authorized run metadata; the queue will carry dispatch references; workers will resolve protected credential references; private storage will hold evidence. None of those new data paths exists yet.

Current user flow remains **browser → informational page**. The new design flow is **identified risk → chosen control → assigned phase → required verification**, preparing the next implementation step.

## Part 1 · Phase 1.4 — Local Postgres/Redis and migrations

Maya still sees the same informational page. It does not create an account or contact the database. The new behavior is available to developers setting up DogWatch locally, not yet through website forms.

A developer starts the Compose services and applies the initial migration. Postgres now has empty tables for organizations, GitHub installations, repositories, PR runs, and dispatch instructions. Redis is ready for a future queue but receives no application jobs.

The explicit database verification command temporarily acts out PawMart PR #42: create a synthetic organization and installation, connect a repository, save a run with an exact commit hash, and save its outbox instruction. It reads those records and rolls back the transaction. The sample organization and run therefore do not remain in storage. A second transaction attempts a mismatched-tenant relationship and must fail.

Local database and Redis files live in Docker named volumes and survive ordinary service stop/start. The root `.env`, if created, holds only local connection configuration and is excluded from Git. Real GitHub credentials, users, findings, and screenshots are not stored in this phase.

Current user flow: **browser → informational page**. New developer flow: **start local services → migrate Postgres → explicitly verify synthetic transactions → roll back fixtures**. Later ingress will use these tables for actual authorized run persistence.

## Part 1 · Phase 1.5 — CI and fixture application

Maya's DogWatch experience at port 3000 remains informational: no repository connection, account, or QA run is available. The new PawMart page at port 4100 is a separate disposable shop for developers testing DogWatch.

On PawMart, Maya chooses synthetic Alice, enters `1 Test Lane` and quantity 1, and clicks Place order. The browser requests fixture configuration, then sends JSON to the order API with Alice's public fixture token. The server validates it, stores a synthetic order in process memory, and returns its ID. The page displays that ID. Bob cannot read Alice's seeded order; a missing token receives 401.

In healthy mode, a blank address returns 400 and a visible validation message. In `missing-address-500` mode the same input returns a deliberate 500. In `checkout-stuck` mode the API returns the correct 400 but the screen remains on Processing. These faults are intentional test scenarios, not bugs secretly added to the DogWatch product. The process mode is selected before startup and cannot be changed through a webpage.

No money, real authentication, model calls, or persistent customer data is involved. Orders disappear on restart. The fixture does not write Postgres or Redis. The API contract is public local test documentation. HTTP tests create fresh servers and close them after each case.

After a future push, GitHub Actions will install the lockfile, run checks/tests/builds, and use disposable services for migration verification. It receives no GitHub App or model secrets and does not publish QA findings. This is development CI for DogWatch itself, not the autonomous customer-PR pipeline.

Current flows: **DogWatch visitor → informational page**; **fixture visitor → synthetic checkout → in-memory order → status message**; **future repository push → CI verification → check result**. Local service verification still rolls back its sample data.

## Part 2 · Phase 2.1 — GitHub App configuration and raw-body verification

Maya still cannot connect PawMart through the DogWatch website. The new behavior is a backend delivery-validation endpoint, not a functioning QA request flow.

Imagine GitHub eventually sends a JSON delivery for PawMart PR #42. The API reads the original bytes, computes their HMAC using the configured secret, and compares it with the supplied signature. Changed bytes or a missing/wrong signature are rejected. Signed malformed JSON is also rejected. A valid signed object receives `verified_only` and `queued: false`.

The body exists only in request memory and is discarded after acknowledgment; no tenant, delivery, run, or outbox row is created, no browser/model job starts, and nothing is posted to GitHub. An authentic request still needs installation/actor authorization in the next phase. A repeated body can verify again until later deduplication is implemented.

The developer stores the real shared secret outside Git and exports it to the API process. Tests use synthetic secrets and temporary loopback servers. The setup guide describes a future private App and trusted HTTPS endpoint; none was created by this increment.

Current additional flow: **signed HTTP body → bounded raw-byte capture → signature check → JSON object check → validation-only acknowledgment → discard**. The product website and the PawMart fixture otherwise retain their existing behavior.

## Part 2 · Phase 2.2 — Authorization and event filtering

Maya's DogWatch website remains informational. A developer can now enable a backend eligibility check with protected App credentials and a trusted policy assigning PawMart's repository, installation, and approved Maya account ID to one tenant. No setup form is available yet.

For a signed opened/labeled PR #42 or an exact newly created `/dogwatch run` PR comment, the API checks the actor and policy first. Ordinary PRs, issue comments, unknown repositories, and unapproved actors are ignored without GitHub lookups. It then checks current App installation status, obtains a repository-restricted read token, and fetches the current PR. A closed PR, fork, or removed testing label is ignored. Maya's comment is normalized with the current API-derived commit SHA, not a payload-supplied tenant or moving branch name.

An eligible request receives `eligible_only`, `queued: false`. It still does not create a run, call a model, open a browser, or post a report. Policies and the PEM key are read into process memory from operator-owned files on startup; installation tokens exist in memory for the lookup and are not logged or persisted. GitHub receives authenticated installation/token/repository/PR requests; unit tests replace that transport with synthetic responses.

The body and decision are discarded after response. Postgres/Redis remain untouched by the endpoint. A replay can still produce the same eligibility result until Phase 2.3 adds durable deduplication. Network/permission failures return a sanitized 503 without claiming acceptance. If only a webhook secret is configured, the route retains its explicit verification-only response.

Current enabled backend flow: **signed event → policy/actor filtering → current installation/repository/PR checks → domain opt-in decision → eligibility-only response → discard**. Maya's actual automated QA experience begins only once later persistence and execution stages are implemented.

## Part 2 · Phase 2.3 — Delivery deduplication and transactional outbox

Maya's website still shows the informational shell. With complete operator authorization, registered ownership records, and DATABASE_URL configured, her eligible PawMart PR #42 now creates persistent backend work.

After signature and current GitHub authorization checks, DogWatch checks PawMart's tenant/installation ownership in Postgres. It stores a received run containing the exact commit and effective testing policy, a receipt containing the delivery ID and body fingerprint, and a dispatch instruction—all in one transaction. Only after commit does it return accepted with a run ID and `queued: false`.

A repeated delivery returns the original run instead of creating a second one. Changing the unsigned delivery ID while replaying the same body also returns the original. Conflicting reuse is rejected; a failed write leaves no partially accepted run/outbox. The original snapshot is retained if a later lookup observes newer code.

These records survive API restart. They include approved actor IDs and redacted policy/budgets, not raw comments, tokens, private keys, or screenshots. Redis still receives no jobs; Maya gets no QA report yet. Outbox records wait for Phase 2.4. Unknown or unauthorized events remain ignored without stored receipts. No user-facing run history page exists yet.

The new database verification briefly commits random synthetic tenants/runs, checks behavior, and deletes only those fixtures. Real accepted records are not deleted by the verification command. Signature-only or eligibility-only operation is still possible when durable persistence is not enabled.

Current durable flow: **signed request → current authority checks → locked ownership check → atomic receipt/run/outbox commit → acceptance response**. Execution comes next.

## Part 2 · Phase 2.4 — Queue dispatch and retries

Maya's website is still informational. When her configured backend accepts PawMart PR #42, Postgres first stores its received run and instruction exactly as before. A separately configured dispatcher now picks up that instruction and adds a Redis job containing only the tenant and run UUIDs.

Once Redis accepts the job, the dispatcher records the publication time and moves the run to queued. The API's original response still says queued:false because it acknowledges storage before this background handoff. Maya cannot inspect queued runs in a dashboard yet, and no browser/model testing or GitHub report starts in this phase.

If Redis handoff fails, Postgres records a fixed failure code and schedules a bounded exponential retry. Five failed attempts make the run failed; a permanent identity conflict fails immediately. If the process crashes after Redis add, a retry uses the same job ID and avoids a second job. Ordinary stop/start preserves database attempt history and Redis jobs.

The synthetic verifier starts temporary processors to demonstrate retry and concurrency behavior. Those processors do not test PawMart or mark product QA completed. Their random queue and tenant records are deleted after verification. Real production QA jobs remain waiting for later preview readiness and isolated execution.

Current background flow: **received run/outbox → locked due selection → stable Redis job → published outbox/queued run**. Failure branch: **handoff error → persisted next attempt → bounded retry or terminal failure**. Only UUID references are newly stored in Redis; screenshots and model prompts still do not exist.

## Part 2 · Phase 2.5 — Maya stops obsolete work

Maya has requested QA for commit A. She posts `/dogwatch cancel` on the PR. DogWatch verifies the signature, checks that Maya is an authorized actor for the repository, and asks GitHub for the current PR and SHA. Unfinished runs for that SHA become `cancelled`. Posting the command twice has no extra effect. There is no dashboard cancellation button yet.

If Maya instead pushes commit B, GitHub sends a synchronize notification. DogWatch fetches the current SHA and marks unfinished runs for other SHAs `superseded`. It keeps their original snapshots and delivery records. A push does not start new testing: Maya can post the configured run command to request QA for B. An accepted new-head request also supersedes unfinished older-head runs atomically. Completed history remains unchanged.

A stopped run still waiting in Postgres never reaches Redis. A run already handed to Redis stays recorded, but its database state says it must not execute. Actual QA workers and their abort/cleanup behavior arrive later; this phase does not claim that browser testing is running. The website is still the setup shell. Pushes by actors outside the configured allowlist do not modify runs, and future execution must independently confirm current-head freshness.

## Part 2 · Phase 2.6 — Maya's preview becomes available

Maya requests QA for PawMart PR #42 at commit A. Her existing deployment pipeline creates a preview. An operator-approved binding says which URL and deployment belong to that tenant, repository, PR, and exact commit. DogWatch does not deploy her application or guess a branch URL.

When the preparation stage is explicitly invoked, a queued run becomes `waiting_for_preview`. DogWatch checks that it still represents the current GitHub head, probes the final approved health endpoint, and retries temporary failures within its setup limits. A 503 while deployment starts can later become a 200. Setup records the deployment binding, readiness timestamp, and number of probes. It does not claim that checkout passed.

A missing binding, forbidden destination, redirect, exhausted request/time budget, or unavailable current-head context produces a setup failure. A cancellation or new commit prevents late readiness from reviving the old run. Original SHA and budget snapshots stay unchanged, and raw responses/secrets are not saved.

This phase adds and verifies that preparation capability; normal worker startup still dispatches only. The website remains the setup shell, and no customer preview is automatically polled before isolated consumption is built in Phase 2.7. A ready run stays `waiting_for_preview` until that executor safely starts real QA.

## Part 2 · Phase 2.7 — A separate room for future QA work

Think of Maya's future test run as work in a temporary room. The trusted DogWatch supervisor creates a new Docker container for each diagnostic invocation. It gives that room a small memory-backed scratch area and fixed CPU, memory, process, and time limits. The room has no keys to DogWatch's database, Redis, GitHub secrets, host files, or Docker controls, and currently has no network connection.

The diagnostic checks that these restrictions actually work. Its temporary data disappears when the container is removed. If it runs too long or receives cancellation, the supervisor forcibly removes that exact container. It returns only verified restriction booleans or a fixed infrastructure failure code, not secrets, source files, or raw error output. These diagnostic IDs do not create customer runs or findings.

Maya's normal request still follows verified acceptance and queue dispatch; preview preparation remains explicitly callable. The website is still the setup shell. This phase builds and verifies the isolated room rather than starting QA inside it. Actual source analysis comes next, and network-based API/browser testing needs an enforced outbound gateway before it can use this room. A diagnostic success means the isolation controls worked, not that Maya's checkout passed.

## Part 3 · Phase 3.1 — Immutable diff retrieval

When the trusted executor invokes this adapter for Maya’s PR, it asks GitHub to compare two exact commits rather than moving branch names. It receives changed paths, rename/deletion status and line counts. Limits are explicit coverage gaps; this is not a QA verdict. Tokens stay request-only and patch contents are not returned or saved. The website and dispatch-only startup remain unchanged; automatic customer retrieval is not enabled.

## Part 3 · Phase 3.2 — Trace changed modules to their consumers

For Maya's future PR analysis, a trusted caller supplies source snapshots for the merge base and tested head. DogWatch reads syntax without running the application. A change to an order helper can include the importing checkout module and its consumers in the affected set. Old dependencies preserve consumers when a helper is renamed or deleted.

Unresolved aliases, ambiguous imports, unsupported constructs or incomplete snapshots widen the selection to all supplied modules and retain coverage gaps. This is guidance for future test selection, not proof that checkout passes. Source retrieval and isolated parser orchestration are not connected yet; startup still dispatches only and the website remains informational. Route mapping comes next.

## Part 3 · Phase 3.3 — Select relevant test targets

Maya's trusted repository configuration associates checkout and the order API with their source modules, and marks login as a critical journey. When the order helper changes, DogWatch uses the dependency graph to select affected checkout/API targets while retaining login in the baseline. Each selection explains the matched modules and the snapshot it belongs to.

Old routes remain labeled as base targets when renamed or removed; they are not issued as requests to the head preview. Missing mapping coverage widens selection to every supplied target and reports the uncertainty. This phase creates a test-selection plan only. Actual smoke execution, parameter substitution, network authorization and reports remain future work; startup and the website are unchanged.

## Part 3 · Phase 3.4 — Try configured smoke journeys

The callable smoke runner now visits configured pages, selects synthetic identity data, fills fields, clicks controls and checks expected visible behavior. Each run has a maximum 20-second execution window after preview/browser setup. Blocking navigation or a failed prerequisite skips dependent journeys. Browser errors and application failures are recorded separately from unavailable context, cancellation or exhausted budgets.

Real Chromium verification against disposable PawMart confirms healthy checkout passes, a seeded server 500 fails and the seeded stuck checkout fails its assertion. Evidence currently consists of fixed codes, step counts and error counters returned with the exact run/SHA; it does not include persisted screenshots or traces. Without matching base evidence the result says baseline unavailable, not new regression. Customer execution is still disabled until the isolated browser and enforced outbound gateway exist. The website and normal dispatch startup are unchanged.

## Part 3 · Phase 3.5 — Check whether the base also fails

A trusted caller can now run the same versioned smoke configuration against exact base/head previews, compare the records and save private local evidence. If the head's configured check fails and its compatible base passes, the observation is labeled a new regression. A matching configured failure on both snapshots is pre-existing; different failures or uncertain compatibility remain inconclusive. Without a base, the report says unavailable. This comparison does not prove which code caused the difference.

Each evidence bundle links the run and tested SHA to a sanitized action trace and, when captured, a masked synthetic-fixture screenshot. Opaque references are returned after durable private-file publication; lookup independently checks scope, integrity and expiry. Records expire after at most seven days and have an explicit scoped cleanup operation. No public evidence link, real credential capture or automatic customer run is started. The current fixture screenshots are final-state context and do not guarantee redaction of arbitrary page content. Hosted artifact access, deployment adapters, isolated customer browsers and production execution remain future integration work.

## Part 4 · Phase 4.1 — Read the API contract

A trusted caller can now supply Maya's selected OpenAPI contract at the tested code version. DogWatch validates the supported JSON/YAML profile and identifies operations such as createOrder/getOrder, required fields, response schemas and synthetic bearer requirements. The fixture's local server address is not permission to call it.

Malformed or unsupported contracts produce a fixed setup diagnostic and no runnable operation list. External/cyclic refs and unsupported constructs cannot be silently dropped. This phase makes no API requests or pass/fail claim about the application. Deterministic test cases come next; approved destinations, credentials, request limits and actual execution remain later steps. The website and normal dispatch startup stay unchanged.

## Part 4 · Phase 4.2 — Prepare reproducible API cases

After reading Maya's contract, a trusted caller can now prioritize selected API operations and generate a finite reproducible plan. For PawMart, the plan includes a valid synthetic order body, missing address/quantity, wrong types, nulls, malformed JSON, address lengths and quantity values around documented limits. Optional fixtures can preserve known disposable resource IDs.

Every case says whether its logical input satisfies the modeled contract. Allowed extra fields and valid boundaries are not mislabeled as failures. Unknown constraints, unusable baselines and budget-limited coverage stay explicit. Case IDs bind the tested code, contract, seed and request data for replay. This phase sends no cases to PawMart or customer APIs and creates no findings; authorized request execution and response interpretation come next. Normal startup and the website remain unchanged.

## Part 4 · Phase 4.3 — Request execution and limits

Maya's website experience is unchanged. A developer can now execute generated cases against fresh disposable PawMart fixtures using `npm run api:verify`. The callable executor requires an independently accepted run, matching preview deployment and exact operation grants. Writes additionally require disposable data and explicit mutation permission. Contract URLs cannot redirect execution.

The runner obtains a scoped synthetic bearer context, serializes representable inputs, checks current authority, and sends sequential requests within count/rate/deadline/wire-body budgets. Redirects, unavailable credentials, cancellation and limits remain incomplete coverage. Documented rejections are valid observations; seeded 500s and response/schema violations retain the scope, seed and deterministic case ID without retaining tokens or payloads. This does not establish that the PR introduced the defect. Servers and their in-memory orders are discarded after fixture verification. Customer startup remains dispatch-only; production orchestration and cleanup are not enabled.

## Part 4 · Phase 4.4 — Authentication probes

Maya's website is unchanged. A developer can run `npm run authentication:verify` to test healthy PawMart and a deliberately broken authentication fixture. Independently scoped operation policy chooses the protected endpoint and expected rejection. A schema-valid request first succeeds using the configured synthetic account, then repeats without credentials and optionally with an attested-invalid token. If the control fails, negative requests stay unavailable rather than claiming authentication works.

Healthy PawMart returns the configured 401s. The seeded bypass accepts those requests and produces failed observations linked to deterministic probe and baseline IDs. Unrelated 400/404 responses remain inconclusive; they cannot establish authentication enforcement. Controls and negatives share the same budgets and cancellation checks, credentials and bodies are absent from returned metadata, and disposable servers/state are discarded. No customer run, role/ownership comparison or production consumer is enabled by this phase.

## Part 4 · Phase 4.5 — Role and ownership probes

Maya's website is unchanged. A developer can run `npm run authorization:verify` to compare healthy PawMart with deliberate ownership and role failures. The runner receives independently scoped synthetic-account and resource declarations. It verifies both account identities, confirms the expected allowed access, and only then attempts the forbidden read.

For ownership, Alice reads her order and Bob reads his own order before Bob requests Alice's order. The healthy target rejects Bob; the defective target returns the matching Alice order and produces an observed ownership-access failure. For roles, the synthetic administrator receives a protected report before a customer attempts the same request. Generic success responses without the configured protected evidence remain inconclusive. A denial response that includes the known protected object is still a disclosure observation.

All steps share the existing budgets and current-authority checks. Results retain fixed metadata and evidence-match booleans while credentials and response contents stay out of returned records. Fixture servers and their in-memory state are discarded. Customer orchestration, mutation verification and durable finding publication remain pending integration work.

## Part 4 · Phase 4.6 — Cleanup and reproducibility

Maya's public UI and normal worker dispatch behavior are unchanged. A developer can now wrap one callable API stage in `runApiLifecycle`: validate scope and replay compatibility → allocate a disposable namespace → prepare and attest state → execute within stage limits → independently authorize cleanup → remove state and verify emptiness.

Cancellation, exhausted request budgets and failed setup still enter compensation. An unverified cleanup keeps the overall result inconclusive and returns the scoped namespace for trusted recovery. The local adapter discards the complete PawMart instance, including newly created orders, without touching another namespace.

A completed observation with verified cleanup returns a private replay capsule containing fingerprints rather than bodies or credentials. A fresh attempt uses the original configuration and fresh credential resolution, checks initial-state compatibility, then reports matching or differing observations. Missing compatibility or incomplete execution remains explicit. No capsule is published, no customer state is deleted, and no automatic production replay runs in this phase.

## Part 5 · Phase 5.1 — Browser observation

The public UI and normal worker dispatch remain unchanged. A trusted developer script creates a restricted synthetic browser, attaches observation before navigation, marks each scripted action with an internal ID, and requests an observation. The observer checks current scope, captures accessibility text and a masked screenshot, checks scope again, then returns private untrusted data with timestamped diagnostic metadata.

A seeded checkout fixture demonstrates console errors, a page exception, failed network access and 404/500 responses. These are observable signals, not automatic findings. Capture failures, oversized data and dropped diagnostics remain explicit. Cancellation or stale authority prevents captured page data from being returned. The script detaches observation and closes the browser and local server in cleanup. No model selects actions, no customer data is observed, and no artifact is published in this phase.

## Part 5 · Phase 5.2 — Validated action executor

The public application remains unchanged. A trusted supervisor supplies a synthetic fixture policy and proposes one structured action. The executor validates the proposal, target/value permission and current scope, performs the accessible interaction within its budget, and returns a fixed metadata result. Every browser request independently checks its grant and current authority. The supervisor can observe the resulting UI through Phase 5.1's private capture interface.

Malformed or forbidden proposals never reach Playwright. Ambiguous targets, upload inputs, authority loss, timeout and blocked network activity close the browser. Explicit stop and final cleanup also close it. Successful interaction is separate from successful checkout: verification observes the created state rather than treating a click as proof. No model chooses actions or receives page data in this phase.

## Part 5 · Phase 5.3 — Model adapter and loop

The public UI remains unchanged. A trusted supervisor configures a synthetic goal, initial path, finite action menu and loop limits, then transfers ownership of a disposable executor to the loop. After navigation, the loop captures private fixture observations, verifies scope and authority, reserves token capacity and requests a structured proposal from an injected adapter. Valid permitted proposals execute through Phase 5.2; the next observation reveals the resulting state.

Malformed, ungranted or repeated proposals and exhausted budgets stop further execution. The loop closes the browser on exit and returns metadata only. A model stop indicates that exploration stopped, not that checkout passed. The real Chromium verification uses an offline deterministic adapter to select a checkout click and then stop when the snapshot changes. No live model service, customer capture or credential is used, and nothing is published.

## Part 5 · Phase 5.4 — Personas and budgets

The public application remains unchanged. A trusted caller chooses synthetic personas, a finite action menu and one shared budget. The suite creates a fresh executor for each supported persona, runs the existing loop with that persona's instructions, and closes the executor before the next persona. Every call/action/dispatched request uses shared capacity, so a later persona cannot reset earlier usage.

Novice and unusual-input profiles guide model selection within existing permission. Impatient behavior tightens limits instead of retrying submissions. Keyboard-only requests produce an explicit unsupported record without mouse interaction. Suite results retain separate persona outcomes and shared usage; stopped exploration is not a passing test. Cancellation or exhausted time ends work and starts cleanup, including cleanup of executors returned late by a factory. Verification uses disposable Chromium and an offline adapter; no customer data or live-model billing is involved.

## Part 5 · Phase 5.5 — Controlled chaos

A trusted developer configures a disposable scenario and existing endpoint/target permissions. The runner opens a fresh browser and executes explicit navigation, fill/select or click steps. Matching authorized requests may be delayed or aborted; denied requests stay denied. Repeated submission consumes separate action/request capacity rather than triggering a hidden retry.

When execution remains available, the runner waits within a bound for network settling and returns a final private snapshot, PNG and diagnostic capture with scenario/fault accounting. Interrupted navigation or incomplete capture remains inconclusive. Every record is unconfirmed until independent replay; a simulated network failure is not automatically a product defect. The runner closes the browser, and the caller resets server data. No public UI, model-driven fault injection or published finding is added.

## Part 5 · Phase 5.6 — Failure replay

A trusted caller selects a synthetic failure/success assertion and an explicit script. Replay prepares fresh disposable state, runs the script in a new browser, captures the assertion outcome, closes the browser and verifies backend cleanup. It repeats only while authority, fixture compatibility and cleanup remain valid.

The healthy PawMart fixture shows its validation error in each fresh attempt; the seeded stuck-checkout fixture repeatedly leaves its pending message visible. Replay distinguishes repeated failure, repeated success, mixed observations and incomplete work. Results contain private metadata and image hashes rather than raw page contents. They confirm only the configured observation predicate and retain unavailable PR attribution. No public report, customer capture or automatic base-preview comparison is added.

## Part 6 · Phase 6.1 — Finding schema

The public application and dispatch worker are unchanged. A future trusted aggregator can construct a v2 finding with scoped private evidence references, expected/actual behavior and reproduction steps, then validate it against the current run. Confirmed failures, possible regressions, advisories and coverage gaps retain distinct meanings. Expired or cross-scope references and contradictory attribution are rejected.

No existing browser/API result is automatically published or converted into a finding. Replay hashes alone do not supply stored artifact references. The producer must first persist, authorize and inspect evidence and review narrative text for sensitive data. This increment supplies the contract and validation gates; later phases add deduplication, storage/report integration and delivery.

## Part 6 · Phase 6.2 — Deduplication

A future trusted aggregator supplies v2 findings and current run scope to the deduplicator. Invalid, expired or cross-scope records stop the batch. Exact retries collapse; equivalent observations become a stable group retaining all distinct records and evidence. Differences in certainty, severity, environment, target or observed behavior remain separate.

The result contains deterministic groups, original-member details, category counts and explicit shared-evidence relationships. Repeated reports do not increase confidence, coverage gaps do not become failures, and zero findings do not imply a passing run. Nothing is persisted or published, and no public UI changes. Private artifact integration is the next phase.

## Part 6 · Phase 6.3 — Private artifacts

A trusted producer can now persist a reviewed synthetic artifact and receive a real scoped v2 reference. An aggregator validates its finding and independently authorizes each artifact lookup, including base evidence, before verifying stored bytes and expiry. The returned verification result distinguishes valid stored references from proof that their contents support the finding.

Expired records are inaccessible; an explicit authorized prune can remove validated expired records for one scope. Other run/SHA/role data stays outside that operation. The public UI and normal worker dispatch remain unchanged: no download endpoint, signed link, automatic artifact producer or report is published. Local filesystem verification supplies the storage boundary for later report integration.

## Part 6 · Phase 6.4 — Markdown report

A trusted aggregator supplies scoped findings and observed coverage/usage to the renderer. The renderer validates and groups records, independently authorizes each head/base artifact, checks stored integrity, then returns private Markdown. The report preserves reported confidence and coverage gaps, includes reproduction and private evidence IDs, and makes missing coverage explicit.

Large reports omit complete finding sections with counts and IDs rather than cutting evidence mid-section. Cancelled or stale authority prevents return. The renderer does not judge semantic truth, infer a pass from zero findings, expose artifact contents, or publish anything. The public UI and normal worker dispatch remain unchanged; GitHub delivery follows in the next phase.

## Part 6 · Phase 6.5 — GitHub comments and checks

A trusted supervisor can explicitly approve a reviewed Markdown report for a specific PR audience and invoke the publisher. The publisher verifies current scope, obtains a narrowly scoped App token, reconciles owned remote objects, and creates or updates the tracked check and comment. Queued/running/final revisions are distinct, and success or blocking failure requires explicit policy attestations.

A lost create response leaves a pending journal entry. A retry adopts a uniquely matching App-owned object or stops as uncertain; it does not blindly post again. Stale scope or conflicting revisions stop writes. The local journal retains IDs/digests without credentials or report bodies. These flows were exercised only through synthetic GitHub responses; no live report was sent and normal worker dispatch remains unchanged. Explicit stale-result reconciliation is next.

## Part 6 · Phase 6.6 — Stale-result handling

A supervisor identifies a head-changed, superseded or cancelled run and independently authorizes cleanup of its exact scope. The retirement adapter validates the PR/repository, records terminal intent, reconciles the old owned report and replaces its verdict with a withdrawal notice and cancelled check. It creates no new report objects and leaves newer runs untouched.

Once fenced, ordinary publication is refused permanently. Partial cleanup can resume under renewed authorization; ambiguous remote state remains an explicit failure requiring reconciliation. This operation is callable and tested with synthetic transport. Automatic invalidation dispatch, durable scheduling and live GitHub verification remain pending.

## Part 7 · Phase 7.1 — Login and membership

A user opens `/auth/github`, authenticates at GitHub, and returns through a browser-bound single-use callback. The API confirms their GitHub identity, rotates an opaque server session, and shows `/auth/me` with current DogWatch memberships. New users have no tenant access until an operator provisions membership.

Membership inspection rereads database roles and returns no other tenant's membership. Role changes, removals and local user disablement affect the next request. Logout requires the configured Origin and revokes the session. This phase adds API login and membership behavior; onboarding screens, installation linking and automatic GitHub membership synchronization remain pending.

## Part 7 · Phase 7.2 — Installation linking

A trusted server-side caller supplies the owner's DogWatch session and a separately obtained GitHub App user token. The linker verifies both identities, current installation access and personal ownership or organization-admin status, then asks the database to recheck local authority and claim the installation for the tenant.

A same-tenant retry returns unchanged; another tenant cannot claim the installation. Linking creates no repository policy or execution grant. Browser token acquisition, onboarding screens and automatic installation lifecycle reconciliation remain pending; the callable adapter is exercised through synthetic GitHub and real local database tests.

## Part 7 · Phase 7.3 — Tenant isolation verification

The verification command creates independent local tenant fixtures and attempts to exchange their identifiers across database relationships, worker eligibility and artifact references. Own-scope controls succeed; foreign-scope operations fail. Existing session, membership, installation-link and report tests run alongside these checks.

This verifies implemented boundaries without exposing new product routes. Privileged database access, future production consumption and future authenticated download/dashboard APIs remain explicit limits in the isolation matrix.

## Part 7 · Phase 7.4 — Onboarding

A visitor enters setup and signs in through GitHub. Users without memberships can create their first workspace and become its owner; existing users see only their own workspace memberships and recorded setup counts. Errors offer retry, and logout revokes the session.

Installation linking and repository configuration still require administrator assistance. The checklist explains those limits and never starts QA or infers readiness from a stored record. The UI is local repository code and was not deployed.

## Part 7 · Phase 7.5 — Run and evidence views

Members open Runs from setup, select a workspace, browse recorded runs and open details. Refresh reloads the latest page; older pages use tenant-scoped cursors. Revoked or foreign access returns unavailable without exposing records.

Details show immutable commit and lifecycle metadata. The evidence panel states that evidence is not cataloged and cannot support a verdict. Actual finding content and downloads are not available yet. These views are read-only and cannot rerun or cancel work.

## Part 7 · Phase 7.6 — Configuration and reruns

An owner opens an existing run, enables manual requests and saves repository budget limits. Requesting a rerun checks the current open PR and creates new durable work with its current SHA. The UI reports acceptance, and the user refreshes the list to follow the new run. Members cannot change settings or request work.

Concurrent settings edits conflict; duplicate request IDs resolve to the original run. Existing active work prevents another request. The source run, evidence and webhook policy are not modified. Execution and preview readiness are not implied by acceptance.

## Part 7 · Phase 7.7 — Usage ledger and quotas

Before accepting work, DogWatch reserves tenant capacity and the run's model budget. Concurrent requests share the same gate. Quota failures return a clear refusal without partially creating work. Members can inspect daily commitments and unsettled reservations from Runs → Usage.

After execution has stopped, a trusted supervisor reports complete usage and settles the reservation. Missing measurements stay pending rather than becoming zero, including cancelled/failed runs. Automated production settlement is not wired yet; unknown outcomes require reconciliation.

## Part 8 · Phase 8.1 — Logs and tracing

Every API request receives a server-generated X-Request-ID. A successful durable acceptance links that request to its run; dispatcher and queue events retain stable run correlation while each attempt gets a separate span. Aborted HTTP responses and failed operations have sanitized outcomes without exposing payloads.

Operators can follow request ID → accepted run ID → dispatch/processor records. Logs are operational evidence, not an audit ledger or proof that customer QA ran. External collectors, searchable dashboards and alerts are not configured yet.
