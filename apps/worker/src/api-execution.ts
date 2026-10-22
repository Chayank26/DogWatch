/** Callable API stage. No consumer, credential minting, publication or source execution. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApiRuntime, bounded } from './api-runtime.js';
import { authorizationPolicySchema } from './api-authorization-plan.js';
import { generateBoundaryCases } from './boundary-cases.js';
import type { BoundaryOptions, BoundaryCase } from './boundary-cases.js';
import { validateApiContract } from './openapi.js';
import type { ContractOperation } from './openapi.js';
import { checkValue, fixtureValue, ValueGap } from './boundary-values.js';
import {
  previewBindingSchema,
  validatePreviewUrl,
  ForbiddenPreviewError,
} from './preview.js';
import type { PreviewBinding } from './preview.js';
import { ApiGap, serializeApiCase } from './api-transport.js';
import type { ApiResponse } from './api-transport.js';

export const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type ApiScope = z.infer<typeof scopeSchema>;
export const grantSchema = scopeSchema.extend({
  deploymentId: z.string().min(1).max(200),
  origin: z.string().url().max(2048),
  disposableData: z.boolean().default(false),
  authorization: authorizationPolicySchema.optional(),
  operations: z
    .array(
      z.strictObject({
        method: z.enum([
          'GET',
          'HEAD',
          'OPTIONS',
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
        ]),
        path: z.string().min(1).max(1024),
        allowMutation: z.boolean().default(false),
        authentication: z
          .strictObject({
            successStatuses: z
              .array(z.number().int().min(200).max(299))
              .min(1)
              .max(10),
            rejectionStatus: z
              .union([z.literal(401), z.literal(403)])
              .default(401),
            invalidBearer: z.boolean().default(false),
          })
          .optional(),
      }),
    )
    .max(200),
});
export type AuthenticationProbe = 'control' | 'missing' | 'invalid_bearer';
export type ApiGrant = z.input<typeof grantSchema>;
export const limitsSchema = z.strictObject({
  maxRequests: z.number().int().min(0).max(1000).default(100),
  maxRetries: z.number().int().min(0).max(2).default(0),
  minIntervalMs: z.number().int().min(50).max(10000).default(100),
  maxRequestMs: z.number().int().min(1).max(10000).default(2000),
  maxExecutionMs: z.number().int().min(1).max(300000).default(20000),
  maxRequestBytes: z.number().int().min(1).max(65536).default(16384),
  maxResponseBytes: z.number().int().min(1).max(65536).default(16384),
  maxTotalRequestBytes: z.number().int().min(1).max(1048576).default(262144),
  maxTotalResponseBytes: z.number().int().min(1).max(4194304).default(1048576),
});
export type ApiLimits = z.infer<typeof limitsSchema>;
export interface ApiCaseResult {
  caseId: string;
  operationKey: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'skipped';
  code: string;
  httpStatus?: number;
  probe?: AuthenticationProbe;
  baselineCaseId?: string;
}
export interface ApiExecution extends ApiScope {
  contractDigest?: string;
  seed: number;
  status: 'completed' | 'inconclusive';
  code: string;
  requests: number;
  requestBytes: number;
  responseBytes: number;
  results: ApiCaseResult[];
  coverageGaps: { code: string; operationKey?: string }[];
}
export function assessApiResponse(
  test: BoundaryCase,
  operation: ContractOperation,
  response: ApiResponse,
  authenticationRejection = false,
): Pick<ApiCaseResult, 'status' | 'code'> {
  const status = response.status;
  if (status >= 300 && status < 400)
    return { status: 'inconclusive', code: 'redirect_forbidden' };
  if (!authenticationRejection && (status === 401 || status === 403))
    return { status: 'inconclusive', code: 'credentials_unavailable' };
  if (status === 429) return { status: 'inconclusive', code: 'rate_limited' };
  if (status >= 500) return { status: 'failed', code: 'server_error' };
  const expected =
    operation.responses[String(status)] ?? operation.responses.default;
  if (!expected) return { status: 'failed', code: 'undocumented_status' };
  if (
    expected.schema &&
    !['HEAD'].includes(test.method) &&
    ![204, 205].includes(status)
  ) {
    if (response.encoded)
      return { status: 'inconclusive', code: 'response_encoding' };
    if (
      response.contentType.split(';')[0]!.trim().toLowerCase() !==
      'application/json'
    )
      return { status: 'failed', code: 'response_media_type' };
    try {
      const verdict = checkValue(
        expected.schema,
        fixtureValue(
          new TextDecoder('utf-8', { fatal: true }).decode(response.body),
        ),
      );
      if (verdict !== 'valid')
        return {
          status: verdict === 'invalid' ? 'failed' : 'inconclusive',
          code: 'response_schema',
        };
    } catch (error) {
      return {
        status:
          error instanceof ValueGap && error.message === 'fixture_json_invalid'
            ? 'failed'
            : 'inconclusive',
        code: 'response_json',
      };
    }
  }
  if (test.inputValidity === 'invalid' && status >= 200 && status < 300)
    return { status: 'failed', code: 'invalid_input_accepted' };
  return {
    status: 'passed',
    code: authenticationRejection
      ? 'authentication_rejected'
      : status >= 400
        ? 'documented_rejection'
        : 'documented_response',
  };
}

/** Verify independently resolved execution authority before any credential or HTTP access.
 * Production callers still need an isolated supervisor, durable lease and whole-run reservation.
 */
export function validateApiExecutionContext(
  scope: ApiScope,
  binding: PreviewBinding,
  grant: z.infer<typeof grantSchema>,
  fixture = false,
): URL {
  const origin = new URL(grant.origin);
  if (origin.origin !== grant.origin || origin.pathname !== '/')
    throw new ApiGap('context_forbidden');
  validatePreviewUrl(origin, binding, fixture);
  if (
    new URL(binding.url).origin !== origin.origin ||
    grant.deploymentId !== binding.deploymentId ||
    Object.entries(scope).some(
      ([key, value]) => grant[key as keyof typeof scope] !== value,
    ) ||
    ['tenantId', 'repositoryId', 'pullRequestNumber', 'headSha'].some(
      (key) =>
        binding[key as keyof PreviewBinding] !== scope[key as keyof ApiScope],
    )
  )
    throw new ApiGap('context_forbidden');
  return origin;
}

export interface ApiExecutionInput {
  scope: ApiScope;
  binding: PreviewBinding;
  grant: ApiGrant;
  contractText: string;
  generation?: BoundaryOptions;
  limits?: z.input<typeof limitsSchema>;
}
export interface ApiExecutionOptions {
  isCurrent: () => Promise<boolean>;
  signal?: AbortSignal;
  fixture?: boolean;
  getBearerToken?: CredentialProvider;
  /** Caller attests this credential is invalid for the scoped target, not another user's token. */
  getInvalidBearerToken?: CredentialProvider;
}
type CredentialProvider = (
  scope: ApiScope,
  deploymentId: string,
  origin: string,
  scheme: string,
) => Promise<string | undefined>;
export function executeApiCases(
  input: ApiExecutionInput,
  options: ApiExecutionOptions,
) {
  return execute(input, options, false);
}
/** Baseline controls and negative authentication checks share one stage budget. */
export function executeApiAuthentication(
  input: ApiExecutionInput,
  options: ApiExecutionOptions,
) {
  return execute(input, options, true);
}
async function execute(
  input: ApiExecutionInput,
  options: ApiExecutionOptions,
  authentication: boolean,
): Promise<ApiExecution> {
  const scope = scopeSchema.parse(input.scope);
  const binding = previewBindingSchema.parse(input.binding);
  const grant = grantSchema.parse(input.grant);
  const limits = limitsSchema.parse(input.limits ?? {});
  // Capture immutable validated inputs before the first await.
  const context = {
    tenantId: scope.tenantId,
    repositoryId: scope.repositoryId,
    headSha: scope.headSha,
  };
  const contract = validateApiContract(context, input.contractText);
  const plan = generateBoundaryCases(
    context,
    input.contractText,
    authentication
      ? { ...input.generation, baselineOnly: true }
      : input.generation,
  );
  const output: ApiExecution = {
    ...scope,
    contractDigest: plan.contractDigest,
    seed: plan.seed,
    status: 'inconclusive',
    code: 'context_forbidden',
    requests: 0,
    requestBytes: 0,
    responseBytes: 0,
    results: [],
    coverageGaps: plan.coverageGaps,
  };
  const probeMetadata = new Map<
    string,
    { probe: AuthenticationProbe; baselineCaseId: string }
  >();
  const cases = authentication
    ? plan.cases.flatMap((baseline) => {
        const permission = grant.operations.find(
          (op) => `${op.method} ${op.path}` === baseline.operationKey,
        );
        const probes: AuthenticationProbe[] = permission?.authentication
          ?.invalidBearer
          ? ['control', 'missing', 'invalid_bearer']
          : ['control', 'missing'];
        return probes.map((probe) => {
          const id = createHash('sha256')
            .update(
              JSON.stringify({
                version: 1,
                baseline: baseline.id,
                scope,
                deploymentId: grant.deploymentId,
                origin: grant.origin,
                expectation: permission?.authentication,
                probe,
              }),
            )
            .digest('hex');
          probeMetadata.set(id, { probe, baselineCaseId: baseline.id });
          return { ...baseline, id };
        });
      })
    : plan.cases;
  const add = (
    test: BoundaryCase,
    status: ApiCaseResult['status'],
    code: string,
    httpStatus?: number,
  ) =>
    output.results.push({
      caseId: test.id,
      operationKey: test.operationKey,
      status,
      code,
      ...probeMetadata.get(test.id),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  const runtime = new ApiRuntime(limits, options, output);
  const { signal } = runtime;
  let stop: string | undefined;
  const blocked = new Set<string>();
  const controls = new Set<string>();
  const controlTokens = new Map<string, string>();
  try {
    const origin = validateApiExecutionContext(
      scope,
      binding,
      grant,
      options.fixture,
    );
    if (contract.status !== 'supported' || !plan.cases.length)
      throw new ApiGap('cases_unavailable');
    if (
      new Set(grant.operations.map((op) => `${op.method} ${op.path}`)).size !==
        grant.operations.length ||
      grant.operations.some(
        (op) =>
          !contract.operations.some(
            (declared) =>
              `${declared.method} ${declared.path}` ===
              `${op.method} ${op.path}`,
          ),
      )
    )
      throw new ApiGap('operation_forbidden');
    const current = () => runtime.current();
    for (const test of cases) {
      if (stop) {
        add(test, 'skipped', stop);
        continue;
      }
      const permission = grant.operations.find(
        (op) => `${op.method} ${op.path}` === test.operationKey,
      );
      if (
        !permission ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(test.method) &&
          (!permission.allowMutation || !grant.disposableData))
      ) {
        add(test, 'skipped', 'operation_forbidden');
        continue;
      }
      if (blocked.has(test.operationKey)) {
        add(
          test,
          'inconclusive',
          authentication
            ? 'authentication_control_unavailable'
            : 'credentials_unavailable',
        );
        continue;
      }
      const operation = contract.operations.find(
        (op) => `${op.method} ${op.path}` === test.operationKey,
      )!;
      const probe = probeMetadata.get(test.id)?.probe;
      const expectation = permission.authentication;
      if (authentication) {
        if (!expectation) {
          add(test, 'skipped', 'authentication_not_granted');
          continue;
        }
        const schemes = operation.security.map((alternative) =>
          Object.keys(alternative),
        );
        if (!schemes.length || schemes.some((names) => !names.length)) {
          add(test, 'skipped', 'authentication_not_required');
          continue;
        }
        if (
          schemes.some((names) => {
            const definition = contract.securitySchemes[names[0]!];
            return (
              names.length !== 1 ||
              definition?.type !== 'http' ||
              definition.scheme !== 'bearer'
            );
          }) ||
          new Set(schemes.flat()).size !== 1
        ) {
          add(test, 'inconclusive', 'authentication_scheme_unsupported');
          continue;
        }
        if (
          !Object.hasOwn(
            operation.responses,
            String(expectation.rejectionStatus),
          ) ||
          expectation.successStatuses.some(
            (status) => !Object.hasOwn(operation.responses, String(status)),
          )
        ) {
          add(test, 'inconclusive', 'authentication_expectation_undocumented');
          continue;
        }
        // Cookie/header/query parameters may themselves carry session authority unknown to the contract.
        if (
          test.request.parameters.some((parameter) => parameter.in !== 'path')
        ) {
          add(
            test,
            'inconclusive',
            'authentication_parameter_authority_unknown',
          );
          continue;
        }
        if (probe !== 'control' && !controls.has(test.operationKey)) {
          add(test, 'inconclusive', 'authentication_control_unavailable');
          continue;
        }
      }
      try {
        await current();
        let token: string | undefined;
        if (
          probe !== 'missing' &&
          operation.security.length &&
          !operation.security.some(
            (alternative) => !Object.keys(alternative).length,
          )
        ) {
          const scheme = operation.security.flatMap((alternative) => {
            const names = Object.keys(alternative);
            const definition = contract.securitySchemes[names[0]!];
            return names.length === 1 &&
              definition?.type === 'http' &&
              definition.scheme === 'bearer'
              ? names
              : [];
          })[0];
          const credentialProvider =
            probe === 'invalid_bearer'
              ? options.getInvalidBearerToken
              : options.getBearerToken;
          if (!scheme || !credentialProvider)
            throw new ApiGap(
              probe === 'invalid_bearer'
                ? 'invalid_credentials_unavailable'
                : 'credentials_unavailable',
            );
          token = await bounded(
            credentialProvider(
              scope,
              binding.deploymentId,
              origin.origin,
              scheme,
            ),
            AbortSignal.any([signal, AbortSignal.timeout(limits.maxRequestMs)]),
          );
          if (!token)
            throw new ApiGap(
              probe === 'invalid_bearer'
                ? 'invalid_credentials_unavailable'
                : 'credentials_unavailable',
            );
          if (
            probe === 'invalid_bearer' &&
            token === controlTokens.get(test.operationKey)
          )
            throw new ApiGap('invalid_credentials_unavailable');
          if (probe === 'control') controlTokens.set(test.operationKey, token);
        }
        const wire = serializeApiCase(test, operation, origin.origin, token);
        if (wire.bytes > limits.maxRequestBytes)
          throw new ApiGap('request_bytes');
        const response = await runtime.send(wire);
        let result = assessApiResponse(test, operation, response);
        if (authentication && expectation) {
          if (probe === 'control') {
            if (
              result.status === 'passed' &&
              expectation.successStatuses.includes(response.status)
            ) {
              controls.add(test.operationKey);
              result = {
                status: 'passed',
                code: 'authentication_control_passed',
              };
            } else {
              blocked.add(test.operationKey);
              result = {
                status: 'inconclusive',
                code: 'authentication_control_unavailable',
              };
            }
          } else if (response.status === expectation.rejectionStatus) {
            result = assessApiResponse(test, operation, response, true);
          } else if (response.status >= 200 && response.status < 300)
            result = { status: 'failed', code: 'authentication_accepted' };
          else if (response.status === 401 || response.status === 403)
            result = {
              status: 'failed',
              code: 'authentication_rejection_mismatch',
            };
          else if (response.status >= 500)
            result = { status: 'failed', code: 'server_error' };
          else if (
            !['redirect_forbidden', 'rate_limited'].includes(result.code)
          )
            result = {
              status: 'inconclusive',
              code: 'authentication_rejection_unproven',
            };
        }
        add(test, result.status, result.code, response.status);
        if (result.code === 'credentials_unavailable')
          blocked.add(test.operationKey);
        if (response.status >= 300 && response.status < 400)
          stop = 'redirect_forbidden';
        if (response.status === 429) stop = 'rate_limited';
      } catch (error) {
        const code = runtime.code(error);
        add(test, 'inconclusive', code);
        if (code === 'credentials_unavailable') blocked.add(test.operationKey);
        if (
          ![
            'credentials_unavailable',
            'invalid_credentials_unavailable',
            'parameter_unrepresentable',
            'body_unrepresentable',
            'header_forbidden',
            'path_forbidden',
            'request_bytes',
          ].includes(code)
        )
          stop = code;
      }
    }
    output.status =
      !stop &&
      output.results.every(
        (result) => result.status === 'passed' || result.status === 'failed',
      ) &&
      !output.coverageGaps.length
        ? 'completed'
        : 'inconclusive';
    output.code =
      stop ??
      (output.status === 'completed'
        ? 'cases_completed'
        : 'coverage_incomplete');
  } catch (error) {
    output.code =
      error instanceof ApiGap
        ? error.code
        : error instanceof ForbiddenPreviewError
          ? 'destination_forbidden'
          : 'context_unavailable';
  } finally {
    controlTokens.clear();
    runtime.close();
  }
  return output;
}
