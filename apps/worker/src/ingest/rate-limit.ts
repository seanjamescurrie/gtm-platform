import type { TokenBucket, TokenBucketOptions } from '@gtm/infra';
import type { Logger } from 'pino';

/**
 * Companies House allows 600 requests per 5 minutes per API key: 2 per second. We refill at 90%
 * of that (1.8/s) to leave headroom for manual calls and smoke tests, and cap bursts at 10.
 * Every worker uses the same key, so they all share this one budget.
 */
export const COMPANIES_HOUSE_RATE_LIMIT: TokenBucketOptions = {
  key: 'ratelimit:companies-house',
  capacity: 10,
  refillPerSecond: 1.8,
};

// Well under the client's 10 s request timeout, which is already running while a request waits.
export const COMPANIES_HOUSE_MAX_WAIT_MS = 5_000;

/**
 * Wrap a bucket so every refusal is logged. A decorator, like rateLimitedFetch itself: the
 * limiter's code stays free of logging, and the worker decides what to record.
 */
export function loggingBucket(bucket: TokenBucket, log: Logger): TokenBucket {
  return {
    key: bucket.key,
    async take(cost) {
      const result = await bucket.take(cost);
      if (!result.allowed) {
        log.info(
          { key: bucket.key, retryAfterMs: result.retryAfterMs, tokensLeft: result.tokensLeft },
          'rate limiter: waiting for a token',
        );
      }
      return result;
    },
  };
}
