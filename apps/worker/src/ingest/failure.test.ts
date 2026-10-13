import { CompaniesHouseError } from '@gtm/integrations';
import { RateLimitError, UnrecoverableError } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { handleIngestFailure, MIN_RATE_LIMIT_PAUSE_MS, type IngestFailureDeps } from './failure.js';

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

    it('rethrows the pause failure if the queue cannot be paused, so the job retries the normal way', async () => {
      const { deps, pauseQueue } = setup();
      const valkeyDown = new Error('valkey is down');
      pauseQueue.mockRejectedValue(valkeyDown);
      const error = CompaniesHouseError.rateLimited(WHERE, secondsFromNow(90));

      await expect(handleIngestFailure(error, deps)).rejects.toBe(valkeyDown);
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
