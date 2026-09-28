import pg from 'pg';
import { pino } from 'pino';
import { createDb } from '../client.js';
import { runMigrations } from '../migrator.js';
import { getTestDatabaseUrl } from './test-db.js';

// Runs once before the integration suite: create the test database if needed, then migrate it.
export default async function setup(): Promise<void> {
  const testUrl = new URL(getTestDatabaseUrl());
  const dbName = testUrl.pathname.slice(1);

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      // Identifiers can't be bound as parameters; dbName is validated by getTestDatabaseUrl.
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
    }
  } finally {
    await admin.end();
  }

  const { db, close } = createDb(testUrl.toString(), pino({ level: 'silent' }));
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}
