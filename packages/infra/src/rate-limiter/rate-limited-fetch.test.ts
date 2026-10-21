import { describe, expect, it, vi } from 'vitest';
import { RateLimitExceededError, rateLimitedFetch } from './rate-limited-fetch.js';
import type { TakeResult, TokenBucket } from './token-bucket.js';

const KEY = 'ratelimit:test';
const URL_ = 'https://api.example.com/things';

const allowed: TakeResult = { allowed: true, retryAfterMs: 0, tokensLeft: 1 };
function refused(retryAfterMs: number): TakeResult {
  return { allowed: false, retryAfterMs, tokensLeft: 0.2 };
}

// A fake bucket that answers each take() with the next result in the list, a fake fetch, and a
// fake clock that only moves when the code sleeps. Nothing waits in real time.
function setup(results: TakeResult[], maxWaitMs = 5_000) {
  let nowMs = 1_000_000;
  const take = vi.fn<TokenBucket['take']>();
  for (const result of results) take.mockResolvedValueOnce(result);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
  const sleep = vi.fn((ms: number) => {
    nowMs += ms;
    return Promise.resolve();
  });
  const limited = rateLimitedFetch(
    fetch,
    { key: KEY, take },
    {
      maxWaitMs,
      sleep,
      now: () => nowMs,
    },
  );
  return { limited, take, fetch, sleep, now: () => nowMs };
}

describe('rateLimitedFetch', () => {
  describe('with a token', () => {
    it('takes a token, then calls fetch once with the same arguments', async () => {
      const { limited, take, fetch, sleep } = setup([allowed]);
      const init: RequestInit = { method: 'GET', headers: { Authorization: 'Basic x' } };

      await limited(URL_, init);

      expect(take).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledExactlyOnceWith(URL_, init);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("returns fetch's response unchanged", async () => {
      const { limited, fetch } = setup([allowed]);
      const response = new Response('the body', { status: 201 });
      fetch.mockResolvedValue(response);

      await expect(limited(URL_)).resolves.toBe(response);
    });

    it("rejects with fetch's own error unchanged", async () => {
      const { limited, fetch } = setup([allowed]);
      const error = new TypeError('fetch failed');
      fetch.mockRejectedValue(error);

      await expect(limited(URL_)).rejects.toBe(error);
    });
  });

  describe('waiting for a token', () => {
    it('sleeps for the wait the bucket reports, then fetches', async () => {
      const { limited, take, fetch, sleep } = setup([refused(200), allowed]);

      await limited(URL_);

      expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
      expect(take).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('keeps waiting while the total stays within maxWaitMs (another worker may take the token first)', async () => {
      const { limited, fetch, sleep } = setup([refused(100), refused(100), allowed], 500);

      await limited(URL_);

      expect(sleep.mock.calls).toEqual([[100], [100]]);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('allows a wait that ends exactly at the deadline', async () => {
      const { limited, fetch } = setup([refused(200), allowed], 200);

      await limited(URL_);

      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  describe('giving up', () => {
    it('throws RateLimitExceededError at once when the wait is longer than maxWaitMs', async () => {
      const { limited, fetch, sleep, now } = setup([refused(6_000)], 5_000);
      const startedAt = now();

      const thrown = await limited(URL_).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(RateLimitExceededError);
      expect(thrown).toMatchObject({ key: KEY, retryAt: new Date(startedAt + 6_000) });
      expect(sleep).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('counts every wait against one deadline, worked out once at the start', async () => {
      // Deadline is start + 300. Sleep 200 (now start + 200); the next wait of 200 would end at
      // start + 400, past the deadline, so it gives up with retryAt = start + 400.
      const { limited, fetch, sleep, now } = setup([refused(200), refused(200)], 300);
      const startedAt = now();

      const thrown = await limited(URL_).catch((e: unknown) => e);

      expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
      expect(thrown).toMatchObject({ retryAt: new Date(startedAt + 400) });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('never waits when maxWaitMs is 0', async () => {
      const { limited, sleep } = setup([refused(1)], 0);

      await expect(limited(URL_)).rejects.toBeInstanceOf(RateLimitExceededError);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('failing closed', () => {
    it('rejects with the bucket error and never calls fetch when Valkey is unavailable', async () => {
      const { limited, take, fetch } = setup([]);
      const error = new Error('Connection is closed.');
      take.mockRejectedValue(error);

      await expect(limited(URL_)).rejects.toBe(error);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("the caller's abort signal", () => {
    it('rejects with the reason, without taking a token, when the signal has already fired', async () => {
      const { limited, take, fetch } = setup([allowed]);
      const reason = new DOMException('The operation timed out.', 'TimeoutError');

      await expect(limited(URL_, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(take).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('stops waiting, and never fetches, when the signal fires during a wait', async () => {
      // The client's request timeout is already running while we wait for a token.
      const { limited, sleep, fetch } = setup([refused(200), allowed]);
      const controller = new AbortController();
      const reason = new DOMException('The operation timed out.', 'TimeoutError');
      sleep.mockImplementationOnce(() => {
        controller.abort(reason);
        return Promise.resolve();
      });

      await expect(limited(URL_, { signal: controller.signal })).rejects.toBe(reason);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('options', () => {
    it.each([-1, Number.NaN])('rejects a maxWaitMs of %s', (maxWaitMs) => {
      const take = vi.fn<TokenBucket['take']>();
      expect(() => rateLimitedFetch(vi.fn(), { key: KEY, take }, { maxWaitMs })).toThrow(
        /maxWaitMs/,
      );
    });

    it('uses a real clock and a real sleep when none are given', async () => {
      const take = vi
        .fn<TokenBucket['take']>()
        .mockResolvedValueOnce(refused(30))
        .mockResolvedValueOnce(allowed);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
      const limited = rateLimitedFetch(fetch, { key: KEY, take }, { maxWaitMs: 1_000 });

      const startedAt = Date.now();
      await limited(URL_);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
});

describe('RateLimitExceededError', () => {
  const retryAt = new Date('2026-10-21T12:00:06.000Z');

  it('is an Error with its own name, so logs and stack traces say what it is', () => {
    const error = new RateLimitExceededError(KEY, retryAt);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RateLimitExceededError');
  });

  it('carries the key and retryAt, and names both in the message', () => {
    const error = new RateLimitExceededError(KEY, retryAt);

    expect(error).toMatchObject({ key: KEY, retryAt });
    expect(error.message).toContain(KEY);
    expect(error.message).toContain('2026-10-21T12:00:06.000Z');
  });
});
