import { Queue } from 'bullmq';
import type { RedisConnection } from '@gtm/infra';
import {
  INGEST_JOB_OPTIONS,
  INGEST_PAGE_JOB_NAME,
  INGEST_QUEUE_NAME,
  ingestJobId,
  ingestPageDataSchema,
  type IngestPageData,
  type IngestPageResult,
} from './job.js';

export type IngestQueue = Queue<IngestPageData, IngestPageResult>;

export function createIngestQueue(connection: RedisConnection): IngestQueue {
  return new Queue(INGEST_QUEUE_NAME, { connection });
}

/**
 * Add one page to the queue. Safe to call twice with the same data: the job id is derived from
 * the data, and BullMQ ignores an add whose id already exists. Returns the job id.
 */
export async function enqueueIngestPage(
  queue: Pick<IngestQueue, 'add'>,
  data: IngestPageData,
): Promise<string> {
  // Parse before adding, so a bad page fails here with a clear error rather than later in the worker.
  const parsed = ingestPageDataSchema.parse(data);
  const jobId = ingestJobId(parsed);
  await queue.add(INGEST_PAGE_JOB_NAME, parsed, { ...INGEST_JOB_OPTIONS, jobId });
  return jobId;
}
