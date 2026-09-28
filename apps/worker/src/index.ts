import { pino } from 'pino';

const log = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });

// Nothing to consume yet; this timer keeps the process alive until BullMQ workers own the event loop.
const keepAlive = setInterval(() => {}, 60_000);

function shutdown(signal: NodeJS.Signals): void {
  log.info({ signal }, 'shutting down');
  clearInterval(keepAlive);
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

log.info('worker started');
