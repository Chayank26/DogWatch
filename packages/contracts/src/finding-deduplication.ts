/** Conservative deterministic grouping; never promotes confidence or invents causality. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { findingScopeSchema, validateFindingForContext } from './findings.js';
import type { FindingRecord } from './findings.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function snapshot(record: FindingRecord): FindingRecord {
  // Reference order is not evidence identity; reproduction step order is significant.
  record.evidence.sort((a, b) => compare(a.artifactId, b.artifactId));
  if ('evidence' in record.baseline)
    record.baseline.evidence.sort((a, b) =>
      compare(a.artifactId, b.artifactId),
    );
  return record;
}
function allEvidence(record: FindingRecord) {
  return [
    ...record.evidence,
    ...('evidence' in record.baseline ? record.baseline.evidence : []),
  ];
}
function identity(record: FindingRecord) {
  const { findingId, createdAt, evidence, metrics, baseline, ...rest } = record;
  void findingId;
  void createdAt;
  void evidence;
  void metrics;
  const basis = 'basis' in rest ? { kind: rest.basis.kind } : undefined;
  return canonical({
    ...rest,
    ...(basis ? { basis } : {}),
    baseline:
      'evidence' in baseline
        ? {
            status: baseline.status,
            baseSha: baseline.baseSha,
            baseRunId: baseline.baseRunId,
          }
        : baseline,
  });
}
export interface FindingGroup {
  groupId: string;
  representativeFindingId: string;
  category: FindingRecord['category'];
  records: FindingRecord[];
  evidenceArtifactIds: string[];
}
export function deduplicateFindings(
  input: unknown,
  context: unknown,
  now: Date = new Date(),
) {
  const scope = findingScopeSchema.parse(context);
  const raw = z.array(z.unknown()).max(100).parse(input);
  if (!Number.isFinite(now.getTime())) throw Error('finding_time_invalid');
  const records = new Map<
    string,
    { record: FindingRecord; serialized: string }
  >();
  const artifacts = new Map<string, string>();
  let bytes = 0,
    duplicateInputs = 0;
  for (const value of raw) {
    const record = snapshot(validateFindingForContext(value, scope, now));
    const serialized = canonical(record);
    bytes += Buffer.byteLength(serialized, 'utf8');
    if (bytes > 2 * 1024 * 1024) throw Error('finding_batch_size');
    const previous = records.get(record.findingId);
    if (previous) {
      if (previous.serialized !== serialized)
        throw Error('finding_id_conflict');
      duplicateInputs++;
      continue;
    }
    for (const artifact of allEvidence(record)) {
      const content = canonical(artifact),
        known = artifacts.get(artifact.artifactId);
      if (known && known !== content)
        throw Error('artifact_reference_conflict');
      artifacts.set(artifact.artifactId, content);
    }
    records.set(record.findingId, { record, serialized });
  }
  const byKey = new Map<string, FindingGroup>();
  for (const { record } of records.values()) {
    const key = identity(record);
    let group = byKey.get(key);
    if (!group) {
      group = {
        groupId: createHash('sha256')
          .update('dogwatch-finding-group-v1\n' + key)
          .digest('hex'),
        representativeFindingId: record.findingId,
        category: record.category,
        records: [],
        evidenceArtifactIds: [],
      };
      byKey.set(key, group);
    }
    group.records.push(record);
  }
  const groups = [...byKey.values()].sort((a, b) =>
    compare(a.groupId, b.groupId),
  );
  const artifactGroups = new Map<string, string[]>();
  for (const group of groups) {
    group.records.sort((a, b) => compare(a.findingId, b.findingId));
    group.representativeFindingId = group.records[0].findingId;
    group.evidenceArtifactIds = [
      ...new Set(
        group.records.flatMap((record) =>
          allEvidence(record).map((item) => item.artifactId),
        ),
      ),
    ].sort(compare);
    for (const artifactId of group.evidenceArtifactIds) {
      const linked = artifactGroups.get(artifactId) ?? [];
      linked.push(group.groupId);
      artifactGroups.set(artifactId, linked);
    }
  }
  const relationships = [...artifactGroups]
    .filter(([, ids]) => ids.length > 1)
    .sort(([a], [b]) => compare(a, b))
    .map(([artifactId, groupIds]) => ({
      kind: 'shared_evidence' as const,
      artifactId,
      groupIds: [...groupIds].sort(compare),
    }));
  const categoryCounts = {
    confirmed_failure: 0,
    possible_regression: 0,
    advisory: 0,
    coverage_gap: 0,
  };
  for (const group of groups) categoryCounts[group.category]++;
  return {
    version: 1,
    ...scope,
    inputCount: raw.length,
    uniqueRecordCount: records.size,
    duplicateInputCount: duplicateInputs,
    groupCount: groups.length,
    categoryCounts,
    groups,
    relationships,
  };
}
