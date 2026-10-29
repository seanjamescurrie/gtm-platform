import type { JobsOptions } from 'bullmq';
import { z } from 'zod';

// BullMQ rejects ":" in queue names and custom job ids (it is the separator in its own Valkey keys).
export const INGEST_QUEUE_NAME = 'company-ingest';
export const INGEST_PAGE_JOB_NAME = 'ingest-page';

// Job data is read back from Valkey, which is a boundary like any API: validate it on the way in and out.
export const ingestPageDataSchema = z.object({
  // Groups the pages of one run. Letters, digits and "-" only, so it can't break the job id format.
  runId: z.string().regex(/^[A-Za-z0-9-]+$/),
  // At least one code: the client treats an empty list as "no filter", which would ingest every UK company.
  sicCodes: z.array(z.string().regex(/^\d{5}$/)).min(1),
  status: z.string().regex(/^[a-z-]+$/),
  startIndex: z.number().int().min(0),
  // Companies House returns at most 5,000 items per page.
  size: z.number().int().min(1).max(5_000),
  // Counted from startIndex 0, so page number = startIndex / size.
  maxPages: z.number().int().min(1),
});

export type IngestPageData = z.infer<typeof ingestPageDataSchema>;

export interface IngestPageResult {
  written: number;
  hits: number;
  // null when this was the last page of the run.
  nextStartIndex: number | null;
}

/**
 * The same page of the same run always gets the same id, and BullMQ ignores an add whose id already
 * exists, so enqueueing a page twice creates one job. `size` is left out on purpose: a run keeps
 * the page size it started with.
 */
export function ingestJobId(data: IngestPageData): string {
  const sicCodes = [...new Set(data.sicCodes)].sort().join('-');
  return `ingest_${data.runId}_${sicCodes}_${data.status}_${data.startIndex}`;
}

// One run per UTC day by default. The clock is a parameter so tests can pin it.
export function defaultRunId(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

export const INGEST_JOB_OPTIONS = {
  attempts: 5,
  // 5s, 10s, 20s, 40s between attempts; jitter spreads retries so workers don't all return at once.
  backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
  // Dedupe by job id only works while the finished job is still in Valkey, so keep it for a while.
  removeOnComplete: { age: SEVEN_DAYS_S, count: 1_000 },
  // Failed jobs stay until someone looks at them; the dead-letter queue arrives in #20.
  removeOnFail: false,
} satisfies JobsOptions;
