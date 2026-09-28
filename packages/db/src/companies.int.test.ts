import { arrayOverlaps, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { upsertCompanies } from './companies.js';
import { companies, type NewCompany } from './schema.js';
import { getTestDatabaseUrl } from './testing/test-db.js';

const { db, close } = createDb(getTestDatabaseUrl(), pino({ level: 'silent' }));

function company(overrides: Partial<NewCompany> = {}): NewCompany {
  return {
    companyNumber: 'NI642876',
    name: 'UNOSQUARE LIMITED',
    status: 'active',
    companyType: 'ltd',
    sicCodes: ['62012'],
    incorporatedOn: '2016-12-23',
    registeredAddress: { locality: 'Belfast', postalCode: 'BT1 3BG' },
    ...overrides,
  };
}

describe('upsertCompanies', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE ${companies}`);
  });
  afterAll(async () => {
    await close();
  });

  it('is idempotent: the same input twice leaves one row', async () => {
    await upsertCompanies(db, [company()]);
    const [first] = await db.select().from(companies);

    await upsertCompanies(db, [company()]);
    const rows = await db.select().from(companies);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
    expect(rows[0]?.createdAt).toEqual(first?.createdAt);
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? Infinity);
  });

  it('updates changed fields on conflict', async () => {
    await upsertCompanies(db, [company()]);
    await upsertCompanies(db, [company({ name: 'UNOSQUARE LTD', status: 'dissolved' })]);

    const [row] = await db.select().from(companies).where(eq(companies.companyNumber, 'NI642876'));
    expect(row).toMatchObject({ name: 'UNOSQUARE LTD', status: 'dissolved' });
  });

  it('keeps the last row when a batch repeats a company number', async () => {
    const written = await upsertCompanies(db, [company({ name: 'OLD' }), company({ name: 'NEW' })]);

    const rows = await db.select().from(companies);
    expect(written).toBe(1);
    expect(rows.map((r) => r.name)).toEqual(['NEW']);
  });

  it('does nothing for an empty batch', async () => {
    expect(await upsertCompanies(db, [])).toBe(0);
  });

  it('round-trips dates as YYYY-MM-DD strings and addresses as json', async () => {
    await upsertCompanies(db, [company()]);
    const [row] = await db.select().from(companies);

    expect(row?.incorporatedOn).toBe('2016-12-23');
    expect(row?.registeredAddress).toEqual({ locality: 'Belfast', postalCode: 'BT1 3BG' });
  });

  it('filters by SIC code overlap', async () => {
    await upsertCompanies(db, [
      company({ companyNumber: '00000001', sicCodes: ['62011'] }),
      company({ companyNumber: '00000002', sicCodes: ['47110', '62020'] }),
      company({ companyNumber: '00000003', sicCodes: ['47110'] }),
      company({ companyNumber: '00000004', sicCodes: [] }),
    ]);

    const matches = await db
      .select({ companyNumber: companies.companyNumber })
      .from(companies)
      .where(arrayOverlaps(companies.sicCodes, ['62011', '62012', '62020']))
      .orderBy(companies.companyNumber);

    expect(matches.map((m) => m.companyNumber)).toEqual(['00000001', '00000002']);
  });
});
