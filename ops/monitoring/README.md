# Metrics and alerts (Phase 8.2)

Export `API_METRICS_PORT=9401` in the API shell, and optionally
`DISPATCHER_METRICS_PORT=9402` in the enabled dispatcher's shell. Environment files
are not loaded automatically. Ports must be distinct from application ports.
Unset means disabled. The disabled dispatcher exits without a scrape server.
Port conflicts refuse startup. GET `http://127.0.0.1:9401/metrics` returns
Prometheus text; all other methods/paths (including query strings) return 404.
Listeners bind only IPv4 loopback, have bounded connections/timeouts, and close
on process shutdown. The public API/proxy does not expose `/metrics`.

Run Prometheus in the same host/network namespace using `prometheus.yaml`.
A Docker container's loopback is different from the host's loopback; this sample
is not a Docker Compose monitoring deployment. Enable the dispatcher scrape job
only when that process is configured. No Alertmanager receiver, external
collector, retention policy or production notifications are installed here.

## Metric contract

- `dogwatch_events_total`: counters labeled by fixed service, event, outcome,
  route template and HTTP status class. Non-HTTP route/status labels are `none`.
- `dogwatch_duration_seconds`: cumulative classic histogram with service, event
  and route labels. Buckets: .005, .025, .1, .5, 1, 5, 30, 120, 300, +Inf seconds.
- `dogwatch_logs_dropped_total`: rejected/lost log records, including sink failures.
- `dogwatch_metric_series_discarded_total`: observations dropped at the registry cap.
- `dogwatch_process_start_time_seconds` and `dogwatch_process_resident_memory_bytes`:
  process-local diagnostics, not readiness checks.

IDs, SHAs, credentials, raw URLs, exception text and tenant names never become
labels. Counters and histogram label groups each cap at 4,096; the fixed logger
allowlists ordinarily impose a tighter bound. Collection happens after sanitation
and before log output, so sink failures do not erase observations. Scrapes do not
create application events. Metrics are in memory and reset on restart. Series
appear on first observation; events before the first scrape cannot be recovered
by `increase`. Use `rate`/`increase` per series before aggregating across replicas.
Injected custom loggers bypass this default registry.

Queue events measure attempts, not unique runs. Dispatch publication measures
committed handoff, not QA completion. HTTP latency includes aborted requests;
health traffic is excluded from API alert calculations. Histogram percentiles
are bucket estimates. There is no queue-depth, oldest-outbox-age, database
readiness, quota/cost or completed-QA metric yet. Idle/no-traffic is not a failure.

## Alert runbooks

Thresholds are initial operator defaults; tune against measured traffic before
production use. Each rule retains job/instance so operators can identify the
process. Check sanitized logs using time and run/request correlation; never add
IDs to metrics to investigate an incident.

| Alert                           | Trigger                                               | Investigation and recovery                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DogWatchTargetDown              | Configured target unreachable for 2m                  | Check process, configured port and same-host scrape access. Remove deliberately disabled targets. A missing scrape configuration cannot fire this rule.                                             |
| DogWatchApiErrors               | >5% 5xx and >=20 non-health requests/5m, held 2m      | Inspect API completion logs, configuration, DB and GitHub dependencies. Verify a health response and a safe application request after restoring the dependency.                                     |
| DogWatchDispatchFailures        | >=3 failed dispatch events/5m, held 1m                | Inspect dispatcher logs and DB/Redis reachability. A failed event can mean DB failure or exhausted handoff retries. Do not blindly replay or modify outbox state; reconciliation remains Phase 8.3. |
| DogWatchQueueConnectionFailures | >=3 queue connection failures/5m, held 1m             | Check Redis process, URL and connection capacity. Confirm successful handoff after recovery. Production QA consumption remains disabled.                                                            |
| DogWatchTelemetryLoss           | Any observed increase in log/metric discard counts/5m | Check stdout consumer/backpressure and process resource pressure; inspect label contract if the series cap is reached. Missing logs cannot be recovered from this registry.                         |
| DogWatchApiLatency              | Estimated p95 >2s with >=20 observations/5m, held 5m  | Compare route histograms and logs; inspect slow dependencies. Aborts are included; do not infer successful responses from latency alone.                                                            |

## Validate without sending notifications

Using Prometheus 3.5.0's `promtool`, from this directory:

```sh
promtool check config prometheus.yaml
promtool check rules alerts.yaml
promtool test rules alerts.test.yaml
```

The fixtures are authored but promtool execution is pending because the tool
download did not complete during implementation. They cover every alert firing, initial hold periods, low request volume,
idle counters, a counter reset and absent targets. Follow the official
[rule-testing reference](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)
when extending them. Production scrape connectivity and notification delivery
require separate deployment validation.
