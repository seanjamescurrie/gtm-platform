import Fastify, { type FastifyInstance } from 'fastify';

// Built separately from listen() so tests can use app.inject() without binding a port.
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.get('/health', () => ({ status: 'ok' }));

  return app;
}
