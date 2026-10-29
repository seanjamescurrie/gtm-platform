import { createHash } from 'node:crypto';

// Bump the version to abandon every entry at once (e.g. if the stored format changes): old keys
// are never read again and expire on their own.
export const CACHE_KEY_PREFIX = 'cache:http:v1:';

/**
 * The cache key for a request: the method and the URL, normalised so that requests meaning the
 * same thing share a key, then hashed.
 *
 * - Normalised: host lower-cased, default port dropped, an empty `?` removed (all done by `URL`);
 *   query parameters sorted by name; the `#fragment` dropped, since it is never sent to the server.
 * - Not normalised: the path (`/a` and `/a/` can differ on a server), and the order of a repeated
 *   parameter's values (`?x=1&x=2` may mean something different from `?x=2&x=1`).
 * - Hashed: keys stay short whatever the URL's length, and nothing from the URL (which can carry
 *   search terms or identifiers) is readable in Valkey.
 * - Headers are never part of the key, so `Authorization` can't leak into it.
 */
export function requestCacheKey(method: string, url: string | URL): string {
  // Throws on a relative URL: without a host, two different APIs could share a key.
  const normalised = new URL(url);
  // sort() also re-serialises the query, so `,` and `%2C`, or `+` and `%20`, come out the same.
  normalised.searchParams.sort();
  normalised.hash = '';

  const canonical = `${method.toUpperCase()} ${normalised.toString()}`;
  return CACHE_KEY_PREFIX + createHash('sha256').update(canonical).digest('hex');
}
