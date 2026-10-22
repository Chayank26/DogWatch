/** One sequential budget/authority boundary shared by all callable API stages. */
import { setTimeout as pause } from 'node:timers/promises';
import { ApiGap, sendApiRequest } from './api-transport.js';
import type { WireRequest, ApiResponse } from './api-transport.js';
import { ForbiddenPreviewError } from './preview.js';
import type { ApiExecutionOptions, ApiLimits } from './api-execution.js';
export async function bounded<T>(
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
export class ApiRuntime {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private lastFinish = -Infinity;
  constructor(
    private readonly limits: ApiLimits,
    private readonly options: ApiExecutionOptions,
    private readonly usage: {
      requests: number;
      requestBytes: number;
      responseBytes: number;
    },
  ) {
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    this.timer = setTimeout(
      () => this.controller.abort(),
      limits.maxExecutionMs,
    );
  }
  async current() {
    this.signal.throwIfAborted();
    let allowed: boolean;
    try {
      allowed = await bounded(this.options.isCurrent(), this.signal);
    } catch {
      throw new ApiGap('context_unavailable');
    }
    if (!allowed) throw new ApiGap('stopped');
    this.signal.throwIfAborted();
  }
  async credential<T>(get: () => Promise<T>) {
    await this.current();
    return bounded(
      get(),
      AbortSignal.any([
        this.signal,
        AbortSignal.timeout(this.limits.maxRequestMs),
      ]),
    );
  }
  async send(wire: WireRequest): Promise<ApiResponse> {
    if (wire.bytes > this.limits.maxRequestBytes)
      throw new ApiGap('request_bytes');
    for (let retry = 0; ; retry++) {
      const delay =
        this.limits.minIntervalMs - (performance.now() - this.lastFinish);
      if (delay > 0) await pause(delay, undefined, { signal: this.signal });
      await this.current();
      if (this.usage.requests >= this.limits.maxRequests)
        throw new ApiGap('request_budget');
      if (
        this.usage.requestBytes + wire.bytes >
        this.limits.maxTotalRequestBytes
      )
        throw new ApiGap('total_request_bytes');
      if (this.usage.responseBytes >= this.limits.maxTotalResponseBytes)
        throw new ApiGap('total_response_bytes');
      this.usage.requests++;
      this.usage.requestBytes += wire.bytes;
      let response: ApiResponse;
      try {
        response = await sendApiRequest(
          wire,
          AbortSignal.any([
            this.signal,
            AbortSignal.timeout(this.limits.maxRequestMs),
          ]),
          Math.min(
            this.limits.maxResponseBytes,
            this.limits.maxTotalResponseBytes - this.usage.responseBytes,
          ),
          (bytes) => {
            this.usage.responseBytes += bytes;
          },
          this.options.fixture,
        );
      } catch (error) {
        if (
          !this.signal.aborted &&
          !(error instanceof ApiGap) &&
          !(error instanceof ForbiddenPreviewError) &&
          ['GET', 'HEAD', 'OPTIONS'].includes(wire.method) &&
          retry < this.limits.maxRetries
        )
          continue;
        throw error;
      } finally {
        this.lastFinish = performance.now();
      }
      await this.current();
      return response;
    }
  }
  code(error: unknown) {
    return this.signal.aborted
      ? this.options.signal?.aborted
        ? 'stopped'
        : 'execution_timeout'
      : error instanceof ApiGap
        ? error.code
        : error instanceof ForbiddenPreviewError
          ? 'destination_forbidden'
          : 'transport_unavailable';
  }
  close() {
    clearTimeout(this.timer);
  }
}
