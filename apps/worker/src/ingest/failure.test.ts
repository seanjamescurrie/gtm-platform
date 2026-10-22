import { RateLimitExceededError, rateLimitedFetch } from '@gtm/infra';
import { CompaniesHouseClient, CompaniesHouseError } from '@gtm/integrations';
import { RateLimitError, UnrecoverableError } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  handleIngestFailure,
  MIN_RATE_LIMIT_PAUSE_MS,
  UNKNOWN_RESET_PAUSE_MS,
  type IngestFailureDeps,
} from './failure.js';

const WHERE = 'GET /advanced-search/companies';
const NOW = new Date('2026-10-08T12:00:00Z');

function setup() {
  const pauseQueue = vi.fn<IngestFailureDeps['pauseQueue']>().mockResolvedValue(undefined);
  const deps: IngestFailureDeps = { pauseQueue, now: () => NOW, log: pino({ level: 'silent' }) };
  return { deps, pauseQueue };
}

function secondsFromNow(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1_000);
}

describe('handleIngestFailure', () => {
  describe('Companies House errors that retrying cannot fix', () => {
    it.each([
      ['unauthorized', CompaniesHouseError.unauthorized(WHERE, 401)],
      ['invalid_response', CompaniesHouseError.invalidResponse(WHERE, new Error('bad shape'))],
      ['http', CompaniesHouseError.http(WHERE, 400)],
    ])('%s fails the job now, with no more attempts', async (_kind, error) => {
      const { deps, pauseQueue } = setup();

      const thrown = await handleIngestFailure(error, deps).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect(pauseQueue).not.toHaveBeenCalled();
    });

    it('keeps the original message, so the failed job says what went wrong', async () => {
      const { deps } = setup();
      const error = CompaniesHouseError.unauthorized(WHERE, 401);

      await expect(handleIngestFailure(error, deps)).rejects.toThrow(error.message);
    });
  });

  describe('Companies House errors worth retrying', () => {
    it.each([
      ['timeout', CompaniesHouseError.timeout(WHERE, new Error('aborted'))],
      ['network', CompaniesHouseError.network(WHERE, new TypeError('fetch failed'))],
      ['server_error', CompaniesHouseError.serverError(WHERE, 503)],
    ])('%s is rethrown unchanged, so BullMQ retries with backoff', async (_kind, error) => {
      const { deps, pauseQueue } = setup();

      await expect(handleIngestFailure(error, deps)).rejects.toBe(error);
      expect(pauseQueue).not.toHaveBeenCalled();
    });
  });

  describe('rate limited (429)', () => {
    it('pauses the whole queue until retryAt', async () => {
      const { deps, pauseQueue } = setup();
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(90));

      await handleIngestFailure(error, deps).catch(() => undefined);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(90_000);
    });

    it('then throws the BullMQ rate-limit error, which returns the job to waiting without using an attempt', async () => {
      const { deps } = setup();
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(90));

      const thrown = await handleIngestFailure(error, deps).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(RateLimitError);
    });

    it.each([
      ['exactly now', 0],
      ['already in the past', -30],
    ])('pauses for the minimum when retryAt is %s', async (_label, seconds) => {
      const { deps, pauseQueue } = setup();
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(seconds));

      await handleIngestFailure(error, deps).catch(() => undefined);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(MIN_RATE_LIMIT_PAUSE_MS);
    });

    it('pauses for a full rate-limit window when retryAt is missing', async () => {
      const { deps, pauseQueue } = setup();
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(90));
      // rateLimited() always sets retryAt, so remove it to reach the branch the type still allows.
      Object.defineProperty(error, 'retryAt', { value: undefined });

      await handleIngestFailure(error, deps).catch(() => undefined);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(UNKNOWN_RESET_PAUSE_MS);
    });

    it('rethrows the pause failure if the queue cannot be paused, so the job retries the normal way', async () => {
      const { deps, pauseQueue } = setup();
      const valkeyDown = new Error('valkey is down');
      pauseQueue.mockRejectedValue(valkeyDown);
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(90));

      await expect(handleIngestFailure(error, deps)).rejects.toBe(valkeyDown);
    });
  });

  describe('our own rate limiter gave up (RateLimitExceededError)', () => {
    const KEY = 'ratelimit:companies-house';

    it('pauses the queue until retryAt and hands the job back, when thrown directly', async () => {
      const { deps, pauseQueue } = setup();
      const error = new RateLimitExceededError(KEY, secondsFromNow(6));

      const thrown = await handleIngestFailure(error, deps).catch((e: unknown) => e);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(6_000);
      expect(thrown).toBeInstanceOf(RateLimitError);
    });

    it('does the same when it is the cause of a network error, which is how the client delivers it', async () => {
      const { deps, pauseQueue } = setup();
      const limiterError = new RateLimitExceededError(KEY, secondsFromNow(6));
      const error = CompaniesHouseError.network(WHERE, limiterError);

      const thrown = await handleIngestFailure(error, deps).catch((e: unknown) => e);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(6_000);
      expect(thrown).toBeInstanceOf(RateLimitError);
    });

    it('finds it further down the cause chain', async () => {
      const { deps, pauseQueue } = setup();
      const limiterError = new RateLimitExceededError(KEY, secondsFromNow(6));
      const error = new Error('outer', { cause: CompaniesHouseError.network(WHERE, limiterError) });

      const thrown = await handleIngestFailure(error, deps).catch((e: unknown) => e);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(6_000);
      expect(thrown).toBeInstanceOf(RateLimitError);
    });

    it('pauses for the minimum when its retryAt has already passed', async () => {
      const { deps, pauseQueue } = setup();
      const error = CompaniesHouseError.network(
        WHERE,
        new RateLimitExceededError(KEY, secondsFromNow(-5)),
      );

      await handleIngestFailure(error, deps).catch(() => undefined);

      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(MIN_RATE_LIMIT_PAUSE_MS);
    });

    it('still retries an ordinary network error with backoff', async () => {
      const { deps, pauseQueue } = setup();
      const error = CompaniesHouseError.network(WHERE, new TypeError('fetch failed'));

      await expect(handleIngestFailure(error, deps)).rejects.toBe(error);
      expect(pauseQueue).not.toHaveBeenCalled();
    });

    it('end to end: a real client whose rate-limited fetch gives up produces an error that pauses the queue', async () => {
      // No Valkey: a bucket that always refuses with a 6 s wait, and a 5 s budget, so the wrapper
      // gives up at once. The real client then wraps that error, exactly as it would in production.
      const take = vi
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterMs: 6_000, tokensLeft: 0 });
      const realFetch = vi.fn<typeof globalThis.fetch>();
      const client = new CompaniesHouseClient({
        apiKey: '00000000-0000-4000-8000-000000000000',
        logger: pino({ level: 'silent' }),
        fetch: rateLimitedFetch(
          realFetch,
          { key: KEY, take },
          {
            maxWaitMs: 5_000,
            now: () => NOW.getTime(),
          },
        ),
      });
      const clientError = await client
        .advancedSearch({ sicCodes: ['62012'] })
        .catch((e: unknown) => e);
      const { deps, pauseQueue } = setup();

      const thrown = await handleIngestFailure(clientError, deps).catch((e: unknown) => e);

      expect(realFetch).not.toHaveBeenCalled();
      expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(6_000);
      expect(thrown).toBeInstanceOf(RateLimitError);
    });
  });

  describe('everything else', () => {
    it('rethrows an error that is not from Companies House (e.g. Postgres down)', async () => {
      const { deps, pauseQueue } = setup();
      const error = new Error('postgres is down');

      await expect(handleIngestFailure(error, deps)).rejects.toBe(error);
      expect(pauseQueue).not.toHaveBeenCalled();
    });

    it('rethrows a thrown value that is not an Error at all', async () => {
      const { deps } = setup();

      await expect(handleIngestFailure('something odd', deps)).rejects.toBe('something odd');
    });
  });
});
