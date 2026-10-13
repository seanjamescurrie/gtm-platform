import type { Logger } from 'pino';

// A 429 whose reset time has already passed still pauses briefly, so the retry isn't instant.
export const MIN_RATE_LIMIT_PAUSE_MS = 1_000;

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
export function handleIngestFailure(error: unknown, deps: IngestFailureDeps): Promise<never> {
  // Hand-written (#9, checkpoint 5): make failure.test.ts pass, one test at a time.
  void error;
  void deps;
  return Promise.reject(new Error('handleIngestFailure is not implemented yet'));
}
