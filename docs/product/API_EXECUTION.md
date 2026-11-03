# API-first productization: durable execution slice

The first workflow selected by the user is API contract checks. This slice adds
actual durable execution ownership and stored API results to the previously
callable stages. `npm run api-supervisor:verify` proves a real isolated Redis job
is consumed, bounded HTTP checks run, and PostgreSQL records the result and usage.
It is not yet a configured customer-facing consumer or a complete GitHub PR flow.

## Run it locally

```sh
docker compose up -d --wait postgres redis
npm run db:migrate
npm run api-supervisor:verify
```

The verifier uses the fixed local Compose targets, a random tenant and an isolated
queue. It cleans its own records/queue and closes its HTTP listener. The additive
`202610280001_run_execution` migration introduces one `RunExecution` per run, with
a tenant-consistent foreign key, owner token, database-clock lease/deadline and
bounded result JSON. It does not rewrite existing runs. Apply it before using the
new supervisor. Do not drop execution history to roll back application code.

## Execution contract

`runApiExecution` accepts a trusted operator-supplied scoped deployment binding,
read-only API grant, OpenAPI text and generation/limit configuration. It copies
inputs before awaiting capabilities, compares tenant/run/repository/PR/SHA scope,
and refuses all methods except GET/HEAD and all mutation grants. An injected
trusted authority resolver must independently verify the current installation,
repository, actor/opt-in authority and current head. It must not simply echo the
input SHA. No resolver is sourced from browser, webhook or model JSON.

The supervisor checks authority before claiming and again at stage/request
boundaries. A queued run must already have a published outbox and an unsettled
usage reservation. A row lock and single execution row prevent concurrent claims
and duplicate deliveries from starting another attempt. Owner tokens never go
into queue payloads or public APIs.

The database sets a 30-second lease capped by the accepted whole-run deadline.
Renewal checks live ownership, token, deadline and durable running state. Expired
ownership cannot be renewed. The supervisor runs bounded preview readiness and
then existing contract-generated API checks, deducting readiness requests from
the accepted request budget. HTTPS/public-address/pinned-DNS restrictions apply
outside the code-only loopback fixture option. No browser or model is used here.

Results contain bounded case IDs, operation templates, fixed codes/statuses,
coverage gaps and counts, not response bodies, headers or credentials. A live
owner commits result, terminal state and measured usage in one transaction using
the admission/settlement tenant lock. Missing usage state rolls the whole commit
back. Readiness/API request accounting must agree. For this stage, known unused
browser/model/artifact counters are zero; host/DB/Redis overhead is not metered.

A completed run means the check stage finished, **not** that its API checks passed.
Confirmed server/schema failures remain failed cases inside a completed execution.
Incomplete coverage or setup produces an inconclusive result and failed run; the
verifier originally caught a too-small case budget and retained that distinction.

## Cancellation, expiry and failures

Cancellation/supersession and expired tokens reject result commit. Unknown usage
is not settled to zero. Exceptions or lost authority return interrupted; their
reservation remains pending. `expireExecution` is an explicit scoped reconciliation
primitive that marks an expired unfinished execution finished and an active run
failed, preserving cancelled/superseded states and unknown usage. It does not
reset a run or authorize replay, and no scheduler invokes it automatically yet.

A queue retry cannot re-execute an existing claim, including an expired one.
Operators must reconcile uncertainty and use a separately authorized fresh rerun
where appropriate. This avoids an unproven exactly-once guarantee. External GitHub
state can change after any remote check; publication will need a fresh authority
check, while durable local cancellation is fenced transactionally.

## Verified boundaries

- Real Redis delivery → readiness → HTTP execution → stored result and usage.
- Healthy response and confirmed API server error retain distinct outcomes.
- Concurrent claims and repeated deliveries do not repeat HTTP work.
- Wrong tenant/token and revoked authority cannot acquire/finish execution.
- Cancellation wins over result settlement; expired leases cannot renew/finish.
- Explicit expiry never replays work or releases unknown usage.
- Settlement failure rolls back result and terminal state together.
- Configuration scope and mutations fail before DB/transport capabilities.

## Next integration work

Worker startup defaults to dispatcher-only operation. Phase 9.3 below adds an
explicitly enabled consumer with trusted configuration, GitHub authority and
expiry reconciliation. Next work is authorized result reads/dashboard presentation,
finding/report publication, operational recovery UI and live staging tests.

The first staging repository, HTTPS preview URL and OpenAPI location are needed
for that integration. Tokens/secrets belong in protected local/provider storage,
not chat, tracked files, result JSON or queue messages. Mutating API checks and
browser execution remain separate later capabilities.

## Phase 9.2 — Trusted API configuration and execution authority

Added `createApiConfiguration` to validate operator-owned read-only API targets
and resolve an exact tenant/repository/PR/SHA binding into supervisor input. It
rejects ambiguous bindings, fixture flags, mutations and authentication probes.
Contract text is supplied by the operator; no PR-controlled file or remote URL is
loaded. HTTPS/origin validation runs at configuration time; public-address DNS
validation remains enforced by the execution transport.

Accepted webhook runs now retain their actor ID. `createGitHubExecutionAuthority`
composes the existing repository-restricted GitHub App adapter with fresh operator
policy and durable run checks. It refuses disabled policies, removed actors,
closed/forked/moved PRs, removed opt-in labels, cancellation and unavailable
configuration/GitHub state. Command opt-in does not require a label. Legacy runs
without actor provenance and manual reruns are refused by this initial adapter;
manual rerun authority remains follow-up work. No new credentials or schema
migration are required.

These are internal integration capabilities. Worker startup still dispatches only;
consumer lifecycle, result presentation and staging validation remain outstanding.
The first repository, HTTPS staging URL and OpenAPI location are still needed.
No live GitHub request, customer execution or deployment was performed.

## Phase 9.3 — Configured worker consumer

Worker startup now enables the API consumer only with `API_CONSUMER_ENABLED=true`.
It requires DATABASE_URL, REDIS_URL, GITHUB_APP_ID, GITHUB_PRIVATE_KEY_FILE,
GITHUB_POLICIES_FILE and API_EXECUTION_CONFIG_FILE. Missing or malformed settings
stop startup. Omit the flag to retain dispatcher-only operation. Apply the
RunExecution migration first. The existing GitHub adapter and execution authority
now live in @dogwatch/github, shared by API and worker.

The execution file is a JSON array of entries with `binding`, `contractText`,
`operations` and optional `limits`, as validated by api-configuration.ts. For example:

```json
[
  {
    "binding": {
      "tenantId": "11111111-1111-4111-8111-111111111111",
      "repositoryId": 123,
      "pullRequestNumber": 1,
      "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "deploymentId": "operator-verified-immutable-deployment",
      "url": "https://preview.example.com/health",
      "allowedOrigins": ["https://preview.example.com"]
    },
    "contractText": "{\"openapi\":\"3.0.3\",\"info\":{\"title\":\"Example\",\"version\":\"1\"},\"paths\":{}}",
    "operations": [{ "method": "GET", "path": "/status" }]
  }
]
```

Replace every example value with the verified deployment and actual OpenAPI text;
the empty example contract does not provide test coverage. Restart the worker
when replacing deployment configuration. Policy is reloaded on each authority
check, so revocation does not require restart. No fixture mode, bearer credentials,
mutation grants or PR-controlled file loading are enabled by this startup path.

The processor reads tenant-scoped durable run identity before selecting a binding.
It retries the enqueue-before-commit race and refuses missing configuration or
unavailable authority with a fixed, sanitized queue error. After BullMQ's existing
three attempts a pre-claim failure remains a queued database run with a failed
queue job and reserved usage; an operator must inspect and retry that retained job
after correcting configuration. There is no automatic reset or new execution.

Every ten seconds the enabled process reconciles up to 100 expired execution
leases; database-clock checks remain authoritative. Interrupted runs become failed
without replay or invented usage settlement. SIGINT/SIGTERM abort active work,
close the consumer, then release queue/database connections. Shutdown can leave a
lease for the next process to reconcile. No live customer deployment has been
validated; result presentation and operational reconciliation UI remain next work.

## Phase 9.4 — Read results in the dashboard

Sign in, open `/runs`, choose your workspace and select a run. API checks now show
recorded passed/failed/inconclusive/skipped counts, expandable individual outcomes
and coverage gaps. Refresh and reopen the run to fetch newer results; this view
does not poll automatically. Completed execution can contain failed checks.
Missing, invalid or unfinished result metadata displays as unavailable. No
baseline comparison or overall passing verdict is invented.

The existing authenticated run-detail endpoint returns `apiChecks` only under its
session/membership guard and tenant-scoped run query. It selects the finished time
and validated bounded result, excluding the execution token and internal lease
state. Evidence availability remains separate. Verify storage authorization with
`npm run db:verify:run-views`, and the production UI with
`npm run api-results:verify` (synthetic API responses; requires Chromium and free
loopback port 3119). Live staging and GitHub publication remain outstanding.

## Phase 9.5 — Download a report

Open a run with recorded API results and select **Download API report**. The
Markdown file contains recorded outcomes and coverage limitations for that run
and commit. The same authorized detail read supplies the report; no public report
URL or unauthenticated artifact endpoint is created. Downloads are generated from
validated stored metadata and contain no execution tokens, response bodies or
credentials. Reports under 50 KB may omit details, explicitly counted in the file.

Baseline comparison is unavailable and reports do not assert regression causality.
GitHub posting remains disabled. Publication requires explicit authorization and
fresh authority checks; live staging verification still requires an actual target.
