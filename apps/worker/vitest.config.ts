import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: './wrangler.jsonc' },
        // Tests drive the free path; Claude-specific behaviour is tested with an explicit provider.
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: 'test-admin-token',
            EXTRACT_MODEL: 'workers-ai',
            PUBLIC_ORIGIN: 'http://localhost',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
