import type { Logger } from 'pino';
import { z } from 'zod';
import type { CacheStore } from './cache-store.js';
import { requestCacheKey } from './request-key.js';

export const CACHE_TTL_OK_MS = 24 * 60 * 60 * 1_000;
export const CACHE_TTL_NOT_FOUND_MS = 60 * 60 * 1_000;
export const MAX_CACHED_BODY_BYTES = 5 * 1024 * 1024;

/**
 * 200s for a day; 404s ("no matches", "no such company") for an hour, since a new company can
 * appear. Everything else (401, 429, 5xx…) describes a moment, not the data: never cached.
 */
export function defaultTtlForStatus(status: number): number | undefined {
  if (status === 200) return CACHE_TTL_OK_MS;
  if (status === 404) return CACHE_TTL_NOT_FOUND_MS;
  return undefined;
}

export interface CachedFetchOptions {
  log: Logger;
  // How long to keep a response with this status, or undefined to not cache it.
  ttlForStatus?: (status: number) => number | undefined;
  maxBodyBytes?: number;
}

// What we store. Read back from Valkey, so validated like any other boundary.
const entrySchema = z.object({
  status: z.number().int().min(200).max(599),
  contentType: z.string().nullable(),
  body: z.string(),
  // Not used to answer requests; it's there so a human can tell what a hashed key holds.
  url: z.string(),
  storedAt: z.string(),
});
type CacheEntry = z.infer<typeof entrySchema>;

// The DOM's BodyInit type isn't in this project's libs (Node only); take it from Response itself.
type ResponseBody = ConstructorParameters<typeof Response>[0];

// Headers that describe the bytes on the wire, which no longer apply once fetch has decoded the
// body into text: keeping them would describe a body this response doesn't have.
const WIRE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

function withCacheHeader(
  body: ResponseBody,
  from: Response,
  cache: 'hit' | 'miss',
  dropWireHeaders: boolean,
): Response {
  // A response from fetch has read-only headers, so build a new one around the same body.
  const headers = new Headers(from.headers);
  if (dropWireHeaders) for (const name of WIRE_HEADERS) headers.delete(name);
  headers.set('x-cache', cache);
  return new Response(body, { status: from.status, statusText: from.statusText, headers });
}

function responseFromEntry(entry: CacheEntry): Response {
  const headers = new Headers({ 'x-cache': 'hit' });
  if (entry.contentType !== null) headers.set('content-type', entry.contentType);
  return new Response(entry.body, { status: entry.status, headers });
}

function requestMethodAndUrl(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) {
  if (input instanceof Request) return { method: init?.method ?? input.method, url: input.url };
  return { method: init?.method ?? 'GET', url: input };
}

/**
 * Wrap `fetch` so a GET whose response is cacheable is answered from the store next time.
 * Put it **outside** rateLimitedFetch, so a hit doesn't spend a token.
 *
 * Fails open: if the store can't be read or written, or an entry is corrupt, the request goes to
 * the real `fetch` as if there were no cache. The cache is an optimisation, not a dependency.
 */
export function cachedFetch(
  fetch: typeof globalThis.fetch,
  store: CacheStore,
  {
    log,
    ttlForStatus = defaultTtlForStatus,
    maxBodyBytes = MAX_CACHED_BODY_BYTES,
  }: CachedFetchOptions,
): typeof globalThis.fetch {
  async function readEntry(key: string): Promise<CacheEntry | undefined> {
    let raw: string | null;
    try {
      raw = await store.get(key);
    } catch (err) {
      log.warn({ err, key }, 'cache read failed; calling the API instead');
      return undefined;
    }
    if (raw === null) return undefined;

    try {
      return entrySchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn({ err, key }, 'corrupt cache entry; deleting it and calling the API');
      await store.del(key).catch(() => undefined);
      return undefined;
    }
  }

  async function writeEntry(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    try {
      await store.set(key, JSON.stringify(entry), ttlMs);
    } catch (err) {
      log.warn({ err, key }, 'cache write failed; the response is still returned');
    }
  }

  return async (input, init) => {
    const { method, url } = requestMethodAndUrl(input, init);
    // Only reads are safe to replay.
    if (method.toUpperCase() !== 'GET') return fetch(input, init);

    const key = requestCacheKey(method, url);
    const cached = await readEntry(key);
    if (cached) return responseFromEntry(cached);

    const response = await fetch(input, init);
    const ttlMs = ttlForStatus(response.status);
    const declaredLength = Number(response.headers.get('content-length'));
    // Not cacheable, or declared too big to hold: pass the body stream through without reading it.
    if (ttlMs === undefined || declaredLength > maxBodyBytes) {
      return withCacheHeader(response.body, response, 'miss', false);
    }

    // A body can only be read once. Read it here to store it, then give the caller a fresh
    // Response built from the same text.
    const body = await response.text();
    if (Buffer.byteLength(body) <= maxBodyBytes) {
      await writeEntry(
        key,
        {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body,
          url: url.toString(),
          storedAt: new Date().toISOString(),
        },
        ttlMs,
      );
    }
    return withCacheHeader(body, response, 'miss', true);
  };
}
