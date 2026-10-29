import { randomUUID } from 'node:crypto';
import { companies, createDb } from '@gtm/db';
import { getTestDatabaseUrl } from '@gtm/db/testing';
import { createRedisConnection } from '@gtm/infra';
import {
  CompaniesHouseError,
  type AdvancedSearchPage,
  type AdvancedSearchQuery,
  type CompanySearchItem,
} from '@gtm/integrations';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIngestQueue,
  enqueueIngestPage,
  ingestJobId,
  type IngestPageData,
  type IngestQueue,
} from '@gtm/queues';
import { createIngestWorker, type IngestWorker } from './worker.js';

// Real Valkey and Postgres; only Companies House is faked. Needs `docker compose up -d --wait`.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const log = pino({ level: 'silent' });
const { db, close: closeDb } = createDb(getTestDatabaseUrl(), log);
const producerConnection = createRedisConnection(REDIS_URL, { logger: log });
const workerConnection = createRedisConnection(REDIS_URL, { forWorker: true, logger: log });

const HITS = 5;

// Companies 1..5 in order, like a real search: each call returns the slice its startIndex asks for.
function fakeCompaniesHouse() {
  const item = (n: number): CompanySearchItem => ({
    name: `COMPANY ${n} LIMITED`,
    companyNumber: String(n).padStart(8, '0'),
    companyStatus: 'active',
    companyType: 'ltd',
    sicCodes: ['62012'],
    dateOfCreation: '2020-01-01',
    registeredOfficeAddress: undefined,
  });
  return vi.fn((query: AdvancedSearchQuery): Promise<AdvancedSearchPage> => {
    const start = query.startIndex ?? 0;
    const end = Math.min(start + (query.size ?? 20), HITS);
    const items = Array.from({ length: Math.max(end - start, 0) }, (_, i) => item(start + i + 1));
    return Promise.resolve({ hits: HITS, items });
  });
}

function page0(overrides: Partial<IngestPageData> = {}): IngestPageData {
  return {
    runId: 'int-test',
    sicCodes: ['62011', '62012', '62020'],
    status: 'active',
    startIndex: 0,
    size: 2,
    maxPages: 10,
    ...overrides,
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function companyCount(): Promise<number> {
  return db.$count(companies);
}

describe('ingest queue (Valkey + Postgres)', () => {
  let prefix: string;
  let queue: IngestQueue;
  let worker: IngestWorker | undefined;
  let advancedSearch: ReturnType<typeof fakeCompaniesHouse>;

  function startWorker(): void {
    worker = createIngestWorker({
      connection: workerConnection,
      queue,
      client: { advancedSearch },
      db,
      log,
      prefix,
    });
  }

  beforeEach(async () => {
    // A fresh key prefix per test: no test can see another's jobs, or any real ones.
    prefix = `test-${randomUUID()}`;
    queue = createIngestQueue(producerConnection, { prefix });
    advancedSearch = fakeCompaniesHouse();
    await db.delete(companies);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.obliterate({ force: true });
    await queue.close();
  });

  afterAll(async () => {
    await Promise.allSettled([producerConnection.quit(), workerConnection.quit()]);
    await closeDb();
  });

  it('ingests a whole run by chaining one job per page', async () => {
    startWorker();

    await enqueueIngestPage(queue, page0());
    await waitFor(async () => (await queue.getCompletedCount()) === 3);

    // Pages at 0, 2 and 4; the last is short (1 item), so the chain stops there.
    expect(advancedSearch.mock.calls.map(([q]) => q.startIndex)).toEqual([0, 2, 4]);
    expect(await companyCount()).toBe(HITS);
  });

  it('creates one job when the same page is enqueued twice', async () => {
    // No worker running, so the jobs stay in the queue to be counted.
    await enqueueIngestPage(queue, page0());
    await enqueueIngestPage(queue, page0());

    expect(await queue.count()).toBe(1);
  });

  it('a second run over the same companies leaves the same rows', async () => {
    startWorker();

    await enqueueIngestPage(queue, page0({ runId: 'first' }));
    await waitFor(async () => (await queue.getCompletedCount()) === 3);
    await enqueueIngestPage(queue, page0({ runId: 'second' }));
    await waitFor(async () => (await queue.getCompletedCount()) === 6);

    expect(await companyCount()).toBe(HITS);
  });

  it('fails a non-retryable error after one attempt', async () => {
    advancedSearch.mockRejectedValue(
      CompaniesHouseError.unauthorized('GET /advanced-search/companies', 401),
    );
    startWorker();

    await enqueueIngestPage(queue, page0());
    await waitFor(async () => (await queue.getFailedCount()) === 1);

    const job = await queue.getJob(ingestJobId(page0()));
    expect(job?.attemptsMade).toBe(1);
    expect(advancedSearch).toHaveBeenCalledOnce();
  });

  it('a 429 pauses the queue and returns the job to waiting without using an attempt', async () => {
    // The first call is rate limited until 1s from now; after that, every call succeeds.
    const realSearch = advancedSearch.getMockImplementation();
    advancedSearch.mockImplementationOnce(() =>
      Promise.reject(
        CompaniesHouseError.rateLimited(
          'GET /advanced-search/companies',
          new Date(Date.now() + 1_000),
        ),
      ),
    );
    if (realSearch) advancedSearch.mockImplementation(realSearch);
    startWorker();
    const failed = vi.fn();
    worker?.on('failed', failed);

    const startedAt = Date.now();
    await enqueueIngestPage(queue, page0({ maxPages: 1 }));
    await waitFor(async () => (await queue.getCompletedCount()) === 1);

    const job = await queue.getJob(ingestJobId(page0({ maxPages: 1 })));
    expect(advancedSearch).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(failed).not.toHaveBeenCalled();
    // A normal failure would have counted against the 5 attempts; a rate-limit hand-back doesn't.
    expect(job?.attemptsMade).toBe(1);
  }, 15_000);
});
