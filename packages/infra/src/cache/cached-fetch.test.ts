import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { CacheStore } from './cache-store.js';
import { CACHE_TTL_NOT_FOUND_MS, CACHE_TTL_OK_MS, cachedFetch } from './cached-fetch.js';
import { requestCacheKey } from './request-key.js';

const URL_ = 'https://api.example.com/advanced-search/companies?sic_codes=62012&size=2';

// A store backed by a Map, recording the TTL of each write. `failing` makes every call reject.
function fakeStore() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const store = {
    get: vi.fn<CacheStore['get']>((key) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn<CacheStore['set']>((key, value, ttlMs) => {
      data.set(key, value);
      ttls.set(key, ttlMs);
      return Promise.resolve();
    }),
    del: vi.fn<CacheStore['del']>((key) => {
      data.delete(key);
      return Promise.resolve();
    }),
  };
  return { store, data, ttls };
}

function setup({
  status = 200,
  body = '{"hits":1,"items":[]}',
  headers = {},
}: { status?: number; body?: string; headers?: Record<string, string> } = {}) {
  const { store, data, ttls } = fakeStore();
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  // A fresh Response per call: a body can only be read once.
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(status === 204 ? null : body, {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    ),
  );
  const cached = cachedFetch(fetch, store, { log });
  return { cached, fetch, store, data, ttls, lines };
}

describe('cachedFetch', () => {
  describe('a miss', () => {
    it('calls fetch once and returns the same status and body', async () => {
      const { cached, fetch } = setup();

      const response = await cached(URL_);

      expect(fetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('{"hits":1,"items":[]}');
    });

    it('marks the response x-cache: miss and keeps the API headers (e.g. the rate-limit count)', async () => {
      const { cached } = setup({ headers: { 'x-ratelimit-remain': '598' } });

      const response = await cached(URL_);

      expect(response.headers.get('x-cache')).toBe('miss');
      expect(response.headers.get('x-ratelimit-remain')).toBe('598');
      expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('drops headers that describe the encoded wire bytes, since the body is now decoded text', async () => {
      const { cached } = setup({ headers: { 'content-encoding': 'gzip' } });

      const response = await cached(URL_);

      expect(response.headers.get('content-encoding')).toBeNull();
    });

    it('stores a 200 for 24 hours, under the request key', async () => {
      const { cached, data, ttls } = setup();

      await cached(URL_);

      const key = requestCacheKey('GET', URL_);
      expect(ttls.get(key)).toBe(CACHE_TTL_OK_MS);
      expect(JSON.parse(data.get(key) ?? '{}')).toMatchObject({
        status: 200,
        contentType: 'application/json',
        body: '{"hits":1,"items":[]}',
        url: URL_,
      });
    });

    it('stores a 404 for 1 hour', async () => {
      const { cached, ttls } = setup({ status: 404, body: '' });

      await cached(URL_);

      expect(ttls.get(requestCacheKey('GET', URL_))).toBe(CACHE_TTL_NOT_FOUND_MS);
    });
  });

  describe('a hit', () => {
    it('answers from the store without calling fetch', async () => {
      const { cached, fetch } = setup();
      await cached(URL_);

      const response = await cached(URL_);

      expect(fetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(response.headers.get('x-cache')).toBe('hit');
      expect(response.headers.get('content-type')).toBe('application/json');
      await expect(response.text()).resolves.toBe('{"hits":1,"items":[]}');
    });

    it('replays a 404 as a 404', async () => {
      const { cached, fetch } = setup({ status: 404, body: '' });
      await cached(URL_);

      const response = await cached(URL_);

      expect(fetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(404);
    });

    it('carries no rate-limit headers: a hit made no API call, so there is no count to report', async () => {
      const { cached } = setup({ headers: { 'x-ratelimit-remain': '598' } });
      await cached(URL_);

      const response = await cached(URL_);

      expect(response.headers.get('x-ratelimit-remain')).toBeNull();
    });

    it('is shared by requests that differ only in headers, Authorization included', async () => {
      const { cached, fetch } = setup();

      await cached(URL_, { headers: { Authorization: 'Basic one' } });
      await cached(URL_, { headers: { Authorization: 'Basic two' } });

      expect(fetch).toHaveBeenCalledOnce();
    });

    it('works when the request is a Request object', async () => {
      const { cached, fetch } = setup();

      await cached(new Request(URL_));
      await cached(URL_);

      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  describe('never cached', () => {
    it.each([201, 204, 401, 429, 500, 503])(
      'a %s: returned as it came, marked miss, and not stored',
      async (status) => {
        const { cached, fetch, store } = setup({ status, body: status === 204 ? '' : 'oops' });

        const first = await cached(URL_);
        await cached(URL_);

        expect(first.status).toBe(status);
        expect(first.headers.get('x-cache')).toBe('miss');
        if (status !== 204) await expect(first.text()).resolves.toBe('oops');
        expect(store.set).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);
      },
    );

    it.each(['POST', 'PUT', 'DELETE'])(
      'a %s: passed straight through, store untouched',
      async (method) => {
        const { cached, fetch, store } = setup();

        await cached(URL_, { method });

        expect(fetch).toHaveBeenCalledExactlyOnceWith(URL_, { method });
        expect(store.get).not.toHaveBeenCalled();
        expect(store.set).not.toHaveBeenCalled();
      },
    );

    it('a body larger than maxBodyBytes, which is still returned in full', async () => {
      const { store } = fakeStore();
      const body = 'x'.repeat(100);
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(body)));
      const cached = cachedFetch(fetch, store, {
        log: pino({ level: 'silent' }),
        maxBodyBytes: 50,
      });

      const response = await cached(URL_);

      await expect(response.text()).resolves.toBe(body);
      expect(store.set).not.toHaveBeenCalled();
    });

    it('a response whose declared content-length is too big: not even read into memory', async () => {
      const { store } = fakeStore();
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('small', { headers: { 'content-length': '999999999' } })),
      );
      const cached = cachedFetch(fetch, store, { log: pino({ level: 'silent' }) });

      const response = await cached(URL_);

      expect(response.headers.get('x-cache')).toBe('miss');
      expect(store.set).not.toHaveBeenCalled();
    });

    it('a fetch that fails: the error comes out unchanged and nothing is stored', async () => {
      const { cached, fetch, store } = setup();
      const error = new TypeError('fetch failed');
      fetch.mockRejectedValueOnce(error);

      await expect(cached(URL_)).rejects.toBe(error);
      expect(store.set).not.toHaveBeenCalled();
    });
  });

  describe('failing open', () => {
    it('calls the API when the store cannot be read', async () => {
      const { cached, fetch, store, lines } = setup();
      store.get.mockRejectedValueOnce(new Error('Connection is closed.'));

      const response = await cached(URL_);

      expect(fetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(lines.some((l) => l.msg === 'cache read failed; calling the API instead')).toBe(true);
    });

    it('still returns the response when the store cannot be written', async () => {
      const { cached, store } = setup();
      store.set.mockRejectedValueOnce(new Error('OOM command not allowed'));

      const response = await cached(URL_);

      await expect(response.text()).resolves.toBe('{"hits":1,"items":[]}');
    });

    it.each([
      ['not JSON', 'nonsense'],
      ['JSON of the wrong shape', '{"status":"200"}'],
    ])(
      'treats a corrupt entry (%s) as a miss, deletes it, and stores a good one',
      async (_label, raw) => {
        const { cached, fetch, store, data } = setup();
        const key = requestCacheKey('GET', URL_);
        data.set(key, raw);

        const response = await cached(URL_);

        expect(fetch).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
        expect(store.del).toHaveBeenCalledWith(key);
        expect(JSON.parse(data.get(key) ?? '{}')).toMatchObject({ status: 200 });
      },
    );
  });

  it('uses a custom ttlForStatus when given one', async () => {
    const { store, ttls } = fakeStore();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('created', { status: 201 })),
    );
    const cached = cachedFetch(fetch, store, {
      log: pino({ level: 'silent' }),
      ttlForStatus: (status) => (status === 201 ? 5_000 : undefined),
    });

    await cached(URL_);

    expect(ttls.get(requestCacheKey('GET', URL_))).toBe(5_000);
  });
});
