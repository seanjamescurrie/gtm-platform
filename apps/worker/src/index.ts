import { getCompaniesHouseApiKey, getDatabaseUrl, getRedisUrl } from '@gtm/config';
import { createDb, type DbHandle } from '@gtm/db';
import { createRedisConnection, type RedisConnection } from '@gtm/infra';
import { CompaniesHouseClient } from '@gtm/integrations';
import { pino } from 'pino';
import { createIngestQueue, type IngestQueue } from './ingest/enqueue.js';
import { createIngestWorker, type IngestWorker } from './ingest/worker.js';

const log = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });

let db: DbHandle | undefined;
let queueConnection: RedisConnection | undefined;
let workerConnection: RedisConnection | undefined;
let queue: IngestQueue | undefined;
let worker: IngestWorker | undefined;

// Close in reverse order of creation. worker.close() waits for the active job to finish, so a
// page is never cut off between its upsert and its enqueue.
async function closeAll(): Promise<void> {
  await worker?.close();
  await queue?.close();
  await db?.close();
  // BullMQ may already have closed these; quitting a closed connection is not an error worth reporting.
  await Promise.allSettled([queueConnection?.quit(), workerConnection?.quit()]);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    // A second Ctrl-C means "now": the active job is abandoned and BullMQ will retry it later.
    log.warn({ signal }, 'forced exit');
    process.exit(1);
  }
  shuttingDown = true;
  log.info({ signal }, 'shutting down; waiting for the active job');
  try {
    await closeAll();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
// Signal handlers ignore returned promises, so shutdown handles its own errors and we mark it `void`.
process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

try {
  const redisUrl = getRedisUrl();
  db = createDb(getDatabaseUrl(), log.child({ component: 'db' }));
  queueConnection = createRedisConnection(redisUrl, { logger: log.child({ component: 'redis' }) });
  workerConnection = createRedisConnection(redisUrl, {
    forWorker: true,
    logger: log.child({ component: 'redis' }),
  });
  queue = createIngestQueue(queueConnection);
  const client = new CompaniesHouseClient({
    apiKey: getCompaniesHouseApiKey(),
    logger: log.child({ component: 'companies-house' }),
  });
  worker = createIngestWorker({
    connection: workerConnection,
    queue,
    client,
    db: db.db,
    log: log.child({ component: 'ingest' }),
  });
  log.info('worker started');
} catch (err) {
  // e.g. a missing env var: exit non-zero with a logged reason rather than hanging.
  log.fatal({ err }, 'failed to start worker');
  await closeAll().catch(() => undefined);
  process.exit(1);
}
