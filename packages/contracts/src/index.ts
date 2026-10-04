/**
 * Shared, framework-independent vocabulary for DogWatch.
 *
 * Zod schemas check values at runtime (when reading JSON); inferred TypeScript
 * types check our own code at compile time. Neither check grants authorization.
 * Future ingress code must verify GitHub's signature and installation access
 * before constructing the normalized event accepted by the policy evaluator.
 */
import { z } from 'zod';

/** Opaque IDs identify records; trimming rejects IDs containing only spaces. */
const idSchema = z.string().trim().min(1).max(200);
/** Git commit IDs are hexadecimal, not branch names that can move later. */
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

/** Progress is separate from whether tests discovered application failures. */
export const runStateSchema = z.enum([
  'received',
  'queued',
  'waiting_for_preview',
  'running',
  'reporting',
  'completed',
  'failed',
  'cancelled',
  'superseded',
]);
export type RunState = z.infer<typeof runStateSchema>;

/** A skipped or inconclusive check must never masquerade as a passing check. */
export const tierOutcomeSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'inconclusive',
]);
export const severitySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
export const confidenceSchema = z.enum([
  'confirmed',
  'probable',
  'unconfirmed',
]);

/**
 * Strict objects reject unknown keys, helping catch misspelled configuration.
 * Positive integer ceilings prohibit unlimited work. These are configurable
 * bounds, not measured performance guarantees. Executors enforce them later.
 */
export const budgetSchema = z.strictObject({
  maxRunSeconds: z.number().int().min(20).max(1800).default(300),
  maxApiRequests: z.number().int().min(1).max(1000).default(100),
  maxBrowserSteps: z.number().int().min(1).max(200).default(30),
  maxModelCalls: z.number().int().min(1).max(100).default(20),
  maxModelTokens: z.number().int().min(1).max(200000).default(20000),
  // Store money as integer cents to avoid floating-point currency arithmetic.
  maxModelCostCents: z.number().int().min(1).max(10000).default(100),
});
export type RunBudget = z.infer<typeof budgetSchema>;

/**
 * Phase 1 policy deliberately supports only JavaScript/TypeScript repositories.
 * Account IDs below are GitHub numeric user IDs, not changeable display names.
 * Secret values and preview URLs do not belong in this opt-in configuration.
 */
export const repositoryPolicySchema = z.strictObject({
  tenantId: idSchema,
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  enabled: z.boolean().default(true),
  label: z.string().trim().min(1).max(50).default('dogwatch'),
  command: z
    .string()
    .trim()
    .regex(/^\/[a-z][a-z0-9-]* run$/)
    .default('/dogwatch run'),
  authorizedActorIds: z.array(z.number().int().positive()).min(1),
  languages: z
    .array(z.enum(['javascript', 'typescript']))
    .min(1)
    .default(['javascript', 'typescript']),
  budget: budgetSchema.default(() => budgetSchema.parse({})),
});
export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>;

/**
 * A normalized event is an internal DTO (data transfer object), not GitHub's
 * raw webhook format. The future adapter resolves tenant and installation IDs
 * using trusted records, and verifies actor permissions independently.
 * Only PR comments are represented; ordinary issue comments must be filtered.
 */
const eventContext = {
  tenantId: idSchema,
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  actorId: z.number().int().positive(),
  deliveryId: idSchema,
  pullRequestNumber: z.number().int().positive(),
  headSha: shaSchema,
};
export const optInEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...eventContext,
    kind: z.literal('pr_opened'),
    labels: z.array(z.string()),
  }),
  z.strictObject({
    ...eventContext,
    kind: z.literal('pr_labeled'),
    addedLabel: z.string(),
  }),
  z.strictObject({
    ...eventContext,
    kind: z.literal('pr_comment'),
    body: z.string().max(65536),
  }),
]);
export type OptInEvent = z.infer<typeof optInEventSchema>;

/** A discriminated result forces callers to distinguish acceptance from refusal. */
export type OptInDecision =
  | { accepted: true; trigger: 'label' | 'command' }
  | {
      accepted: false;
      reason:
        'disabled' | 'scope_mismatch' | 'unauthorized_actor' | 'no_opt_in';
    };

/**
 * Pure decision gate: no HTTP calls, database writes, queue dispatch, or secrets.
 * Both inputs are validated even when a TypeScript caller supplies them: types
 * disappear at runtime, and future configuration will originate as JSON.
 */
export function evaluateOptIn(
  policyInput: unknown,
  eventInput: unknown,
): OptInDecision {
  const policy = repositoryPolicySchema.parse(policyInput);
  const event = optInEventSchema.parse(eventInput);
  if (!policy.enabled) return { accepted: false, reason: 'disabled' };
  // Matching all three scope IDs prevents using one repository's policy elsewhere.
  if (
    policy.tenantId !== event.tenantId ||
    policy.installationId !== event.installationId ||
    policy.repositoryId !== event.repositoryId
  ) {
    return { accepted: false, reason: 'scope_mismatch' };
  }
  // Require approved actors for every trigger, including labels already on a PR.
  if (!policy.authorizedActorIds.includes(event.actorId)) {
    return { accepted: false, reason: 'unauthorized_actor' };
  }
  if (event.kind === 'pr_opened' && event.labels.includes(policy.label)) {
    return { accepted: true, trigger: 'label' };
  }
  if (event.kind === 'pr_labeled' && event.addedLabel === policy.label) {
    return { accepted: true, trigger: 'label' };
  }
  // Exact whole-comment matching avoids executing commands quoted in prose/code.
  if (event.kind === 'pr_comment' && event.body.trim() === policy.command) {
    return { accepted: true, trigger: 'command' };
  }
  return { accepted: false, reason: 'no_opt_in' };
}

/**
 * Immutable context for a future queued run. Recording the code version and budget in
 * the run prevents a mid-run configuration edit from silently changing its scope.
 * Idempotency/delivery deduplication belongs to durable storage in a later phase.
 */
export const runRequestSchema = z.strictObject({
  runId: idSchema,
  deliveryId: idSchema,
  tenantId: idSchema,
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  pullRequestNumber: z.number().int().positive(),
  headSha: shaSchema,
  trigger: z.enum(['label', 'command']),
  budget: budgetSchema,
});
export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * Findings must describe observed behavior and point to evidence. Artifact IDs
 * are references to private storage records, never public URLs or secret payloads.
 * This schema checks shape; the aggregator will establish truth and deduplicate.
 */
export const findingSchema = z.strictObject({
  findingId: idSchema,
  runId: idSchema,
  tier: z.enum(['tier0', 'tier1', 'tier2']),
  severity: severitySchema,
  confidence: confidenceSchema,
  title: z.string().trim().min(1).max(200),
  expected: z.string().trim().min(1).max(4000),
  actual: z.string().trim().min(1).max(4000),
  reproductionSteps: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
  evidenceArtifactIds: z.array(idSchema).min(1).max(50),
  baseline: z.enum([
    'new_regression',
    'pre_existing',
    'unavailable',
    'inconclusive',
  ]),
});
export type Finding = z.infer<typeof findingSchema>;
