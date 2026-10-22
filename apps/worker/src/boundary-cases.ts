/** Deterministic logical request plans only; execution authority stays with the caller. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateApiContract } from './openapi.js';
import type { ContractContext, ContractOperation } from './openapi.js';
import {
  sample,
  checkValue,
  mutate,
  stable,
  fixtureValue,
  ValueGap,
} from './boundary-values.js';
import type { JsonValue, Verdict, ValueMutation } from './boundary-values.js';
const method = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
]);
const selector = z.strictObject({ method, path: z.string().min(1).max(1024) });
const scalar = z.union([
  z.string().max(16384),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const optionsSchema = z.strictObject({
  baselineOnly: z.boolean().default(false),
  seed: z.number().int().min(0).max(4294967295).default(0),
  maxCases: z.number().int().min(1).max(200).default(100),
  maxCasesPerOperation: z.number().int().min(1).max(100).default(32),
  maxPayloadBytes: z.number().int().min(1).max(16384).default(4096),
  maxTotalPayloadBytes: z.number().int().min(1).max(1048576).default(262144),
  operationAllowlist: z.array(selector).max(200).optional(),
  priority: z
    .strictObject({
      tenantId: z.uuid(),
      repositoryId: z.number().int().positive().safe(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      operations: z.array(selector).max(200),
    })
    .optional(),
  fixtures: z
    .array(
      z.strictObject({
        ...selector.shape,
        bodyJson: z.string().max(16384).optional(),
        parameters: z
          .array(
            z.strictObject({
              in: z.enum(['path', 'query', 'header', 'cookie']),
              name: z.string().min(1).max(100),
              value: scalar,
            }),
          )
          .max(50)
          .default([]),
      }),
    )
    .max(200)
    .default([]),
});
export type BoundaryOptions = z.input<typeof optionsSchema>;
export interface LogicalRequest {
  parameters: {
    in: 'path' | 'query' | 'header' | 'cookie';
    name: string;
    value: JsonValue;
  }[];
  body:
    | { kind: 'absent' }
    | { kind: 'json'; value: JsonValue }
    | { kind: 'malformed_json'; text: string };
}
export interface BoundaryCase {
  id: string;
  operationKey: string;
  method: string;
  path: string;
  kind: string;
  location: string;
  inputValidity: 'valid' | 'invalid';
  payloadBytes: number;
  request: LogicalRequest;
}
export interface CoverageGap {
  code: string;
  operationKey?: string;
}
export interface BoundaryPlan extends ContractContext {
  version: 1;
  status: 'generated' | 'partial' | 'unavailable';
  contractDigest?: string;
  seed: number;
  executionAuthorized: false;
  cases: BoundaryCase[];
  coverageGaps: CoverageGap[];
  totalPayloadBytes: number;
}
const keyOf = (operation: { method: string; path: string }) =>
  `${operation.method} ${operation.path}`;
const paramKey = (parameter: { in: string; name: string }) =>
  `${parameter.in}:${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
function checkRequest(
  operation: ContractOperation,
  request: LogicalRequest,
): Verdict {
  if (request.body.kind === 'malformed_json') return 'invalid';
  const values: Verdict[] = [];
  for (const parameter of operation.parameters) {
    const supplied = request.parameters.find(
      (item) => paramKey(item) === paramKey(parameter),
    );
    values.push(
      supplied
        ? checkValue(parameter.schema, supplied.value)
        : parameter.required
          ? 'invalid'
          : 'valid',
    );
  }
  if (operation.requestBody)
    values.push(
      request.body.kind === 'absent'
        ? operation.requestBody.required
          ? 'invalid'
          : 'valid'
        : checkValue(operation.requestBody.schema, request.body.value),
    );
  return values.includes('invalid')
    ? 'invalid'
    : values.includes('unknown')
      ? 'unknown'
      : 'valid';
}
function edit(value: JsonValue, mutation: ValueMutation): JsonValue {
  if (!mutation.pointer.length) return mutation.value!;
  const result = fixtureValue(stable(value));
  let parent = result;
  for (const part of mutation.pointer.slice(0, -1))
    parent = (parent as Record<string | number, JsonValue>)[part];
  const last = mutation.pointer.at(-1)!;
  if (mutation.remove)
    delete (parent as Record<string | number, JsonValue>)[last];
  else (parent as Record<string | number, JsonValue>)[last] = mutation.value!;
  return result;
}
const pointer = (parts: (string | number)[]) =>
  (parts.length ? '/' : '') +
  parts
    .map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/');
interface Candidate {
  kind: string;
  location: string;
  request: LogicalRequest;
}
function* variations(
  operation: ContractOperation,
  baseline: LogicalRequest,
  maxSize: number,
  gap: (code: string) => void,
): Generator<Candidate> {
  if (operation.requestBody && baseline.body.kind === 'json') {
    yield {
      kind: 'missing_body',
      location: 'body',
      request: { ...baseline, body: { kind: 'absent' } },
    };
    yield {
      kind: 'malformed_json',
      location: 'body',
      request: {
        ...baseline,
        body: { kind: 'malformed_json', text: '{"dogwatch":' },
      },
    };
    for (const mutation of mutate(
      operation.requestBody.schema,
      baseline.body.value,
      maxSize,
      gap,
    )) {
      const location = 'body' + pointer(mutation.pointer);
      if (location.length > 1024) {
        gap('mutation_location_budget');
        continue;
      }
      yield {
        kind: mutation.kind,
        location,
        request: {
          ...baseline,
          body: { kind: 'json', value: edit(baseline.body.value, mutation) },
        },
      };
    }
  }
  for (const parameter of operation.parameters) {
    const index = baseline.parameters.findIndex(
      (item) => paramKey(item) === paramKey(parameter),
    );
    const location = paramKey(parameter);
    yield {
      kind: 'missing_parameter',
      location,
      request: {
        ...baseline,
        parameters: baseline.parameters.filter((_, item) => item !== index),
      },
    };
    for (const mutation of mutate(
      parameter.schema,
      baseline.parameters[index].value,
      maxSize,
      gap,
    )) {
      yield {
        kind: mutation.kind,
        location,
        request: {
          ...baseline,
          parameters: baseline.parameters.map((item, offset) =>
            offset === index ? { ...item, value: mutation.value! } : item,
          ),
        },
      };
    }
  }
}
function credentialOverlap(
  operation: ContractOperation,
  schemes: ReturnType<typeof validateApiContract>['securitySchemes'],
) {
  return operation.security.some((requirement) =>
    Object.keys(requirement).some((name) => {
      const scheme = schemes[name];
      return (
        scheme.type === 'apiKey' &&
        operation.parameters.some(
          (parameter) =>
            paramKey(parameter) ===
            paramKey({ in: scheme.in, name: scheme.name }),
        )
      );
    }),
  );
}
export function generateBoundaryCases(
  context: ContractContext,
  text: string,
  optionsInput: BoundaryOptions = {},
): BoundaryPlan {
  const options = optionsSchema.parse(optionsInput);
  const contract = validateApiContract(context, text);
  const output: BoundaryPlan = {
    version: 1,
    tenantId: contract.tenantId,
    repositoryId: contract.repositoryId,
    headSha: contract.headSha,
    contractDigest: contract.contractDigest,
    seed: options.seed,
    executionAuthorized: false,
    status: 'unavailable',
    cases: [],
    coverageGaps: [],
    totalPayloadBytes: 0,
  };
  const gapKeys = new Set<string>();
  function gap(code: string, operationKey?: string) {
    const key = code + ':' + (operationKey ?? '');
    if (!gapKeys.has(key) && output.coverageGaps.length < 100) {
      gapKeys.add(key);
      output.coverageGaps.push({
        code,
        ...(operationKey ? { operationKey } : {}),
      });
    }
  }
  if (contract.status !== 'supported') {
    gap('contract_' + contract.status);
    for (const item of contract.diagnostics) gap(item.code);
    return output;
  }
  if (
    options.priority &&
    (options.priority.tenantId !== context.tenantId ||
      options.priority.repositoryId !== context.repositoryId ||
      options.priority.headSha !== context.headSha)
  )
    throw new Error('boundary_priority_scope_mismatch');
  const known = new Set(contract.operations.map(keyOf));
  const fixtures = new Map<string, (typeof options.fixtures)[number]>();
  for (const fixture of options.fixtures) {
    const key = keyOf(fixture);
    if (!known.has(key) || fixtures.has(key))
      throw new Error('boundary_fixture_identity');
    fixtures.set(key, fixture);
  }
  const allowed =
    options.operationAllowlist &&
    new Set(options.operationAllowlist.map(keyOf));
  const priority = new Set(options.priority?.operations.map(keyOf));
  for (const key of [...(allowed ?? []), ...priority])
    if (!known.has(key)) throw new Error('boundary_unknown_operation');
  const operations = contract.operations
    .filter((operation) => !allowed || allowed.has(keyOf(operation)))
    .sort(
      (a, b) =>
        Number(priority.has(keyOf(b))) - Number(priority.has(keyOf(a))) ||
        (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0),
    );
  if (!operations.length) {
    gap('no_selected_operations');
    return output;
  }
  const seen = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  const queues: {
    operation: ContractOperation;
    iterator: Generator<Candidate>;
    done: boolean;
  }[] = [];
  let work = 0;
  function add(operation: ContractOperation, candidate: Candidate) {
    const key = keyOf(operation);
    if (++work > 2000) {
      gap('candidate_work_budget');
      return false;
    }
    if (output.cases.length >= options.maxCases) {
      gap('case_budget');
      return false;
    }
    if ((counts.get(key) ?? 0) >= options.maxCasesPerOperation) {
      gap('operation_case_budget', key);
      return false;
    }
    const payload = stable(candidate.request),
      bytes = Buffer.byteLength(payload);
    if (bytes > options.maxPayloadBytes) {
      gap('case_payload_budget', key);
      return false;
    }
    if (output.totalPayloadBytes + bytes > options.maxTotalPayloadBytes) {
      gap('total_payload_budget');
      return false;
    }
    const hashes = seen.get(key) ?? new Set<string>();
    const hash = createHash('sha256').update(payload).digest('hex');
    if (hashes.has(hash)) return false;
    const inputValidity = checkRequest(operation, candidate.request);
    if (inputValidity === 'unknown') {
      gap('schema_semantics_unmodeled', key);
      return false;
    }
    hashes.add(hash);
    seen.set(key, hashes);
    const id = createHash('sha256')
      .update(
        stable({
          version: 1,
          tenantId: context.tenantId,
          repositoryId: context.repositoryId,
          headSha: context.headSha,
          contractDigest: contract.contractDigest,
          seed: options.seed,
          operationKey: key,
          payload,
        }),
      )
      .digest('hex');
    output.cases.push({
      id,
      operationKey: key,
      method: operation.method,
      path: operation.path,
      kind: candidate.kind,
      location: candidate.location,
      inputValidity,
      payloadBytes: bytes,
      request: JSON.parse(payload) as LogicalRequest,
    });
    output.totalPayloadBytes += bytes;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return true;
  }
  for (const operation of operations) {
    const key = keyOf(operation);
    if (output.cases.length >= options.maxCases) {
      gap('case_budget');
      break;
    }
    if (credentialOverlap(operation, contract.securitySchemes)) {
      gap('credential_parameter_overlap', key);
      continue;
    }
    try {
      const fixture = fixtures.get(key);
      const supplied = new Map<
        string,
        NonNullable<typeof fixture>['parameters'][number]
      >();
      for (const parameter of fixture?.parameters ?? []) {
        const name = paramKey(parameter);
        if (
          supplied.has(name) ||
          !operation.parameters.some((item) => paramKey(item) === name)
        )
          throw new ValueGap('fixture_parameter_identity');
        supplied.set(name, parameter);
      }
      if (fixture?.bodyJson !== undefined && !operation.requestBody)
        throw new ValueGap('fixture_body_undeclared');
      const baseline: LogicalRequest = {
        parameters: operation.parameters.map((parameter) => ({
          in: parameter.in,
          name: parameter.name,
          value: supplied.has(paramKey(parameter))
            ? supplied.get(paramKey(parameter))!.value
            : sample(
                parameter.schema,
                `${options.seed}/${key}/${paramKey(parameter)}`,
                options.maxPayloadBytes,
              ),
        })),
        body: operation.requestBody
          ? {
              kind: 'json',
              value:
                fixture?.bodyJson !== undefined
                  ? fixtureValue(fixture.bodyJson)
                  : sample(
                      operation.requestBody.schema,
                      `${options.seed}/${key}/body`,
                      options.maxPayloadBytes,
                    ),
            }
          : { kind: 'absent' },
      };
      const validity = checkRequest(operation, baseline);
      if (validity !== 'valid') {
        gap(
          validity === 'unknown'
            ? 'baseline_semantics_unmodeled'
            : 'baseline_not_schema_valid',
          key,
        );
        continue;
      }
      if (
        add(operation, {
          kind: 'baseline',
          location: 'request',
          request: baseline,
        })
      )
        queues.push({
          operation,
          iterator: variations(
            operation,
            baseline,
            options.maxPayloadBytes,
            (code) => gap(code, key),
          ),
          done: false,
        });
    } catch (error) {
      gap(
        error instanceof ValueGap ? error.message : 'baseline_unavailable',
        key,
      );
    }
  }
  while (!options.baselineOnly && queues.some((queue) => !queue.done)) {
    if (output.cases.length >= options.maxCases) {
      gap('case_budget');
      break;
    }
    if (work >= 2000) {
      gap('candidate_work_budget');
      break;
    }
    if (output.totalPayloadBytes >= options.maxTotalPayloadBytes) {
      gap('total_payload_budget');
      break;
    }
    for (const queue of queues) {
      if (queue.done) continue;
      if (
        (counts.get(keyOf(queue.operation)) ?? 0) >=
        options.maxCasesPerOperation
      ) {
        gap('operation_case_budget', keyOf(queue.operation));
        queue.done = true;
        continue;
      }
      if (output.cases.length >= options.maxCases || work >= 2000) break;
      try {
        const next = queue.iterator.next();
        if (next.done) queue.done = true;
        else add(queue.operation, next.value);
      } catch {
        gap('mutation_unavailable', keyOf(queue.operation));
        queue.done = true;
      }
    }
  }
  output.status = output.cases.length
    ? output.coverageGaps.length
      ? 'partial'
      : 'generated'
    : 'unavailable';
  return output;
}
