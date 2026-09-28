import { getDatabaseUrl } from '@gtm/config';
import { pino } from 'pino';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrator.js';

const log = pino({ name: 'migrate' });

let handle: DbHandle | undefined;
try {
  handle = createDb(getDatabaseUrl(), log);
  await runMigrations(handle.db);
  log.info('migrations applied');
} catch (err) {
  log.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await handle?.close();
}
