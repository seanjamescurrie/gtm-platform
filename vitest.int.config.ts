import { defineConfig } from 'vitest/config';

// Integration tests need `docker compose up -d --wait`. Kept separate so `pnpm test` stays Docker-free.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.int.test.ts'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    env: { LOG_LEVEL: 'silent' },
    // Tests share one database, so run files one at a time.
    fileParallelism: false,
  },
});
