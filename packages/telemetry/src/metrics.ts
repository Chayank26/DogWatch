// Only the logger's sanitized records enter this process-local registry.
const buckets = [0.005, 0.025, 0.1, 0.5, 1, 5, 30, 120, 300, Infinity];
type Series = { count: number; sum: number; buckets: number[] };
const counters = new Map<string, number>();
const durations = new Map<string, Series>();
const maxSeries = 4096;
let discarded = 0;
const started = Date.now() / 1000;
function labels(values: Record<string, string | number>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(',');
}
export function observe(record: Record<string, string | number>) {
  const base = {
    service: record.service,
    event: record.event,
    route:
      record.event === 'http.request' ? (record.route ?? 'unmatched') : 'none',
  };
  const key = labels({
    ...base,
    outcome: record.outcome,
    status_class:
      record.event === 'http.request' && typeof record.statusCode === 'number'
        ? `${Math.floor(record.statusCode / 100)}xx`
        : 'none',
  });
  if (!counters.has(key) && counters.size >= maxSeries) {
    discarded++;
    return;
  }
  counters.set(key, (counters.get(key) ?? 0) + 1);
  if (typeof record.durationMs !== 'number') return;
  const durationKey = labels(base);
  if (!durations.has(durationKey) && durations.size >= maxSeries) {
    discarded++;
    return;
  }
  const series = durations.get(durationKey) ?? {
    count: 0,
    sum: 0,
    buckets: buckets.map(() => 0),
  };
  const seconds = record.durationMs / 1000;
  series.count++;
  series.sum += seconds;
  buckets.forEach((bound, index) => {
    if (seconds <= bound) series.buckets[index]++;
  });
  durations.set(durationKey, series);
}
export function renderMetrics(dropped: number) {
  const lines = [
    '# HELP dogwatch_events_total Sanitized operational events, including attempts.',
    '# TYPE dogwatch_events_total counter',
  ];
  for (const [key, value] of counters)
    lines.push(`dogwatch_events_total{${key}} ${value}`);
  lines.push(
    '# HELP dogwatch_duration_seconds Event duration in seconds.',
    '# TYPE dogwatch_duration_seconds histogram',
  );
  for (const [key, series] of durations) {
    buckets.forEach((bound, index) =>
      lines.push(
        `dogwatch_duration_seconds_bucket{${key},le="${bound === Infinity ? '+Inf' : bound}"} ${series.buckets[index]}`,
      ),
    );
    lines.push(
      `dogwatch_duration_seconds_sum{${key}} ${series.sum}`,
      `dogwatch_duration_seconds_count{${key}} ${series.count}`,
    );
  }
  for (const [name, type, help, value] of [
    [
      'dogwatch_logs_dropped_total',
      'counter',
      'Records lost or rejected by logging.',
      dropped,
    ],
    [
      'dogwatch_metric_series_discarded_total',
      'counter',
      'Observations discarded at the series bound.',
      discarded,
    ],
    [
      'dogwatch_process_start_time_seconds',
      'gauge',
      'Process telemetry start time in Unix seconds.',
      started,
    ],
    [
      'dogwatch_process_resident_memory_bytes',
      'gauge',
      'Resident process memory in bytes.',
      process.memoryUsage().rss,
    ],
  ])
    lines.push(
      `# HELP ${name} ${help}`,
      `# TYPE ${name} ${type}`,
      `${name} ${value}`,
    );
  return lines.join('\n') + '\n';
}
