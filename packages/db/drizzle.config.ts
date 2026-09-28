import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs from packages/db; load the repo .env if present (existing env vars win).
try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env file: rely on the environment.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  // Only `drizzle-kit studio` connects; `generate` works offline from the schema.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
