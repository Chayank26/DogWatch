/** Read-only role/ownership observations with explicit identity and resource controls. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  scopeSchema,
  grantSchema,
  limitsSchema,
  validateApiExecutionContext,
  assessApiResponse,
} from './api-execution.js';
import type {
  ApiExecutionInput,
  ApiExecutionOptions,
  ApiScope,
} from './api-execution.js';
import { previewBindingSchema } from './preview.js';
import { validateApiContract } from './openapi.js';
import type { ContractOperation, ContractValidation } from './openapi.js';
import {
  generateBoundaryCases,
  boundaryOptionsSchema,
} from './boundary-cases.js';
import type { BoundaryCase } from './boundary-cases.js';
import { fixtureValue, stable } from './boundary-values.js';
import type { JsonValue } from './boundary-values.js';
import { ApiRuntime } from './api-runtime.js';
import { ApiGap, serializeApiCase } from './api-transport.js';
import type { ApiResponse } from './api-transport.js';
import type {
  AuthorizationScenario,
  AuthorizationIdentity,
} from './api-authorization-plan.js';

const credentialSchema = scopeSchema.extend({
  deploymentId: z.string().min(1).max(200),
  origin: z.string().url().max(2048),
  identityRef: z.string().min(1).max(100),
  subjectId: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  bearerToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
});
export type ScopedIdentityCredential = z.infer<typeof credentialSchema>;
export interface IdentityContext extends ApiScope {
  deploymentId: string;
  origin: string;
}
export type AuthorizationStep =
  | 'allowed_identity'
  | 'denied_identity'
  | 'allowed_access'
  | 'denied_own_access'
  | 'forbidden_access';
export interface AuthorizationObservation {
  scenarioId: string;
  kind: 'role' | 'ownership';
  step: AuthorizationStep;
  caseId: string;
  baselineCaseId?: string;
  operationKey: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'skipped';
  code: string;
  httpStatus?: number;
  /** Only booleans are retained. No response values, IDs, roles or credential material. */
  evidenceMatched?: boolean;
}
export interface AuthorizationExecution extends ApiScope {
  version: 1;
  contractDigest?: string;
  seed: number;
  status: 'completed' | 'inconclusive';
  code: string;
  requests: number;
  requestBytes: number;
  responseBytes: number;
  results: AuthorizationObservation[];
}
type Proof = { field: string[]; value: JsonValue }[];
interface Prepared {
  test: BoundaryCase;
  operation: ContractOperation;
  scheme: string;
}
const stages = (scenario: AuthorizationScenario): AuthorizationStep[] =>
  scenario.kind === 'ownership'
    ? [
        'allowed_identity',
        'denied_identity',
        'allowed_access',
        'denied_own_access',
        'forbidden_access',
      ]
    : [
        'allowed_identity',
        'denied_identity',
        'allowed_access',
        'forbidden_access',
      ];
function matches(response: ApiResponse, proof: Proof) {
  if (
    response.encoded ||
    response.contentType.split(';')[0]!.trim().toLowerCase() !==
      'application/json'
  )
    return false;
  try {
    const data = fixtureValue(
      new TextDecoder('utf-8', { fatal: true }).decode(response.body),
    );
    return proof.every((assertion) => {
      let value: JsonValue = data;
      for (const key of assertion.field) {
        if (
          value === null ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.hasOwn(value, key)
        )
          return false;
        value = value[key]!;
      }
      return value === assertion.value;
    });
  } catch {
    return false;
  }
}
function bearer(
  operation: ContractOperation,
  contract: ContractValidation,
): string {
  const alternatives = operation.security.map((requirement) =>
    Object.keys(requirement),
  );
  if (
    !alternatives.length ||
    alternatives.some((names) => names.length !== 1) ||
    new Set(alternatives.flat()).size !== 1
  )
    throw new ApiGap('authorization_security_unsupported');
  const name = alternatives[0]![0]!,
    definition = contract.securitySchemes[name];
  if (definition?.type !== 'http' || definition.scheme !== 'bearer')
    throw new ApiGap('authorization_security_unsupported');
  return name;
}
function ownerProof(
  policy: Extract<AuthorizationScenario, { kind: 'ownership' }>,
  own: boolean,
): Proof {
  return [
    {
      field: policy.resourceIdField,
      value: own ? policy.actorResource : policy.ownerResource,
    },
    {
      field: policy.ownerField,
      value: own ? policy.denied.subjectId : policy.allowed.subjectId,
    },
  ];
}
/** All endpoint/scenario authority lives inside the independently scoped grant. */
export async function executeApiAuthorization(
  input: ApiExecutionInput,
  options: ApiExecutionOptions & {
    getIdentity: (
      context: IdentityContext,
      identity: AuthorizationIdentity,
      scheme: string,
    ) => Promise<ScopedIdentityCredential | undefined>;
  },
): Promise<AuthorizationExecution> {
  const scope = scopeSchema.parse(input.scope),
    binding = previewBindingSchema.parse(input.binding),
    grant = grantSchema.parse(input.grant),
    limits = limitsSchema.parse(input.limits ?? {});
  // Snapshot mutable caller inputs before any asynchronous identity/network work.
  const contractText = input.contractText;
  const generation = boundaryOptionsSchema.parse(input.generation ?? {});
  const context = {
    tenantId: scope.tenantId,
    repositoryId: scope.repositoryId,
    headSha: scope.headSha,
  };
  const contract = validateApiContract(context, contractText);
  // Validate generator configuration before invoking credentials or transport.
  const validationPlan = generateBoundaryCases(context, contractText, {
    ...generation,
    baselineOnly: true,
  });
  const output: AuthorizationExecution = {
    ...scope,
    version: 1,
    contractDigest: contract.contractDigest,
    seed: validationPlan.seed,
    status: 'inconclusive',
    code: 'authorization_unavailable',
    requests: 0,
    requestBytes: 0,
    responseBytes: 0,
    results: [],
  };
  const runtime = new ApiRuntime(limits, options, output);
  let stop: string | undefined;
  try {
    const origin = validateApiExecutionContext(
      scope,
      binding,
      grant,
      options.fixture,
    );
    const policy = grant.authorization;
    if (!policy) throw new ApiGap('authorization_not_granted');
    if (contract.status !== 'supported')
      throw new ApiGap('contract_unavailable');
    const known = new Set(
      contract.operations.map((op) => `${op.method} ${op.path}`),
    );
    const granted = grant.operations.map((op) => `${op.method} ${op.path}`);
    if (
      new Set(granted).size !== granted.length ||
      granted.some((key) => !known.has(key))
    )
      throw new ApiGap('operation_forbidden');
    const prepare = (
      path: string,
      parameters: { name: string; value: string }[],
      status: number,
    ): Prepared => {
      if (
        generation?.operationAllowlist &&
        !generation.operationAllowlist.some(
          (selector) => selector.method === 'GET' && selector.path === path,
        )
      )
        throw new ApiGap('operation_forbidden');
      if (!granted.includes(`GET ${path}`))
        throw new ApiGap('operation_forbidden');
      const operation = contract.operations.find(
        (op) => op.method === 'GET' && op.path === path,
      )!;
      if (
        operation.requestBody ||
        operation.parameters.some((parameter) => parameter.in !== 'path')
      )
        throw new ApiGap('authorization_request_unsupported');
      if (!operation.responses[String(status)]?.schema)
        throw new ApiGap('authorization_evidence_schema_unavailable');
      if (
        parameters.length !== operation.parameters.length ||
        new Set(parameters.map((p) => p.name)).size !== parameters.length ||
        operation.parameters.some(
          (p) => !parameters.some((value) => value.name === p.name),
        )
      )
        throw new ApiGap('authorization_resource_binding');
      const plan = generateBoundaryCases(context, contractText, {
        ...generation,
        baselineOnly: true,
        operationAllowlist: [{ method: 'GET', path }],
        fixtures: [
          {
            method: 'GET',
            path,
            parameters: parameters.map((p) => ({ ...p, in: 'path' as const })),
          },
        ],
      });
      if (
        plan.status !== 'generated' ||
        plan.cases.length !== 1 ||
        plan.cases[0]!.inputValidity !== 'valid'
      )
        throw new ApiGap('authorization_baseline_unavailable');
      const prepared = {
        test: plan.cases[0]!,
        operation,
        scheme: bearer(operation, contract),
      };
      // Validate faithful path/header serialization before any identity lookup or request.
      serializeApiCase(prepared.test, operation, origin.origin);
      return prepared;
    };
    for (const scenario of policy.scenarios) {
      let controlFailed = false;
      const rows = stages(scenario);
      const prepared = new Map<AuthorizationStep, Prepared>();
      const add = (
        step: AuthorizationStep,
        status: AuthorizationObservation['status'],
        code: string,
        response?: ApiResponse,
        evidenceMatched?: boolean,
      ) => {
        const request = prepared.get(step);
        const operationKey =
          request?.test.operationKey ??
          `GET ${step.endsWith('_identity') ? policy.identityCheck.path : scenario.path}`;
        const caseId = createHash('sha256')
          .update(
            stable({
              version: 1,
              scope,
              deploymentId: grant.deploymentId,
              origin: grant.origin,
              contractDigest: contract.contractDigest ?? null,
              seed: output.seed,
              identityCheck: policy.identityCheck,
              scenario,
              step,
              baseline: request?.test.id ?? null,
            }),
          )
          .digest('hex');
        output.results.push({
          scenarioId: scenario.id,
          kind: scenario.kind,
          step,
          caseId,
          operationKey,
          ...(request ? { baselineCaseId: request.test.id } : {}),
          status,
          code,
          ...(response ? { httpStatus: response.status } : {}),
          ...(evidenceMatched === undefined ? {} : { evidenceMatched }),
        });
      };
      if (stop) {
        for (const step of rows) add(step, 'skipped', stop);
        continue;
      }
      let credentials: {
        allowed: ScopedIdentityCredential;
        denied: ScopedIdentityCredential;
      };
      try {
        // Mutation proof requires independent readback/reset controls, reserved for later integration.
        if (scenario.method !== 'GET')
          throw new ApiGap('authorization_mutation_unsupported');
        const identity = prepare(
          policy.identityCheck.path,
          [],
          policy.identityCheck.successStatus,
        );
        prepared.set('allowed_identity', identity);
        prepared.set('denied_identity', identity);
        const parameters =
          scenario.kind === 'ownership'
            ? [
                {
                  name: scenario.resourceParameter,
                  value: scenario.ownerResource,
                },
              ]
            : scenario.parameters;
        const target = prepare(
          scenario.path,
          parameters,
          scenario.successStatus,
        );
        if (identity.scheme !== target.scheme)
          throw new ApiGap('authorization_security_unsupported');
        if (
          !Object.hasOwn(
            target.operation.responses,
            String(scenario.rejectionStatus),
          )
        )
          throw new ApiGap('authorization_expectation_undocumented');
        prepared.set('allowed_access', target);
        prepared.set('forbidden_access', target);
        if (scenario.kind === 'ownership')
          prepared.set(
            'denied_own_access',
            prepare(
              scenario.path,
              [
                {
                  name: scenario.resourceParameter,
                  value: scenario.actorResource,
                },
              ],
              scenario.successStatus,
            ),
          );
        const get = async (who: AuthorizationIdentity) => {
          const identityContext = {
            ...scope,
            deploymentId: grant.deploymentId,
            origin: origin.origin,
          };
          const candidate = await runtime.credential(() =>
            options.getIdentity(
              { ...identityContext },
              { ...who },
              identity.scheme,
            ),
          );
          const checked = credentialSchema.safeParse(candidate);
          if (
            !checked.success ||
            Object.entries(identityContext).some(
              ([key, value]) =>
                checked.data[key as keyof IdentityContext] !== value,
            ) ||
            checked.data.identityRef !== who.ref ||
            checked.data.subjectId !== who.subjectId ||
            checked.data.role !== who.role
          )
            throw new ApiGap('identity_credentials_unavailable');
          return checked.data;
        };
        credentials = {
          allowed: await get(scenario.allowed),
          denied: await get(scenario.denied),
        };
        if (credentials.allowed.bearerToken === credentials.denied.bearerToken)
          throw new ApiGap('identity_credentials_not_distinct');
      } catch (error) {
        const code = runtime.code(error);
        for (const step of rows) add(step, 'inconclusive', code);
        if (
          [
            'stopped',
            'execution_timeout',
            'context_unavailable',
            'transport_unavailable',
            'destination_forbidden',
          ].includes(code)
        )
          stop = code;
        continue;
      }
      for (const step of rows) {
        if (stop) {
          add(step, 'skipped', stop);
          continue;
        }
        if (controlFailed) {
          add(step, 'inconclusive', 'authorization_control_unavailable');
          continue;
        }
        const request = prepared.get(step)!;
        const allowed =
          step === 'allowed_identity' || step === 'allowed_access';
        const who = allowed ? scenario.allowed : scenario.denied;
        const token = allowed
          ? credentials.allowed.bearerToken
          : credentials.denied.bearerToken;
        const identityStep =
          step === 'allowed_identity' || step === 'denied_identity';
        const proof: Proof = identityStep
          ? [
              {
                field: policy.identityCheck.subjectField,
                value: who.subjectId,
              },
              { field: policy.identityCheck.roleField, value: who.role },
            ]
          : scenario.kind === 'ownership'
            ? ownerProof(scenario, step === 'denied_own_access')
            : scenario.evidence;
        try {
          const response = await runtime.send(
            serializeApiCase(
              request.test,
              request.operation,
              origin.origin,
              token,
            ),
          );
          if (response.status >= 300 && response.status < 400) {
            stop = 'redirect_forbidden';
            add(step, 'inconclusive', stop, response);
            continue;
          }
          if (response.status === 429) {
            stop = 'rate_limited';
            add(step, 'inconclusive', stop, response);
            continue;
          }
          // A denial status can still disclose the protected object. Validate its
          // shape against the successful control schema, retaining the real status.
          if (
            step === 'forbidden_access' &&
            matches(response, proof) &&
            assessApiResponse(request.test, request.operation, {
              ...response,
              status: scenario.successStatus,
            }).status === 'passed'
          ) {
            add(
              step,
              'failed',
              scenario.kind === 'ownership'
                ? 'ownership_access_observed'
                : 'role_access_observed',
              response,
              true,
            );
            continue;
          }
          if (
            step === 'forbidden_access' &&
            response.status === scenario.rejectionStatus
          ) {
            const assessed = assessApiResponse(
              request.test,
              request.operation,
              response,
              true,
            );
            add(
              step,
              assessed.status,
              assessed.status === 'passed'
                ? 'authorization_rejected'
                : assessed.code,
              response,
            );
            continue;
          }
          const expected = identityStep
            ? policy.identityCheck.successStatus
            : scenario.successStatus;
          const assessed = assessApiResponse(
            request.test,
            request.operation,
            response,
          );
          const evidence =
            assessed.status === 'passed' &&
            response.status === expected &&
            matches(response, proof);
          if (step !== 'forbidden_access') {
            if (evidence)
              add(
                step,
                'passed',
                identityStep
                  ? 'identity_verified'
                  : 'authorization_control_passed',
                response,
                true,
              );
            else {
              controlFailed = true;
              add(
                step,
                'inconclusive',
                'authorization_control_unavailable',
                response,
                false,
              );
            }
          } else if (response.status >= 500)
            add(step, 'failed', 'server_error', response);
          else if (response.status >= 200 && response.status < 300)
            add(
              step,
              'inconclusive',
              'authorization_access_unproven',
              response,
              false,
            );
          else if (response.status === 401)
            add(
              step,
              'inconclusive',
              'identity_credentials_unavailable',
              response,
            );
          else if (response.status === 403 || response.status === 404)
            add(step, 'failed', 'authorization_rejection_mismatch', response);
          else
            add(
              step,
              'inconclusive',
              'authorization_rejection_unproven',
              response,
            );
        } catch (error) {
          stop = runtime.code(error);
          add(step, 'inconclusive', stop);
        }
      }
      // Credentials remain local to this scenario and never enter returned evidence.
    }
    output.status =
      !stop &&
      output.results.length > 0 &&
      output.results.every(
        (row) => row.status === 'passed' || row.status === 'failed',
      )
        ? 'completed'
        : 'inconclusive';
    output.code =
      stop ??
      (output.status === 'completed'
        ? 'authorization_completed'
        : 'coverage_incomplete');
  } catch (error) {
    output.code = runtime.code(error);
  } finally {
    runtime.close();
  }
  return output;
}
