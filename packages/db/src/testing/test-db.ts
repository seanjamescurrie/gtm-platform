const DEFAULT_TEST_DATABASE_URL = 'postgres://gtm:gtm@localhost:5432/gtm_test';

// Integration tests truncate tables, so refuse any database that isn't clearly a test one.
export function getTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point at a database ending in "_test", got "${name}"`);
  }
  return url;
}
