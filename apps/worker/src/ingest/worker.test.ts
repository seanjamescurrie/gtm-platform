import type { AdvancedSearchPage } from '@gtm/integrations';
import { CompaniesHouseError } from '@gtm/integrations';
import { RateLimitError, UnrecoverableError } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { IngestPageData } from '@gtm/queues';
import { createIngestJobHandler, type IngestJobHandlerDeps } from './worker.js';

const NOW = new Date('2026-10-08T12:00:00Z');

const page0: IngestPageData = {
  runId: '2026-10-08',
  sicCodes: ['62011', '62012', '62020'],
  status: 'active',
  startIndex: 0,
  size: 2,
  maxPages: 1,
};

const searchPage: AdvancedSearchPage = {
  hits: 1,
  items: [
    {
      name: 'UNOSQUARE LIMITED',
      companyNumber: 'NI642876',
      companyStatus: 'active',
      companyType: 'ltd',
      sicCodes: ['62012'],
      dateOfCreation: '2016-12-23',
      registeredOfficeAddress: undefined,
    },
  ],
};

function setup() {
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const advancedSearch = vi
    .fn<IngestJobHandlerDeps['client']['advancedSearch']>()
    .mockResolvedValue(searchPage);
  const upsert = vi
    .fn<IngestJobHandlerDeps['upsert']>()
    .mockImplementation((rows) => Promise.resolve(rows.length));
  const pauseQueue = vi.fn<IngestJobHandlerDeps['pauseQueue']>().mockResolvedValue(undefined);
  const deps: IngestJobHandlerDeps = {
    client: { advancedSearch },
    upsert,
    enqueueNext: vi.fn<IngestJobHandlerDeps['enqueueNext']>().mockResolvedValue(undefined),
    pauseQueue,
    now: () => NOW,
    log,
  };
  return { handler: createIngestJobHandler(deps), advancedSearch, upsert, pauseQueue, lines };
}

describe('createIngestJobHandler', () => {
  it('runs the page and returns the processor result', async () => {
    const { handler, upsert } = setup();

    const result = await handler({ id: 'job-1', data: page0, attemptsMade: 0 });

    expect(result).toEqual({ written: 1, hits: 1, nextStartIndex: null });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('tags every log line for the job with runId, jobId and attempt', async () => {
    const { handler, lines } = setup();

    await handler({ id: 'job-1', data: page0, attemptsMade: 2 });

    const pageLine = lines.find((l) => l.msg === 'processed ingest page');
    expect(pageLine).toMatchObject({ runId: '2026-10-08', jobId: 'job-1', attempt: 3 });
  });

  it('fails invalid job data at once, without calling Companies House', async () => {
    const { handler, advancedSearch } = setup();

    const thrown = await handler({
      id: 'job-1',
      data: { ...page0, sicCodes: [] },
      attemptsMade: 0,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(advancedSearch).not.toHaveBeenCalled();
  });

  it('turns a non-retryable client error into UnrecoverableError', async () => {
    const { handler, advancedSearch } = setup();
    advancedSearch.mockRejectedValue(
      CompaniesHouseError.unauthorized('GET /advanced-search/companies', 401),
    );

    const thrown = await handler({ id: 'job-1', data: page0, attemptsMade: 0 }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(UnrecoverableError);
  });

  it('pauses the queue on a 429 and hands the job back', async () => {
    const { handler, advancedSearch, pauseQueue } = setup();
    advancedSearch.mockRejectedValue(
      CompaniesHouseError.rateLimited(
        'GET /advanced-search/companies',
        new Date(NOW.getTime() + 60_000),
      ),
    );

    const thrown = await handler({ id: 'job-1', data: page0, attemptsMade: 0 }).catch(
      (e: unknown) => e,
    );

    expect(pauseQueue).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(thrown).toBeInstanceOf(RateLimitError);
  });

  it('rethrows other errors unchanged, so BullMQ retries with backoff', async () => {
    const { handler, upsert } = setup();
    const error = new Error('postgres is down');
    upsert.mockRejectedValue(error);

    await expect(handler({ id: 'job-1', data: page0, attemptsMade: 0 })).rejects.toBe(error);
  });
});
