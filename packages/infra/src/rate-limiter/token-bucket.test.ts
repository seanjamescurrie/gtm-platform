import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createRedisConnection, type RedisConnection } from '../redis.js';
import { createTokenBucket, type TokenBucketOptions } from './token-bucket.js';

// No Valkey needed: these check what happens before (or instead of) talking to it.
const logger = pino({ level: 'silent' });
const options: TokenBucketOptions = { key: 'test:ratelimit:unit', capacity: 3, refillPerSecond: 1 };

function closedConnection(): RedisConnection {
  // Port 1 is never Valkey, and disconnecting at once makes every command reject immediately.
  const connection = createRedisConnection('redis://127.0.0.1:1', { logger });
  connection.disconnect();
  return connection;
}

// A stand-in that only implements `eval`, returning whatever the test wants Valkey to have said.
function connectionReplying(reply: unknown): RedisConnection {
  // The bucket only calls `eval`; a full ioredis client isn't needed to test reply validation.
  return { eval: () => Promise.resolve(reply) } as unknown as RedisConnection;
}

describe('createTokenBucket options', () => {
  it('accepts valid options', () => {
    expect(createTokenBucket(closedConnection(), options).key).toBe('test:ratelimit:unit');
  });

  it('rejects an empty key', () => {
    expect(() => createTokenBucket(closedConnection(), { ...options, key: '' })).toThrow(/key/);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a capacity of %s', (capacity) => {
    expect(() => createTokenBucket(closedConnection(), { ...options, capacity })).toThrow(
      /capacity/,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a refill rate of %s',
    (refillPerSecond) => {
      expect(() => createTokenBucket(closedConnection(), { ...options, refillPerSecond })).toThrow(
        /refill/,
      );
    },
  );
});

describe('take', () => {
  it.each([0, -1, 1.5, 4])(
    'rejects a cost of %s (it must be a whole number from 1 to the capacity)',
    async (cost) => {
      const bucket = createTokenBucket(closedConnection(), options);

      await expect(bucket.take(cost)).rejects.toThrow(/cost/);
    },
  );

  it('fails closed: when Valkey is unreachable, take rejects instead of allowing', async () => {
    const bucket = createTokenBucket(closedConnection(), options);

    await expect(bucket.take()).rejects.toThrow();
  });

  it('turns a valid reply into a result, parsing the fractional tokens', async () => {
    const bucket = createTokenBucket(connectionReplying([0, 350, '0.3']), options);

    await expect(bucket.take()).resolves.toEqual({
      allowed: false,
      retryAfterMs: 350,
      tokensLeft: 0.3,
    });
  });

  it.each([
    ['not an array', 'OK'],
    ['too short', [1, 0]],
    ['allowed is not 0 or 1', [2, 0, '1']],
    ['the wait is not a whole number', [0, 1.5, '1']],
    ['tokens left is not a string (Lua would have truncated it)', [1, 0, 1]],
    ['tokens left is not a number', [1, 0, 'lots']],
  ])('rejects a reply where %s', async (_label, reply) => {
    const bucket = createTokenBucket(connectionReplying(reply), options);

    await expect(bucket.take()).rejects.toThrow();
  });
});
