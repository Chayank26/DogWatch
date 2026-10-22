/** Operator-owned authorization scenarios; no scripts, credentials or arbitrary JSONPath. */
import { z } from 'zod';
const label = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const field = z
  .array(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .refine(
        (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
      ),
  )
  .min(1)
  .max(8);
const identity = z.strictObject({ ref: label, subjectId: label, role: label });
const success = z.number().int().min(200).max(299).default(200);
const rejection = z.union([z.literal(403), z.literal(404)]).default(403);
const shared = {
  id: label,
  method: z
    .enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    .default('GET'),
  path: z.string().min(1).max(1024),
  allowed: identity,
  denied: identity,
  successStatus: success,
  rejectionStatus: rejection,
};
const scalar = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const authorizationPolicySchema = z
  .strictObject({
    identityCheck: z.strictObject({
      path: z.string().min(1).max(1024),
      subjectField: field,
      roleField: field,
      successStatus: success,
    }),
    scenarios: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            ...shared,
            kind: z.literal('role'),
            parameters: z
              .array(
                z.strictObject({
                  name: label,
                  value: z.string().min(1).max(200),
                }),
              )
              .max(10)
              .default([]),
            evidence: z
              .array(z.strictObject({ field, value: scalar }))
              .min(1)
              .max(8),
          }),
          z.strictObject({
            ...shared,
            kind: z.literal('ownership'),
            resourceParameter: label,
            ownerResource: z.string().min(1).max(200),
            actorResource: z.string().min(1).max(200),
            resourceIdField: field,
            ownerField: field,
          }),
        ]),
      )
      .min(1)
      .max(20),
  })
  .superRefine((policy, ctx) => {
    const ids = new Set<string>(),
      identities = new Map<string, string>();
    const reject = () =>
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid authorization scenario identity',
      });
    if (
      JSON.stringify(policy.identityCheck.subjectField) ===
      JSON.stringify(policy.identityCheck.roleField)
    )
      reject();
    for (const scenario of policy.scenarios) {
      if (ids.has(scenario.id)) reject();
      ids.add(scenario.id);
      if (
        scenario.allowed.ref === scenario.denied.ref ||
        scenario.allowed.subjectId === scenario.denied.subjectId
      )
        reject();
      if (
        scenario.kind === 'role' &&
        scenario.allowed.role === scenario.denied.role
      )
        reject();
      if (
        scenario.kind === 'ownership' &&
        (scenario.allowed.role !== scenario.denied.role ||
          scenario.ownerResource === scenario.actorResource ||
          JSON.stringify(scenario.resourceIdField) ===
            JSON.stringify(scenario.ownerField))
      )
        reject();
      for (const who of [scenario.allowed, scenario.denied]) {
        const binding = JSON.stringify([who.subjectId, who.role]);
        if (identities.has(who.ref) && identities.get(who.ref) !== binding)
          reject();
        identities.set(who.ref, binding);
      }
    }
  });
export type AuthorizationPolicy = z.infer<typeof authorizationPolicySchema>;
export type AuthorizationScenario = AuthorizationPolicy['scenarios'][number];
export type AuthorizationIdentity = AuthorizationScenario['allowed'];
