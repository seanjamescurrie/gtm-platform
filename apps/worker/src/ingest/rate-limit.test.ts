import type { TakeResult, TokenBucket } from '@gtm/infra';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPANIES_HOUSE_MAX_WAIT_MS,
  COMPANIES_HOUSE_RATE_LIMIT,
  loggingBucket,
} from './rate-limit.js';

function setup(result: TakeResult) {
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const take = vi.fn<TokenBucket['take']>().mockResolvedValue(result);
  return { bucket: loggingBucket({ key: 'ratelimit:test', take }, log), take, lines };
}

describe('loggingBucket', () => {
  it('passes take through unchanged, cost included', async () => {
    const result: TakeResult = { allowed: true, retryAfterMs: 0, tokensLeft: 4 };
    const { bucket, take } = setup(result);

    await expect(bucket.take(2)).resolves.toBe(result);
    expect(take).toHaveBeenCalledExactlyOnceWith(2);
    expect(bucket.key).toBe('ratelimit:test');
  });

  it('logs nothing when a token is available', async () => {
    const { bucket, lines } = setup({ allowed: true, retryAfterMs: 0, tokensLeft: 4 });

    await bucket.take();

    expect(lines).toEqual([]);
  });

  it('logs the key and the wait when it has to wait', async () => {
    const { bucket, lines } = setup({ allowed: false, retryAfterMs: 420, tokensLeft: 0.24 });

    await bucket.take();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ key: 'ratelimit:test', retryAfterMs: 420, tokensLeft: 0.24 });
  });
});

describe('Companies House policy', () => {
  it('stays below 600 requests per 5 minutes, even counting one full burst', () => {
    const { capacity, refillPerSecond } = COMPANIES_HOUSE_RATE_LIMIT;

    expect(capacity + refillPerSecond * 300).toBeLessThan(600);
  });

  it('waits well inside the client request timeout of 10 s', () => {
    expect(COMPANIES_HOUSE_MAX_WAIT_MS).toBeLessThan(10_000);
  });
});
