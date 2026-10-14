/** Operator-owned mappings turn conservative module impact into test priorities. */
import { z } from 'zod';
import { affectedModules } from './graph.js';
import type { ModuleGraph } from './graph.js';

const modulePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes(':') &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
  );
const targetPath = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/[?#\\\s]/.test(value) &&
      [...value].every((character) => character.charCodeAt(0) >= 32) &&
      !value.split('/').some((part) => part === '.' || part === '..'),
  );
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('route'), path: targetPath }),
  z.strictObject({
    kind: z.literal('api'),
    path: targetPath,
    method: z.enum([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ]),
  }),
  z.strictObject({
    kind: z.literal('journey'),
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  }),
]);
export const impactMappingSchema = z.strictObject({
  tenantId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  // Caller attests whether every configured test target is represented.
  complete: z.boolean(),
  entries: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        target,
        modules: z.array(modulePath).min(1).max(100),
        critical: z.boolean().default(false),
      }),
    )
    .max(200),
});
export type ImpactMapping = z.infer<typeof impactMappingSchema>;

function validateMapping(input: ImpactMapping, graph: ModuleGraph) {
  const mapping = impactMappingSchema.parse(input);
  if (
    mapping.tenantId !== graph.tenantId ||
    mapping.repositoryId !== graph.repositoryId ||
    mapping.sha !== graph.sha
  )
    throw new Error('impact_mapping_scope_mismatch');
  if (
    new Set(mapping.entries.map((entry) => entry.id)).size !==
    mapping.entries.length
  )
    throw new Error('impact_duplicate_id');
  return mapping;
}

/** No URL resolution or requests: paths are labels, not permission to execute tests. */
export function mapRouteImpact(
  base: ModuleGraph,
  head: ModuleGraph,
  comparison: Parameters<typeof affectedModules>[2],
  baseMappingInput: ImpactMapping,
  headMappingInput: ImpactMapping,
) {
  const impact = affectedModules(base, head, comparison);
  const baseMapping = validateMapping(baseMappingInput, base);
  const headMapping = validateMapping(headMappingInput, head);
  const gaps = [...impact.coverageGaps];
  if (!baseMapping.complete || !headMapping.complete)
    gaps.push({ code: 'incomplete_route_mapping' });
  for (const [mapping, graph] of [
    [baseMapping, base],
    [headMapping, head],
  ] as const) {
    const known = new Set(graph.modules.map((module) => module.path));
    for (const entry of mapping.entries)
      if (entry.modules.some((path) => !known.has(path)))
        gaps.push({ code: 'unknown_mapped_module', path: entry.id });
  }
  const mapped = new Set(
    [...baseMapping.entries, ...headMapping.entries].flatMap(
      (entry) => entry.modules,
    ),
  );
  if (impact.modules.some((path) => !mapped.has(path)))
    gaps.push({ code: 'unmapped_affected_module' });
  const widened = impact.widened || gaps.length > 0;
  const affected = new Set(impact.modules);
  const selected = [];
  for (const [snapshot, mapping] of [
    ['base', baseMapping],
    ['head', headMapping],
  ] as const)
    for (const entry of mapping.entries) {
      const matchedModules = [
        ...new Set(entry.modules.filter((path) => affected.has(path))),
      ].sort();
      if (matchedModules.length || entry.critical || widened)
        selected.push({
          snapshot,
          sha: mapping.sha,
          id: entry.id,
          target: entry.target,
          matchedModules,
          reasons: [
            ...(matchedModules.length ? ['affected_module'] : []),
            ...(entry.critical ? ['critical_baseline'] : []),
            ...(widened ? ['coverage_widened'] : []),
          ],
        });
    }
  return {
    tenantId: head.tenantId,
    repositoryId: head.repositoryId,
    baseSha: base.sha,
    headSha: head.sha,
    selected,
    widened,
    coverageGaps: gaps.filter(
      (gap, index, all) =>
        all.findIndex(
          (other) => other.code === gap.code && other.path === gap.path,
        ) === index,
    ),
  };
}
