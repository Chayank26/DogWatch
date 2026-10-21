/** Bounded JSON/YAML OpenAPI ingestion. No untrusted schema is compiled or fetched. */
import { createHash } from 'node:crypto';
import { parseDocument, isAlias, isMap, isSeq, isScalar } from 'yaml';
import AjvDraft04Module from 'ajv-draft-04';
import { openapiV3 } from '@apidevtools/openapi-schemas';
import { z } from 'zod';
import {
  ContractProblem,
  invalid,
  unsupported,
  object,
  normalizeContract,
} from './openapi-profile.js';
import type {
  ContractOperation,
  ContractSecurityScheme,
} from './openapi-profile.js';
export type {
  ContractOperation,
  ContractParameter,
  ContractSchema,
  ContractSecurity,
  ContractSecurityScheme,
} from './openapi-profile.js';
const contextSchema = z.strictObject({
  tenantId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type ContractContext = z.infer<typeof contextSchema>;
export interface ContractValidation extends ContractContext {
  status: 'supported' | 'invalid' | 'unsupported' | 'unavailable';
  contractDigest?: string;
  operations: ContractOperation[];
  securitySchemes: Record<string, ContractSecurityScheme>;
  diagnostics: { code: string }[];
}
// Compile only the bundled, trusted OpenAPI *document* schema. Customer Schema
// Objects remain data; no resolver, compileAsync, loadSchema or custom formats run.
// The CommonJS package exposes its constructor through its .default property.
const validator = new AjvDraft04Module.default({
  strict: false,
  allErrors: false,
  validateFormats: false,
  ownProperties: true,
  logger: false,
}).compile(openapiV3);
function parse(text: string): unknown {
  let document;
  try {
    document = parseDocument(text, {
      strict: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch {
    return invalid('contract_syntax');
  }
  if (document.errors.length || document.warnings.length)
    invalid('contract_syntax');
  if (document.directives?.yaml.version !== '1.2')
    unsupported('contract_yaml_version');
  const pending: { node: unknown; depth: number }[] = [
    { node: document.contents, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++nodes > 10000 || depth > 40) unsupported('contract_document_budget');
    if (isAlias(node)) unsupported('contract_yaml_alias');
    if (
      node &&
      typeof node === 'object' &&
      (('anchor' in node && node.anchor) || ('tag' in node && node.tag))
    )
      unsupported('contract_yaml_tag_or_anchor');
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
          invalid('contract_non_string_key');
        if (
          ['__proto__', 'prototype', 'constructor', '<<'].includes(
            pair.key.value,
          )
        )
          unsupported('contract_unsafe_key');
        pending.push(
          { node: pair.key, depth: depth + 1 },
          { node: pair.value, depth: depth + 1 },
        );
      }
    } else if (isSeq(node))
      for (const child of node.items)
        pending.push({ node: child, depth: depth + 1 });
    else if (isScalar(node)) {
      if (typeof node.value === 'string' && node.value.length > 32768)
        unsupported('contract_scalar_budget');
      if (
        typeof node.value === 'number' &&
        (!Number.isFinite(node.value) ||
          (Number.isInteger(node.value) && !Number.isSafeInteger(node.value)))
      )
        unsupported('contract_number_budget');
    }
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    return invalid('contract_syntax');
  }
}

/** Context must come from an authorized immutable run; the text grants no access. */
export function validateApiContract(
  contextInput: ContractContext,
  text: string,
): ContractValidation {
  const context = contextSchema.parse(contextInput);
  let contractDigest: string | undefined;
  try {
    if (typeof text !== 'string') invalid('contract_text_required');
    if (Buffer.byteLength(text) > 262144) unsupported('contract_byte_budget');
    if (!text.trim()) invalid('contract_text_required');
    contractDigest = createHash('sha256').update(text).digest('hex');
    const document = object(parse(text));
    if (
      typeof document.openapi !== 'string' ||
      !/^3\.0\.[0-4]$/.test(document.openapi)
    )
      unsupported('contract_openapi_version');
    if (!validator(document)) invalid('contract_structure');
    const normalized = normalizeContract(document);
    return {
      ...context,
      contractDigest,
      status: 'supported',
      ...normalized,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ...context,
      contractDigest,
      status: error instanceof ContractProblem ? error.status : 'unavailable',
      operations: [],
      securitySchemes: {},
      diagnostics: [
        {
          code:
            error instanceof ContractProblem
              ? error.code
              : 'contract_processing_unavailable',
        },
      ],
    };
  }
}
