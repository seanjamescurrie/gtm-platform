import type { TokenBucket } from './token-bucket.js';

/**
 * Thrown when a request would have to wait longer than `maxWaitMs` for a token. `retryAt` is when
 * the bucket expects to have one, so the caller can hand the work back until then.
 */
export class RateLimitExceededError extends Error {
  readonly key: string;
  readonly retryAt: Date;

  constructor(key: string, retryAt: Date) {
    super(`Rate limit exceeded for key ${key}, retry at ${retryAt.toISOString()}`);
    this.name = 'RateLimitExceededError';
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
  const {
    maxWaitMs,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;
  if (maxWaitMs < 0 || !Number.isFinite(maxWaitMs)) {
    throw new Error(`maxWaitMs must be 0 or more, got ${maxWaitMs}`);
  }

  return async (input, init) => {
    const deadline = now() + maxWaitMs;
    for (;;) {
      init?.signal?.throwIfAborted();
      const result = await bucket.take();
      const nowMs = now();
      if (result.allowed) {
        return fetch(input, init);
      }
      const waitEndsAt = result.retryAfterMs + nowMs;
      if (waitEndsAt > deadline) {
        throw new RateLimitExceededError(bucket.key, new Date(waitEndsAt));
      }
      await sleep(result.retryAfterMs);
    }
  };
}
