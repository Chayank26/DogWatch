/** Policy tests: untrusted task JSON cannot supply Docker flags, commands, or secrets. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  sandboxCreateArguments,
  sandboxTaskSchema,
  runIsolatedProbe,
  isolationEvidenceSchema,
} from './isolation.js';
const identity = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  kind: 'probe' as const,
};
test('sandbox argv has fixed resource, filesystem, privilege, and egress restrictions', () => {
  const args = sandboxCreateArguments(
    `dogwatch-sandbox-${randomUUID()}`,
    `sha256:${'a'.repeat(64)}`,
  );
  for (const restriction of [
    '--network=none',
    '--read-only',
    '--user=10001:10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    '--cpus=0.5',
    '--memory=128m',
    '--memory-swap=128m',
    '--pids-limit=32',
    '--log-driver=none',
  ])
    assert.ok(args.includes(restriction));
  for (const forbidden of [
    '--privileged',
    '--volume',
    '--mount',
    '--env',
    '--network=host',
    '--pid=host',
    '--security-opt=seccomp=unconfined',
  ])
    assert.ok(!args.includes(forbidden));
  assert.throws(() =>
    sandboxCreateArguments(
      'customer; touch /tmp/file',
      `sha256:${'a'.repeat(64)}`,
    ),
  );
  assert.throws(() =>
    sandboxCreateArguments(
      `dogwatch-sandbox-${randomUUID()}`,
      'untrusted:latest',
    ),
  );
});
test('tasks accept references and fixed diagnostics only', () => {
  assert.equal(sandboxTaskSchema.safeParse(identity).success, true);
  for (const change of [
    { command: 'curl metadata' },
    { env: { TOKEN: 'secret' } },
    { image: 'other' },
    { kind: 'exec' },
    { runId: '../other-tenant' },
  ])
    assert.equal(
      sandboxTaskSchema.safeParse({ ...identity, ...change }).success,
      false,
    );
});
test('already cancelled tasks do not contact Docker', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await runIsolatedProbe(identity, { signal: controller.signal }),
    { status: 'failed', code: 'sandbox_cancelled' },
  );
});
test('false or extra evidence fails closed instead of passing isolation', () => {
  assert.equal(
    isolationEvidenceSchema.safeParse({ nonRoot: false }).success,
    false,
  );
});
