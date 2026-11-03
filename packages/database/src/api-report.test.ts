import assert from 'node:assert/strict';
import test from 'node:test';
import { renderApiReport } from './api-report.js';
const scope = {
  id: 'run',
  repository: 'example/repo',
  pullRequestNumber: 1,
  headSha: 'a'.repeat(40),
};
const result = {
  status: 'completed',
  code: 'api_completed',
  requests: 1,
  results: [
    {
      caseId: 'one',
      operationKey: 'GET /<script>@everyone [click](https://evil.example)',
      status: 'failed',
      code: 'server_error',
      httpStatus: 500,
    },
  ],
  coverageGaps: [],
};
test('report preserves failed outcomes without claiming regression or passing coverage', () => {
  const report = renderApiReport(scope, '2026-11-03', result);
  assert.match(report, /0 passed · 1 failed/);
  assert.match(report, /Baseline comparison is unavailable/);
  assert.ok(!report.includes('<script>'));
  assert.ok(!report.includes('@everyone'));
  assert.ok(!report.includes('[click](https://evil.example)'));
  assert.match(report, /HTTP 500/);
});
test('report bounds large results and discloses omissions and incomplete coverage', () => {
  const report = renderApiReport(scope, '2026-11-03', {
    ...result,
    status: 'inconclusive',
    results: Array.from({ length: 1000 }, () => ({
      ...result.results[0],
      operationKey: 'x'.repeat(1200),
    })),
    coverageGaps: [{ code: 'case_budget' }],
  });
  assert.ok(Buffer.byteLength(report) < 50000);
  assert.match(report, /1000 failed/);
  assert.match(report, /Report shortened/);
  assert.match(report, /Coverage incomplete/);
});
