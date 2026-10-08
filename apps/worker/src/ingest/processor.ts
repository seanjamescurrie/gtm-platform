import type { NewCompany } from '@gtm/db';
import type { CompaniesHouseClient } from '@gtm/integrations';
import type { Logger } from 'pino';
import type { IngestPageData, IngestPageResult } from './job.js';

// Everything the processor touches comes in from outside, so tests run with fakes: no network, Valkey or Postgres.
export interface IngestPageDeps {
  client: Pick<CompaniesHouseClient, 'advancedSearch'>;
  upsert: (rows: readonly NewCompany[]) => Promise<number>;
  enqueueNext: (data: IngestPageData) => Promise<unknown>;
  log: Logger;
}

/**
 * Process one page of an ingest run: fetch it, upsert it, then enqueue the next page if there is one.
 * Must be safe to run twice with the same data.
 */
export function processIngestPage(
  deps: IngestPageDeps,
  data: IngestPageData,
): Promise<IngestPageResult> {
  // Hand-written (#9, checkpoint 4): make processor.test.ts pass, one test at a time.
  void deps;
  void data;
  return Promise.reject(new Error('processIngestPage is not implemented yet'));
}
