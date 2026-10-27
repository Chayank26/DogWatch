/** Repeated local measurements; no GitHub, model, database or customer targets. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Express } from 'express';
import { corpus, categories, scoreBenchmark } from './benchmark.js';
import type { Measurement } from './benchmark.js';
import { probeFixture } from './benchmark-probes.js';
assert.equal(process.argv.length, 2, 'Benchmark takes no target arguments');
const { createFixtureApp } = (await import(
  new URL('../../fixture/dist/app.js', import.meta.url).href
)) as { createFixtureApp(mode: string): Express };
const repeats = 3;
const started = performance.now();
const generatedAt = new Date().toISOString();
const measurements: Measurement[] = [];
const root = new URL('../../../', import.meta.url);
const digest = createHash('sha256');
const sources = [
  'apps/worker/src/benchmark.ts',
  'apps/worker/src/benchmark-probes.ts',
  'apps/worker/src/verify-benchmark.ts',
  'apps/worker/src/smoke-fixture.ts',
  'apps/worker/src/smoke.ts',
  'apps/fixture/src/app.ts',
  'apps/fixture/src/browser.ts',
  'apps/fixture/public/index.html',
  'apps/fixture/public/style.css',
  'package-lock.json',
];
for (const path of sources)
  digest.update(path + '\0').update(await readFile(new URL(path, root)));
// Fail startup rather than turning a missing browser into a benchmark finding.
const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
await browser.close();
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const item of corpus) {
    // Every category gets fresh state; measurements cannot depend on probe order.
    for (const category of categories) {
      const server = createFixtureApp(item.mode).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const measurement = await probeFixture(
          `http://127.0.0.1:${address.port}`,
          category,
        );
        measurements.push({
          caseId: item.id,
          repeat,
          category,
          ...measurement,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    console.log(`Benchmark ${repeat + 1}/${repeats}: ${item.id}`);
  }
}
const baseline = scoreBenchmark(measurements, repeats, false);
const combined = scoreBenchmark(measurements, repeats, true);
const runtime = Object.fromEntries(
  categories.map((category) => {
    const times = measurements
      .filter((row) => row.category === category)
      .map((row) => row.durationMs)
      .sort((a, b) => a - b);
    return [
      category,
      {
        samples: times.length,
        medianMs: times[Math.floor(times.length / 2)],
        p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      },
    ];
  }),
);
const report = {
  schemaVersion: 1,
  corpusVersion: 'pawmart-v1',
  generatedAt,
  corpusKind: 'synthetic-fault-variants-not-real-PRs',
  repeats,
  corpus,
  sourceDigest: digest.digest('hex'),
  sources,
  environment: {
    node: process.version,
    browser: browserVersion,
    platform: process.platform,
    arch: process.arch,
  },
  baseline: { kind: 'fixed-http-probes', ...baseline },
  combined: { kind: 'fixed-http-plus-scripted-browser', ...combined },
  browserAgent: { status: 'not_evaluated', incrementalRecall: null },
  scriptedBrowserIncrementalRecall:
    combined.overall.recall! - baseline.overall.recall!,
  measurements,
  runtime,
  totalMs: Math.round(performance.now() - started),
  cost: {
    modelCalls: 0,
    modelTokens: 0,
    modelCostUsd: 0,
    totalCostUsd: null,
    httpProbeRequests: measurements.reduce((sum, row) => sum + row.requests, 0),
    browserRequests: null,
  },
  pilotThreshold: { status: 'not_agreed', generalAccuracyClaim: false },
};
const directory = new URL('.local/benchmarks/', root);
await mkdir(directory, { recursive: true, mode: 0o700 });
const destination = new URL('pawmart-v1.json', directory);
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    report: fileURLToPath(destination),
    baseline: baseline.overall,
    combined: combined.overall,
    reproducibility: combined.reproducibility,
    totalMs: report.totalMs,
  }),
);
