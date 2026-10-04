/**
 * Prisma CLI configuration. Resolve the root .env relative to this file instead
 * of the terminal's working directory. Existing shell variables take precedence.
 * Generation can run without a live DB; migrations need a real DATABASE_URL.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // This fallback matches the disposable Compose database, never a hosted service.
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
  },
});
