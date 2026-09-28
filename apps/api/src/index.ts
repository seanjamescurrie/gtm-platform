import { getApiPort } from '@gtm/config';
import { buildServer } from './server.js';

const app = buildServer();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ port: getApiPort(), host: '0.0.0.0' });
} catch (err) {
  // e.g. EADDRINUSE: exit non-zero with a logged reason rather than hanging.
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
}
