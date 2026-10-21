/** Paired real-browser evidence on trusted disposable loopback fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createFixtureSmokeDriver } from './smoke-fixture.js';
import {
  runSmokeWithEvidence,
  compareSmokeEvidence,
} from './smoke-evidence.js';
import {
  persistSmokeEvidence,
  readSmokeEvidence,
  compareStoredSmokeEvidence,
} from './evidence-store.js';
import type { SmokePlan } from './smoke.js';
const fixtureUrl = new URL('../../fixture/dist/app.js', import.meta.url);
const { createFixtureApp } = (await import(fixtureUrl.href)) as {
  createFixtureApp(mode: string): Express;
};
const root = await mkdtemp(join(tmpdir(), 'dogwatch-baseline-'));
const references: { base?: string; head?: string } = {};
const context = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};
async function capture(role: 'base' | 'head', broken: boolean) {
  const app = createFixtureApp('healthy');
  // A labeled synthetic UI assertion isolates attribution from API error logging.
  app.get('/comparison-target', (_request, response) =>
    response
      .type('html')
      .send(
        `<!doctype html><p id="result">${broken ? 'Broken' : 'Ready'}</p><label>Fixture input<input id="secret" value="synthetic"></label>`,
      ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const driver = await createFixtureSmokeDriver(
      `http://127.0.0.1:${address.port}`,
      { first: 'synthetic-first', second: 'synthetic-second' },
    );
    // Different field values must produce identical masked screenshots.
    try {
      await driver.execute(
        { kind: 'navigate', path: '/comparison-target' },
        2000,
      );
      await driver.execute(
        { kind: 'fill', selector: '#secret', valueRef: 'first' },
        2000,
      );
      const first = await driver.captureScreenshot!();
      await driver.execute(
        { kind: 'fill', selector: '#secret', valueRef: 'second' },
        2000,
      );
      assert.deepEqual(await driver.captureScreenshot!(), first);
    } catch (error) {
      await driver.close();
      throw error;
    }
    const sha = role === 'base' ? context.baseSha : context.headSha;
    const plan: SmokePlan = {
      tenantId: context.tenantId,
      runId: context.runId,
      repositoryId: context.repositoryId,
      headSha: sha,
      maxExecutionMs: 20000,
      maxSteps: 30,
      journeys: [
        {
          id: 'checkout-render',
          dependsOn: [],
          steps: [
            { kind: 'navigate', path: '/comparison-target' },
            { kind: 'text', selector: '#result', expected: 'Ready' },
          ],
        },
      ],
    };
    const record = await runSmokeWithEvidence(plan, driver, {
      role,
      scenarioId: 'fixture-render-v1',
      isCurrent: async () => true,
    });
    assert.equal(record.outcome, broken ? 'failed' : 'passed');
    assert.equal(record.screenshot.status, 'captured');
    const scope = {
      tenantId: context.tenantId,
      runId: context.runId,
      repositoryId: context.repositoryId,
      sha,
      role,
    };
    const reference = await persistSmokeEvidence(root, scope, record);
    references[role] = reference.artifactId;
    const loaded = await readSmokeEvidence(root, scope, reference.artifactId);
    assert.deepEqual(loaded.record, record);
    return loaded.record;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
try {
  const passingBase = await capture('base', false);
  const failingHead = await capture('head', true);
  assert.equal(
    compareSmokeEvidence(context, failingHead, passingBase).journeys[0]
      .baseline,
    'new_regression',
  );
  const failingBase = await capture('base', true);
  assert.equal(
    compareSmokeEvidence(context, failingHead, failingBase).journeys[0]
      .baseline,
    'pre_existing',
  );
  assert.equal(
    compareSmokeEvidence(context, failingHead).journeys[0].baseline,
    'unavailable',
  );
  assert.equal(
    compareSmokeEvidence(context, failingHead, {
      ...passingBase,
      scenarioId: 'incompatible-data',
    }).journeys[0].baseline,
    'inconclusive',
  );
  assert.equal(
    (await readdir(join(root, context.tenantId, context.runId))).length,
    3,
  );
  const stored = await compareStoredSmokeEvidence(
    root,
    context,
    references.head!,
    references.base!,
  );
  assert.equal(stored.journeys[0].baseline, 'pre_existing');
  assert.equal(stored.artifactReferences.head.artifactId, references.head);
  process.stdout.write(
    'Base comparison, masked screenshots and private evidence persistence verified\n',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
