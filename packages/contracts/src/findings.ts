/** Versioned private finding contracts. Validation is not evidence verification or publication permission. */
import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const findingScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive().safe(),
  headSha: sha,
});
export const findingArtifactSchema = z.strictObject({
  artifactId: z.uuid(),
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  sha,
  role: z.enum(['base', 'head']),
  kind: z.enum([
    'api_observation',
    'browser_observation',
    'replay_result',
    'static_analysis',
    'screenshot',
    'baseline_comparison',
  ]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
  expiresAt: z.iso.datetime(),
});
const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('api'),
    method: z.enum([
      'GET',
      'HEAD',
      'OPTIONS',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ]),
    path: text(1024).refine(
      (value) =>
        value.startsWith('/') &&
        !value.startsWith('//') &&
        !/[?#\\\s]/.test(value) &&
        !value
          .split('/')
          .some((segment) => segment === '.' || segment === '..'),
    ),
  }),
  z.strictObject({ kind: z.literal('journey'), journeyId: id }),
  z.strictObject({
    kind: z.literal('source'),
    path: text(500).refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value
          .split('/')
          .some(
            (segment) => segment === '..' || segment === '.' || segment === '',
          ),
    ),
    line: z.number().int().positive().max(1000000).optional(),
  }),
]);
const baselineSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['unavailable', 'inconclusive']) }),
  z.strictObject({
    status: z.enum(['new_regression', 'pre_existing']),
    baseSha: sha,
    baseRunId: z.uuid(),
    comparisonArtifactId: z.uuid(),
    evidence: z.array(findingArtifactSchema).min(1).max(10),
  }),
]);
const metricsSchema = z
  .strictObject({
    attemptedActions: z.number().int().min(0).max(10000),
    completedActions: z.number().int().min(0).max(10000),
    failedActions: z.number().int().min(0).max(10000),
    elapsedMs: z.number().int().min(0).max(86400000),
  })
  .refine(
    (value) =>
      value.completedActions + value.failedActions <= value.attemptedActions,
  );
const common = {
  ...findingScopeSchema.shape,
  version: z.literal(2),
  findingId: id,
  tier: z.enum(['tier0', 'tier1', 'tier2']),
  environment: z.strictObject({
    deploymentId: text(200),
    role: z.literal('head'),
  }),
  contentPolicy: z.literal('reviewed_redacted'),
  createdAt: z.iso.datetime(),
  target: targetSchema,
  title: text(200),
  expected: text(4000),
  actual: text(4000),
  reproductionSteps: z.array(text(2000)).max(50),
  evidence: z.array(findingArtifactSchema).max(30),
  baseline: baselineSchema,
  metrics: metricsSchema.optional(),
};
export const findingRecordSchema = z
  .discriminatedUnion('category', [
    z.strictObject({
      ...common,
      category: z.literal('confirmed_failure'),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      confidence: z.literal('confirmed'),
      basis: z.strictObject({
        kind: z.enum(['validated_observation', 'reproduced']),
        artifactId: z.uuid(),
      }),
      reproductionSteps: z.array(text(2000)).min(1).max(50),
      evidence: z.array(findingArtifactSchema).min(1).max(30),
    }),
    z.strictObject({
      ...common,
      category: z.literal('possible_regression'),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      confidence: z.enum(['probable', 'unconfirmed']),
      reproductionSteps: z.array(text(2000)).min(1).max(50),
      evidence: z.array(findingArtifactSchema).min(1).max(30),
    }),
    z.strictObject({
      ...common,
      category: z.literal('advisory'),
      severity: z.enum(['low', 'info']),
      confidence: z.enum(['probable', 'unconfirmed']),
      evidence: z.array(findingArtifactSchema).min(1).max(30),
    }),
    z.strictObject({
      ...common,
      category: z.literal('coverage_gap'),
      severity: z.literal('info'),
      confidence: z.literal('unconfirmed'),
      reason: z.enum([
        'unsupported',
        'budget_exhausted',
        'cancelled',
        'unavailable',
        'missing_context',
        'cleanup_unverified',
        'scope_stale',
      ]),
    }),
  ])
  .superRefine((finding, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const evidence = finding.evidence;
    if (
      new Set(evidence.map((item) => item.artifactId)).size !== evidence.length
    )
      fail('Duplicate evidence');
    for (const item of evidence) {
      if (
        item.tenantId !== finding.tenantId ||
        item.repositoryId !== finding.repositoryId ||
        item.runId !== finding.runId ||
        item.sha !== finding.headSha ||
        item.role !== 'head'
      )
        fail('Head evidence scope mismatch');
      if (Date.parse(item.expiresAt) <= Date.parse(finding.createdAt))
        fail('Evidence expired at creation');
    }
    if (finding.category === 'confirmed_failure') {
      const basis = evidence.find(
        (item) => item.artifactId === finding.basis.artifactId,
      );
      if (
        !basis ||
        (finding.basis.kind === 'reproduced'
          ? basis.kind !== 'replay_result'
          : ![
              'api_observation',
              'browser_observation',
              'static_analysis',
            ].includes(basis.kind))
      )
        fail('Missing compatible confirmation evidence');
      if (
        finding.basis.kind === 'validated_observation' &&
        basis &&
        basis.kind !==
          (
            {
              tier0: 'static_analysis',
              tier1: 'api_observation',
              tier2: 'browser_observation',
            } as const
          )[finding.tier]
      )
        fail('Confirmation evidence tier mismatch');
    }
    if (
      finding.baseline.status === 'new_regression' ||
      finding.baseline.status === 'pre_existing'
    ) {
      if (finding.category !== 'confirmed_failure')
        fail('Only confirmed failures can claim baseline attribution');
      const baseline = finding.baseline;
      if (
        baseline.baseSha === finding.headSha ||
        baseline.baseRunId === finding.runId
      )
        fail('Baseline must be independent');
      if (
        !evidence.some(
          (item) =>
            item.artifactId === baseline.comparisonArtifactId &&
            item.kind === 'baseline_comparison',
        )
      )
        fail('Comparison artifact required');
      if (
        new Set(
          [...evidence, ...baseline.evidence].map((item) => item.artifactId),
        ).size !==
        evidence.length + baseline.evidence.length
      )
        fail('Duplicate baseline evidence');
      for (const item of baseline.evidence) {
        if (
          item.tenantId !== finding.tenantId ||
          item.repositoryId !== finding.repositoryId ||
          item.runId !== baseline.baseRunId ||
          item.sha !== baseline.baseSha ||
          item.role !== 'base'
        )
          fail('Base evidence scope mismatch');
        if (Date.parse(item.expiresAt) <= Date.parse(finding.createdAt))
          fail('Base evidence expired at creation');
      }
    }
    if (finding.tier === 'tier0' && finding.target.kind !== 'source')
      fail('Static tier requires source target');
    if (finding.tier === 'tier1' && finding.target.kind !== 'api')
      fail('API tier requires operation target');
    if (finding.tier === 'tier2' && finding.target.kind !== 'journey')
      fail('Browser tier requires journey target');
  });
export type FindingRecord = z.infer<typeof findingRecordSchema>;
/** Trusted callers still verify artifact ownership/content/redaction with the storage adapter. */
export function validateFindingForContext(
  record: unknown,
  context: unknown,
  now: Date = new Date(),
): FindingRecord {
  const finding = findingRecordSchema.parse(record),
    scope = findingScopeSchema.parse(context);
  if (
    Object.entries(scope).some(
      ([key, value]) => finding[key as keyof typeof scope] !== value,
    )
  )
    throw Error('finding_scope_mismatch');
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp) || Date.parse(finding.createdAt) > timestamp)
    throw Error('finding_time_invalid');
  const artifacts = [
    ...finding.evidence,
    ...('evidence' in finding.baseline ? finding.baseline.evidence : []),
  ];
  if (artifacts.some((item) => Date.parse(item.expiresAt) <= timestamp))
    throw Error('finding_evidence_expired');
  return finding;
}
