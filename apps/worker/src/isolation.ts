/**
 * Trusted host-side Docker supervisor. The sandbox never receives daemon access,
 * host mounts, a shell command, configuration secrets, or arbitrary repository code.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const sandboxImage = 'dogwatch-sandbox:phase-2.7';
export const sandboxTaskSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  kind: z.enum(['probe', 'timeout_probe']),
});
export type SandboxTask = z.infer<typeof sandboxTaskSchema>;
export const isolationEvidenceSchema = z.strictObject({
  nonRoot: z.literal(true),
  noCapabilities: z.literal(true),
  noNewPrivileges: z.literal(true),
  rootWriteDenied: z.literal(true),
  dockerSocketAbsent: z.literal(true),
  tmpWritable: z.literal(true),
  tmpFresh: z.literal(true),
  metadataBlocked: z.literal(true),
  controlSecretsAbsent: z.literal(true),
});
export type SandboxOutcome =
  | { status: 'verified'; evidence: z.infer<typeof isolationEvidenceSchema> }
  | {
      status: 'failed';
      code:
        | 'sandbox_timeout'
        | 'sandbox_cancelled'
        | 'sandbox_unavailable'
        | 'sandbox_invalid_evidence'
        | 'sandbox_cleanup_failed';
    };

/** Pure argv builder: fixed restrictions cannot be overridden by task JSON. */
export function sandboxCreateArguments(
  name: string,
  imageId: string,
): string[] {
  if (
    !/^dogwatch-sandbox-[a-f0-9-]{36}$/.test(name) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId)
  )
    throw new Error('Invalid sandbox identity');
  return [
    'create',
    '--name',
    name,
    '--label',
    'dogwatch.managed=sandbox',
    '--interactive',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--user=10001:10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    '--cpus=0.5',
    '--memory=128m',
    '--memory-swap=128m',
    '--pids-limit=32',
    '--ulimit=nofile=256:256',
    '--ulimit=core=0:0',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777',
    '--log-driver=none',
    '--restart=no',
    '--init',
    imageId,
  ];
}

/** Bounded argv-only subprocess. Raw Docker diagnostics never become results/logs. */
function docker(
  args: string[],
  options: { signal?: AbortSignal; stdin?: string; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      {
        timeout: options.timeout ?? 15000,
        signal: options.signal,
        maxBuffer: 16384,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    // Handle early CLI exit without an unhandled EPIPE on its input stream.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
  });
}

/**
 * Create/attach/remove a single unique container. Deadline/cancellation kill the
 * attachment and removal forcibly stops the container; a CLI kill alone is insufficient.
 * This helper verifies infrastructure only; it never marks a product run completed.
 */
export async function runIsolatedProbe(
  taskInput: SandboxTask,
  options: {
    signal?: AbortSignal;
    maxRuntimeSeconds?: number;
    // Verification may inspect the created container; no such hook runs inside it.
    onCreated?: (name: string) => Promise<void>;
  } = {},
): Promise<SandboxOutcome> {
  const task = sandboxTaskSchema.parse(taskInput);
  const seconds = z
    .number()
    .int()
    .min(1)
    .max(60)
    .parse(options.maxRuntimeSeconds ?? 10);
  if (options.signal?.aborted)
    return { status: 'failed', code: 'sandbox_cancelled' };
  const name = `dogwatch-sandbox-${randomUUID()}`;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), seconds * 1000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let outcome: SandboxOutcome;
  try {
    // Resolve once and create by content ID, so a later tag change cannot replace
    // the image between inspect and start. Operators build the trusted image first.
    const imageId = (
      await docker(['image', 'inspect', '--format', '{{.Id}}', sandboxImage], {
        signal,
      })
    ).trim();
    await docker(sandboxCreateArguments(name, imageId), { signal });
    if (options.onCreated) {
      // The host diagnostic hook is bounded by the same deadline as execution.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('Sandbox stopped'));
        if (signal.aborted) reject(new Error('Sandbox stopped'));
        else signal.addEventListener('abort', abort, { once: true });
        options.onCreated!(name)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    }
    const output = await docker(['start', '--attach', '--interactive', name], {
      signal,
      stdin: JSON.stringify(task),
      timeout: seconds * 1000,
    });
    const evidence = isolationEvidenceSchema.safeParse(JSON.parse(output));
    outcome = evidence.success
      ? { status: 'verified', evidence: evidence.data }
      : { status: 'failed', code: 'sandbox_invalid_evidence' };
  } catch {
    outcome = {
      status: 'failed',
      code: options.signal?.aborted
        ? 'sandbox_cancelled'
        : deadline.signal.aborted
          ? 'sandbox_timeout'
          : 'sandbox_unavailable',
    };
  } finally {
    clearTimeout(timer);
    // Cleanup deliberately has its own bounded timeout rather than the now-aborted
    // task signal. Remove only the exact random container owned by this invocation.
    try {
      await docker(['rm', '--force', name], { timeout: 15000 });
    } catch {
      // Inspect failure also fails closed: inability to prove absence is an orphan risk.
      try {
        const names = await docker([
          'ps',
          '--all',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ]);
        if (names.trim())
          outcome = { status: 'failed', code: 'sandbox_cleanup_failed' };
      } catch {
        outcome = { status: 'failed', code: 'sandbox_cleanup_failed' };
      }
    }
  }
  return outcome!;
}
