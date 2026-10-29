import { createRedisConnection } from '@gtm/infra';
import { createIngestQueue } from '@gtm/queues';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { QUEUE_DASHBOARD_PATH, QUEUE_DASHBOARD_USER } from './queue-dashboard.js';
import { buildServer } from './server.js';

// No Valkey: these requests never reach a queue. Port 1 is never Valkey, and disconnecting at once
// stops ioredis retrying in the background.
const connection = createRedisConnection('redis://127.0.0.1:1', {
  logger: pino({ level: 'silent' }),
});
connection.disconnect();
const queue = createIngestQueue(connection);
// BullMQ reports the closed connection as an 'error' event; without a listener that would crash the run.
queue.on('error', () => undefined);

const PASSWORD = 'correct-horse-battery';
const auth = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const GOOD = auth(QUEUE_DASHBOARD_USER, PASSWORD);

const withDashboard = buildServer({ queueDashboard: { queues: [queue], password: PASSWORD } });
const withoutDashboard = buildServer();

afterAll(async () => {
  await Promise.all([withDashboard.close(), withoutDashboard.close()]);
  await queue.close().catch(() => undefined);
});

describe('queue dashboard', () => {
  describe('when no password is configured', () => {
    it('is not mounted: /admin/queues is a 404', async () => {
      const res = await withoutDashboard.inject({ url: QUEUE_DASHBOARD_PATH });

      expect(res.statusCode).toBe(404);
    });

    it('leaves the rest of the API alone', async () => {
      const res = await withoutDashboard.inject({ url: '/health' });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('authentication', () => {
    it('asks for credentials, so a browser shows its login prompt', async () => {
      const res = await withDashboard.inject({ url: QUEUE_DASHBOARD_PATH });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic realm="queue dashboard"/);
    });

    it.each([
      ['a wrong password', auth(QUEUE_DASHBOARD_USER, 'not-the-password')],
      ['a wrong user', auth('root', PASSWORD)],
      ['an empty password', auth(QUEUE_DASHBOARD_USER, '')],
      ['a malformed header', 'Basic not-base64-at-all!!'],
    ])('refuses %s', async (_label, authorization) => {
      const res = await withDashboard.inject({
        url: QUEUE_DASHBOARD_PATH,
        headers: { authorization },
      });

      expect(res.statusCode).toBe(401);
    });

    it('serves the dashboard page with the right credentials', async () => {
      const res = await withDashboard.inject({
        url: QUEUE_DASHBOARD_PATH,
        headers: { authorization: GOOD },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('protects the dashboard API too, not just the page', async () => {
      const res = await withDashboard.inject({ url: `${QUEUE_DASHBOARD_PATH}/api/queues` });

      expect(res.statusCode).toBe(401);
    });

    it('applies only to the dashboard: /health needs no credentials', async () => {
      const res = await withDashboard.inject({ url: '/health' });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('read-only', () => {
    it.each([
      ['PUT', '/api/queues/company-ingest/retry/failed'],
      ['PUT', '/api/queues/company-ingest/clean/completed'],
      ['PUT', '/api/queues/company-ingest/obliterate'],
      ['POST', '/api/queues/company-ingest/add'],
      ['PATCH', '/api/queues/company-ingest/some-job/update-data'],
      // Pauses every queue at once, rather than acting on one.
      ['PUT', '/api/queues/pause'],
    ] as const)('refuses %s %s with a 405', async (method, path) => {
      const res = await withDashboard.inject({
        method,
        url: `${QUEUE_DASHBOARD_PATH}${path}`,
        headers: { authorization: GOOD },
      });

      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
    });

    it('checks credentials before refusing, so an anonymous request learns nothing', async () => {
      const res = await withDashboard.inject({
        method: 'PUT',
        url: `${QUEUE_DASHBOARD_PATH}/api/queues/company-ingest/obliterate`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
