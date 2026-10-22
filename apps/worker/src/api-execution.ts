/** Callable API stage. No consumer, credential minting, publication or source execution. */
import { z } from 'zod';
import { setTimeout as pause } from 'node:timers/promises';
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
import { ApiGap, serializeApiCase, sendApiRequest } from './api-transport.js';
import type { ApiResponse } from './api-transport.js';

const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type ApiScope = z.infer<typeof scopeSchema>;
const grantSchema = scopeSchema.extend({
  deploymentId: z.string().min(1).max(200),
  origin: z.string().url().max(2048),
  disposableData: z.boolean().default(false),
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
      }),
    )
    .max(200),
});
export type ApiGrant = z.input<typeof grantSchema>;
const limitsSchema = z.strictObject({
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
export interface ApiCaseResult {
  caseId: string;
  operationKey: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'skipped';
  code: string;
  httpStatus?: number;
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
/** Bound even a trusted callback which ignores cancellation. */
async function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function assess(
  test: BoundaryCase,
  operation: ContractOperation,
  response: ApiResponse,
): Pick<ApiCaseResult, 'status' | 'code'> {
  const status = response.status;
  if (status >= 300 && status < 400)
    return { status: 'inconclusive', code: 'redirect_forbidden' };
  if (status === 401 || status === 403)
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
    code: status >= 400 ? 'documented_rejection' : 'documented_response',
  };
}

/**
 * grant/binding/callbacks are independently resolved operator authority, never contract data.
 * Production callers still need an isolated supervisor, durable lease and whole-run reservation.
 */
export async function executeApiCases(
  input: {
    scope: ApiScope;
    binding: PreviewBinding;
    grant: ApiGrant;
    contractText: string;
    generation?: BoundaryOptions;
    limits?: z.input<typeof limitsSchema>;
  },
  options: {
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
    fixture?: boolean;
    getBearerToken?: (
      scope: ApiScope,
      deploymentId: string,
      origin: string,
      scheme: string,
    ) => Promise<string | undefined>;
  },
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
    input.generation,
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
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.maxExecutionMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let stop: string | undefined;
  let lastStart = -Infinity;
  const blocked = new Set<string>();
  try {
    const origin = new URL(grant.origin);
    if (origin.origin !== grant.origin || origin.pathname !== '/')
      throw new ApiGap('context_forbidden');
    validatePreviewUrl(origin, binding, options.fixture);
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
    const current = async () => {
      signal.throwIfAborted();
      let allowed: boolean;
      try {
        allowed = await bounded(options.isCurrent(), signal);
      } catch {
        throw new ApiGap('context_unavailable');
      }
      if (!allowed) throw new ApiGap('stopped');
      signal.throwIfAborted();
    };
    for (const test of plan.cases) {
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
        add(test, 'inconclusive', 'credentials_unavailable');
        continue;
      }
      const operation = contract.operations.find(
        (op) => `${op.method} ${op.path}` === test.operationKey,
      )!;
      try {
        await current();
        let token: string | undefined;
        if (
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
          if (!scheme || !options.getBearerToken)
            throw new ApiGap('credentials_unavailable');
          token = await bounded(
            options.getBearerToken(
              scope,
              binding.deploymentId,
              origin.origin,
              scheme,
            ),
            AbortSignal.any([signal, AbortSignal.timeout(limits.maxRequestMs)]),
          );
          if (!token) throw new ApiGap('credentials_unavailable');
        }
        const wire = serializeApiCase(test, operation, origin.origin, token);
        if (wire.bytes > limits.maxRequestBytes)
          throw new ApiGap('request_bytes');
        for (let retry = 0; ; retry++) {
          const delay = limits.minIntervalMs - (performance.now() - lastStart);
          if (delay > 0) await pause(delay, undefined, { signal });
          await current();
          if (output.requests >= limits.maxRequests)
            throw new ApiGap('request_budget');
          if (output.requestBytes + wire.bytes > limits.maxTotalRequestBytes)
            throw new ApiGap('total_request_bytes');
          if (output.responseBytes >= limits.maxTotalResponseBytes)
            throw new ApiGap('total_response_bytes');
          output.requests++;
          output.requestBytes += wire.bytes;
          lastStart = performance.now();
          let response: ApiResponse;
          try {
            response = await sendApiRequest(
              wire,
              AbortSignal.any([
                signal,
                AbortSignal.timeout(limits.maxRequestMs),
              ]),
              Math.min(
                limits.maxResponseBytes,
                limits.maxTotalResponseBytes - output.responseBytes,
              ),
              (bytes) => {
                output.responseBytes += bytes;
              },
              options.fixture,
            );
          } catch (error) {
            if (
              !signal.aborted &&
              !(error instanceof ApiGap) &&
              !(error instanceof ForbiddenPreviewError) &&
              ['GET', 'HEAD', 'OPTIONS'].includes(test.method) &&
              retry < limits.maxRetries
            )
              continue;
            throw error;
          } finally {
            // Conservative spacing after completion also bounds starts when DNS is slow.
            lastStart = performance.now();
          }
          await current();
          const result = assess(test, operation, response);
          add(test, result.status, result.code, response.status);
          if (result.code === 'credentials_unavailable')
            blocked.add(test.operationKey);
          if (['redirect_forbidden', 'rate_limited'].includes(result.code))
            stop = result.code;
          break;
        }
      } catch (error) {
        const code = signal.aborted
          ? options.signal?.aborted
            ? 'stopped'
            : 'execution_timeout'
          : error instanceof ApiGap
            ? error.code
            : error instanceof ForbiddenPreviewError
              ? 'destination_forbidden'
              : 'transport_unavailable';
        add(test, 'inconclusive', code);
        if (code === 'credentials_unavailable') blocked.add(test.operationKey);
        if (
          ![
            'credentials_unavailable',
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
    clearTimeout(timer);
  }
  return output;
}
