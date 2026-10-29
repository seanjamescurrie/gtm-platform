import type { CacheStore, TakeResult, TokenBucket } from '@gtm/infra';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { companiesHouseFetch } from './http.js';

const URL_ = 'https://api.company-information.service.gov.uk/advanced-search/companies?size=2';

function setup() {
  const data = new Map<string, string>();
  const cache: CacheStore = {
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    del: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
  const allowed: TakeResult = { allowed: true, retryAfterMs: 0, tokensLeft: 9 };
  const take = vi.fn<TokenBucket['take']>().mockResolvedValue(allowed);
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response('{"hits":0,"items":[]}', { status: 200 })),
  );
  const chFetch = companiesHouseFetch({
    fetch,
    bucket: { key: 'ratelimit:test', take },
    cache,
    log: pino({ level: 'silent' }),
  });
  return { chFetch, take, fetch };
}

describe('companiesHouseFetch', () => {
  it('a miss takes one token and makes one request', async () => {
    const { chFetch, take, fetch } = setup();

    await chFetch(URL_);

    expect(take).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('a hit takes no token and makes no request: the cache sits outside the limiter', async () => {
    const { chFetch, take, fetch } = setup();
    await chFetch(URL_);

    const response = await chFetch(URL_);

    expect(response.headers.get('x-cache')).toBe('hit');
    expect(take).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
