import { getApiPort } from '@gtm/config';
import { buildServer } from './server.js';

const app = buildServer();

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
} catch (err) {
  // e.g. EADDRINUSE: exit non-zero with a logged reason rather than hanging.
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
}
