/** Local production-build rehearsal only; generated infrastructure and synthetic state. */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const { fetch, AbortSignal } = globalThis;
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(
  process.argv.length,
  2,
  'Release rehearsal accepts no target overrides',
);
assert.equal(process.versions.node.split('.')[0], '24', 'Node 24 is required');
for (const name of [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
])
  assert.ok(
    !existsSync(join(root, 'apps/web', name)),
    `Rehearsal refuses dashboard ${name}; use a clean checkout`,
  );
const project = 'dogwatch-release-' + randomUUID().replaceAll('-', '');
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NEXT_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
  RELEASE_DB_PASSWORD: randomBytes(24).toString('hex'),
};
const compose = [
  'compose',
  '-f',
  join(root, 'ops/release/compose.yaml'),
  '-p',
  project,
];
const directory = join(root, '.local/releases');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, 'rehearsal.lock');
mkdirSync(lock); // Refuse concurrent rehearsals before replacing build artifacts.
const destination = join(directory, 'rehearsal.json');
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'local-production-build-rehearsal',
  node: process.version,
  status: 'running',
  checks: [],
  cleanup: 'pending',
  limitations: [
    'no-cloud-deployment',
    'no-TLS',
    'no-live-OAuth-or-webhook',
    'no-production-QA-consumer',
    'no-hosted-artifacts',
    'no-complete-PR-to-report-pipeline',
    'no-previous-version-rollback-tested',
  ],
};
const save = () =>
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
save();
function command(binary, args, extra = {}) {
  return execFileSync(binary, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    ...extra,
  });
}
function docker(args) {
  return command('docker', [...compose, ...args]);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
const processes = [];
function launch(name, args, env, cwd = root) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...environment, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-65536);
    });
  const item = { name, child, ended: false, code: null, output: () => output };
  item.exit = new Promise((resolve) => {
    child.once('error', () => {
      item.ended = true;
      resolve();
    });
    child.once('exit', (code) => {
      item.ended = true;
      item.code = code;
      resolve();
    });
  });
  processes.push(item);
  return item;
}
async function stop(item) {
  if (item.ended) {
    assert.ok(
      item.code === 0 || (item.stopRequested && item.code === 143),
      `${item.name} exited unsuccessfully`,
    );
    return;
  }
  item.stopRequested = true;
  item.child.kill('SIGTERM');
  for (let n = 0; n < 100 && !item.ended; n++) await pause(100);
  if (!item.ended) {
    item.child.kill('SIGKILL');
    await item.exit;
    throw Error('release_shutdown_timeout');
  }
  assert.ok(
    item.code === 0 || item.code === null || item.code === 143,
    `${item.name} did not stop cleanly`,
  );
}
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (interrupted) throw Error('release_interrupted');
    if (await check()) return;
    await pause(100);
  }
  throw Error(`release_timeout_${label}`);
}
async function get(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
}
async function ready(item, url) {
  await until(async () => {
    if (item.ended) throw Error(`release_process_${item.name}_exited`);
    try {
      return (await get(url)).ok;
    } catch {
      return false;
    }
  }, item.name);
}
function checked(name) {
  report.checks.push(name);
  save();
  console.log(`Release check: ${name}`);
}
let db,
  queue,
  infra = false;
const declaration = join(root, 'apps/web/next-env.d.ts');
const originalDeclaration = readFileSync(declaration);
const previousBuild = join(directory, project + '-previous-next');
const webBuild = join(root, 'apps/web/.next');
let buildOwned = false,
  previousBuildSaved = false;
const started = performance.now();
try {
  infra = true;
  docker(['up', '-d', '--wait']);
  const publishedPort = (service, port) => {
    const value = docker(['port', service, String(port)]).trim();
    assert.match(value, /^127\.0\.0\.1:\d+$/);
    return Number(value.split(':')[1]);
  };
  const databaseUrl = `postgresql://dogwatch:${environment.RELEASE_DB_PASSWORD}@127.0.0.1:${publishedPort('postgres', 5432)}/dogwatch_release`;
  const redisUrl = `redis://127.0.0.1:${publishedPort('redis', 6379)}`;
  const apiPort = await freePort(),
    webPort = await freePort(),
    metricsPort = await freePort();
  assert.equal(
    new Set([apiPort, webPort, metricsPort]).size,
    3,
    'Ephemeral ports collided; retry rehearsal',
  );
  const apiOrigin = `http://127.0.0.1:${apiPort}`,
    webOrigin = `http://127.0.0.1:${webPort}`;
  environment.DOGWATCH_API_ORIGIN = apiOrigin;
  environment.DATABASE_URL = databaseUrl;
  if (existsSync(webBuild)) {
    renameSync(webBuild, previousBuild);
    previousBuildSaved = true;
  }
  buildOwned = true;
  command('npm', ['run', 'build']);
  checked('production-workspace-build');
  command('npm', ['run', 'db:migrate']);
  command('npm', ['run', 'db:migrate']);
  command('npm', ['run', 'db:status']);
  checked('fresh-migration-and-idempotent-reapply');
  // Do not let service-specific credentials bleed into another process.
  delete environment.DATABASE_URL;
  delete environment.RELEASE_DB_PASSWORD;
  const { createDatabase } = await import(
    new URL('../packages/database/dist/index.js', import.meta.url)
  );
  const { createRunQueue } = await import(
    new URL('../packages/queue/dist/index.js', import.meta.url)
  );
  db = createDatabase(databaseUrl);
  queue = createRunQueue(redisUrl);
  const apiEnv = {
    NODE_ENV: 'production',
    API_PORT: String(apiPort),
    DATABASE_URL: databaseUrl,
    GITHUB_OAUTH_CLIENT_ID: 'synthetic-rehearsal',
    GITHUB_OAUTH_CLIENT_SECRET: 'synthetic-not-a-real-secret',
    AUTH_ORIGIN: webOrigin,
  };
  let api = launch('api', ['apps/api/dist/index.js'], apiEnv);
  const require = createRequire(join(root, 'apps/web/package.json'));
  const web = launch(
    'dashboard',
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    { NODE_ENV: 'production' },
    join(root, 'apps/web'),
  );
  await ready(api, apiOrigin + '/health');
  await ready(web, webOrigin + '/');
  const proxy = await get(webOrigin + '/auth/me');
  assert.equal(proxy.status, 401);
  assert.ok(
    proxy.headers.get('x-request-id'),
    'Dashboard must reach the actual API',
  );
  assert.equal(
    (
      await fetch(apiOrigin + '/webhooks/github', {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      })
    ).status,
    503,
  );
  checked('api-dashboard-proxy-and-unconfigured-webhook-refusal');
  const tenantId = randomUUID();
  await db.tenant.create({
    data: { id: tenantId, name: 'Disposable release fixture' },
  });
  await db.installation.create({ data: { id: 1n, tenantId } });
  await db.repository.create({
    data: { id: 1n, tenantId, installationId: 1n, fullName: 'fixture/release' },
  });
  const run = await db.run.create({
    data: {
      tenantId,
      repositoryId: 1n,
      deliveryId: randomUUID(),
      pullRequestNumber: 1,
      headSha: 'a'.repeat(40),
      policySnapshot: {},
      budgetSnapshot: {},
    },
  });
  await db.outboxEvent.create({
    data: { tenantId, runId: run.id, nextAttemptAt: new Date(0) },
  });
  const workerEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    DISPATCHER_METRICS_PORT: String(metricsPort),
  };
  let worker = launch('dispatcher', ['apps/worker/dist/index.js'], workerEnv);
  await ready(worker, `http://127.0.0.1:${metricsPort}/metrics`);
  await until(
    async () =>
      (await db.run.findUniqueOrThrow({ where: { id: run.id } })).state ===
      'queued',
    'dispatch',
  );
  assert.ok((await db.outboxEvent.findFirstOrThrow()).publishedAt);
  assert.equal(await queue.getWaitingCount(), 1);
  checked('compiled-dispatcher-durable-handoff');
  await stop(worker);
  worker = launch(
    'dispatcher-restart',
    ['apps/worker/dist/index.js'],
    workerEnv,
  );
  await ready(worker, `http://127.0.0.1:${metricsPort}/metrics`);
  await pause(1200);
  assert.equal(worker.ended, false);
  assert.equal(await queue.getWaitingCount(), 1);
  assert.equal((await db.outboxEvent.findFirstOrThrow()).attempts, 1);
  await stop(api);
  api = launch('api-restart', ['apps/api/dist/index.js'], apiEnv);
  await ready(api, apiOrigin + '/health');
  assert.equal((await get(webOrigin + '/auth/me')).status, 401);
  checked('process-restarts-preserve-handoff-and-proxy');
  const hashes = {};
  for (const path of [
    'package-lock.json',
    'apps/api/dist/index.js',
    'apps/worker/dist/index.js',
    'apps/web/.next/BUILD_ID',
  ])
    hashes[path] = createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
  report.artifactHashes = hashes;
  report.rehearsalSourceHashes = Object.fromEntries(
    ['scripts/rehearse-release.mjs', 'ops/release/compose.yaml'].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ]),
  );
  report.commit = command('git', ['rev-parse', 'HEAD']).trim();
  report.workingTreeDirty =
    command('git', ['status', '--porcelain']).trim().length > 0;
  report.buildId = readFileSync(
    join(root, 'apps/web/.next/BUILD_ID'),
    'utf8',
  ).trim();
  report.totalMs = Math.round(performance.now() - started);
} catch {
  report.status = 'failed';
  process.exitCode = 1;
  console.error(
    'Release rehearsal failed; inspect the recorded completed checks. No runtime secrets were published.',
  );
} finally {
  const cleanup = [];
  for (const item of [...processes].reverse()) {
    try {
      await stop(item);
    } catch {
      cleanup.push(item.name);
    }
  }
  try {
    await queue?.close();
    await db?.$disconnect();
  } catch {
    cleanup.push('clients');
  }
  // Compose still requires interpolation even for down; the placeholder is unused.
  environment.RELEASE_DB_PASSWORD = 'cleanup-unused';
  if (infra)
    try {
      docker(['down', '--volumes', '--remove-orphans']);
    } catch {
      cleanup.push('generated-infrastructure');
    }
  try {
    if (buildOwned) rmSync(webBuild, { recursive: true, force: true });
    if (previousBuildSaved) renameSync(previousBuild, webBuild);
    writeFileSync(declaration, originalDeclaration);
  } catch {
    cleanup.push('previous-dashboard-build');
  }
  rmSync(lock, { recursive: true, force: true });
  report.cleanupFailures = cleanup;
  report.cleanup = cleanup.length ? 'failed' : 'passed';
  if (cleanup.length) {
    report.status = 'failed';
    process.exitCode = 1;
  } else if (report.status !== 'failed') {
    report.checks.push('graceful-shutdown-and-isolated-cleanup');
    report.status = 'passed';
  }
  save();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
console.log(`Release rehearsal report: ${destination}`);
