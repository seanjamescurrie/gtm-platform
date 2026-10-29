import { cachedFetch, rateLimitedFetch, type CacheStore, type TokenBucket } from '@gtm/infra';
import type { Logger } from 'pino';
import { COMPANIES_HOUSE_MAX_WAIT_MS } from './rate-limit.js';

export interface CompaniesHouseFetchDeps {
  fetch: typeof globalThis.fetch;
  bucket: Pick<TokenBucket, 'key' | 'take'>;
  cache: CacheStore;
  log: Logger;
}

/**
 * The `fetch` the Companies House client uses, built outside in:
 *
 *   cache (#11) → rate limiter (#10) → network
 *
 * The cache answers repeats first, so a hit spends no token; only a miss reaches the limiter that
 * every worker shares. Swap the two and every hit would still wait for, and spend, a token.
 */
export function companiesHouseFetch({
  fetch,
  bucket,
  cache,
  log,
}: CompaniesHouseFetchDeps): typeof globalThis.fetch {
  const limited = rateLimitedFetch(fetch, bucket, { maxWaitMs: COMPANIES_HOUSE_MAX_WAIT_MS });
  return cachedFetch(limited, cache, { log });
}
