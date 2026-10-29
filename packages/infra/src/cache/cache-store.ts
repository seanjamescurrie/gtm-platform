import type { RedisConnection } from '../redis.js';

/**
 * The three things the response cache needs from a key-value store. Keeping it this small means
 * the ioredis details live in one adapter, and tests can use a Map.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export function redisCacheStore(connection: RedisConnection): CacheStore {
  return {
    get: (key) => connection.get(key),
    set: async (key, value, ttlMs) => {
      // PX: expire after this many milliseconds. Every entry gets one, since the shared Valkey
      // runs with `noeviction` and can't throw old entries away by itself.
      await connection.set(key, value, 'PX', ttlMs);
    },
    del: async (key) => {
      await connection.del(key);
    },
  };
}
