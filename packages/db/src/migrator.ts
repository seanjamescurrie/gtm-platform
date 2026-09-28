import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// Each migration runs in a transaction and is recorded in drizzle.__drizzle_migrations, so re-runs skip applied ones.
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
