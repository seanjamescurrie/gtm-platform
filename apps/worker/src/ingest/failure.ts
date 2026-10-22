import { CompaniesHouseError } from '@gtm/integrations';
import { RateLimitExceededError } from '@gtm/infra';
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

// The rate limiter's error usually arrives wrapped: the client turns anything fetch throws into a
// `network` error with the original as `cause`. The depth cap stops a chain that loops back on itself.
function findRateLimitExceededError(error: unknown): RateLimitExceededError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (current instanceof RateLimitExceededError) return current;
    current = current.cause;
  }
  return undefined;
}

// One place for "wait until retryAt": both kinds of rate limit pause the same way, so they can't
// drift apart. retryAt is a moment; the pause is the duration from now until then.
async function pauseQueueUntil(
  retryAt: Date,
  deps: IngestFailureDeps,
  message: string,
  fields: Record<string, unknown> = {},
): Promise<never> {
  const pauseMs = Math.max(retryAt.getTime() - deps.now().getTime(), MIN_RATE_LIMIT_PAUSE_MS);
  deps.log.warn({ ...fields, pauseMs }, message);
  await deps.pauseQueue(pauseMs);
  throw Worker.RateLimitError();
}

/**
 * Decide what BullMQ should do with an error thrown while processing a page. Always throws:
 * the error it throws is the instruction to BullMQ.
 *
 * - Our rate limiter gave up (RateLimitExceededError, directly or as a cause): pause the queue until
 *   its `retryAt`, then throw `Worker.RateLimitError()` (job goes back to waiting).
 * - Companies House error that isn't retryable: throw BullMQ's `UnrecoverableError` (fail now, no more attempts).
 * - Companies House rate limited (429): pause the queue until `retryAt`, then throw `Worker.RateLimitError()`.
 * - Anything else: rethrow the same error (BullMQ retries with backoff).
 */
export async function handleIngestFailure(error: unknown, deps: IngestFailureDeps): Promise<never> {
  // First: it's the most specific case, and it reaches us disguised as a retryable network error.
  const limiterError = findRateLimitExceededError(error);
  if (limiterError) {
    return pauseQueueUntil(
      limiterError.retryAt,
      deps,
      'rate limiter out of tokens, pausing queue',
      {
        key: limiterError.key,
      },
    );
  }

  if (!(error instanceof CompaniesHouseError)) throw error;

  if (error.kind === 'rate_limited') {
    const retryAt = error.retryAt ?? new Date(deps.now().getTime() + UNKNOWN_RESET_PAUSE_MS);
    return pauseQueueUntil(retryAt, deps, 'rate limited by companies house, pausing queue');
  }

  if (!error.retryable) throw new UnrecoverableError(error.message);

  throw error;
}
