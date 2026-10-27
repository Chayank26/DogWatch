# Structured logs and run correlation

Phase 8.1 adds a dependency-free internal `@dogwatch/telemetry` workspace. Production API, dispatcher and queue boundaries emit newline-delimited JSON to stdout. Importing the package does not start a listener or contact any service. Build scripts compile it before its consumers; the lockfile adds only the local workspace link.

## Record format

Each record has `version: 1`, UTC timestamp, service, fixed event, fixed outcome and derived level. Optional metadata is allowlisted: server request ID, trace/span IDs, tenant/run/outbox/job/delivery UUIDs, immutable head SHA, approved HTTP route template, method, response status, elapsed milliseconds and attempt number. Unknown keys and malformed/out-of-range values are omitted. Unknown runtime event/outcome values are dropped. Route values not in the fixed registry become `unmatched`.

There is no free-form message or exception field. Do not add raw errors, URLs, query strings, bodies, cookies, authorization headers, OAuth state/code, tokens, preview URLs, findings or artifact payloads. UUID identifiers are still operationally sensitive: restrict log access and retention. The allowlist is a data minimization boundary, not permission to publish logs. Third-party startup/process diagnostics and infrastructure access logs are outside this serializer and require separate controls.

## Correlation model

The API generates a fresh request UUID and trace/span IDs for every request, returns `X-Request-ID`, and ignores incoming `X-Request-ID` and `traceparent` values. Concurrent async request contexts use AsyncLocalStorage and do not share metadata. Each HTTP response produces one finish/abort record. Aborted records omit a response status because no successful transmission is established. Unknown paths are never logged verbatim. Status codes distinguish ordinary 4xx responses, while 5xx responses receive failed/error outcomes.

Committed webhook/manual acceptance emits the durable run UUID and, when available, its originating request UUID. Run traces deterministically derive a 32-hex identifier from `dogwatch-run:<run UUID>`. Dispatcher, enqueue and processor events can correlate across process boundaries using the same run ID without adding untrusted fields to Redis jobs. Each operation/attempt gets a new span ID; processor start/end events share their attempt context. A request can therefore be followed through its acceptance event to run-correlated records.

This is application correlation, not W3C trace-context propagation, an OpenTelemetry exporter, a full parent/child span tree or distributed tracing infrastructure. No external collector, sampling configuration or trace UI is installed. Query by request ID to locate ingress, then by run ID/trace ID for asynchronous work. Logs do not establish tenant authorization or guarantee that QA executed.

## Event boundaries

| Event                                      | Meaning                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `http.request`                             | Response finished or connection aborted; route template/status/duration only |
| `webhook.acceptance` / `manual.acceptance` | Persistence returned an accepted or duplicate durable run                    |
| `outbox.dispatch`                          | Published/retry/failed transaction result, or sanitized transaction failure  |
| `queue.enqueue`                            | Redis add returned; a later database commit can still fail                   |
| `queue.process`                            | Injected processor started/completed/failed, with retry attempt              |
| `queue.connection`                         | Sanitized queue/worker connection failure                                    |
| `service.lifecycle`                        | Process started/stopped or dispatcher disabled                               |

Dispatcher transaction outcomes are logged only after transaction completion; idle polls are suppressed. Enqueue acknowledgement is deliberately separate from durable dispatch success. Transaction failures emit failed outcomes without raw diagnostics. Production QA consumption is still disabled; processor telemetry is exercised by the existing injected harness, not evidence of customer execution.

## Failure behavior

The logger catches synchronous formatting/sink exceptions. Injected HTTP/dispatcher loggers are protected too, so a logging failure cannot turn a committed result into a retry. The default destination drops records if stdout is destroyed or its queued bytes exceed 64 KiB, and handles stdout stream errors without re-emitting raw errors. Log records are bounded by fixed fields rather than serialized application objects. No buffering service, retry queue, delivery guarantee or flush-on-shutdown guarantee is claimed.

`droppedLogCount()` exposes a process-local diagnostic count. It is not a metric exporter or alert; the next phase can consume it. Custom sinks must be synchronous and bounded: blocking sinks block their caller, and asynchronous sink delivery is outside this contract. Logging is not a durable audit ledger; RunControlEvent and other application persistence remain authoritative.

## Verification

`npm test` includes telemetry allowlist/failure/context tests and HTTP correlation/abort tests. `npm run db:verify:telemetry` checks committed dispatcher outcomes and broken-sink isolation using local PostgreSQL fixtures. `npm run queue:verify` exercises real local Redis harness retries and emits correlated records; fixtures are isolated and removed. The queue verification fixture now uses a valid budget and explicit test quota capacity so quota validation does not hide queue behavior.

No browser, live GitHub/customer request, cloud service, database migration or deployment is required for this phase. Production log routing, retention, collector availability and alerting remain operator work.
