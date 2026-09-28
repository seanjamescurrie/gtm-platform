import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One run for the whole repo; switch to `projects` when a package needs a different environment (e.g. the dashboard).
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Integration tests need Docker; they run via `pnpm test:int` (vitest.int.config.ts).
    exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
    env: { LOG_LEVEL: 'silent' },
  },
});
