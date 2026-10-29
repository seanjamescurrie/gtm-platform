import Fastify, { type FastifyInstance } from 'fastify';
import { queueDashboard, type QueueDashboardOptions } from './queue-dashboard.js';

export interface ServerOptions {
  // Present only when QUEUE_DASHBOARD_PASSWORD is set; otherwise the dashboard isn't mounted.
  queueDashboard?: QueueDashboardOptions;
}

// Built separately from listen() so tests can use app.inject() without binding a port.
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.get('/health', () => ({ status: 'ok' }));

  // Fastify loads plugins when the server starts (listen, ready or inject), and reports a plugin
  // error there, so the promise register returns needn't be awaited here.
  if (options.queueDashboard) void app.register(queueDashboard, options.queueDashboard);

  return app;
}
