import type { NewCompany } from '@gtm/db';
import type { CompaniesHouseClient } from '@gtm/integrations';
import type { Logger } from 'pino';
import type { IngestPageData, IngestPageResult } from '@gtm/queues';
import { toNewCompany } from './map.js';

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
export async function processIngestPage(
  deps: IngestPageDeps,
  data: IngestPageData,
): Promise<IngestPageResult> {
  const { sicCodes, size, startIndex, status, maxPages } = data;

  const page = await deps.client.advancedSearch({ sicCodes, startIndex, status, size });

  const written = await deps.upsert(page.items.map(toNewCompany));

  // Paging follows what Companies House returned, never what the upsert wrote: the two can differ.
  const isFullPage = page.items.length === size;
  const hasHitsLeft = startIndex + size < page.hits;
  const underCap = startIndex / size + 1 < maxPages;
  const nextStartIndex = isFullPage && hasHitsLeft && underCap ? startIndex + size : null;

  // After the upsert, so a crash between the two repeats this page instead of skipping it.
  if (nextStartIndex !== null) {
    await deps.enqueueNext({ ...data, startIndex: nextStartIndex });
  }

  deps.log.info({ startIndex, written, hits: page.hits, nextStartIndex }, 'processed ingest page');

  return { hits: page.hits, written, nextStartIndex };
}
