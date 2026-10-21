/** Explicit OpenAPI 3.0 testing profile. Never resolve files, URLs or code. */
export class ContractProblem extends Error {
  constructor(
    readonly status: 'invalid' | 'unsupported',
    readonly code: string,
  ) {
    super(code);
  }
}
export function invalid(code: string): never {
  throw new ContractProblem('invalid', code);
}
export function unsupported(code: string): never {
  throw new ContractProblem('unsupported', code);
}
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('contract_object_required');
  return value as ObjectValue;
}
export interface ContractSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  nullable: boolean;
  enum?: (string | number | boolean | null)[];
  properties?: Record<string, ContractSchema>;
  required?: string[];
  additionalProperties?: boolean | ContractSchema;
  items?: ContractSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}
export interface ContractParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  style: 'form' | 'simple';
  explode: boolean;
  schema: ContractSchema;
}
export type ContractSecurityScheme =
  | { type: 'http'; scheme: 'bearer' | 'basic' }
  | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string };
export type ContractSecurity = Record<string, string[]>[];
export interface ContractOperation {
  path: string;
  method: string;
  operationId?: string;
  parameters: ContractParameter[];
  security: ContractSecurity;
  requestBody?: { required: boolean; schema: ContractSchema };
  responses: Record<string, { schema?: ContractSchema }>;
}
const has = (value: object, key: string) => Object.hasOwn(value, key);
const token = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const methods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
];
const parameterKey = (parameter: { in: unknown; name: unknown }) =>
  `${parameter.in}:${parameter.in === 'header' ? String(parameter.name).toLowerCase() : parameter.name}`;
const annotationKeys = new Set([
  'title',
  'description',
  'default',
  'example',
  'deprecated',
  'externalDocs',
]);
export function normalizeContract(document: ObjectValue) {
  const components = document.components ? object(document.components) : {};
  let expansions = 0;
  let schemaBytes = 0;
  let operationBytes = 0;
  for (const [category, entries] of Object.entries(components)) {
    if (category.startsWith('x-')) continue;
    for (const name of Object.keys(object(entries))) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) invalid('contract_component_name');
      if (name.length > 100) unsupported('contract_component_name_budget');
    }
    if (Object.keys(object(entries)).length > 200)
      unsupported('contract_component_budget');
    if (
      ['callbacks', 'links', 'headers'].includes(category) &&
      Object.keys(object(entries)).length
    )
      unsupported('contract_component_kind');
  }
  function resolve(
    value: unknown,
    category: string,
    ancestors = new Set<string>(),
  ) {
    let node = object(value);
    const trail = new Set(ancestors);
    while (has(node, '$ref')) {
      if (++expansions > 5000) unsupported('contract_expansion_budget');
      const ref = node.$ref;
      if (typeof ref !== 'string' || ref.length > 2048)
        invalid('contract_reference_invalid');
      if (Object.keys(node).length !== 1)
        unsupported('contract_reference_siblings');
      if (!ref.startsWith('#/')) unsupported('contract_external_reference');
      const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
      if (!match || match[1] !== category || /~(?![01])/.test(match[2]))
        invalid('contract_reference_target');
      if (match[2].includes('%')) unsupported('contract_encoded_reference');
      if (trail.has(ref)) unsupported('contract_recursive_reference');
      if (trail.size >= 20) unsupported('contract_reference_depth');
      trail.add(ref);
      const entries = components[category] ? object(components[category]) : {};
      const name = match[2].replace(/~1/g, '/').replace(/~0/g, '~');
      if (!has(entries, name)) invalid('contract_reference_missing');
      node = object(entries[name]);
    }
    return { node, trail };
  }
  function schema(
    value: unknown,
    ancestors = new Set<string>(),
    depth = 0,
  ): ContractSchema {
    if (++expansions > 5000 || depth > 20)
      unsupported('contract_schema_budget');
    const { node, trail } = resolve(value, 'schemas', ancestors);
    const type = node.type;
    if (
      !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(
        String(type),
      )
    )
      unsupported('contract_schema_type');
    const known = new Set([
      'type',
      'nullable',
      'enum',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'uniqueItems',
      'minProperties',
      'maxProperties',
      'readOnly',
      'writeOnly',
    ]);
    for (const key of Object.keys(node))
      if (!known.has(key) && !annotationKeys.has(key) && !key.startsWith('x-'))
        unsupported('contract_schema_keyword');
    if (node.readOnly || node.writeOnly)
      unsupported('contract_directional_schema');
    const result: ContractSchema = {
      type: type as ContractSchema['type'],
      nullable: node.nullable === true,
    };
    const keywordTypes: Record<string, string[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      minProperties: ['object'],
      maxProperties: ['object'],
      items: ['array'],
      minItems: ['array'],
      maxItems: ['array'],
      uniqueItems: ['array'],
      minLength: ['string'],
      maxLength: ['string'],
      pattern: ['string'],
      minimum: ['number', 'integer'],
      maximum: ['number', 'integer'],
      exclusiveMinimum: ['number', 'integer'],
      exclusiveMaximum: ['number', 'integer'],
      multipleOf: ['number', 'integer'],
    };
    for (const [key, types] of Object.entries(keywordTypes))
      if (has(node, key) && !types.includes(String(type)))
        unsupported('contract_schema_keyword_type');
    if (type === 'object') {
      const properties = node.properties ? object(node.properties) : {};
      if (Object.keys(properties).length > 100)
        unsupported('contract_property_budget');
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([name, child]) => [
          name,
          schema(child, trail, depth + 1),
        ]),
      );
      result.required = (node.required ?? []) as string[];
      if (result.required.some((name) => !has(properties, name)))
        unsupported('contract_unmodeled_required_property');
      result.additionalProperties =
        typeof node.additionalProperties === 'object'
          ? schema(node.additionalProperties, trail, depth + 1)
          : node.additionalProperties !== false;
    }
    if (type === 'array') {
      if (!node.items) invalid('contract_array_items_missing');
      result.items = schema(node.items, trail, depth + 1);
    }
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'uniqueItems',
      'minProperties',
      'maxProperties',
    ] as const) {
      if (has(node, key)) Object.assign(result, { [key]: node[key] });
    }
    for (const [min, max] of [
      ['minimum', 'maximum'],
      ['minLength', 'maxLength'],
      ['minItems', 'maxItems'],
      ['minProperties', 'maxProperties'],
    ] as const)
      if (
        typeof node[min] === 'number' &&
        typeof node[max] === 'number' &&
        node[min] > node[max]
      )
        invalid('contract_contradictory_bounds');
    if (
      (node.exclusiveMinimum && !has(node, 'minimum')) ||
      (node.exclusiveMaximum && !has(node, 'maximum'))
    )
      invalid('contract_exclusive_bound_missing');
    if (
      node.minimum === node.maximum &&
      typeof node.minimum === 'number' &&
      (node.exclusiveMinimum || node.exclusiveMaximum)
    )
      invalid('contract_contradictory_bounds');
    if (node.pattern !== undefined) {
      if ((node.pattern as string).length > 256)
        unsupported('contract_pattern_budget');
      // Syntax check only: never match attacker-selected regexes against data here.
      try {
        new RegExp(node.pattern as string);
      } catch {
        invalid('contract_pattern_invalid');
      }
    }
    if (node.enum) {
      const values = node.enum as unknown[];
      if (values.length > 100) unsupported('contract_enum_budget');
      if (values.some((item) => item !== null && typeof item === 'object'))
        unsupported('contract_complex_enum');
      const matches = (item: unknown) =>
        item === null
          ? result.nullable
          : type === 'integer'
            ? typeof item === 'number' && Number.isInteger(item)
            : typeof item === type;
      if (values.some((item) => !matches(item)))
        unsupported('contract_enum_type');
      result.enum = values as ContractSchema['enum'];
    }
    const {
      properties,
      items: _items,
      additionalProperties: _additional,
      ...scalar
    } = result;
    void _items;
    void _additional;
    schemaBytes +=
      Buffer.byteLength(JSON.stringify(scalar)) +
      Buffer.byteLength(JSON.stringify(Object.keys(properties ?? {})));
    if (schemaBytes > 1048576) unsupported('contract_normalized_budget');
    return result;
  }
  // Validate all declared schemas, including currently unreferenced definitions.
  for (const value of Object.values(
    components.schemas ? object(components.schemas) : {},
  ))
    schema(value);
  const securitySchemes: Record<string, ContractSecurityScheme> = {};
  for (const [name, value] of Object.entries(
    components.securitySchemes ? object(components.securitySchemes) : {},
  )) {
    if (!token(name)) unsupported('contract_security_name');
    const { node } = resolve(value, 'securitySchemes');
    if (
      node.type === 'http' &&
      (node.scheme === 'bearer' || node.scheme === 'basic')
    )
      securitySchemes[name] = { type: 'http', scheme: node.scheme };
    else if (
      node.type === 'apiKey' &&
      ['header', 'query', 'cookie'].includes(String(node.in)) &&
      typeof node.name === 'string' &&
      /^[a-zA-Z0-9_.-]{1,100}$/.test(node.name)
    )
      securitySchemes[name] = {
        type: 'apiKey',
        in: node.in as 'header' | 'query' | 'cookie',
        name: node.name,
      };
    else unsupported('contract_security_scheme');
  }
  function security(value: unknown): ContractSecurity {
    if (value === undefined) return [];
    const requirements = value as Record<string, string[]>[];
    return requirements.map((requirement) =>
      Object.fromEntries(
        Object.entries(requirement).map(([name, scopes]) => {
          if (!has(securitySchemes, name))
            invalid('contract_security_undefined');
          if (scopes.length) invalid('contract_security_scopes');
          return [name, []];
        }),
      ),
    );
  }
  const inheritedSecurity = security(document.security);
  function parameters(value: unknown): ContractParameter[] {
    if (value === undefined) return [];
    if ((value as unknown[]).length > 50)
      unsupported('contract_parameter_budget');
    const seen = new Set<string>();
    return (value as unknown[]).map((item) => {
      const { node } = resolve(item, 'parameters');
      if (
        typeof node.name !== 'string' ||
        !token(node.name) ||
        !['path', 'query', 'header', 'cookie'].includes(String(node.in))
      )
        unsupported('contract_parameter_name');
      if (
        node.in === 'header' &&
        ['accept', 'content-type', 'authorization'].includes(
          String(node.name).toLowerCase(),
        )
      )
        unsupported('contract_ignored_header_parameter');
      const key = parameterKey({ in: node.in, name: node.name });
      if (seen.has(key)) invalid('contract_parameter_duplicate');
      seen.add(key);
      if (!node.schema || node.content)
        unsupported('contract_parameter_content');
      const normalized = schema(node.schema);
      if (normalized.type === 'array' || normalized.type === 'object')
        unsupported('contract_parameter_structure');
      const style =
        node.in === 'path' || node.in === 'header' ? 'simple' : 'form';
      if (
        (node.style && node.style !== style) ||
        node.allowReserved ||
        node.allowEmptyValue
      )
        unsupported('contract_parameter_serialization');
      if (node.in === 'path' && node.required !== true)
        invalid('contract_path_parameter_required');
      return {
        name: node.name as string,
        in: node.in as ContractParameter['in'],
        required: node.required === true,
        style,
        explode:
          typeof node.explode === 'boolean' ? node.explode : style === 'form',
        schema: normalized,
      };
    });
  }
  function jsonContent(value: unknown): ContractSchema {
    const content = object(value);
    if (Object.keys(content).length !== 1 || !has(content, 'application/json'))
      unsupported('contract_media_type');
    const media = object(content['application/json']);
    if (!media.schema || media.encoding) unsupported('contract_media_schema');
    return schema(media.schema);
  }
  function response(value: unknown) {
    const { node } = resolve(value, 'responses');
    if (node.links || node.headers) unsupported('contract_response_metadata');
    return node.content ? { schema: jsonContent(node.content) } : {};
  }
  // Unused declarations still must satisfy the profile; none may hide remote refs.
  for (const value of Object.values(
    components.parameters ? object(components.parameters) : {},
  ))
    parameters([value]);
  for (const value of Object.values(
    components.requestBodies ? object(components.requestBodies) : {},
  )) {
    const { node } = resolve(value, 'requestBodies');
    jsonContent(node.content);
  }
  for (const value of Object.values(
    components.responses ? object(components.responses) : {},
  ))
    response(value);
  const operations: ContractOperation[] = [];
  const operationIds = new Set<string>();
  const paths = object(document.paths);
  if (Object.keys(paths).length > 100) unsupported('contract_path_budget');
  const templates = new Set<string>();
  for (const [path, value] of Object.entries(paths)) {
    if (path.startsWith('x-')) continue;
    if (
      path.length > 1024 ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[?#\\\s%]/.test(path) ||
      [...path].some((c) => c.charCodeAt(0) < 32) ||
      path.split('/').some((part) => part === '.' || part === '..')
    )
      unsupported('contract_path');
    const names = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (
      path.replace(/\{[^{}]+\}/g, '').match(/[{}]/) ||
      names.some((name) => !token(name)) ||
      new Set(names).size !== names.length
    )
      invalid('contract_path_template');
    const template = path.replace(/\{[^{}]+\}/g, '{}');
    if (templates.has(template)) invalid('contract_path_ambiguous');
    templates.add(template);
    const item = object(value);
    if (has(item, '$ref')) unsupported('contract_path_reference');
    const inherited = parameters(item.parameters);
    for (const method of methods) {
      if (!has(item, method)) continue;
      if (operations.length >= 200) unsupported('contract_operation_budget');
      const operation = object(item[method]);
      if (operation.callbacks) unsupported('contract_callbacks');
      const operationId = operation.operationId as string | undefined;
      if (operationId !== undefined) {
        if (!token(operationId)) unsupported('contract_operation_id');
        if (operationIds.has(operationId))
          invalid('contract_operation_duplicate');
        operationIds.add(operationId);
      }
      const overrides = parameters(operation.parameters);
      const combined = new Map(
        inherited.map((parameter) => [parameterKey(parameter), parameter]),
      );
      for (const parameter of overrides)
        combined.set(parameterKey(parameter), parameter);
      const effective = [...combined.values()];
      if (
        names.some(
          (name) =>
            !effective.some(
              (parameter) => parameter.in === 'path' && parameter.name === name,
            ),
        ) ||
        effective.some(
          (parameter) =>
            parameter.in === 'path' && !names.includes(parameter.name),
        )
      )
        invalid('contract_path_parameter_mismatch');
      const responses: ContractOperation['responses'] = {};
      for (const [status, value] of Object.entries(
        object(operation.responses),
      )) {
        if (status.startsWith('x-')) continue;
        if (!/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/.test(status))
          invalid('contract_response_status');
        responses[status] = response(value);
      }
      if (!Object.keys(responses).length) invalid('contract_responses_missing');
      const normalized: ContractOperation = {
        path,
        method: method.toUpperCase(),
        ...(operationId ? { operationId } : {}),
        parameters: effective,
        security: has(operation, 'security')
          ? security(operation.security)
          : inheritedSecurity,
        responses,
      };
      if (operation.requestBody) {
        const { node } = resolve(operation.requestBody, 'requestBodies');
        normalized.requestBody = {
          required: node.required === true,
          schema: jsonContent(node.content),
        };
      }
      operationBytes += Buffer.byteLength(JSON.stringify(normalized));
      if (operationBytes > 1048576) unsupported('contract_normalized_budget');
      operations.push(normalized);
    }
  }
  if (!operations.length) unsupported('contract_operations_missing');
  return { operations, securitySchemes };
}
