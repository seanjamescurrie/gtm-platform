// Queue definitions shared by the processes that produce and consume jobs (the worker, its CLI,
// and the API's queue dashboard). Apps don't import from each other, so they meet here.
export {
  defaultRunId,
  INGEST_JOB_OPTIONS,
  INGEST_PAGE_JOB_NAME,
  INGEST_QUEUE_NAME,
  ingestJobId,
  ingestPageDataSchema,
  type IngestPageData,
  type IngestPageResult,
} from './job.js';
export { createIngestQueue, enqueueIngestPage, type IngestQueue } from './enqueue.js';
