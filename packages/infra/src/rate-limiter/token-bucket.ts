import type { RedisConnection } from '../redis.js';

export interface TokenBucketOptions {
  // The Valkey key holding this bucket. Every worker that shares a limit uses the same key.
  key: string;
  // The most tokens the bucket holds: the largest burst it allows.
  capacity: number;
  // Tokens added per second: the steady rate it allows.
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  // How long until `cost` tokens will be available; 0 when allowed.
  retryAfterMs: number;
  // Tokens left after this call. Usually fractional.
  tokensLeft: number;
}

export interface TokenBucket {
  readonly key: string;
  take(cost?: number): Promise<TakeResult>;
}

/**
 * A token bucket whose state lives in Valkey, so every worker using the same key shares one budget.
 * Throws at once if the options are invalid.
 */
export function createTokenBucket(
  connection: RedisConnection,
  options: TokenBucketOptions,
): TokenBucket {
  // Hand-written (#10, checkpoint 1): make token-bucket.test.ts and token-bucket.int.test.ts pass.
  void connection;
  void options;
  throw new Error('createTokenBucket is not implemented yet');
}
