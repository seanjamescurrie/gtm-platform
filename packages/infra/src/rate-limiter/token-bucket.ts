import { readFileSync } from 'node:fs';
import type { RedisConnection } from '../redis.js';
import { z } from 'zod';

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

const TOKEN_SCRIPT = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf-8');

const optionsSchema = z.object({
  key: z.string().min(1),
  capacity: z.number().int().min(1),
  refillPerSecond: z.number().positive(),
});

// The script's reply is another system's answer, so check its shape before trusting it.
// tokensLeft arrives as a string because Lua would cut a fraction to an integer on return.
const responseSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.number().int(),
  z.string().refine((value) => Number.isFinite(Number(value)), 'must be a finite number'),
]);

/**
 * A token bucket whose state lives in Valkey, so every worker using the same key shares one budget.
 * Throws at once if the options are invalid.
 */
export function createTokenBucket(
  connection: RedisConnection,
  options: TokenBucketOptions,
): TokenBucket {
  const valid = optionsSchema.parse(options);

  const { key, capacity, refillPerSecond } = valid;

  return {
    key,
    async take(cost = 1) {
      if (cost <= 0 || !Number.isInteger(cost) || cost > capacity) {
        throw new Error(`cost must be a whole number from 1 to ${capacity}, got ${cost}`);
      }
      const response = await connection.eval(TOKEN_SCRIPT, 1, key, capacity, refillPerSecond, cost);

      const [allowed, retryAfterMs, tokensLeft] = responseSchema.parse(response);

      return {
        allowed: allowed === 1,
        retryAfterMs,
        tokensLeft: Number(tokensLeft),
      };
    },
  };
}
