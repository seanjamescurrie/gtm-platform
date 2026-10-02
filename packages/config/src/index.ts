import { z } from 'zod';

// Keep env parsing here so apps never read process.env directly. getApiPort predates zod here; it moves to a schema when the full env schema lands.
const DEFAULT_API_PORT = 3000;

export function getApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.API_PORT;
  if (raw === undefined || raw === '') return DEFAULT_API_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`API_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

const databaseUrlSchema = z
  .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' })
  // zod 4 still runs refinements after a failed check, so this must not throw on non-URL input.
  .refine(
    (url) => URL.canParse(url) && new URL(url).pathname.length > 1,
    'must include a database name',
  );

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const result = databaseUrlSchema.safeParse(env.DATABASE_URL);
  if (!result.success) {
    // Never echo the value: it contains the password.
    const reason = env.DATABASE_URL ? (result.error.issues[0]?.message ?? 'invalid') : 'is not set';
    throw new Error(`DATABASE_URL ${reason}`);
  }
  return result.data;
}

const companiesHouseKey = z.uuid({ version: 'v4', error: 'must be a valid UUID v4' });

export function getCompaniesHouseApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = companiesHouseKey.safeParse(env.COMPANIES_HOUSE_API_KEY);
  if (!key.success) {
    const reason = env.COMPANIES_HOUSE_API_KEY
      ? (key.error.issues[0]?.message ?? 'invalid')
      : 'is not set';
    throw new Error(`COMPANIES_HOUSE_API_KEY ${reason}`);
  }
  return key.data;
}
