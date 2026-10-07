/**
 * Preview setup only: explicit immutable deployment bindings replace guessed PR
 * URLs. No credentials, model calls, browser exploration, or QA verdicts occur here.
 */
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as pause } from 'node:timers/promises';

/** Operator-owned configuration. A binding must match every run scope dimension. */
const safeUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Preview URLs must not contain credentials, queries, or fragments');
export const previewBindingSchema = z.strictObject({
  tenantId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  deploymentId: z.string().min(1).max(200),
  url: safeUrl,
  allowedOrigins: z.array(safeUrl).min(1).max(10),
  maxWaitSeconds: z.number().int().min(1).max(300).default(60),
  maxRequests: z.number().int().min(1).max(100).default(20),
  pollIntervalMs: z.number().int().min(50).max(10000).default(1000),
});
export type PreviewBinding = z.infer<typeof previewBindingSchema>;
export type PreviewOutcome =
  | { status: 'ready'; requests: number }
  | {
      status: 'failed';
      code:
        | 'preview_forbidden'
        | 'preview_timeout'
        | 'preview_request_budget'
        | 'preview_stopped'
        | 'preview_context_unavailable'
        | 'preview_missing'
        | 'preview_ambiguous';
      requests: number;
    };

// The MVP transport supports public IPv4 only. IPv6 is denied until its special
// ranges and pinned transport have equivalent verification. Deny special/private
// IPv4 blocks even when an operator allowlists the hostname.
const forbidden = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  forbidden.addSubnet(network, prefix, 'ipv4');

export class ForbiddenPreviewError extends Error {}
/** Bound asynchronous operations and remove listeners as soon as each finishes. */
async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Test-only loopback mode cannot be selected by JSON configuration. */
export function validatePreviewUrl(
  url: URL,
  binding: PreviewBinding,
  fixture = false,
) {
  const origins = binding.allowedOrigins.map((origin) => new URL(origin));
  if (
    origins.some(
      (origin) =>
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password,
    )
  )
    throw new ForbiddenPreviewError('Expected bare allowed origins');
  if (
    !origins.some((origin) => origin.origin === url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.startsWith('[') ||
    (url.protocol !== 'https:' &&
      !(fixture && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw new ForbiddenPreviewError('Destination forbidden');
}

/**
 * Resolve before connecting and pin the checked IP in the socket lookup callback.
 * Node does not follow redirects here. Every retry performs a fresh checked lookup;
 * DNS rebinding cannot replace the approved address between check and connect.
 */
export async function probePreview(
  url: URL,
  binding: PreviewBinding,
  signal: AbortSignal,
  fixture = false,
): Promise<number> {
  validatePreviewUrl(url, binding, fixture);
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await bounded(lookup(url.hostname, { all: true }), signal);
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) =>
        family !== 4 ||
        (forbidden.check(address, 'ipv4') &&
          !(
            fixture &&
            address === '127.0.0.1' &&
            url.hostname === '127.0.0.1'
          )),
    )
  )
    throw new ForbiddenPreviewError('Resolved address forbidden');
  const address = addresses[0]!.address;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        // Keep URL hostname for Host and TLS certificate verification, while routing
        // the socket only to the approved address. Support Node's all-addresses lookup.
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
        headers: {
          'user-agent': 'DogWatch-preview-readiness',
          accept: 'text/html, application/json',
        },
      },
      (response) => {
        // Header status is enough for readiness. Destroy the body immediately so
        // arbitrary response size cannot consume the run's memory budget.
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Injected callbacks let fixtures test policies without contacting arbitrary hosts. */
export async function waitForPreview(
  bindingInput: PreviewBinding,
  options: {
    signal?: AbortSignal;
    isCurrent: () => Promise<boolean>;
    probe?: typeof probePreview;
    fixture?: boolean;
  },
): Promise<PreviewOutcome> {
  const binding = previewBindingSchema.parse(bindingInput);
  const url = new URL(binding.url);
  let requests = 0;
  const deadlineController = new AbortController();
  // A referenced timer keeps setup alive even while a resolver callback stalls.
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    binding.maxWaitSeconds * 1000,
  );
  const deadline = deadlineController.signal;
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  try {
    validatePreviewUrl(url, binding, options.fixture);
    while (!signal.aborted) {
      // Revalidate durable cancellation/current-head before every attempt and after
      // a successful response. Abort still bounds injected state/network callbacks.
      const current = await bounded(options.isCurrent(), signal);
      if (!current)
        return {
          status: 'failed',
          code: deadline.aborted ? 'preview_timeout' : 'preview_stopped',
          requests,
        };
      if (requests >= binding.maxRequests)
        return { status: 'failed', code: 'preview_request_budget', requests };
      requests++;
      let status = 0;
      try {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(2000),
        ]);
        status = await bounded(
          (options.probe ?? probePreview)(
            url,
            binding,
            requestSignal,
            options.fixture,
          ),
          requestSignal,
        );
      } catch (error) {
        if (error instanceof ForbiddenPreviewError) throw error;
        // Network and TLS failures are readiness failures, not application findings.
      }
      // Fail closed on every redirect instead of trusting Location or forwarding
      // authentication. Configure the final approved health URL explicitly.
      if (status >= 300 && status < 400)
        throw new ForbiddenPreviewError('Redirect forbidden');
      if (status >= 200 && status < 300) {
        if (await bounded(options.isCurrent(), signal))
          return { status: 'ready', requests };
        return { status: 'failed', code: 'preview_stopped', requests };
      }
      await pause(binding.pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (error instanceof ForbiddenPreviewError)
      return { status: 'failed', code: 'preview_forbidden', requests };
    if (!signal.aborted)
      return {
        status: 'failed',
        code: 'preview_context_unavailable',
        requests,
      };
  } finally {
    clearTimeout(deadlineTimer);
  }
  return {
    status: 'failed',
    code: options.signal?.aborted ? 'preview_stopped' : 'preview_timeout',
    requests,
  };
}
