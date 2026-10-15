import { describe, expect, it, vi } from 'vitest';
import { enqueueIngestPage, type IngestQueue } from './enqueue.js';
import { INGEST_JOB_OPTIONS, INGEST_PAGE_JOB_NAME, type IngestPageData } from './job.js';

const page: IngestPageData = {
  runId: '2026-10-08',
  sicCodes: ['62011', '62012', '62020'],
  status: 'active',
  startIndex: 500,
  size: 500,
  maxPages: 2,
};

function fakeQueue() {
  return { add: vi.fn<IngestQueue['add']>() };
}

describe('enqueueIngestPage', () => {
  it('adds the page with its deterministic job id and the retry options', async () => {
    const queue = fakeQueue();

    const jobId = await enqueueIngestPage(queue, page);

    expect(jobId).toBe('ingest_2026-10-08_62011-62012-62020_active_500');
    expect(queue.add).toHaveBeenCalledExactlyOnceWith(INGEST_PAGE_JOB_NAME, page, {
      ...INGEST_JOB_OPTIONS,
      jobId,
    });
  });

  it('uses the same job id when the same page is enqueued twice', async () => {
    const queue = fakeQueue();

    const first = await enqueueIngestPage(queue, page);
    const second = await enqueueIngestPage(queue, { ...page });

    expect(second).toBe(first);
  });

  it('rejects invalid data without touching the queue', async () => {
    const queue = fakeQueue();

    await expect(enqueueIngestPage(queue, { ...page, sicCodes: [] })).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
