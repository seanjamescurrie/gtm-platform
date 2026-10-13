import type { AdvancedSearchPage, CompanySearchItem } from '@gtm/integrations';
import { CompaniesHouseError } from '@gtm/integrations';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { IngestPageData } from './job.js';
import { toNewCompany } from './map.js';
import { processIngestPage, type IngestPageDeps } from './processor.js';

function data(overrides: Partial<IngestPageData> = {}): IngestPageData {
  return {
    runId: '2026-10-08',
    sicCodes: ['62011', '62012', '62020'],
    status: 'active',
    startIndex: 0,
    size: 3,
    maxPages: 10,
    ...overrides,
  };
}

function item(n: number): CompanySearchItem {
  return {
    name: `COMPANY ${n} LIMITED`,
    companyNumber: String(n).padStart(8, '0'),
    companyStatus: 'active',
    companyType: 'ltd',
    sicCodes: ['62012'],
    dateOfCreation: '2020-01-01',
    registeredOfficeAddress: undefined,
  };
}

// A page of `count` items out of `hits` matches in total.
function page(count: number, hits: number): AdvancedSearchPage {
  return { hits, items: Array.from({ length: count }, (_, i) => item(i + 1)) };
}

// Fakes for every dependency. By default: a full page of 3 with more to come, and every call succeeds.
function setup(searchPage: AdvancedSearchPage = page(3, 100)) {
  const advancedSearch = vi
    .fn<IngestPageDeps['client']['advancedSearch']>()
    .mockResolvedValue(searchPage);
  const upsert = vi
    .fn<IngestPageDeps['upsert']>()
    .mockImplementation((rows) => Promise.resolve(rows.length));
  const enqueueNext = vi.fn<IngestPageDeps['enqueueNext']>().mockResolvedValue(undefined);
  const deps: IngestPageDeps = {
    client: { advancedSearch },
    upsert,
    enqueueNext,
    log: pino({ level: 'silent' }),
  };
  return { deps, advancedSearch, upsert, enqueueNext };
}

describe('processIngestPage', () => {
  describe('one page', () => {
    it('searches Companies House for exactly the page the job describes', async () => {
      const { deps, advancedSearch } = setup();

      await processIngestPage(deps, data({ startIndex: 6 }));

      expect(advancedSearch).toHaveBeenCalledExactlyOnceWith({
        sicCodes: ['62011', '62012', '62020'],
        status: 'active',
        size: 3,
        startIndex: 6,
      });
    });

    it('upserts every item on the page, mapped to a companies row', async () => {
      const searchPage = page(3, 100);
      const { deps, upsert } = setup(searchPage);

      await processIngestPage(deps, data());

      expect(upsert).toHaveBeenCalledExactlyOnceWith(searchPage.items.map(toNewCompany));
    });

    it('returns what was written (as reported by the upsert) and the total hits', async () => {
      const { deps, upsert } = setup(page(3, 100));
      upsert.mockResolvedValue(2); // e.g. the page repeated a company number

      const result = await processIngestPage(deps, data());

      expect(result).toMatchObject({ written: 2, hits: 100 });
    });
  });

  describe('the next page', () => {
    it('enqueues the next page: same run, start index moved on by one page', async () => {
      const { deps, enqueueNext } = setup(page(3, 100));

      const result = await processIngestPage(deps, data({ startIndex: 6 }));

      expect(enqueueNext).toHaveBeenCalledExactlyOnceWith(data({ startIndex: 9 }));
      expect(result.nextStartIndex).toBe(9);
    });

    it('upserts before it enqueues, so a crash between the two repeats this page instead of skipping it', async () => {
      const { deps, upsert, enqueueNext } = setup();

      await processIngestPage(deps, data());

      const upsertOrder = upsert.mock.invocationCallOrder[0] ?? Infinity;
      const enqueueOrder = enqueueNext.mock.invocationCallOrder[0] ?? -Infinity;
      expect(upsertOrder).toBeLessThan(enqueueOrder);
    });
    it('pages by what Companies House returned, not by what the upsert wrote', async () => {
      // A full page of 3 where the database reports 2 rows written (the page repeated a company).
      // The next page still starts one full page on, and the chain must not stop.
      const { deps, upsert, enqueueNext } = setup(page(3, 100));
      upsert.mockResolvedValue(2);

      const result = await processIngestPage(deps, data());

      expect(enqueueNext).toHaveBeenCalledExactlyOnceWith(data({ startIndex: 3 }));
      expect(result).toEqual({ written: 2, hits: 100, nextStartIndex: 3 });
    });
  });

  describe('stopping', () => {
    it('stops on an empty page', async () => {
      const { deps, enqueueNext } = setup(page(0, 0));

      const result = await processIngestPage(deps, data());

      expect(enqueueNext).not.toHaveBeenCalled();
      expect(result).toEqual({ written: 0, hits: 0, nextStartIndex: null });
    });

    it('stops on a short page: fewer items than the page size means there is nothing after it', async () => {
      const { deps, enqueueNext } = setup(page(2, 100));

      const result = await processIngestPage(deps, data());

      expect(enqueueNext).not.toHaveBeenCalled();
      expect(result).toEqual({ written: 2, hits: 100, nextStartIndex: null });
    });

    it('stops when a full page reaches the last hit exactly', async () => {
      // Items 6, 7 and 8 of 9: a full page, and also the end.
      const { deps, enqueueNext } = setup(page(3, 9));

      const result = await processIngestPage(deps, data({ startIndex: 6 }));

      expect(enqueueNext).not.toHaveBeenCalled();
      expect(result.nextStartIndex).toBeNull();
    });

    it('stops after maxPages pages, counted from start index 0', async () => {
      // size 3, maxPages 2: start index 0 is page 1, start index 3 is page 2 and the last.
      const { deps, enqueueNext } = setup(page(3, 100));

      const result = await processIngestPage(deps, data({ startIndex: 3, maxPages: 2 }));

      expect(enqueueNext).not.toHaveBeenCalled();
      expect(result.nextStartIndex).toBeNull();
    });

    it('carries on while under maxPages', async () => {
      const { deps, enqueueNext } = setup(page(3, 100));

      const result = await processIngestPage(deps, data({ startIndex: 0, maxPages: 2 }));

      expect(enqueueNext).toHaveBeenCalledOnce();
      expect(result.nextStartIndex).toBe(3);
    });
  });

  describe('failures (the job must fail, so BullMQ can retry it)', () => {
    it('rejects with the client error, and writes and enqueues nothing', async () => {
      const { deps, advancedSearch, upsert, enqueueNext } = setup();
      const error = CompaniesHouseError.serverError('GET /advanced-search/companies', 503);
      advancedSearch.mockRejectedValue(error);

      await expect(processIngestPage(deps, data())).rejects.toBe(error);
      expect(upsert).not.toHaveBeenCalled();
      expect(enqueueNext).not.toHaveBeenCalled();
    });

    it('rejects when the upsert fails, and does not enqueue the next page', async () => {
      const { deps, upsert, enqueueNext } = setup();
      const error = new Error('postgres is down');
      upsert.mockRejectedValue(error);

      await expect(processIngestPage(deps, data())).rejects.toBe(error);
      expect(enqueueNext).not.toHaveBeenCalled();
    });

    it('rejects when enqueueing the next page fails, so the chain is not silently cut', async () => {
      const { deps, enqueueNext } = setup();
      const error = new Error('valkey is down');
      enqueueNext.mockRejectedValue(error);

      await expect(processIngestPage(deps, data())).rejects.toBe(error);
    });
  });

  it('is idempotent: running the same page twice makes the same calls both times', async () => {
    const { deps, upsert, enqueueNext } = setup();

    const first = await processIngestPage(deps, data());
    const second = await processIngestPage(deps, data());

    expect(second).toEqual(first);
    expect(upsert.mock.calls[1]).toEqual(upsert.mock.calls[0]);
    expect(enqueueNext.mock.calls[1]).toEqual(enqueueNext.mock.calls[0]);
  });
});
