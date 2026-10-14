import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildModuleGraph } from './graph.js';
import { mapRouteImpact } from './impact.js';
import type { ImpactMapping } from './impact.js';
const tenantId = randomUUID();
const base = buildModuleGraph({
  tenantId,
  repositoryId: 20,
  sha: 'a'.repeat(40),
  complete: true,
  files: [
    { path: 'order.ts', source: 'export const order = 1;' },
    { path: 'checkout.ts', source: 'import "./order";' },
    { path: 'login.ts', source: 'export const login = 1;' },
  ],
});
const head = { ...base, sha: 'b'.repeat(40) };
const comparison = {
  baseSha: base.sha,
  headSha: head.sha,
  complete: true,
  files: [{ filename: 'order.ts' }],
};
const mapping = (sha: string): ImpactMapping => ({
  tenantId,
  repositoryId: 20,
  sha,
  complete: true,
  entries: [
    {
      id: 'checkout',
      target: { kind: 'route', path: '/checkout' },
      modules: ['checkout.ts'],
      critical: false,
    },
    {
      id: 'orders',
      target: { kind: 'api', method: 'POST', path: '/api/orders' },
      modules: ['order.ts'],
      critical: false,
    },
    {
      id: 'login',
      target: { kind: 'journey', name: 'login' },
      modules: ['login.ts'],
      critical: false,
    },
  ],
});
test('maps transitive impact to routes and API operations with snapshot evidence', () => {
  const result = mapRouteImpact(
    base,
    head,
    comparison,
    mapping(base.sha),
    mapping(head.sha),
  );
  assert.equal(result.widened, false);
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['checkout', 'orders', 'checkout', 'orders'],
  );
  assert.deepEqual(result.selected[0].matchedModules, ['checkout.ts']);
  assert.equal(result.selected[2].sha, head.sha);
});
test('critical journeys remain selected for unrelated changes', () => {
  const before = mapping(base.sha),
    after = mapping(head.sha);
  before.entries[2].critical = after.entries[2].critical = true;
  const result = mapRouteImpact(base, head, comparison, before, after);
  assert.ok(
    result.selected
      .filter((entry) => entry.id === 'login')
      .every((entry) => entry.reasons.includes('critical_baseline')),
  );
  assert.equal(result.selected.length, 6);
});
test('incomplete, unknown and unmapped coverage widens all configured targets', () => {
  for (const kind of ['incomplete', 'unknown', 'unmapped']) {
    const after = mapping(head.sha);
    if (kind === 'incomplete') after.complete = false;
    if (kind === 'unknown') after.entries[0].modules = ['absent.ts'];
    const before = mapping(base.sha);
    if (kind === 'unmapped') {
      before.entries = before.entries.filter((entry) => entry.id !== 'orders');
      after.entries = after.entries.filter((entry) => entry.id !== 'orders');
    }
    const result = mapRouteImpact(base, head, comparison, before, after);
    assert.equal(result.widened, true);
    assert.equal(
      result.selected.length,
      before.entries.length + after.entries.length,
    );
    assert.ok(result.coverageGaps.length);
  }
});
test('removed and renamed targets retain base labels without becoming head targets', () => {
  const before = mapping(base.sha),
    after = mapping(head.sha);
  after.entries[0].target = { kind: 'route', path: '/new-checkout' };
  after.entries = after.entries.filter((entry) => entry.id !== 'orders');
  const result = mapRouteImpact(base, head, comparison, before, after);
  assert.ok(
    result.selected.some(
      (entry) => entry.snapshot === 'base' && entry.id === 'orders',
    ),
  );
  assert.ok(
    !result.selected.some(
      (entry) => entry.snapshot === 'head' && entry.id === 'orders',
    ),
  );
  assert.deepEqual(
    result.selected.find((entry) => entry.snapshot === 'head')?.target,
    { kind: 'route', path: '/new-checkout' },
  );
});
test('scope mismatches, duplicate identities and unsafe target paths fail closed', () => {
  const after = mapping(head.sha);
  for (const invalid of [
    { ...after, tenantId: randomUUID() },
    { ...after, repositoryId: 21 },
    { ...after, sha: base.sha },
    { ...after, entries: [after.entries[0], after.entries[0]] },
    ...['https://example.com', '//example.com', '/x?secret=1', '/../x'].map(
      (path) => ({
        ...after,
        entries: [{ ...after.entries[0], target: { kind: 'route', path } }],
      }),
    ),
  ])
    assert.throws(() =>
      mapRouteImpact(
        base,
        head,
        comparison,
        mapping(base.sha),
        invalid as ImpactMapping,
      ),
    );
});
