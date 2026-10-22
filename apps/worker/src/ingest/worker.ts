import { upsertCompanies, type Db } from '@gtm/db';
import type { RedisConnection } from '@gtm/infra';
import type { CompaniesHouseClient } from '@gtm/integrations';
import { UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { enqueueIngestPage, type IngestQueue } from './enqueue.js';
import { handleIngestFailure, type IngestFailureDeps } from './failure.js';
import {
  INGEST_QUEUE_NAME,
  ingestPageDataSchema,
  type IngestPageData,
  type IngestPageResult,
} from './job.js';
import { processIngestPage, type IngestPageDeps } from './processor.js';

export type IngestWorker = Worker<IngestPageData, IngestPageResult>;

// The parts of a BullMQ job the handler reads. `data` is unknown: it comes back from Valkey unchecked.
export interface IngestJob {
  id?: string | undefined;
  data: unknown;
  attemptsMade: number;
}

export type IngestJobHandlerDeps = Omit<IngestPageDeps, 'log'> &
  Omit<IngestFailureDeps, 'log'> & { log: Logger };

/**
 * The function BullMQ calls for each job: validate the data, give the job its own logger, run the
 * processor, and turn any error into an instruction for BullMQ. Kept apart from `new Worker` so it
 * can be tested without Valkey.
 */
export function createIngestJobHandler(deps: IngestJobHandlerDeps) {
  return async (job: IngestJob): Promise<IngestPageResult> => {
    const parsed = ingestPageDataSchema.safeParse(job.data);
    if (!parsed.success) {
      deps.log.error({ jobId: job.id, issues: parsed.error.issues }, 'invalid ingest job data');
      // Bad data stays bad, so retrying can't help.
      throw new UnrecoverableError(`invalid ingest job data: ${parsed.error.message}`);
    }
    const data = parsed.data;

    // runId is the correlation id: every log line for every page of one run carries it.
    const log = deps.log.child({ runId: data.runId, jobId: job.id, attempt: job.attemptsMade + 1 });

    try {
      return await processIngestPage({ ...deps, log }, data);
    } catch (error) {
      return await handleIngestFailure(error, { ...deps, log });
    }
  };
}

export interface IngestWorkerOptions {
  // Must be created with `forWorker: true`; BullMQ refuses it otherwise.
  connection: RedisConnection;
  // Producer side, for enqueueing the next page.
  queue: Pick<IngestQueue, 'add'>;
  client: Pick<CompaniesHouseClient, 'advancedSearch'>;
  db: Db;
  log: Logger;
  now?: () => Date;
  // Must match the queue's prefix (see createIngestQueue).
  prefix?: string;
}

export function createIngestWorker({
  connection,
  queue,
  client,
  db,
  log,
  now = () => new Date(),
  prefix,
}: IngestWorkerOptions): IngestWorker {
  // `worker` is only used inside pauseQueue, which runs after construction, so referring to it here is safe.
  const handler = createIngestJobHandler({
    client,
    upsert: (rows) => upsertCompanies(db, rows),
    enqueueNext: (next) => enqueueIngestPage(queue, next),
    pauseQueue: (ms) => worker.rateLimit(ms),
    now,
    log,
  });

  const worker: IngestWorker = new Worker<IngestPageData, IngestPageResult>(
    INGEST_QUEUE_NAME,
    handler,
    {
      connection,
      ...(prefix ? { prefix } : {}),
      // One page at a time per worker. The shared token bucket (#10) keeps all workers together
      // under the Companies House limit, so more workers or more concurrency stay safe.
      concurrency: 1,
    },
  );

  worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, ...result }, 'ingest job completed');
  });
  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, 'ingest job failed');
  });
  // An EventEmitter with no 'error' listener crashes the process on the first Valkey hiccup.
  worker.on('error', (err) => {
    log.error({ err }, 'ingest worker error');
  });

  return worker;
}
