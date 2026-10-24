/** Private deterministic Markdown. Rendering never grants publication or proves finding truth. */
import { z } from 'zod';
import {
  deduplicateFindings,
  findingScopeSchema,
  findingArtifactSchema,
} from '@dogwatch/contracts';
import type { FindingGroup } from '@dogwatch/contracts';
import { verifyFindingArtifacts } from './private-artifacts.js';
import { bounded } from './api-runtime.js';
const count = z.number().int().min(0).max(1000000000);
const summarySchema = z.strictObject({
  status: z.enum([
    'completed',
    'inconclusive',
    'failed',
    'cancelled',
    'superseded',
  ]),
  coverage: z
    .array(
      z
        .strictObject({
          tier: z.enum(['tier0', 'tier1', 'tier2']),
          planned: count,
          completed: count,
          failed: count,
          inconclusive: count,
          skipped: count,
        })
        .refine(
          (value) =>
            value.failed <= value.completed &&
            value.completed + value.inconclusive + value.skipped <=
              value.planned,
        ),
    )
    .max(3)
    .refine(
      (rows) => new Set(rows.map((row) => row.tier)).size === rows.length,
    ),
  usage: z
    .strictObject({
      actions: count,
      requests: count,
      modelCalls: count,
      inputTokens: count,
      outputTokens: count,
      reservedCostMicros: count,
    })
    .optional(),
});
/** Code spans render all supplied text literally, including URLs, mentions and HTML. */
export function literalMarkdown(value: string) {
  const text = Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? ' '
      : character;
  }).join('');
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(longest + 1);
  return fence + ' ' + text + ' ' + fence;
}
function groupMarkdown(group: FindingGroup) {
  const record = group.records[0];
  const literal = literalMarkdown;
  const target =
    record.target.kind === 'api'
      ? record.target.method + ' ' + record.target.path
      : record.target.kind === 'journey'
        ? record.target.journeyId
        : record.target.path +
          (record.target.line ? ':' + record.target.line : '');
  const lines = [
    `### ${literal(record.title)}`,
    '',
    `Group: ${group.groupId}`,
    `Category: ${record.category}; severity: ${record.severity}; reported confidence: ${record.confidence}.`,
    `Target (${record.tier}): ${literal(target)}. Deployment: ${literal(record.environment.deploymentId)}.`,
    `Baseline: ${record.baseline.status}.`,
    '',
    `**Expected:** ${literal(record.expected)}`,
    `**Actual:** ${literal(record.actual)}`,
    '',
    'Reproduction:',
    '',
  ];
  if (record.reproductionSteps.length)
    record.reproductionSteps.forEach((step, index) =>
      lines.push(`${index + 1}. ${literal(step)}`),
    );
  else lines.push('No reproduction steps supplied.');
  if (record.category === 'coverage_gap')
    lines.push('', `Coverage reason: ${record.reason}.`);
  lines.push('', 'Retained records and private evidence:', '');
  for (const member of group.records) {
    lines.push(
      `- Record ${literal(member.findingId)}; created ${member.createdAt}.`,
    );
    if ('basis' in member)
      lines.push(
        `  Basis: ${member.basis.kind}; artifact ${member.basis.artifactId}.`,
      );
    if ('baseSha' in member.baseline)
      lines.push(
        `  Base SHA: ${member.baseline.baseSha}; base run: ${member.baseline.baseRunId}; comparison artifact: ${member.baseline.comparisonArtifactId}.`,
      );
    if (member.metrics)
      lines.push(
        `  Observed actions: ${member.metrics.completedActions}/${member.metrics.attemptedActions} completed; ${member.metrics.failedActions} failed; elapsed ${member.metrics.elapsedMs} ms. These metrics are not summed across records.`,
      );
    const refs = [
      ...member.evidence,
      ...('evidence' in member.baseline ? member.baseline.evidence : []),
    ];
    if (!refs.length) lines.push('  No artifact references supplied.');
    for (const ref of refs)
      lines.push(
        `  Artifact ${ref.artifactId} (${ref.kind}, ${ref.role}); SHA-256 ${ref.sha256}; expires ${ref.expiresAt}.`,
      );
  }
  return lines.join('\n');
}
export async function buildMarkdownReport(
  input: { scope: unknown; findings: unknown; summary: unknown },
  options: {
    artifactRoot: string;
    authorizeArtifact: (
      reference: z.infer<typeof findingArtifactSchema>,
    ) => Promise<boolean>;
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
    maxGroups?: number;
    maxBytes?: number;
  },
) {
  const scope = findingScopeSchema.parse(input.scope),
    summary = summarySchema.parse(input.summary);
  const maxGroups = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.maxGroups ?? 20),
    maxBytes = z
      .number()
      .int()
      .min(4096)
      .max(65536)
      .parse(options.maxBytes ?? 60000);
  const groups = deduplicateFindings(input.findings, scope);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const current = async () => {
    signal.throwIfAborted();
    if (!(await bounded(options.isCurrent(), signal)))
      throw Error('report_stale');
    signal.throwIfAborted();
  };
  try {
    await current();
    // Validate even omitted groups: a size limit must not conceal invalid references.
    for (const group of groups.groups)
      for (const record of group.records) {
        await current();
        await bounded(
          verifyFindingArtifacts(
            options.artifactRoot,
            record,
            scope,
            (reference) =>
              bounded(options.authorizeArtifact(reference), signal),
          ),
          signal,
        );
      }
    const lines = [
      '# DogWatch QA report',
      '',
      `PR #${scope.pullRequestNumber}; repository ${scope.repositoryId}; head SHA ${scope.headSha}.`,
      `Run: ${scope.runId}. Reported run status: ${summary.status}.`,
      '',
      'This report is private. Artifact references were authorized and checked for stored-byte integrity and expiry. Finding claims and redaction attestations were not semantically verified by this renderer.',
      '',
      `Finding groups: ${groups.groupCount}; unique records: ${groups.uniqueRecordCount}; exact retry inputs removed: ${groups.duplicateInputCount}.`,
      `Confirmed failures: ${groups.categoryCounts.confirmed_failure}; possible regressions: ${groups.categoryCounts.possible_regression}; advisories: ${groups.categoryCounts.advisory}; coverage gaps: ${groups.categoryCounts.coverage_gap}.`,
      '',
      '## Coverage',
      '',
    ];
    if (!summary.coverage.length)
      lines.push('Coverage was not supplied. No passing verdict is inferred.');
    for (const row of [...summary.coverage].sort((a, b) =>
      a.tier.localeCompare(b.tier),
    ))
      lines.push(
        `- ${row.tier}: planned ${row.planned}; completed ${row.completed} (failed ${row.failed}); inconclusive ${row.inconclusive}; skipped ${row.skipped}; unaccounted ${row.planned - row.completed - row.inconclusive - row.skipped}.`,
      );
    if (!groups.groupCount)
      lines.push(
        '',
        'No findings were supplied. This does not establish a passing run.',
      );
    if (summary.usage) {
      const u = summary.usage;
      lines.push(
        '',
        '## Usage',
        '',
        `Actions: ${u.actions}; requests: ${u.requests}; model calls: ${u.modelCalls}; reported input/output tokens: ${u.inputTokens}/${u.outputTokens}; reserved cost: ${u.reservedCostMicros} micro-units (estimate, not verified billing).`,
      );
    }
    lines.push('', '## Findings', '');
    let markdown = lines.join('\n');
    const included: string[] = [],
      omitted: string[] = [];
    // Reserve room for the fixed footer; never cut a reproduction/evidence section in half.
    const categoryOrder = {
      confirmed_failure: 0,
      possible_regression: 1,
      advisory: 2,
      coverage_gap: 3,
    };
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const ordered = [...groups.groups].sort(
      (a, b) =>
        categoryOrder[a.category] - categoryOrder[b.category] ||
        severityOrder[a.records[0].severity] -
          severityOrder[b.records[0].severity] ||
        a.groupId.localeCompare(b.groupId),
    );
    for (const group of ordered) {
      const section = '\n' + groupMarkdown(group) + '\n';
      if (
        included.length >= maxGroups ||
        Buffer.byteLength(markdown + section, 'utf8') > maxBytes - 512
      )
        omitted.push(group.groupId);
      else {
        markdown += section;
        included.push(group.groupId);
      }
    }
    markdown += `\n## Report limits\n\nShown groups: ${included.length}; omitted groups: ${omitted.length}. ${omitted.length ? 'Report incomplete: inspect the retained structured groups before making a decision.' : 'All supplied groups are shown.'}\nShared-evidence relationships: ${groups.relationships.length}; shared references do not establish a common cause.\nPrivate artifacts have no public links or inline images in this report.\n`;
    if (Buffer.byteLength(markdown, 'utf8') > maxBytes)
      throw Error('report_size');
    // Recheck freshness after asynchronous verification and rendering.
    deduplicateFindings(
      groups.groups.flatMap((group) => group.records),
      scope,
    );
    await current();
    return {
      version: 1,
      ...scope,
      audience: 'private' as const,
      completeness: omitted.length
        ? ('partial' as const)
        : ('complete' as const),
      markdown,
      shownGroupIds: included,
      omittedGroupIds: omitted,
      groupCount: groups.groupCount,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
