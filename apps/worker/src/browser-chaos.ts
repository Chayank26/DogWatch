/** Trusted deterministic fault plans, never model-provided browser permissions. */
import { z } from 'zod';
import { browserActionSchema } from './browser-actions.js';
export const requestFaultSchema = z
  .strictObject({
    kind: z.enum(['delay', 'offline', 'interrupt_navigation']),
    path: z
      .string()
      .regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/)
      .max(1024),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
    startAt: z.number().int().min(1).max(100).default(1),
    count: z.number().int().min(1).max(3).default(1),
    delayMs: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === 'delay') !== (value.delayMs !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Delay requires duration only for delay faults',
      });
    if (value.kind === 'interrupt_navigation' && value.method !== 'GET')
      ctx.addIssue({
        code: 'custom',
        message: 'Navigation interruption requires GET',
      });
  });
export type RequestFault = z.infer<typeof requestFaultSchema>;
/** Matching occurs only after normal authorization. Each eligible request gets one ordinal. */
export function createRequestFault(input: unknown) {
  const plan = requestFaultSchema.parse(input);
  let matched = 0,
    applied = 0;
  return {
    next(path: string, method: string, navigation: boolean) {
      if (
        path !== plan.path ||
        method !== plan.method ||
        (plan.kind === 'interrupt_navigation' && !navigation)
      )
        return undefined;
      matched++;
      if (matched < plan.startAt || applied >= plan.count) return undefined;
      applied++;
      return { ...plan };
    },
    snapshot: () => ({ plan: { ...plan }, matched, applied }),
  };
}
export const chaosScriptSchema = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    kind: z.enum([
      'slow_network',
      'offline',
      'navigation_interruption',
      'refresh',
      'repeated_submission',
      'boundary_input',
    ]),
    steps: z.array(browserActionSchema).min(1).max(20),
    fault: requestFaultSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const required = {
      slow_network: 'delay',
      offline: 'offline',
      navigation_interruption: 'interrupt_navigation',
    } as const;
    const expected = required[value.kind as keyof typeof required];
    if (expected ? value.fault?.kind !== expected : value.fault !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Scenario fault mismatch' });
    if (
      value.kind === 'refresh' &&
      !value.steps.some(
        (step, index) =>
          step.kind === 'navigate' &&
          value.steps
            .slice(0, index)
            .some(
              (previous) =>
                previous.kind === 'navigate' && previous.path === step.path,
            ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Refresh requires explicit navigation steps',
      });
    if (
      value.kind === 'repeated_submission' &&
      !value.steps.some(
        (step, index) =>
          step.kind === 'click' &&
          value.steps
            .slice(0, index)
            .some(
              (previous) =>
                previous.kind === 'click' && previous.target === step.target,
            ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Repeated submission requires explicit clicks',
      });
    if (
      value.kind === 'boundary_input' &&
      !value.steps.some(
        (step) => step.kind === 'fill' || step.kind === 'select',
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Boundary input requires synthetic value reference',
      });
  });
