/** Small immutable fixture snapshots test impact behavior without source execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildModuleGraph, affectedModules } from './graph.js';
import type { SourceSnapshot } from './graph.js';
const identity = {
  tenantId: randomUUID(),
  repositoryId: 20,
  sha: 'a'.repeat(40),
  complete: true,
};
const snapshot = (
  files: [string, string][],
  sha = identity.sha,
): SourceSnapshot => ({
  ...identity,
  sha,
  files: files.map(([path, source]) => ({ path, source })),
});
test('extracts declarations, exports, barrel edges and transitive consumers', () => {
  const graph = buildModuleGraph(
    snapshot([
      [
        'src/order.ts',
        'const price=1; export {price as total}; export function checkout(){}',
      ],
      ['src/index.ts', 'export {checkout} from "./order.js";'],
      [
        'src/page.tsx',
        'import {checkout} from "./index"; export default function Page(){return <div/>}',
      ],
      ['src/unrelated.ts', 'export class Other {}'],
    ]),
  );
  assert.equal(graph.complete, true);
  assert.equal(
    graph.modules[0].symbols.find((symbol) => symbol.name === 'price')
      ?.exported,
    true,
  );
  assert.deepEqual(graph.modules[0].exports, ['total', 'checkout']);
  assert.equal(graph.edges.length, 2);
  const result = affectedModules(graph, graph, {
    baseSha: graph.sha,
    headSha: graph.sha,
    complete: true,
    files: [{ filename: 'src/order.ts' }],
  });
  assert.deepEqual(result.modules, [
    'src/index.ts',
    'src/order.ts',
    'src/page.tsx',
  ]);
  assert.equal(result.widened, false);
});
test('old graph preserves consumers of removed and renamed modules, including cycles', () => {
  const base = buildModuleGraph(
    snapshot([
      ['old.ts', 'import "./page"; export const old=1;'],
      ['page.ts', 'import "./old";'],
    ]),
  );
  const head = buildModuleGraph(
    snapshot(
      [
        ['new.ts', 'export const renamed=1;'],
        ['page.ts', 'import "./new";'],
      ],
      'b'.repeat(40),
    ),
  );
  assert.deepEqual(
    affectedModules(base, head, {
      baseSha: base.sha,
      headSha: head.sha,
      complete: true,
      files: [{ filename: 'new.ts', previous_filename: 'old.ts' }],
    }).modules,
    ['new.ts', 'old.ts', 'page.ts'],
  );
});
test('dynamic imports, aliases, missing modules, syntax and generated files widen coverage', () => {
  const graph = buildModuleGraph(
    snapshot([
      [
        'broken.ts',
        'import x from "./absent"; import("./lazy"); require(name); const = ;',
      ],
      ['lazy.ts', 'export const value=1;'],
      ['alias.ts', 'import "@app/util";'],
      ['generated/data.ts', 'export const generated=1;'],
      ['style.css', 'body{}'],
    ]),
  );
  for (const code of [
    'dynamic_import',
    'commonjs_dependency',
    'unresolved_import',
    'external_or_alias_import',
    'generated_or_declaration',
    'unsupported_language',
    'syntax_error',
  ])
    assert.ok(
      graph.coverageGaps.some((gap) => gap.code === code),
      code,
    );
  assert.equal(
    affectedModules(graph, graph, {
      baseSha: graph.sha,
      headSha: graph.sha,
      complete: true,
      files: [{ filename: 'lazy.ts' }],
    }).widened,
    true,
  );
});
test('incomplete comparisons widen, cross-tenant and wrong SHA inputs fail', () => {
  const graph = buildModuleGraph(
    snapshot([
      ['a.ts', 'export const a=1;'],
      ['b.ts', 'export const b=2;'],
    ]),
  );
  const comparison = {
    baseSha: graph.sha,
    headSha: graph.sha,
    complete: false,
    files: [{ filename: 'a.ts' }],
  };
  assert.deepEqual(affectedModules(graph, graph, comparison).modules, [
    'a.ts',
    'b.ts',
  ]);
  assert.throws(() =>
    affectedModules(graph, { ...graph, tenantId: randomUUID() }, comparison),
  );
  assert.throws(() =>
    affectedModules(graph, graph, { ...comparison, headSha: 'f'.repeat(40) }),
  );
});
test('input budgets, duplicate paths and traversal paths fail before parsing', () => {
  assert.throws(() => buildModuleGraph(snapshot([['../secret.ts', '']])));
  assert.throws(() =>
    buildModuleGraph(
      snapshot([
        ['a.ts', ''],
        ['a.ts', ''],
      ]),
    ),
  );
  assert.throws(() =>
    buildModuleGraph(
      snapshot(
        Array.from({ length: 9 }, (_, i) => [`${i}.ts`, ' '.repeat(262144)]),
      ),
    ),
  );
});

test('comparison uses merge-base graph when target branch tip differs', () => {
  const graph = buildModuleGraph(snapshot([['a.ts', 'export const a=1;']]));
  const comparison = {
    baseSha: 'c'.repeat(40),
    mergeBaseSha: graph.sha,
    headSha: graph.sha,
    complete: true,
    files: [{ filename: 'a.ts' }],
  };
  assert.equal(affectedModules(graph, graph, comparison).widened, false);
  assert.throws(() =>
    affectedModules(graph, graph, {
      ...comparison,
      mergeBaseSha: 'd'.repeat(40),
    }),
  );
});

test('namespace re-exports and default declarations retain exact export names', () => {
  const graph = buildModuleGraph(
    snapshot([
      ['util.ts', 'export const value = 1;'],
      [
        'page.ts',
        'export * as tools from "./util"; export default function Page() {} export {};',
      ],
    ]),
  );
  assert.deepEqual(graph.modules[1].exports, ['tools', 'default']);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.complete, true);
});

test('ambiguous resolution and namespace declarations cannot claim complete coverage', () => {
  const graph = buildModuleGraph(
    snapshot([
      [
        'page.ts',
        'import "./util"; namespace Hidden { export const value = 1; }',
      ],
      ['util.ts', 'export const value = 1;'],
      ['util.js', 'export const value = 2;'],
    ]),
  );
  assert.equal(graph.complete, false);
  assert.ok(graph.coverageGaps.some((gap) => gap.code === 'ambiguous_import'));
  assert.ok(
    graph.coverageGaps.some((gap) => gap.code === 'namespace_declaration'),
  );
  assert.deepEqual(
    affectedModules(graph, graph, {
      baseSha: graph.sha,
      headSha: graph.sha,
      complete: true,
      files: [{ filename: 'util.ts' }],
    }).modules,
    ['page.ts', 'util.js', 'util.ts'],
  );
});
