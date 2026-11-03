/* global fetch */
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
/** Browser verification with synthetic authenticated API responses; no live account. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';
const origin = 'http://127.0.0.1:3119';
const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
    'apps/web',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3119',
  ],
  { stdio: 'ignore', env: { PATH: process.env.PATH, NODE_ENV: 'production' } },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw Error('Verification server could not start');
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for owned server. */
    }
    await pause(100);
  }
  assert.ok(ready, 'Server startup timed out');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const run = {
    id: '22222222-2222-4222-8222-222222222222',
    repository: 'fixture/api',
    pullRequestNumber: 1,
    headSha: 'a'.repeat(40),
    state: 'completed',
    createdAt: '2026-11-03T00:00:00Z',
    previewReady: false,
  };
  let mode = 'recorded';
  await page.route('**/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === '/auth/onboarding'
        ? {
            workspaces: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'Fixture workspace',
                role: 'member',
              },
            ],
          }
        : path.endsWith('/runs')
          ? { runs: [run], nextCursor: null }
          : {
              ...run,
              report:
                mode === 'missing'
                  ? null
                  : {
                      filename: 'dogwatch-api-fixture.md',
                      markdown: '# Synthetic API report\n1 failed\n',
                    },
              apiChecks:
                mode === 'missing'
                  ? { status: 'unavailable' }
                  : {
                      status: 'recorded',
                      finishedAt: run.createdAt,
                      result: {
                        status:
                          mode === 'incomplete' ? 'inconclusive' : 'completed',
                        code: 'api_completed',
                        requests: 2,
                        results: [
                          {
                            caseId: 'one',
                            operationKey: 'GET /<script>alert(1)</script>',
                            status: 'failed',
                            code: 'server_error',
                            httpStatus: 500,
                          },
                        ],
                        coverageGaps:
                          mode === 'incomplete'
                            ? [{ code: 'case_budget' }]
                            : [],
                      },
                    },
              evidence: { message: 'Evidence not cataloged.' },
            };
    await route.fulfill({ json: data });
  });
  await page.goto(origin + '/runs');
  await page
    .getByLabel('Workspace', { exact: true })
    .selectOption({ label: 'Fixture workspace' });
  const open = async () => {
    await page.getByRole('button', { name: 'fixture/api · PR #1' }).click();
    await page
      .getByRole('heading', { name: 'API checks', exact: true })
      .waitFor();
  };
  await open();
  assert.match(
    await page
      .getByRole('region', { name: 'API checks', exact: true })
      .innerText(),
    /0 passed · 1 failed/,
  );
  await page.getByText('Individual checks (1)', { exact: true }).click();
  assert.ok(
    await page
      .getByText('GET /<script>alert(1)</script>', { exact: true })
      .isVisible(),
  );
  assert.equal(
    await page.locator('section[aria-label="API checks"] script').count(),
    0,
  );
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download API report' }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'dogwatch-api-fixture.md');
  const stream = await download.createReadStream();
  let downloaded = '';
  for await (const chunk of stream) downloaded += chunk.toString();
  assert.equal(downloaded, '# Synthetic API report\n1 failed\n');
  mode = 'incomplete';
  await open();
  assert.ok(
    await page.getByText('Coverage incomplete', { exact: false }).isVisible(),
  );
  assert.ok(await page.getByText('case budget', { exact: true }).isVisible());
  mode = 'missing';
  await open();
  assert.match(
    await page
      .getByRole('region', { name: 'API checks', exact: true })
      .innerText(),
    /No API check result is available/,
  );
  assert.equal(
    await page.getByText('0 passed · 1 failed', { exact: false }).count(),
    0,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Download API report' }).count(),
    0,
  );
  console.log(
    'API results browser verified: failed checks, incomplete coverage, unavailable results, escaped contract text and stale result replacement.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null)
    await new Promise((resolve) => server.once('exit', resolve));
}
