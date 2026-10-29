import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisConnection } from '../redis.js';
import { redisCacheStore } from './cache-store.js';
import { CACHE_TTL_NOT_FOUND_MS, CACHE_TTL_OK_MS, cachedFetch } from './cached-fetch.js';
import { requestCacheKey } from './request-key.js';

// Real Valkey; only the API is faked. Every test uses its own URL, so its own key.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const log = pino({ level: 'silent' });
const a = createRedisConnection(REDIS_URL, { logger: log });
const b = createRedisConnection(REDIS_URL, { logger: log });

const keys: string[] = [];
function uniqueUrl(): string {
  const url = `https://api.example.com/test/${randomUUID()}?size=2`;
  keys.push(requestCacheKey('GET', url));
  return url;
}

function api(status = 200, body = '{"ok":true}') {
  return vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response(status === 204 ? null : body, { status })),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  if (keys.length > 0) await a.del(...keys.splice(0));
});
afterAll(async () => {
  await Promise.allSettled([a.quit(), b.quit()]);
});

describe('cachedFetch (Valkey)', () => {
  it('a second call is answered from Valkey', async () => {
    const fetch = api();
    const cached = cachedFetch(fetch, redisCacheStore(a), { log });
    const url = uniqueUrl();

    const first = await cached(url);
    const second = await cached(url);

    expect(fetch).toHaveBeenCalledOnce();
    expect(first.headers.get('x-cache')).toBe('miss');
    expect(second.headers.get('x-cache')).toBe('hit');
    await expect(second.text()).resolves.toBe('{"ok":true}');
  });

  it('two connections (two workers) share entries', async () => {
    const fetchA = api();
    const fetchB = api();
    const url = uniqueUrl();

    await cachedFetch(fetchA, redisCacheStore(a), { log })(url);
    const response = await cachedFetch(fetchB, redisCacheStore(b), { log })(url);

    expect(fetchB).not.toHaveBeenCalled();
    expect(response.headers.get('x-cache')).toBe('hit');
  });

  it('sets a 24-hour expiry on a 200 and a 1-hour expiry on a 404', async () => {
    const ok = uniqueUrl();
    const missing = uniqueUrl();

    await cachedFetch(api(200), redisCacheStore(a), { log })(ok);
    await cachedFetch(api(404, ''), redisCacheStore(a), { log })(missing);

    const okTtl = await a.pttl(requestCacheKey('GET', ok));
    const missingTtl = await a.pttl(requestCacheKey('GET', missing));
    expect(okTtl).toBeGreaterThan(CACHE_TTL_OK_MS - 5_000);
    expect(okTtl).toBeLessThanOrEqual(CACHE_TTL_OK_MS);
    expect(missingTtl).toBeGreaterThan(CACHE_TTL_NOT_FOUND_MS - 5_000);
    expect(missingTtl).toBeLessThanOrEqual(CACHE_TTL_NOT_FOUND_MS);
  });

  it('an entry that has expired is fetched again', async () => {
    const fetch = api();
    const cached = cachedFetch(fetch, redisCacheStore(a), { log, ttlForStatus: () => 100 });
    const url = uniqueUrl();

    await cached(url);
    await sleep(150);
    const response = await cached(url);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.headers.get('x-cache')).toBe('miss');
  });

  it('nothing is written for a status that is never cached', async () => {
    const url = uniqueUrl();

    await cachedFetch(api(500, 'down'), redisCacheStore(a), { log })(url);

    expect(await a.exists(requestCacheKey('GET', url))).toBe(0);
  });

  it('fails open when Valkey is unreachable', async () => {
    const closed = createRedisConnection('redis://127.0.0.1:1', { logger: log });
    closed.disconnect();
    const fetch = api();
    const cached = cachedFetch(fetch, redisCacheStore(closed), { log });

    const response = await cached(uniqueUrl());

    expect(fetch).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });
});
