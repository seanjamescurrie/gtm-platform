import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { runMigrations } from './migrator.js';
import { getTestDatabaseUrl } from './testing/test-db.js';

const { db, close } = createDb(getTestDatabaseUrl(), pino({ level: 'silent' }));

describe('runMigrations', () => {
  afterAll(async () => {
    await close();
  });

  // Global setup has already migrated the test database once.
  it('is a no-op on an up-to-date database', async () => {
    const count = async (): Promise<number> => {
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      );
      return rows[0]?.n ?? -1;
    };
    const before = await count();

    await runMigrations(db);

    expect(before).toBe(2);
    expect(await count()).toBe(before);
  });

  it('enables pgvector', async () => {
    const { rows } = await db.execute<{ distance: number }>(
      sql`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance`,
    );
    expect(rows[0]?.distance).toBe(1);
  });
});
