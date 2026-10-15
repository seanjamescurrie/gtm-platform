import { getRedisUrl } from '@gtm/config';
import { createRedisConnection } from '@gtm/infra';
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { z } from 'zod';
import { createIngestQueue, enqueueIngestPage } from './enqueue.js';
import { defaultRunId } from './job.js';

// Starts an ingest run by enqueueing its first page. The worker (`pnpm dev`) does the rest.
// Usage: pnpm --filter @gtm/worker ingest [--sic 62011,62012] [--size 500] [--max-pages 2] [--run-id X]

const log = pino({ name: 'ingest-cli', level: process.env.LOG_LEVEL ?? 'info' });

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    sic: { type: 'string', default: '62011,62012,62020' },
    status: { type: 'string', default: 'active' },
    size: { type: 'string', default: '500' },
    'max-pages': { type: 'string', default: '2' },
  },
});

const connection = createRedisConnection(getRedisUrl(), { logger: log });
const queue = createIngestQueue(connection);
try {
  const data = {
    runId: values['run-id'] ?? defaultRunId(new Date()),
    sicCodes: values.sic.split(',').map((code) => code.trim()),
    status: values.status,
    startIndex: 0,
    size: Number(values.size),
    maxPages: Number(values['max-pages']),
  };
  const jobId = await enqueueIngestPage(queue, data);
  log.info({ jobId, ...data }, 'ingest run enqueued; the worker picks it up');
} catch (err) {
  if (err instanceof z.ZodError) {
    log.fatal({ issues: err.issues }, 'invalid ingest options');
  } else {
    log.fatal({ err }, 'could not enqueue the ingest run');
  }
  process.exitCode = 1;
} finally {
  await queue.close();
  await connection.quit();
}
