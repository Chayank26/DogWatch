/** Labeled fixture evaluation. Labels are consumed only by scoring, never probes. */
export const categories = [
  'api',
  'authentication',
  'ownership',
  'role',
  'ui',
  'coupled',
] as const;
export type Category = (typeof categories)[number];
export type Observation = 'clear' | 'detected' | 'inconclusive' | 'not_run';
export const corpus = [
  { id: 'clean', mode: 'healthy', labels: [] },
  {
    id: 'invalid-address-server-error',
    mode: 'missing-address-500',
    labels: ['api'],
  },
  {
    id: 'missing-auth-accepted',
    mode: 'authentication-bypass',
    labels: ['authentication'],
  },
  {
    id: 'foreign-order-readable',
    mode: 'ownership-bypass',
    labels: ['ownership'],
  },
  { id: 'customer-admin-report', mode: 'role-bypass', labels: ['role'] },
  { id: 'validation-ui-stuck', mode: 'checkout-stuck', labels: ['ui'] },
  {
    id: 'quantity-write-read-loss',
    mode: 'quantity-lost',
    labels: ['coupled'],
  },
] as const;
export type Measurement = {
  caseId: string;
  repeat: number;
  category: Category;
  observation: Observation;
  durationMs: number;
  requests: number;
  code: string;
};
export function scoreBenchmark(
  rows: Measurement[],
  repeats: number,
  includeBrowser: boolean,
) {
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 10)
    throw Error('benchmark_repeats');
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.caseId}:${row.repeat}:${row.category}`;
    if (
      !corpus.some((c) => c.id === row.caseId) ||
      !categories.includes(row.category) ||
      !Number.isInteger(row.repeat) ||
      row.repeat < 0 ||
      row.repeat >= repeats ||
      !['clear', 'detected', 'inconclusive', 'not_run'].includes(
        row.observation,
      ) ||
      !Number.isFinite(row.durationMs) ||
      row.durationMs < 0 ||
      !Number.isSafeInteger(row.requests) ||
      row.requests < 0 ||
      keys.has(key)
    )
      throw Error('benchmark_measurement');
    keys.add(key);
  }
  if (keys.size !== corpus.length * categories.length * repeats)
    throw Error('benchmark_incomplete');
  function summarize(selected: Measurement[]) {
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0,
      inconclusive = 0,
      notRun = 0;
    for (const row of selected) {
      const expected = (
        corpus.find((c) => c.id === row.caseId)!.labels as readonly string[]
      ).includes(row.category);
      const observed =
        !includeBrowser && row.category === 'ui' ? 'not_run' : row.observation;
      if (observed === 'inconclusive') inconclusive++;
      if (observed === 'not_run') notRun++;
      if (observed === 'detected') {
        if (expected) tp++;
        else fp++;
      } else if (expected)
        fn++; // Abstention never improves recall.
      else if (observed === 'clear') tn++;
    }
    return {
      tp,
      fp,
      fn,
      tn,
      inconclusive,
      notRun,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
      falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
      evaluated: selected.length - inconclusive - notRun,
      total: selected.length,
    };
  }
  let stable = 0;
  for (const item of corpus)
    for (const category of categories) {
      const observed = rows
        .filter((row) => row.caseId === item.id && row.category === category)
        .map((row) =>
          !includeBrowser && category === 'ui' ? 'not_run' : row.observation,
        );
      if (new Set(observed).size === 1) stable++;
    }
  return {
    overall: summarize(rows),
    categories: Object.fromEntries(
      categories.map((category) => [
        category,
        summarize(rows.filter((row) => row.category === category)),
      ]),
    ),
    reproducibility: {
      stableCells: stable,
      totalCells: corpus.length * categories.length,
      rate: stable / (corpus.length * categories.length),
    },
  };
}
