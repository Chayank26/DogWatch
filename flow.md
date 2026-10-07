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
