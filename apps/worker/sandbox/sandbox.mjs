/**
 * Trusted isolation diagnostic, not a repository executor or QA engine.
 * Accept only bounded identity references and a fixed diagnostic mode on stdin.
 * Print booleans only: environment values, file contents, and exceptions never leave.
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { readFile, writeFile, access } from 'node:fs/promises';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (Buffer.byteLength(input) > 4096) throw new Error('Invalid input');
}
const task = JSON.parse(input);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
if (
  Object.keys(task).sort().join(',') !== 'kind,runId,tenantId' ||
  !uuid.test(task.runId) ||
  !uuid.test(task.tenantId) ||
  !['probe', 'timeout_probe'].includes(task.kind)
)
  throw new Error('Invalid task');

// This fixed delay verifies host deadlines/cancellation without accepting code.
if (task.kind === 'timeout_probe') await pause(30000);

const status = await readFile('/proc/self/status', 'utf8');
let rootWriteDenied = false;
try {
  await writeFile('/opt/dogwatch/forbidden-write', 'probe');
} catch (error) {
  rootWriteDenied = ['EROFS', 'EACCES'].includes(error.code);
}
let dockerSocketAbsent = false;
try {
  await access('/var/run/docker.sock');
} catch (error) {
  dockerSocketAbsent = error.code === 'ENOENT';
}

// Each container has a fresh memory-backed tmp directory, never a shared workspace.
let tmpFresh = false;
try {
  await access('/tmp/dogwatch-probe-marker');
} catch (error) {
  tmpFresh = error.code === 'ENOENT';
}
await writeFile('/tmp/dogwatch-probe-marker', task.runId);
const scratch = `/tmp/probe-${randomUUID()}`;
await writeFile(scratch, task.runId);
const tmpWritable = (await readFile(scratch, 'utf8')) === task.runId;
const metadataBlocked = await new Promise((resolve) => {
  const socket = connect({ host: '169.254.169.254', port: 80 });
  socket.setTimeout(500);
  socket.once('connect', () => {
    socket.destroy();
    resolve(false);
  });
  socket.once('error', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('timeout', () => {
    socket.destroy();
    resolve(true);
  });
});
process.stdout.write(
  JSON.stringify({
    nonRoot: process.getuid() === 10001,
    noCapabilities: /^CapEff:\s+0+$/m.test(status),
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    rootWriteDenied,
    dockerSocketAbsent,
    tmpWritable,
    tmpFresh,
    metadataBlocked,
    // Canary is set only on the host during verification; none of these are passed in.
    controlSecretsAbsent: [
      'DOGWATCH_HOST_CANARY',
      'DATABASE_URL',
      'REDIS_URL',
      'GITHUB_WEBHOOK_SECRET',
    ].every((key) => process.env[key] === undefined),
  }) + '\n',
);
