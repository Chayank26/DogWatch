import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { persistPrivateArtifact } from './private-artifacts.js';
import { buildMarkdownReport, literalMarkdown } from './markdown-report.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dogwatch-report-'));
  const scope = {
    tenantId: randomUUID(),
    runId: randomUUID(),
    repositoryId: 20,
    pullRequestNumber: 42,
    headSha: 'a'.repeat(40),
  };
  const ref = await persistPrivateArtifact(
    root,
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
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      payload: { format: 'json', value: { code: 'synthetic_failure' } },
    },
  );
  const finding = {
    ...scope,
    version: 2,
    findingId: 'one',
    tier: 'tier2',
    environment: { deploymentId: 'fixture', role: 'head' },
    contentPolicy: 'reviewed_redacted',
    createdAt: new Date().toISOString(),
    target: { kind: 'journey', journeyId: 'checkout' },
    title: 'Checkout pending',
    expected: 'Validation error',
    actual: 'Pending',
    reproductionSteps: ['Submit an empty synthetic address'],
    evidence: [ref],
    baseline: { status: 'unavailable' },
    category: 'confirmed_failure',
    severity: 'medium',
    confidence: 'confirmed',
    basis: { kind: 'validated_observation', artifactId: ref.artifactId },
  };
  const summary = {
    status: 'completed',
    coverage: [
      {
        tier: 'tier2',
        planned: 3,
        completed: 1,
        failed: 1,
        inconclusive: 1,
        skipped: 0,
      },
    ],
  };
  const options = {
    artifactRoot: root,
    authorizeArtifact: async () => true,
    isCurrent: async () => true,
  };
  return {
    root,
    scope,
    ref,
    finding,
    summary,
    options,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test('report verifies real artifacts and retains deterministic groups, reproduction, uncertainty and coverage', async () => {
  const f = await fixture();
  try {
    const second = { ...f.finding, findingId: 'two' };
    const a = await buildMarkdownReport(
      {
        scope: f.scope,
        findings: [f.finding, second, f.finding],
        summary: f.summary,
      },
      f.options,
    );
    const b = await buildMarkdownReport(
      {
        scope: f.scope,
        findings: [second, f.finding, f.finding],
        summary: f.summary,
      },
      f.options,
    );
    assert.equal(a.markdown, b.markdown);
    assert.equal(a.groupCount, 1);
    assert.match(a.markdown, /exact retry inputs removed: 1/);
    assert.match(a.markdown, /unaccounted 1/);
    assert.match(a.markdown, /Baseline: unavailable/);
    assert.ok(a.markdown.includes(f.ref.artifactId));
    assert.match(a.markdown, /Submit an empty synthetic address/);
    assert.match(a.markdown, /not semantically verified/);
  } finally {
    await f.cleanup();
  }
});
test('untrusted Markdown, HTML, mentions, links, backticks and newlines stay inside literal spans', () => {
  const value =
    '```\n# forged\n<script>x</script> [evil](https://evil) @everyone \u202e';
  const rendered = literalMarkdown(value);
  assert.ok(rendered.startsWith('```` '));
  assert.ok(rendered.endsWith(' ````'));
  assert.ok(!rendered.includes('\n'));
  assert.ok(!rendered.includes('\u202e'));
  assert.equal(literalMarkdown('`value`'), '`` `value` ``');
});
test('empty or missing coverage never becomes a passing report', async () => {
  const f = await fixture();
  try {
    const report = await buildMarkdownReport(
      {
        scope: f.scope,
        findings: [],
        summary: { status: 'completed', coverage: [] },
      },
      f.options,
    );
    assert.match(report.markdown, /does not establish a passing run/);
    assert.match(report.markdown, /Coverage was not supplied/);
  } finally {
    await f.cleanup();
  }
});
test('group and byte limits omit whole sections with explicit incompleteness', async () => {
  const f = await fixture();
  try {
    const second = { ...f.finding, findingId: 'two', actual: 'Other behavior' };
    const report = await buildMarkdownReport(
      { scope: f.scope, findings: [f.finding, second], summary: f.summary },
      { ...f.options, maxGroups: 1 },
    );
    assert.equal(report.completeness, 'partial');
    assert.equal(report.omittedGroupIds.length, 1);
    assert.match(report.markdown, /Report incomplete/);
    const big = {
      ...f.finding,
      reproductionSteps: Array(50).fill('x'.repeat(2000)),
    };
    const bounded = await buildMarkdownReport(
      { scope: f.scope, findings: [big], summary: f.summary },
      { ...f.options, maxBytes: 4096 },
    );
    assert.ok(Buffer.byteLength(bounded.markdown) <= 4096);
    assert.equal(bounded.shownGroupIds.length, 0);
    assert.equal(bounded.omittedGroupIds.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('unauthorized or missing artifacts prevent report creation even when groups would be omitted', async () => {
  const f = await fixture();
  try {
    const input = { scope: f.scope, findings: [f.finding], summary: f.summary };
    await assert.rejects(
      buildMarkdownReport(input, {
        ...f.options,
        authorizeArtifact: async () => false,
      }),
      /artifact_forbidden/,
    );
    let checks = 0;
    await assert.rejects(
      buildMarkdownReport(
        {
          ...input,
          findings: [
            f.finding,
            { ...f.finding, findingId: 'other', actual: 'Distinct' },
          ],
        },
        {
          ...f.options,
          maxGroups: 1,
          authorizeArtifact: async () => ++checks === 1,
        },
      ),
      /artifact_forbidden/,
    );
    await unlink(
      join(
        f.root,
        'findings-v2',
        f.scope.tenantId,
        f.scope.runId,
        f.ref.artifactId + '.json',
      ),
    );
    await assert.rejects(buildMarkdownReport(input, f.options));
  } finally {
    await f.cleanup();
  }
});
test('cancelled and stale authority cannot return report text', async () => {
  const f = await fixture();
  try {
    const input = { scope: f.scope, findings: [f.finding], summary: f.summary };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      buildMarkdownReport(input, { ...f.options, signal: controller.signal }),
    );
    let current = true;
    await assert.rejects(
      buildMarkdownReport(input, {
        ...f.options,
        isCurrent: async () => current,
        authorizeArtifact: async () => {
          current = false;
          return true;
        },
      }),
      /report_stale/,
    );
  } finally {
    await f.cleanup();
  }
});
test('invalid coverage counts and scope mixes fail validation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      buildMarkdownReport(
        {
          scope: f.scope,
          findings: [],
          summary: {
            status: 'completed',
            coverage: [
              {
                tier: 'tier2',
                planned: 1,
                completed: 2,
                failed: 1,
                inconclusive: 0,
                skipped: 0,
              },
            ],
          },
        },
        f.options,
      ),
    );
    await assert.rejects(
      buildMarkdownReport(
        {
          scope: { ...f.scope, runId: randomUUID() },
          findings: [f.finding],
          summary: f.summary,
        },
        f.options,
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test('coverage gaps, advisory claims and usage reservations retain their distinct meaning', async () => {
  const f = await fixture();
  try {
    const { basis: _, ...record } = f.finding;
    void _;
    const gap = {
      ...record,
      category: 'coverage_gap',
      severity: 'info',
      confidence: 'unconfirmed',
      reason: 'budget_exhausted',
      evidence: [],
      reproductionSteps: [],
    };
    const report = await buildMarkdownReport(
      {
        scope: f.scope,
        findings: [gap],
        summary: {
          ...f.summary,
          status: 'inconclusive',
          usage: {
            actions: 2,
            requests: 3,
            modelCalls: 1,
            inputTokens: 100,
            outputTokens: 20,
            reservedCostMicros: 500,
          },
        },
      },
      f.options,
    );
    assert.match(report.markdown, /coverage gaps: 1/);
    assert.match(report.markdown, /Coverage reason: budget_exhausted/);
    assert.match(report.markdown, /estimate, not verified billing/);
    assert.match(report.markdown, /No artifact references supplied/);
  } finally {
    await f.cleanup();
  }
});
