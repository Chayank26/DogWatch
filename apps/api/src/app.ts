/**
 * Importable API factory: tests supply a secret explicitly without starting the
 * production listener. No webhook data is persisted or queued in Phase 2.1.
 */
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { verifyGitHubSignature } from './webhook.js';

export function createApiApp(webhookSecret?: string) {
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
    (request, response) => {
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
      // Authentication alone grants no tenant permission. Returning 200 here only
      // acknowledges this validation-only milestone; it does NOT accept a QA run.
      response.json({ status: 'verified_only', queued: false });
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
