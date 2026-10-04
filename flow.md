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
