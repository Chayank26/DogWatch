/** Production composition. No fixture permission or credential callback is exposed. */
import { createPrivateKey } from 'node:crypto';
import {
  createGitHubExecutionAuthority,
  parsePolicies,
} from '@dogwatch/github';
import type { createDatabase } from '@dogwatch/database';
import { createApiConfiguration } from './api-configuration.js';
import { runApiExecution } from './api-supervisor.js';
import type { RunJob } from '@dogwatch/queue';

export function consumerSettings(env: NodeJS.ProcessEnv) {
  if (!env.API_CONSUMER_ENABLED || env.API_CONSUMER_ENABLED === 'false')
    return null;
  if (env.API_CONSUMER_ENABLED !== 'true')
    throw Error('api_consumer_invalid_flag');
  const appId = Number(env.GITHUB_APP_ID);
  const {
    API_EXECUTION_CONFIG_FILE: configFile,
    GITHUB_POLICIES_FILE: policyFile,
    GITHUB_PRIVATE_KEY_FILE: keyFile,
  } = env;
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !configFile ||
    !policyFile ||
    !keyFile ||
    !env.DATABASE_URL ||
    !env.REDIS_URL
  )
    throw Error('api_consumer_configuration_required');
  return { appId, configFile, policyFile, keyFile };
}
async function readBounded(path: string, limit: number) {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw Error('configuration_too_large');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}
export function createApiProcessor(
  db: ReturnType<typeof createDatabase>,
  configuration: ReturnType<typeof createApiConfiguration>,
  authority: Parameters<typeof runApiExecution>[2],
  signal: AbortSignal,
  execute = runApiExecution,
) {
  return async (job: RunJob) => {
    try {
      signal.throwIfAborted();
      const run = await db.run.findFirst({
        where: { id: job.runId, tenantId: job.tenantId },
      });
      if (
        !run ||
        ['completed', 'failed', 'cancelled', 'superseded'].includes(run.state)
      )
        return { status: 'inactive' };
      // Redis can deliver before the dispatcher's database transaction commits.
      if (run.state === 'received') throw Error('dispatch_pending');
      const input = configuration({
        tenantId: run.tenantId,
        runId: run.id,
        repositoryId: Number(run.repositoryId),
        pullRequestNumber: run.pullRequestNumber,
        headSha: run.headSha,
      });
      if (!input) throw Error('configuration_missing');
      const outcome = await execute(db, input, authority, { signal });
      if (outcome.status === 'not_authorized')
        throw Error('authority_unavailable');
      return outcome;
    } catch {
      // BullMQ saves exception text. Never persist raw provider/configuration errors.
      throw Error('api_execution_unavailable');
    }
  };
}
export async function configureApiConsumer(
  db: ReturnType<typeof createDatabase>,
  settings: NonNullable<ReturnType<typeof consumerSettings>>,
  signal: AbortSignal,
) {
  try {
    const configuration = createApiConfiguration(
      JSON.parse(await readBounded(settings.configFile, 8 * 1024 * 1024)),
    );
    const loadPolicies = async () =>
      JSON.parse(await readBounded(settings.policyFile, 1024 * 1024));
    parsePolicies(await loadPolicies());
    const key = await readBounded(settings.keyFile, 65536);
    if (createPrivateKey(key).asymmetricKeyType !== 'rsa')
      throw Error('invalid_app_key');
    const authority = createGitHubExecutionAuthority(
      db,
      loadPolicies,
      settings.appId,
      key,
    );
    return createApiProcessor(db, configuration, authority, signal);
  } catch {
    throw Error('api_consumer_configuration_invalid');
  }
}
