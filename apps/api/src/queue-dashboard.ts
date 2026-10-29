import { createHash, timingSafeEqual } from 'node:crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import basicAuth from '@fastify/basic-auth';
import type { Queue } from 'bullmq';
import type { FastifyPluginAsync } from 'fastify';

export const QUEUE_DASHBOARD_PATH = '/admin/queues';
export const QUEUE_DASHBOARD_USER = 'admin';

export interface QueueDashboardOptions {
  queues: Queue[];
  password: string;
}

// Compare in constant time, so response timing doesn't reveal how much of a guess was right.
// Hashing first gives both sides the same length, which timingSafeEqual requires.
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Bull Board at /admin/queues, read-only, behind HTTP basic auth. Register it with
 * `app.register(queueDashboard, options)`; everything here is scoped to this plugin, so the hooks
 * below apply to the dashboard's routes only, not to the rest of the API.
 */
export const queueDashboard: FastifyPluginAsync<QueueDashboardOptions> = async (
  app,
  { queues, password },
) => {
  await app.register(basicAuth, {
    // Check both, always: returning early on a wrong user name would be faster than a wrong password.
    validate: (user, pass) => {
      const userOk = sameSecret(user, QUEUE_DASHBOARD_USER);
      const passOk = sameSecret(pass, password);
      return userOk && passOk ? Promise.resolve() : Promise.reject(new Error('Unauthorized'));
    },
    // Sends WWW-Authenticate, so a browser shows its login prompt.
    authenticate: { realm: 'queue dashboard' },
  });
  // Auth first: an anonymous request learns nothing, not even which methods are refused.
  app.addHook('onRequest', app.basicAuth);
  // Read-only, twice over. Bull Board's readOnlyMode makes each queue refuse actions, but it is
  // enforced route by route inside Bull Board, and some optional routes aren't tied to a queue
  // (POST /api/metrics/history/purge appears when metrics history is enabled). Every non-GET route
  // Bull Board has changes something, so refusing them all here also covers routes a future
  // version adds.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      await reply
        .code(405)
        .header('allow', 'GET, HEAD')
        .send({ error: 'queue dashboard is read-only' });
    }
  });

  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath(QUEUE_DASHBOARD_PATH);
  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
  });
  await app.register(serverAdapter.registerPlugin(), { prefix: QUEUE_DASHBOARD_PATH });
};
