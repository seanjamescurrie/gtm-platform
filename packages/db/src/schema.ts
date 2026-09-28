import { sql } from 'drizzle-orm';
import { date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export interface RegisteredAddress {
  premises?: string;
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

// Shaped around the Companies House company profile. Status and type are text, not enums:
// Companies House can add values, and an enum would fail the insert mid-ingest. Zod validates at the boundary.
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Text, not a number: "NI642876" and "SC123456" have prefixes, and leading zeros matter.
    companyNumber: text('company_number').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    companyType: text('company_type').notNull(),
    sicCodes: text('sic_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // mode 'string' keeps dates as 'YYYY-MM-DD', avoiding timezone shifts from JS Date.
    incorporatedOn: date('incorporated_on', { mode: 'string' }),
    ceasedOn: date('ceased_on', { mode: 'string' }),
    registeredAddress: jsonb('registered_address').$type<RegisteredAddress>(),
    chEtag: text('ch_etag'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // GIN index backs array-overlap filters such as `sic_codes && '{62011,62012,62020}'`.
  (t) => [index('companies_sic_codes_idx').using('gin', t.sicCodes)],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
