/** Repeatable local gates; never infer a production certification from passing tests. */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2)
  throw Error('Security verification accepts no target overrides');
const stages = [
  ['application-boundaries', ['test']],
  ['database-tenant-isolation', ['run', 'db:verify:tenant-isolation']],
  ['database-session-revocation', ['run', 'db:verify:identity']],
  ['database-installation-ownership', ['run', 'db:verify:installation-link']],
  ['offline-container-isolation', ['run', 'isolation:verify']],
];
const listing = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
);
if (listing.status !== 0) throw Error('Source inventory unavailable');
const sources = [
  ...new Set(
    listing.stdout
      .split('\0')
      .filter(
        (path) =>
          /^(apps\/|packages\/|scripts\/|package(?:-lock)?\.json$|compose\.yaml$|tsconfig.base.json$)/.test(
            path,
          ) && /\.(ts|mjs|json|sql|yaml|html|css)$/.test(path),
      ),
  ),
].sort();
const digest = createHash('sha256');
for (const path of sources) {
  if (!lstatSync(join(root, path)).isFile())
    throw Error('Unexpected source file type');
  digest.update(path + '\0').update(readFileSync(join(root, path)));
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'local-current-boundaries-not-production-certification',
  sourceDigest: digest.digest('hex'),
  sources,
  node: process.version,
  stages: [],
  status: 'running',
  notValidated: [
    'live-model-injection-resistance',
    'hostile-customer-browser-egress',
    'active-QA-worker-isolation',
    'hosted-artifact-delivery',
    'production-RLS',
    'live-GitHub-OAuth',
    'cloud-IAM-TLS-secret-management',
    'dependency-vulnerability-audit',
    'penetration-test',
  ],
};
const directory = join(root, '.local/security');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const destination = join(directory, 'validation.json');
const save = () =>
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
save(); // Replace any stale success before executing gates.
for (const [name, args] of stages) {
  console.log(`Security gate: ${name}`);
  const start = performance.now();
  const result = spawnSync('npm', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const output = result.stdout ?? '';
  const tests = [...output.matchAll(/(?:#|ℹ) tests (\d+)/g)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  const skipped = [...output.matchAll(/(?:#|ℹ) skipped (\d+)/g)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  const passed =
    result.status === 0 &&
    !result.error &&
    (name !== 'application-boundaries' || (tests > 0 && skipped === 0));
  report.stages.push({
    name,
    status: passed ? 'passed' : 'failed',
    durationMs: Math.round(performance.now() - start),
    ...(name === 'application-boundaries' ? { tests, skipped } : {}),
    exitCode: result.status,
    signal: result.signal,
  });
  report.status = passed ? 'running' : 'failed';
  save();
  if (!passed) {
    console.error(
      `Gate failed: ${name}. Rerun npm ${args.join(' ')} for local diagnostics. No raw subprocess output was published.`,
    );
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  report.status = 'passed';
  save();
}
console.log(`Security report: ${destination}`);
