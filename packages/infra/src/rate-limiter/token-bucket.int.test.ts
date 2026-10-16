import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRedisConnection } from '../redis.js';
import { createTokenBucket, type TokenBucketOptions } from './token-bucket.js';

// Real Valkey: the bucket is a Lua script, so only Valkey can run it. Each test uses its own key.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const logger = pino({ level: 'silent' });
const a = createRedisConnection(REDIS_URL, { logger });
const b = createRedisConnection(REDIS_URL, { logger });

const keys: string[] = [];
function bucketOptions(capacity: number, refillPerSecond: number): TokenBucketOptions {
  const key = `test:ratelimit:${randomUUID()}`;
  keys.push(key);
  return { key, capacity, refillPerSecond };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A refill rate so slow that nothing refills during a test.
const NO_REFILL = 0.001;

afterEach(async () => {
  if (keys.length > 0) await a.del(...keys.splice(0));
});
afterAll(async () => {
  await Promise.allSettled([a.quit(), b.quit()]);
});

describe('token bucket (Valkey)', () => {
  it('a fresh bucket allows exactly `capacity` takes, then refuses', async () => {
    const bucket = createTokenBucket(a, bucketOptions(3, NO_REFILL));

    const results = [];
    for (let i = 0; i < 4; i++) results.push((await bucket.take()).allowed);

    expect(results).toEqual([true, true, true, false]);
  });

  it('reports how long until a token is available, rounded up', async () => {
    // 2 tokens per second: an empty bucket has its next token in 500 ms.
    const bucket = createTokenBucket(a, bucketOptions(1, 2));

    await bucket.take();
    const refused = await bucket.take();

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(400);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(500);
    expect(Number.isInteger(refused.retryAfterMs)).toBe(true);
  });

  it('an allowed take reports no wait and the tokens left', async () => {
    const bucket = createTokenBucket(a, bucketOptions(3, NO_REFILL));

    const result = await bucket.take();

    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
    expect(result.tokensLeft).toBeCloseTo(2, 2);
  });

  it('a cost above 1 takes that many tokens', async () => {
    const bucket = createTokenBucket(a, bucketOptions(3, NO_REFILL));

    const result = await bucket.take(2);

    expect(result.allowed).toBe(true);
    expect(result.tokensLeft).toBeCloseTo(1, 2);
    expect((await bucket.take(2)).allowed).toBe(false);
  });

  it('refills over time', async () => {
    // 10 tokens per second: after 250 ms an empty bucket holds about 2.5, capped at the capacity of 2.
    const bucket = createTokenBucket(a, bucketOptions(2, 10));
    await bucket.take();
    await bucket.take();
    expect((await bucket.take()).allowed).toBe(false);

    await sleep(250);

    expect((await bucket.take()).allowed).toBe(true);
  });

  it('never refills above the capacity, however long it sits idle', async () => {
    // 20 tokens per second for 300 ms would be 6 tokens, but the capacity is 2.
    const bucket = createTokenBucket(a, bucketOptions(2, 20));
    await bucket.take();

    await sleep(300);

    const results = [];
    for (let i = 0; i < 3; i++) results.push((await bucket.take()).allowed);
    expect(results).toEqual([true, true, false]);
  });

  it('keeps fractional tokens between calls', async () => {
    // 2 tokens per second: 150 ms after emptying, the bucket holds about 0.3 of a token.
    const bucket = createTokenBucket(a, bucketOptions(1, 2));
    await bucket.take();

    await sleep(150);
    const refused = await bucket.take();

    expect(refused.allowed).toBe(false);
    // If the fraction had been lost, the wait would be back at about 500 ms and tokensLeft 0.
    expect(refused.tokensLeft).toBeGreaterThan(0.1);
    expect(refused.tokensLeft).toBeLessThan(0.9);
    expect(refused.retryAfterMs).toBeLessThan(450);
  });

  it('two connections on the same key share one budget', async () => {
    const options = bucketOptions(3, NO_REFILL);
    const onA = createTokenBucket(a, options);
    const onB = createTokenBucket(b, options);

    await onA.take();
    await onA.take();

    expect((await onB.take()).allowed).toBe(true);
    expect((await onB.take()).allowed).toBe(false);
  });

  it('50 takes at once, over two connections, allow exactly the capacity', async () => {
    const options = bucketOptions(10, NO_REFILL);
    const onA = createTokenBucket(a, options);
    const onB = createTokenBucket(b, options);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? onA : onB).take()),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('different keys are independent', async () => {
    const first = createTokenBucket(a, bucketOptions(1, NO_REFILL));
    const second = createTokenBucket(a, bucketOptions(1, NO_REFILL));

    await first.take();

    expect((await second.take()).allowed).toBe(true);
  });

  it('expires the key once the bucket would be full again', async () => {
    // Capacity 2 at 10 per second: one token short, so full again in 100 ms.
    const options = bucketOptions(2, 10);
    const bucket = createTokenBucket(a, options);
    await bucket.take();

    const ttl = await a.pttl(options.key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);

    await sleep(150);
    expect(await a.exists(options.key)).toBe(0);
  });

  it('a bucket whose key expired starts full again', async () => {
    const options = bucketOptions(2, 10);
    const bucket = createTokenBucket(a, options);
    await bucket.take();
    await bucket.take();

    await sleep(250);

    const results = [];
    for (let i = 0; i < 3; i++) results.push((await bucket.take()).allowed);
    expect(results).toEqual([true, true, false]);
  });
});
