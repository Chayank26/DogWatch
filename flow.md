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
