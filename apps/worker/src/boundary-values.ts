/** Small bounded value model; never compile customer schemas or execute their regexes. */
import { createHash } from 'node:crypto';
import type { ContractSchema } from './openapi.js';
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Verdict = 'valid' | 'invalid' | 'unknown';
export class ValueGap extends Error {}
function decimal(value: number) {
  const [mantissa, exponent = '0'] = Math.abs(value).toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return {
    coefficient: BigInt(whole + fraction),
    exponent: Number(exponent) - fraction.length,
  };
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function fixtureValue(text: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValueGap('fixture_json_invalid');
  }
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 2000 || item.depth > 20) throw new ValueGap('value_budget');
    if (
      typeof item.value === 'number' &&
      (!Number.isFinite(item.value) ||
        (Number.isInteger(item.value) && !Number.isSafeInteger(item.value)))
    )
      throw new ValueGap('numeric_precision');
    if (item.value && typeof item.value === 'object') {
      if (
        Object.keys(item.value).some((key) =>
          ['__proto__', 'prototype', 'constructor'].includes(key),
        )
      )
        throw new ValueGap('fixture_unsafe_key');
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}
function pattern(value: string, expression: string): Verdict {
  // A finite, explicitly modeled set. No RegExp constructed from contract text.
  switch (expression) {
    case '\\S':
      return /\S/u.test(value) ? 'valid' : 'invalid';
    case '^\\S+$':
      return /^\S+$/u.test(value) ? 'valid' : 'invalid';
    case '^[a-z]+$':
      return /^[a-z]+$/u.test(value) ? 'valid' : 'invalid';
    case '^[A-Za-z]+$':
      return /^[A-Za-z]+$/u.test(value) ? 'valid' : 'invalid';
    case '^[0-9]+$':
    case '^\\d+$':
      return /^[0-9]+$/u.test(value) ? 'valid' : 'invalid';
    case '^[A-Za-z0-9_-]+$':
      return /^[A-Za-z0-9_-]+$/u.test(value) ? 'valid' : 'invalid';
    default:
      return 'unknown';
  }
}
const combine = (values: Verdict[]): Verdict =>
  values.includes('invalid')
    ? 'invalid'
    : values.includes('unknown')
      ? 'unknown'
      : 'valid';
export function checkValue(
  schema: ContractSchema,
  value: JsonValue,
  depth = 0,
): Verdict {
  if (depth > 20) return 'unknown';
  if (value === null)
    return schema.nullable && (!schema.enum || schema.enum.includes(null))
      ? 'valid'
      : 'invalid';
  if (schema.enum && !schema.enum.some((item) => item === value))
    return 'invalid';
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
    const keys = Object.keys(value);
    if (
      (schema.required ?? []).some((key) => !Object.hasOwn(value, key)) ||
      keys.length < (schema.minProperties ?? 0) ||
      keys.length > (schema.maxProperties ?? Infinity)
    )
      return 'invalid';
    return combine(
      keys.map((key) => {
        const child =
          schema.properties && Object.hasOwn(schema.properties, key)
            ? schema.properties[key]
            : undefined;
        if (child) return checkValue(child, value[key], depth + 1);
        if (schema.additionalProperties === false) return 'invalid';
        return typeof schema.additionalProperties === 'object'
          ? checkValue(schema.additionalProperties, value[key], depth + 1)
          : 'valid';
      }),
    );
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return 'invalid';
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      return 'invalid';
    if (schema.uniqueItems && new Set(value.map(stable)).size !== value.length)
      return 'invalid';
    return schema.items
      ? combine(value.map((item) => checkValue(schema.items!, item, depth + 1)))
      : 'unknown';
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'invalid';
    const length = [...value].length;
    if (
      length < (schema.minLength ?? 0) ||
      length > (schema.maxLength ?? Infinity)
    )
      return 'invalid';
    return schema.pattern ? pattern(value, schema.pattern) : 'valid';
  }
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? 'valid' : 'invalid';
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (schema.type === 'integer' && !Number.isInteger(value))
  )
    return 'invalid';
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return 'unknown';
  if (
    schema.minimum !== undefined &&
    (value < schema.minimum ||
      (schema.exclusiveMinimum && value === schema.minimum))
  )
    return 'invalid';
  if (
    schema.maximum !== undefined &&
    (value > schema.maximum ||
      (schema.exclusiveMaximum && value === schema.maximum))
  )
    return 'invalid';
  if (schema.multipleOf !== undefined) {
    // Test decimal JSON values exactly, avoiding epsilon-based false positives.
    const numerator = decimal(value),
      denominator = decimal(schema.multipleOf);
    const difference = numerator.exponent - denominator.exponent;
    const top = numerator.coefficient * 10n ** BigInt(Math.max(0, difference));
    const bottom =
      denominator.coefficient * 10n ** BigInt(Math.max(0, -difference));
    if (top % bottom !== 0n) return 'invalid';
  }
  return 'valid';
}
export function adjacent(value: number, direction: 1 | -1) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction * Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8),
    view = new DataView(buffer);
  view.setFloat64(0, value);
  view.setBigUint64(
    0,
    view.getBigUint64(0) + BigInt(value > 0 ? direction : -direction),
  );
  return view.getFloat64(0);
}
export function sample(
  schema: ContractSchema,
  salt: string,
  maxSize: number,
  depth = 0,
  budget = { left: 2000 },
): JsonValue {
  if (depth > 20 || --budget.left < 0) throw new ValueGap('value_budget');
  const hash = createHash('sha256').update(salt).digest('hex');
  if (schema.enum) {
    for (const value of schema.enum)
      if (checkValue(schema, value) === 'valid') return value;
    throw new ValueGap('enum_baseline_unavailable');
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    const required = [...(schema.required ?? [])].sort();
    const names = [
      ...required,
      ...Object.keys(properties)
        .sort()
        .filter((name) => !required.includes(name)),
    ];
    const limit = schema.maxProperties ?? names.length;
    if (required.length > limit || (schema.minProperties ?? 0) > 100)
      throw new ValueGap('object_baseline_unavailable');
    const result: { [key: string]: JsonValue } = {};
    for (const name of names.slice(0, limit)) {
      result[name] = sample(
        properties[name],
        salt + '/' + name,
        maxSize,
        depth + 1,
        budget,
      );
      if (Buffer.byteLength(stable(result)) > maxSize)
        throw new ValueGap('baseline_payload_budget');
    }
    for (
      let index = 0;
      Object.keys(result).length < (schema.minProperties ?? 0);
      index++
    ) {
      if (schema.additionalProperties === false)
        throw new ValueGap('object_baseline_unavailable');
      const key = `dogwatch_extra_${index}`;
      if (Object.hasOwn(result, key)) continue;
      result[key] =
        typeof schema.additionalProperties === 'object'
          ? sample(
              schema.additionalProperties,
              salt + key,
              maxSize,
              depth + 1,
              budget,
            )
          : 'synthetic';
      if (Buffer.byteLength(stable(result)) > maxSize)
        throw new ValueGap('baseline_payload_budget');
    }
    if (Buffer.byteLength(stable(result)) > maxSize)
      throw new ValueGap('baseline_payload_budget');
    return result;
  }
  if (schema.type === 'array') {
    const length = Math.max(
      schema.minItems ?? 0,
      Math.min(1, schema.maxItems ?? 1),
    );
    if (length > 32 || !schema.items)
      throw new ValueGap('array_baseline_unavailable');
    const value: JsonValue[] = [];
    for (let index = 0; index < length; index++) {
      value.push(
        sample(schema.items, salt + '/' + index, maxSize, depth + 1, budget),
      );
      if (Buffer.byteLength(stable(value)) > maxSize)
        throw new ValueGap('baseline_payload_budget');
    }
    return value;
  }
  if (schema.type === 'string') {
    const length = Math.max(
      schema.minLength ?? 0,
      Math.min(1, schema.maxLength ?? 1),
    );
    if (length > maxSize) throw new ValueGap('string_baseline_unavailable');
    const alphabet =
      schema.pattern === '^[0-9]+$' || schema.pattern === '^\\d+$'
        ? '0123456789'
        : 'abcdefghijklmnopqrstuvwxyz';
    return Array.from(
      { length },
      (_, index) =>
        alphabet[parseInt(hash[index % hash.length], 16) % alphabet.length],
    ).join('');
  }
  if (schema.type === 'boolean') return parseInt(hash[0], 16) % 2 === 0;
  const min = schema.minimum ?? -Infinity,
    max = schema.maximum ?? Infinity;
  const low =
    schema.type === 'integer'
      ? schema.exclusiveMinimum
        ? Math.floor(min) + 1
        : Math.ceil(min)
      : schema.exclusiveMinimum
        ? adjacent(min, 1)
        : min;
  const high =
    schema.type === 'integer'
      ? schema.exclusiveMaximum
        ? Math.ceil(max) - 1
        : Math.floor(max)
      : schema.exclusiveMaximum
        ? adjacent(max, -1)
        : max;
  const candidates = [0, low, high, 1, -1];
  if (schema.multipleOf) {
    const factor = schema.multipleOf;
    const start = Number.isFinite(low) ? Math.ceil(low / factor) : 0;
    candidates.unshift(start * factor, (start + 1) * factor);
  }
  for (const value of candidates)
    if (Number.isFinite(value) && checkValue(schema, value) === 'valid')
      return value;
  throw new ValueGap('numeric_baseline_unavailable');
}
export interface ValueMutation {
  kind: string;
  pointer: (string | number)[];
  value?: JsonValue;
  remove?: boolean;
}
export function* mutate(
  schema: ContractSchema,
  value: JsonValue,
  maxSize: number,
  gap: (code: string) => void,
  pointer: (string | number)[] = [],
): Generator<ValueMutation> {
  yield {
    kind: 'wrong_type',
    pointer,
    value:
      schema.type === 'object'
        ? []
        : schema.type === 'array'
          ? {}
          : schema.type === 'string'
            ? 0
            : 'dogwatch-invalid',
  };
  yield { kind: 'null', pointer, value: null };
  if (
    schema.type === 'object' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    for (const name of [...(schema.required ?? [])].sort())
      yield {
        kind: 'missing_required',
        pointer: [...pointer, name],
        remove: true,
      };
    let key = 'dogwatch_unexpected';
    while (Object.hasOwn(value, key)) key += '_';
    yield {
      kind: 'unexpected_property',
      pointer: [...pointer, key],
      value: 'synthetic',
    };
    for (const name of Object.keys(value).sort()) {
      const child =
        (schema.properties && Object.hasOwn(schema.properties, name)
          ? schema.properties[name]
          : undefined) ??
        (typeof schema.additionalProperties === 'object'
          ? schema.additionalProperties
          : undefined);
      if (child)
        yield* mutate(child, value[name], maxSize, gap, [...pointer, name]);
    }
  } else if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    const sizes = new Set([
      0,
      schema.minItems ?? 0,
      (schema.minItems ?? 0) - 1,
      ...(schema.maxItems !== undefined
        ? [schema.maxItems, schema.maxItems + 1]
        : []),
    ]);
    for (const length of sizes) {
      if (length < 0) continue;
      if (length > 32 || length > maxSize) {
        gap('array_boundary_budget');
        continue;
      }
      try {
        const resized: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          resized.push(
            index < value.length
              ? value[index]
              : sample(schema.items, 'boundary-array/' + index, maxSize),
          );
          if (Buffer.byteLength(stable(resized)) > maxSize)
            throw new ValueGap('array_boundary_budget');
        }
        yield {
          kind: 'array_length',
          pointer,
          value: resized,
        };
      } catch {
        gap('array_boundary_unavailable');
      }
    }
    if (schema.uniqueItems && value.length)
      yield { kind: 'duplicate_item', pointer, value: [value[0], value[0]] };
    if (value.length)
      yield* mutate(schema.items, value[0], maxSize, gap, [...pointer, 0]);
  } else if (schema.type === 'string') {
    const lengths = new Set([
      0,
      schema.minLength ?? 0,
      (schema.minLength ?? 0) - 1,
      (schema.minLength ?? 0) + 1,
      ...(schema.maxLength !== undefined
        ? [
            Math.max(0, schema.maxLength - 1),
            schema.maxLength,
            schema.maxLength + 1,
          ]
        : []),
    ]);
    for (const length of lengths) {
      if (length < 0) continue;
      if (length > maxSize) {
        gap('string_boundary_budget');
        continue;
      }
      yield { kind: 'string_length', pointer, value: 'a'.repeat(length) };
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    const numbers = new Set([
      0,
      ...(schema.minimum !== undefined
        ? [
            schema.minimum,
            schema.type === 'integer'
              ? Math.ceil(schema.minimum) - 1
              : adjacent(schema.minimum, -1),
            schema.type === 'integer'
              ? Math.floor(schema.minimum) + 1
              : adjacent(schema.minimum, 1),
          ]
        : []),
      ...(schema.maximum !== undefined
        ? [
            schema.maximum,
            schema.type === 'integer'
              ? Math.ceil(schema.maximum) - 1
              : adjacent(schema.maximum, -1),
            schema.type === 'integer'
              ? Math.floor(schema.maximum) + 1
              : adjacent(schema.maximum, 1),
          ]
        : []),
    ]);
    if (schema.type === 'integer') numbers.add(0.5);
    if (schema.multipleOf) numbers.add(schema.multipleOf / 2);
    for (const number of numbers) {
      if (
        !Number.isFinite(number) ||
        (Number.isInteger(number) && !Number.isSafeInteger(number))
      ) {
        gap('numeric_precision');
        continue;
      }
      yield { kind: 'numeric_boundary', pointer, value: number };
    }
  }
  if (schema.enum) {
    let outside: JsonValue =
      schema.type === 'boolean'
        ? !schema.enum.includes(true)
        : schema.type === 'string'
          ? 'dogwatch-outside-enum'
          : 0;
    if (typeof outside === 'string')
      while (schema.enum.includes(outside)) outside += '_';
    if (typeof outside === 'number')
      while (schema.enum.includes(outside)) outside++;
    if (!schema.enum.includes(outside as string | number | boolean | null))
      yield { kind: 'outside_enum', pointer, value: outside };
  }
}
