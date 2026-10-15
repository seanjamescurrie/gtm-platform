import { CompaniesHouseError } from '@gtm/integrations';
import { UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';

// A 429 whose reset time has already passed still pauses briefly, so the retry isn't instant.
export const MIN_RATE_LIMIT_PAUSE_MS = 1_000;

// rateLimited() always sets retryAt, but the type allows it to be missing. If it ever is, assume the
// worst and wait out a full Companies House rate-limit window (matches the default in errors.ts).
export const UNKNOWN_RESET_PAUSE_MS = 5 * 60_000;

export interface IngestFailureDeps {
  // Stops the whole queue handing out jobs for this many milliseconds (BullMQ's `worker.rateLimit`).
  pauseQueue: (ms: number) => Promise<void>;
  // The clock is injected so tests can pin it.
  now: () => Date;
  log: Logger;
}

/**
 * Decide what BullMQ should do with an error thrown while processing a page. Always throws:
 * the error it throws is the instruction to BullMQ.
 *
 * - Companies House error that isn't retryable: throw BullMQ's `UnrecoverableError` (fail now, no more attempts).
 * - Rate limited: pause the queue until `retryAt`, then throw `Worker.RateLimitError()` (job goes back to waiting).
 * - Anything else: rethrow the same error (BullMQ retries with backoff).
 */
export async function handleIngestFailure(error: unknown, deps: IngestFailureDeps): Promise<never> {
  if (!(error instanceof CompaniesHouseError)) throw error;

  if (error.kind === 'rate_limited') {
    const pause = Math.max(
      error.retryAt ? error.retryAt.getTime() - deps.now().getTime() : UNKNOWN_RESET_PAUSE_MS,
      MIN_RATE_LIMIT_PAUSE_MS,
    );
    deps.log.warn({ pauseMs: pause }, 'rate limited by companies house, pausing queue');
    await deps.pauseQueue(pause);
    throw Worker.RateLimitError();
  }

  if (!error.retryable) throw new UnrecoverableError(error.message);

  throw error;
}
