import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '@gtm/infra';
import {
  createIngestQueue,
  enqueueIngestPage,
  ingestJobId,
  type IngestPageData,
} from '@gtm/queues';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QUEUE_DASHBOARD_PATH, QUEUE_DASHBOARD_USER } from './queue-dashboard.js';
import { buildServer } from './server.js';

// Real Valkey; a random BullMQ prefix so the dashboard sees only this test's jobs.
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const connection = createRedisConnection(REDIS_URL, { logger: pino({ level: 'silent' }) });
const queue = createIngestQueue(connection, { prefix: `test-${randomUUID()}` });

const PASSWORD = 'correct-horse-battery';
const authorization = `Basic ${Buffer.from(`${QUEUE_DASHBOARD_USER}:${PASSWORD}`).toString('base64')}`;
const app = buildServer({ queueDashboard: { queues: [queue], password: PASSWORD } });

const page: IngestPageData = {
  runId: 'dashboard-test',
  sicCodes: ['62012'],
  status: 'active',
  startIndex: 0,
  size: 20,
  maxPages: 1,
};

// Only the parts of Bull Board's reply these tests read.
const queuesReply = z.object({
  queues: z.array(
    z.object({
      name: z.string(),
      readOnlyMode: z.boolean(),
      counts: z.record(z.string(), z.number()),
      jobs: z.array(z.object({ id: z.string(), data: z.unknown() })),
    }),
  ),
});

afterAll(async () => {
  await app.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe('queue dashboard (Valkey)', () => {
  it('lists the ingest queue, read-only, with its job counts and job data', async () => {
    await enqueueIngestPage(queue, page);

    const res = await app.inject({
      url: `${QUEUE_DASHBOARD_PATH}/api/queues?activeQueue=company-ingest&status=waiting`,
      headers: { authorization },
    });

    expect(res.statusCode).toBe(200);
    const [listed] = queuesReply.parse(res.json()).queues;
    expect(listed).toMatchObject({ name: 'company-ingest', readOnlyMode: true });
    expect(listed?.counts.waiting).toBe(1);
    expect(listed?.jobs[0]).toMatchObject({ id: ingestJobId(page), data: page });
  });

  it('refuses to promote a job, and the job is left exactly as it was', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${QUEUE_DASHBOARD_PATH}/api/queues/company-ingest/${ingestJobId(page)}/promote`,
      headers: { authorization },
    });

    expect(res.statusCode).toBe(405);
    expect(await queue.getJobState(ingestJobId(page))).toBe('waiting');
  });
});
