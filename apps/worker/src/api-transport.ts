/** Trusted bounded HTTP transport. No redirects, proxies, cookie jar or decompression. */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolvePreviewAddress } from './preview.js';
import { checkValue, stable } from './boundary-values.js';
import type { BoundaryCase } from './boundary-cases.js';
import type { ContractOperation } from './openapi.js';

export class ApiGap extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export interface WireRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  bytes: number;
}
const reserved =
  /^(host|connection|content-length|content-type|transfer-encoding|authorization|cookie|set-cookie|upgrade|expect|trailer|te|forwarded|accept-encoding|proxy-.*|sec-.*|x-forwarded-.*)$/i;
const ascii = (value: string) =>
  [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126);
/** Refuse values whose logical invalidity would disappear during scalar serialization. */
export function serializeApiCase(
  test: BoundaryCase,
  operation: ContractOperation,
  origin: string,
  token?: string,
): WireRequest {
  let path = test.path;
  const url = new URL(origin);
  const headers: Record<string, string> = {
    host: url.host,
    connection: 'close',
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'DogWatch-api',
  };
  const query = new URLSearchParams();
  const cookies: string[] = [];
  if (token !== undefined) {
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 4096)
      throw new ApiGap('credentials_unavailable');
    headers.authorization = `Bearer ${token}`;
  }
  for (const parameter of test.request.parameters) {
    const declaration = operation.parameters.find(
      (p) => p.in === parameter.in && p.name === parameter.name,
    );
    const value = parameter.value;
    if (!declaration || value === null || typeof value === 'object')
      throw new ApiGap('parameter_unrepresentable');
    const text = String(value);
    // Model only conventional numeric/boolean scalar parsing, never arbitrary coercion.
    const parsed =
      declaration.schema.type === 'string'
        ? text
        : ['integer', 'number'].includes(declaration.schema.type) &&
            text.trim() &&
            Number.isFinite(Number(text))
          ? Number(text)
          : declaration.schema.type === 'boolean' &&
              ['true', 'false'].includes(text)
            ? text === 'true'
            : text;
    if (
      checkValue(declaration.schema, value) !==
      checkValue(declaration.schema, parsed)
    )
      throw new ApiGap('parameter_unrepresentable');
    if (parameter.in === 'path') {
      if (
        !/^[A-Za-z0-9_~.-]{1,200}$/.test(text) ||
        text === '.' ||
        text === '..'
      )
        throw new ApiGap('parameter_unrepresentable');
      path = path.replaceAll(`{${parameter.name}}`, text);
    } else if (parameter.in === 'query') query.append(parameter.name, text);
    else if (parameter.in === 'cookie')
      cookies.push(
        `${encodeURIComponent(parameter.name)}=${encodeURIComponent(text)}`,
      );
    else {
      const name = parameter.name.toLowerCase();
      if (
        !/^[a-z0-9-]+$/.test(name) ||
        reserved.test(name) ||
        Object.hasOwn(headers, name) ||
        !ascii(text)
      )
        throw new ApiGap('header_forbidden');
      headers[name] = text;
    }
  }
  if (
    !/^\/[A-Za-z0-9/_~.-]*$/.test(path) ||
    path.startsWith('//') ||
    path.split('/').some((p) => p === '.' || p === '..')
  )
    throw new ApiGap('path_forbidden');
  url.pathname = path;
  if (url.pathname !== path) throw new ApiGap('path_forbidden');
  url.search = query.toString();
  if (url.href.length > 2048) throw new ApiGap('request_bytes');
  if (cookies.length) headers.cookie = cookies.join('; ');
  const body = Buffer.from(
    test.request.body.kind === 'absent'
      ? ''
      : test.request.body.kind === 'json'
        ? stable(test.request.body.value)
        : test.request.body.text,
  );
  if (body.length && ['GET', 'HEAD'].includes(test.method))
    throw new ApiGap('body_unrepresentable');
  if (operation.requestBody) headers['content-type'] = 'application/json';
  headers['content-length'] = String(body.length);
  const head = `${test.method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(
    headers,
  )
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('')}\r\n`;
  return {
    url,
    method: test.method,
    headers,
    body,
    bytes: Buffer.byteLength(head) + body.length,
  };
}
export interface ApiResponse {
  status: number;
  contentType: string;
  encoded: boolean;
  body: Buffer;
}
export async function sendApiRequest(
  wire: WireRequest,
  signal: AbortSignal,
  maxBytes: number,
  onBytes: (bytes: number) => void,
  fixture = false,
): Promise<ApiResponse> {
  const address = await resolvePreviewAddress(wire.url, signal, fixture);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (
      wire.url.protocol === 'https:' ? httpsRequest : httpRequest
    )(
      wire.url,
      {
        method: wire.method,
        headers: wire.headers,
        agent: false,
        signal,
        maxHeaderSize: 8192,
        setDefaultHeaders: false,
        setHost: false,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          // Charge only accepted body bytes; reject and discard the overflow chunk.
          const charged = Math.min(chunk.length, maxBytes - bytes);
          bytes += charged;
          onBytes(charged);
          if (chunk.length > charged) {
            reject(new ApiGap('response_bytes'));
            response.destroy();
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () =>
          reject(new ApiGap('transport_unavailable')),
        );
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers['content-type'] ?? '',
            encoded:
              !!response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity',
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(wire.body);
  });
}
