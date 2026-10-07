/** Synthetic tests verify boundaries and budget behavior without external network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  previewBindingSchema,
  waitForPreview,
  probePreview,
} from './preview.js';

const binding = previewBindingSchema.parse({
  tenantId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
  deploymentId: 'preview-42-a',
  url: 'https://preview.example.com/health',
  allowedOrigins: ['https://preview.example.com'],
  maxWaitSeconds: 1,
  maxRequests: 3,
  pollIntervalMs: 50,
});
test('polls transient status then accepts healthy headers', async () => {
  let calls = 0;
  assert.deepEqual(
    await waitForPreview(binding, {
      isCurrent: async () => true,
      probe: async () => (++calls === 1 ? 503 : 200),
    }),
    { status: 'ready', requests: 2 },
  );
});
test('redirects, wrong origins, credentials, and query secrets fail closed', async () => {
  const redirected = await waitForPreview(binding, {
    isCurrent: async () => true,
    probe: async () => 302,
  });
  assert.equal(
    redirected.status === 'failed' && redirected.code,
    'preview_forbidden',
  );
  let calls = 0;
  const wrongOrigin = await waitForPreview(
    { ...binding, url: 'https://other.example.com/' },
    {
      isCurrent: async () => true,
      probe: async () => {
        calls++;
        return 200;
      },
    },
  );
  assert.equal(
    wrongOrigin.status === 'failed' && wrongOrigin.code,
    'preview_forbidden',
  );
  assert.equal(calls, 0);
  for (const url of [
    'https://user:secret@preview.example.com/',
    'https://preview.example.com/?token=secret',
  ]) {
    assert.equal(
      previewBindingSchema.safeParse({ ...binding, url }).success,
      false,
    );
  }
});
test('private, metadata, and IPv6 literal destinations are rejected before connecting', async () => {
  for (const hostname of [
    'localhost',
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '[::1]',
  ]) {
    const origin = `https://${hostname}`;
    const outcome = await waitForPreview(
      { ...binding, url: origin, allowedOrigins: [origin] },
      { isCurrent: async () => true },
    );
    assert.equal(
      outcome.status === 'failed' && outcome.code,
      'preview_forbidden',
    );
  }
});
test('request exhaustion and wall clock timeout have distinct outcomes', async () => {
  const exhausted = await waitForPreview(binding, {
    isCurrent: async () => true,
    probe: async () => 503,
  });
  assert.deepEqual(exhausted, {
    status: 'failed',
    code: 'preview_request_budget',
    requests: 3,
  });
  // An injected stalled probe must still obey the global deadline.
  const timedOut = await waitForPreview(binding, {
    isCurrent: async () => true,
    probe: () => new Promise(() => {}),
  });
  assert.equal(
    timedOut.status === 'failed' && timedOut.code,
    'preview_timeout',
  );
});
test('cancellation and a stale-head check prevent readiness success', async () => {
  const abort = new AbortController();
  abort.abort();
  const cancelled = await waitForPreview(binding, {
    signal: abort.signal,
    isCurrent: async () => true,
  });
  assert.equal(
    cancelled.status === 'failed' && cancelled.code,
    'preview_stopped',
  );
  let checks = 0;
  const stale = await waitForPreview(binding, {
    isCurrent: async () => ++checks === 1,
    probe: async () => 200,
  });
  assert.equal(stale.status === 'failed' && stale.code, 'preview_stopped');
});
test('production transport rejects plaintext even if its origin is allowed', async () => {
  await assert.rejects(
    probePreview(
      new URL('http://127.0.0.1:4100/health'),
      { ...binding, allowedOrigins: ['http://127.0.0.1:4100'] },
      AbortSignal.timeout(100),
    ),
    /forbidden/i,
  );
});
