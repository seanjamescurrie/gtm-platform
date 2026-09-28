import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { companies, type NewCompany } from './schema.js';

/**
 * Insert or update companies by company number. Safe to run twice with the same input.
 * Returns the number of rows written.
 */
export async function upsertCompanies(db: Db, rows: readonly NewCompany[]): Promise<number> {
  // Postgres rejects a batch that touches the same conflict key twice, so keep the last row per company.
  const unique = [...new Map(rows.map((row) => [row.companyNumber, row])).values()];
  if (unique.length === 0) return 0;

  const written = await db
    .insert(companies)
    .values(unique)
    .onConflictDoUpdate({
      target: companies.companyNumber,
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        companyType: sql`excluded.company_type`,
        sicCodes: sql`excluded.sic_codes`,
        incorporatedOn: sql`excluded.incorporated_on`,
        ceasedOn: sql`excluded.ceased_on`,
        registeredAddress: sql`excluded.registered_address`,
        chEtag: sql`excluded.ch_etag`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: companies.id });

  return written.length;
}
