import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { pino, type Logger } from 'pino';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string, logger: Logger = pino({ name: 'db' })): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5_000 });
  // An idle client losing its connection emits 'error' on the pool; unhandled, that crashes the process.
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
