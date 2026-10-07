/** Real Docker verification; random containers only, no customer runs or credentials. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { runIsolatedProbe } from './isolation.js';
const execute = promisify(execFile);
const task = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  kind: 'probe' as const,
};
const created: string[] = [];

/** Inspect actual engine settings rather than trusting the argv builder alone. */
async function inspectCreated(name: string) {
  created.push(name);
  const { stdout } = await execute('docker', ['inspect', name], {
    timeout: 10000,
    maxBuffer: 65536,
  });
  const [container] = JSON.parse(stdout);
  const host = container.HostConfig;
  assert.equal(container.Config.User, '10001:10001');
  assert.equal(host.Privileged, false);
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.NetworkMode, 'none');
  assert.equal(host.NanoCpus, 500000000);
  assert.equal(host.Memory, 134217728);
  assert.equal(host.MemorySwap, 134217728);
  assert.equal(host.PidsLimit, 32);
  assert.ok(host.CapDrop.includes('ALL'));
  assert.ok(host.SecurityOpt.includes('no-new-privileges=true'));
  assert.equal(host.LogConfig.Type, 'none');
  assert.equal(container.Mounts.length, 0);
  assert.match(host.Tmpfs['/tmp'], /noexec/);
  assert.match(host.Tmpfs['/tmp'], /size=16777216/);
  assert.ok(
    !container.Config.Env.some((value: string) =>
      value.startsWith('DOGWATCH_HOST_CANARY='),
    ),
  );
}

// A host-only canary proves ordinary process environment is not injected into Docker.
const previousCanary = process.env.DOGWATCH_HOST_CANARY;
process.env.DOGWATCH_HOST_CANARY = `secret-${randomUUID()}`;
try {
  const verified = await runIsolatedProbe(task, {
    maxRuntimeSeconds: 15,
    onCreated: inspectCreated,
  });
  assert.equal(verified.status, 'verified', JSON.stringify(verified));
  // A second probe has fresh tmpfs and its own random container identity.
  assert.equal(
    (
      await runIsolatedProbe(
        { ...task, runId: randomUUID() },
        { onCreated: inspectCreated },
      )
    ).status,
    'verified',
  );
  const timedOut = await runIsolatedProbe(
    { ...task, kind: 'timeout_probe' },
    { maxRuntimeSeconds: 2, onCreated: inspectCreated },
  );
  assert.deepEqual(timedOut, { status: 'failed', code: 'sandbox_timeout' });
  const cancellation = new AbortController();
  const cancelled = await runIsolatedProbe(
    { ...task, kind: 'timeout_probe' },
    {
      signal: cancellation.signal,
      maxRuntimeSeconds: 15,
      onCreated: async (name) => {
        await inspectCreated(name);
        setTimeout(() => cancellation.abort(), 500);
      },
    },
  );
  assert.deepEqual(cancelled, { status: 'failed', code: 'sandbox_cancelled' });
  for (const name of created) {
    const { stdout } = await execute(
      'docker',
      ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
      { timeout: 10000 },
    );
    assert.equal(stdout.trim(), '', 'Invocation must remove its exact sandbox');
  }
  assert.equal(new Set(created).size, 4);
  process.stdout.write(
    'Isolation verified: engine limits, non-root, read-only root, tmpfs, no capabilities/socket/secrets/metadata access, timeout/cancellation cleanup.\n',
  );
} finally {
  if (previousCanary === undefined) delete process.env.DOGWATCH_HOST_CANARY;
  else process.env.DOGWATCH_HOST_CANARY = previousCanary;
}
