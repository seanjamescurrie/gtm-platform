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

// rediss:// is Redis over TLS, which ElastiCache for Valkey uses in production.
const redisUrlSchema = z.url({
  protocol: /^rediss?$/,
  error: 'must be a redis:// or rediss:// URL',
});

export function getRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const result = redisUrlSchema.safeParse(env.REDIS_URL);
  if (!result.success) {
    // Never echo the value: it can contain a password.
    const reason = env.REDIS_URL ? (result.error.issues[0]?.message ?? 'invalid') : 'is not set';
    throw new Error(`REDIS_URL ${reason}`);
  }
  return result.data;
}

/**
 * Where the response cache (#11) lives. Defaults to REDIS_URL, so local dev needs nothing extra.
 * In production it can point at a separate cluster that is allowed to evict old entries, which the
 * BullMQ instance must never do (it runs with `noeviction`).
 */
export function getRedisCacheUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Empty counts as unset, like API_PORT: `REDIS_CACHE_URL=` in .env means "use the default".
  if (env.REDIS_CACHE_URL === undefined || env.REDIS_CACHE_URL === '') return getRedisUrl(env);

  const result = redisUrlSchema.safeParse(env.REDIS_CACHE_URL);
  if (!result.success) {
    // Never echo the value: it can contain a password.
    throw new Error(`REDIS_CACHE_URL ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  return result.data;
}

// Long enough that guessing it over HTTP basic auth isn't practical. Not a substitute for real auth.
const QUEUE_DASHBOARD_PASSWORD_MIN_LENGTH = 12;
const queueDashboardPassword = z.string().min(QUEUE_DASHBOARD_PASSWORD_MIN_LENGTH, {
  error: `must be at least ${QUEUE_DASHBOARD_PASSWORD_MIN_LENGTH} characters`,
});

/**
 * The password for the API's queue dashboard (#12). Unset or empty means the dashboard is off:
 * not mounted, and the API doesn't connect to Valkey for it.
 */
export function getQueueDashboardPassword(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.QUEUE_DASHBOARD_PASSWORD;
  if (raw === undefined || raw === '') return undefined;

  const result = queueDashboardPassword.safeParse(raw);
  if (!result.success) {
    // Never echo the value, or even its length: either would help someone guess it.
    throw new Error(`QUEUE_DASHBOARD_PASSWORD ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  return result.data;
}
