/** Offline validation only: never connects to DB, Redis, GitHub or a target. */
import { open } from 'node:fs/promises';
import { createApiConfiguration } from './api-configuration.js';
try {
  const path = process.argv[2] ?? process.env.API_EXECUTION_CONFIG_FILE;
  if (!path) throw Error('configuration_path_required');
  const file = await open(path, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw Error('configuration_too_large');
    text = buffer.subarray(0, size).toString('utf8');
  } finally {
    await file.close();
  }
  const entries: unknown = JSON.parse(text);
  createApiConfiguration(entries);
  if (!Array.isArray(entries) || !entries.length)
    throw Error('configuration_empty');
  process.stdout.write(
    'API configuration valid. Offline check only; deployment identity, connectivity and GitHub authority remain unverified.\n',
  );
} catch {
  process.stderr.write(
    'API configuration invalid or unavailable. Check file access, size, exact deployment scope, supported OpenAPI, unique GET/HEAD grants and anonymous operation access.\n',
  );
  process.exitCode = 1;
}
