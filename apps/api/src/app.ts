/**
 * Importable API factory: tests supply a secret explicitly without starting the
 * production listener. Optional persistence commits authorized runs in Phase 2.3;
 * queue dispatch occurs in the separate worker process.
 */
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { verifyGitHubSignature } from './webhook.js';
import { authorizeDelivery } from './authorization.js';
import type { AuthorizationDependencies } from './authorization.js';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';
import {
  DeliveryConflictError,
  OwnershipMismatchError,
} from '@dogwatch/database';
import type {
  AcceptanceInput,
  AcceptanceResult,
  StopInput,
} from '@dogwatch/database';

export function createApiApp(
  webhookSecret?: string,
  authorization?: AuthorizationDependencies,
  persist?: (input: AcceptanceInput) => Promise<AcceptanceResult>,
  stop?: (input: StopInput) => Promise<number>,
) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) =>
    response.json({ service: 'dogwatch-api', status: 'ok' }),
  );
  app.post(
    '/webhooks/github',
    // Capture bounded raw bytes before any JSON parser. Refuse compression so
    // decompression cannot silently change the bytes that GitHub signed.
    express.raw({ type: 'application/json', limit: '1mb', inflate: false }),
    async (request, response) => {
      // An unset secret disables this endpoint while retaining local health checks.
      if (!webhookSecret) {
        response.status(503).json({ error: 'Webhook not configured' });
        return;
      }
      if (!request.is('application/json')) {
        response.status(415).json({ error: 'Expected application/json' });
        return;
      }
      if (
        !Buffer.isBuffer(request.body) ||
        !verifyGitHubSignature(
          request.body,
          request.get('x-hub-signature-256'),
          webhookSecret,
        )
      ) {
        response.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
      // JSON parsing is deliberately after authentication; never reserialize before HMAC.
      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString('utf8'));
      } catch {
        response.status(400).json({ error: 'Invalid JSON' });
        return;
      }
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload)
      ) {
        response.status(400).json({ error: 'Expected a JSON object' });
        return;
      }
      // Default startup remains verification-only until all auth inputs are supplied.
      if (!authorization) {
        response.json({ status: 'verified_only', queued: false });
        return;
      }
      try {
        const result = await authorizeDelivery(
          request.get('x-github-event'),
          request.get('x-github-delivery'),
          payload,
          authorization,
        );
        if (result.status === 'stop_requested') {
          // Never return trusted policy or tenant context in HTTP responses.
          const affected = stop ? await stop(result) : undefined;
          response.json({
            status: stop ? 'stopped' : 'stop_eligible_only',
            operation: result.operation,
            affected,
            queued: false,
          });
          return;
        }
        if (result.status === 'eligible_only' && persist) {
          // Hash the authenticated original bytes, not reserialized JSON or unsigned
          // headers. Successful HTTP acceptance happens only after the transaction.
          const saved = await persist({
            event: result.event,
            policy: result.policy,
            eventName: request.get('x-github-event')!,
            payloadSha256: createHash('sha256')
              .update(request.body)
              .digest('hex'),
          });
          response.status(saved.status === 'accepted' ? 202 : 200).json(saved);
          return;
        }
        // Never expose normalized tenant context or policy contents to the caller.
        response.json(
          result.status === 'eligible_only'
            ? { status: result.status, queued: false, trigger: result.trigger }
            : result,
        );
      } catch (error) {
        if (error instanceof DeliveryConflictError) {
          response.status(409).json({ error: 'Delivery identity conflict' });
        } else if (error instanceof OwnershipMismatchError) {
          response.status(403).json({ error: 'Repository ownership mismatch' });
        } else if (
          error instanceof ZodError ||
          (error instanceof Error &&
            ['Invalid delivery ID', 'Missing added label'].includes(
              error.message,
            ))
        ) {
          response.status(400).json({ error: 'Invalid event payload' });
        } else {
          // Unknown upstream failures cannot become eligible decisions. Returning
          // 503 signals failed handling; an operator can explicitly redeliver. A response
          // loss after commit is reconciled as a duplicate on retry.
          response
            .status(503)
            .json({ error: 'Authorization or storage unavailable' });
        }
      }
    },
  );
  const handleError: ErrorRequestHandler = (
    error,
    _request,
    response,
    next,
  ) => {
    // Express requires four parameters to recognize error-handling middleware.
    void next;
    const code =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 500;
    response
      .status([400, 413, 415].includes(code) ? code : 500)
      .json({ error: 'Request could not be processed' });
  };
  app.use(handleError);
  return app;
}
