import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('GET /health', () => {
  const app = buildServer();
  afterAll(async () => {
    await app.close();
  });

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
