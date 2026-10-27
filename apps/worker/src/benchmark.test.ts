import test from 'node:test';
import assert from 'node:assert/strict';
import { corpus, categories, scoreBenchmark } from './benchmark.js';
import type { Measurement } from './benchmark.js';
function perfect(): Measurement[] {
  return corpus.flatMap((item) =>
    [0, 1, 2].flatMap((repeat) =>
      categories.map((category) => ({
        caseId: item.id,
        repeat,
        category,
        observation: (item.labels as readonly string[]).includes(category)
          ? ('detected' as const)
          : ('clear' as const),
        durationMs: 1,
        requests: 1,
        code: 'synthetic-scoring-test',
      })),
    ),
  );
}
test('scoring reports category denominators and scripted-browser increment without inventing precision', () => {
  const rows = perfect();
  const combined = scoreBenchmark(rows, 3, true);
  assert.deepEqual(combined.overall, {
    tp: 18,
    fp: 0,
    fn: 0,
    tn: 108,
    inconclusive: 0,
    notRun: 0,
    precision: 1,
    recall: 1,
    falsePositiveRate: 0,
    evaluated: 126,
    total: 126,
  });
  const baseline = scoreBenchmark(rows, 3, false);
  assert.equal(baseline.overall.fn, 3);
  assert.equal(baseline.overall.notRun, 21);
  assert.equal(baseline.categories.ui.precision, null);
  assert.equal(baseline.categories.ui.recall, 0);
});
test('inconclusive positives are missed defects and negatives do not become true negatives', () => {
  const rows = perfect();
  for (const row of rows) row.observation = 'inconclusive';
  const result = scoreBenchmark(rows, 3, true);
  assert.equal(result.overall.fn, 18);
  assert.equal(result.overall.tn, 0);
  assert.equal(result.overall.precision, null);
  assert.equal(result.overall.falsePositiveRate, null);
  assert.equal(result.overall.evaluated, 0);
});
test('false positives, false negatives and unstable repeated decisions remain visible', () => {
  const rows = perfect();
  rows.find(
    (row) => row.caseId === 'clean' && row.category === 'api',
  )!.observation = 'detected';
  rows.find(
    (row) => row.caseId === 'validation-ui-stuck' && row.category === 'ui',
  )!.observation = 'clear';
  const result = scoreBenchmark(rows, 3, true);
  assert.equal(result.overall.fp, 1);
  assert.equal(result.overall.fn, 1);
  assert.equal(result.reproducibility.stableCells, 40);
});
test('missing, duplicate, foreign and malformed measurements cannot produce a report', () => {
  assert.throws(() => scoreBenchmark(perfect().slice(1), 3, true));
  const rows = perfect();
  assert.throws(() => scoreBenchmark([...rows, rows[0]], 3, true));
  rows[0].caseId = 'foreign';
  assert.throws(() => scoreBenchmark(rows, 3, true));
  rows[0] = { ...perfect()[0], durationMs: NaN };
  assert.throws(() => scoreBenchmark(rows, 3, true));
  assert.throws(() => scoreBenchmark(perfect(), 1, true));
});
