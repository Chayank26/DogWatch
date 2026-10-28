/** Recorded synthetic demo and real report renderer; no live accounts/providers. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Express } from 'express';
import { persistPrivateArtifact } from './private-artifacts.js';
import { buildMarkdownReport } from './markdown-report.js';
assert.equal(
  process.argv.length,
  2,
  'Portfolio demo accepts no target arguments',
);
const { createFixtureApp } = (await import(
  new URL('../../fixture/dist/app.js', import.meta.url).href
)) as { createFixtureApp(mode: string): Express };
const root = fileURLToPath(new URL('../../../', import.meta.url));
const relativeDirectory = '.local/portfolio/' + randomUUID();
const directory = join(root, relativeDirectory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const artifactRoot = await mkdtemp(join(tmpdir(), 'dogwatch-portfolio-'));
const observations = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const mode of ['healthy', 'missing-address-500', 'checkout-stuck']) {
    const server = createFixtureApp(mode).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
      acceptDownloads: false,
      recordVideo: { dir: directory, size: { width: 1280, height: 800 } },
    });
    try {
      await context.route('**/*', async (route) => {
        if (
          new URL(route.request().url()).origin !== origin ||
          route.request().redirectedFrom()
        ) {
          await route.abort();
          return;
        }
        const response = await route.fetch({ maxRedirects: 0, timeout: 3000 });
        try {
          if (response.status() >= 300 && response.status() < 400)
            await route.abort();
          else await route.fulfill({ response });
        } finally {
          await response.dispose();
        }
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const page = await context.newPage();
      const video = page.video()!;
      await page.goto(origin, { waitUntil: 'networkidle', timeout: 5000 });
      await page.selectOption('#user', 'alice');
      await page.fill('#address', '');
      // Short holds are recording pacing, not synchronization for correctness.
      await page.waitForTimeout(700);
      const responsePromise = page.waitForResponse(
        (r) =>
          r.url() === origin + '/api/orders' && r.request().method() === 'POST',
        { timeout: 5000 },
      );
      await page.click('button[type=submit]');
      const response = await responsePromise;
      assert.equal(
        response.status(),
        mode === 'missing-address-500' ? 500 : 400,
      );
      const expected =
        mode === 'checkout-stuck' ? 'Processing…' : 'Address is required';
      await page
        .locator('#status')
        .filter({ hasText: expected })
        .waitFor({ state: 'visible', timeout: 3000 });
      await page.waitForTimeout(1500);
      assert.ok((await page.textContent('#status'))?.includes(expected));
      const screenshot = `${mode}.png`;
      await page.screenshot({ path: join(directory, screenshot) });
      await context.close();
      const clip = `${mode}.webm`;
      await rename(await video.path(), join(directory, clip));
      observations.push({
        mode,
        httpStatus: response.status(),
        ui: mode === 'checkout-stuck' ? 'pending' : 'validation-message',
        clip,
        screenshot,
      });
    } finally {
      await context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  const scope = {
    tenantId: randomUUID(),
    runId: randomUUID(),
    repositoryId: 20,
    pullRequestNumber: 42,
    headSha: 'a'.repeat(40),
  };
  const evidence = await persistPrivateArtifact(
    artifactRoot,
    {
      tenantId: scope.tenantId,
      runId: scope.runId,
      repositoryId: 20,
      sha: scope.headSha,
      role: 'head',
    },
    {
      version: 1,
      kind: 'browser_observation',
      contentPolicy: 'reviewed_redacted',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      payload: {
        format: 'json',
        value: { code: 'synthetic_checkout_pending', httpStatus: 400 },
      },
    },
  );
  const report = await buildMarkdownReport(
    {
      scope,
      findings: [
        {
          ...scope,
          version: 2,
          findingId: 'synthetic-checkout-pending',
          tier: 'tier2',
          environment: { deploymentId: 'local-pawmart', role: 'head' },
          contentPolicy: 'reviewed_redacted',
          createdAt: new Date().toISOString(),
          target: { kind: 'journey', journeyId: 'empty-address-checkout' },
          title: 'Checkout remains pending after validation rejection',
          expected: 'Display the address validation message',
          actual: 'Processing remains visible after HTTP 400',
          reproductionSteps: [
            'Open the disposable PawMart checkout-stuck fixture',
            'Select synthetic Alice and leave address blank',
            'Submit the form; observe HTTP 400 and unchanged Processing status',
          ],
          evidence: [evidence],
          baseline: { status: 'unavailable' },
          category: 'confirmed_failure',
          severity: 'medium',
          confidence: 'confirmed',
          basis: {
            kind: 'validated_observation',
            artifactId: evidence.artifactId,
          },
        },
      ],
      summary: {
        status: 'completed',
        coverage: [
          {
            tier: 'tier2',
            planned: 1,
            completed: 1,
            failed: 1,
            inconclusive: 0,
            skipped: 0,
          },
        ],
      },
    },
    {
      artifactRoot,
      authorizeArtifact: async () => true,
      isCurrent: async () => true,
    },
  );
  assert.equal(report.groupCount, 1);
  assert.match(report.markdown, /Baseline: unavailable/);
  await writeFile(
    join(directory, 'sample-report.md'),
    '# Synthetic portfolio sample — not a live PR report\n\nGenerated by the existing renderer from one checked local fixture observation. IDs are synthetic; temporary private evidence was verified during rendering and then removed. No baseline comparison or GitHub publication occurred.\n\n' +
      report.markdown,
  );
  const files = [
    ...observations.flatMap((o) => [o.clip, o.screenshot]),
    'sample-report.md',
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(directory, path)))
          .digest('hex'),
      ]),
    ),
  );
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        status: 'passed',
        scope: 'synthetic-local-demo',
        generatedAt: new Date().toISOString(),
        browser: browser.version(),
        directory: relativeDirectory,
        observations,
        hashes,
        publication: 'not-published',
        livePilot: 'not-started',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Portfolio demo verified: ${relativeDirectory}/manifest.json`);
} finally {
  await browser.close();
  await rm(artifactRoot, { recursive: true, force: true });
}
