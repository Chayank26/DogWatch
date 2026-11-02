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

Normal worker startup still runs the dispatcher only. Before enabling an API
consumer, wire trusted per-repository execution configuration, a real GitHub
installation/actor/current-head resolver, protected credential references,
operational expiry/reconciliation and a consumer lifecycle. Add authorized result
reads/dashboard presentation, finding/report publication and live staging tests.
Do not wire the verifier's always-authorized callback or fixture permission into
customer startup.

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
