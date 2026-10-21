import type { TokenBucket } from './token-bucket.js';

/**
 * Thrown when a request would have to wait longer than `maxWaitMs` for a token. `retryAt` is when
 * the bucket expects to have one, so the caller can hand the work back until then.
 */
export class RateLimitExceededError extends Error {
  readonly key: string;
  readonly retryAt: Date;

  constructor(key: string, retryAt: Date) {
    // Hand-written (#10, checkpoint 2): give it a message naming the key and retryAt, and a `name`
    // (see CompaniesHouseError in @gtm/integrations for the pattern).
    super('RateLimitExceededError is not implemented yet');
    this.key = key;
    this.retryAt = retryAt;
  }
}

export interface RateLimitedFetchOptions {
  // The longest a request waits for a token before giving up with RateLimitExceededError.
  // Keep it well under the caller's request timeout: the timeout is already running while it waits.
  maxWaitMs: number;
  // Injected so tests don't wait in real time. Default: a real setTimeout.
  sleep?: (ms: number) => Promise<void>;
  // Milliseconds since 1970. Injected so tests can pin it. Default: Date.now.
  now?: () => number;
}

/**
 * Wrap `fetch` so every request first takes a token from `bucket`. Pass the result anywhere a
 * `fetch` is expected, e.g. the `fetch` option of CompaniesHouseClient.
 * Throws at once if the options are invalid.
 */
export function rateLimitedFetch(
  fetch: typeof globalThis.fetch,
  bucket: Pick<TokenBucket, 'key' | 'take'>,
  options: RateLimitedFetchOptions,
): typeof globalThis.fetch {
  // Hand-written (#10, checkpoint 2): make rate-limited-fetch.test.ts pass.
  void fetch;
  void bucket;
  void options;
  return () => Promise.reject(new Error('rateLimitedFetch is not implemented yet'));
}
