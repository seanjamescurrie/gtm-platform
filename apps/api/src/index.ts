import { getApiPort, getQueueDashboardPassword, getRedisUrl } from '@gtm/config';
import { createRedisConnection } from '@gtm/infra';
import { createIngestQueue } from '@gtm/queues';
import { pino } from 'pino';
import { buildServer, type ServerOptions } from './server.js';

const log = pino({ name: 'api', level: process.env.LOG_LEVEL ?? 'info' });

let options: ServerOptions = {};
let closeQueueDashboard = async (): Promise<void> => {};
try {
  // The queue dashboard (#12) is the API's only use of Valkey, so connect only when it's on.
  const password = getQueueDashboardPassword();
  if (password) {
    const connection = createRedisConnection(getRedisUrl(), {
      logger: log.child({ component: 'redis' }),
    });
    const queue = createIngestQueue(connection);
    // An EventEmitter with no 'error' listener crashes the process on the first Valkey hiccup.
    queue.on('error', (err) => log.error({ err }, 'queue dashboard: valkey error'));
    options = { queueDashboard: { queues: [queue], password } };
    closeQueueDashboard = async () => {
      await queue.close();
      await connection.quit();
    };
  }
} catch (err) {
  // e.g. a password shorter than 12 characters: refuse to start rather than serve it.
  log.fatal({ err }, 'invalid api configuration');
  process.exit(1);
}

const app = buildServer(options);
// Fastify runs onClose hooks during app.close(), so a clean shutdown also closes Valkey.
app.addHook('onClose', () => closeQueueDashboard());

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
// Signal handlers ignore returned promises, so shutdown handles its own errors and we mark it `void`.
process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ port: getApiPort(), host: '0.0.0.0' });
  app.log.info({ queueDashboard: options.queueDashboard ? '/admin/queues' : 'off' }, 'api started');
} catch (err) {
  // e.g. EADDRINUSE: exit non-zero with a logged reason rather than hanging.
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
}
