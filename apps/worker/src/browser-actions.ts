/** Validated proposal vocabulary and trusted grants. No selectors, scripts or raw secrets. */
import { z } from 'zod';
import { scopeSchema } from './api-execution.js';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(value));
export const browserActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), path }),
  z.strictObject({ kind: z.literal('click'), target: id }),
  z.strictObject({
    kind: z.enum(['fill', 'select']),
    target: id,
    valueRef: id,
  }),
  z.strictObject({
    kind: z.literal('scroll'),
    deltaY: z.number().int().min(-1000).max(1000),
  }),
  z.strictObject({ kind: z.literal('stop') }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserPolicySchema = scopeSchema
  .extend({
    origin: z.string().url(),
    disposableData: z.boolean(),
    navigationPaths: z.array(path).max(30),
    requests: z
      .array(
        z.strictObject({
          path,
          method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
          allowMutation: z.boolean().default(false),
        }),
      )
      .max(100),
    targets: z
      .array(
        z.strictObject({
          id,
          locator: z.discriminatedUnion('kind', [
            z.strictObject({
              kind: z.literal('label'),
              name: z.string().min(1).max(200),
            }),
            z.strictObject({
              kind: z.literal('role'),
              role: z.enum([
                'button',
                'link',
                'textbox',
                'combobox',
                'checkbox',
              ]),
              name: z.string().min(1).max(200),
            }),
          ]),
          actions: z
            .array(z.enum(['click', 'fill', 'select']))
            .min(1)
            .max(3),
          valueRefs: z.array(id).max(30).default([]),
          destructive: z.boolean().default(false),
          allowDestructive: z.boolean().default(false),
        }),
      )
      .max(100),
    values: z
      .record(id, z.string().max(1000))
      .refine((value) => Object.keys(value).length <= 30),
    allowScroll: z.boolean().default(false),
    maxActions: z.number().int().min(1).max(100).default(20),
    maxRequests: z.number().int().min(1).max(200).default(100),
    actionMs: z.number().int().min(1).max(5000).default(2000),
    sessionMs: z.number().int().min(1).max(60000).default(20000),
  })
  .superRefine((policy, ctx) => {
    if (
      new Set(policy.targets.map((target) => target.id)).size !==
      policy.targets.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate targets' });
  });
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;
export function actionAllowed(
  action: BrowserAction,
  policy: BrowserPolicy,
): boolean {
  if (action.kind === 'stop') return true;
  if (action.kind === 'navigate')
    return policy.navigationPaths.includes(action.path);
  if (action.kind === 'scroll') return policy.allowScroll;
  const target = policy.targets.find((item) => item.id === action.target);
  return (
    !!target &&
    target.actions.includes(action.kind) &&
    (!target.destructive ||
      (target.allowDestructive && policy.disposableData)) &&
    (!('valueRef' in action) ||
      (target.valueRefs.includes(action.valueRef) &&
        Object.hasOwn(policy.values, action.valueRef)))
  );
}
export function requestAllowed(
  urlInput: string,
  method: string,
  policy: BrowserPolicy,
): boolean {
  try {
    const url = new URL(urlInput);
    if (
      url.origin !== policy.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const grant = policy.requests.find(
      (item) => item.path === url.pathname && item.method === method,
    );
    return (
      !!grant &&
      (['GET', 'HEAD'].includes(method) ||
        (grant.allowMutation && policy.disposableData))
    );
  } catch {
    return false;
  }
}
