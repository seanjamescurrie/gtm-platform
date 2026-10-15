import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createRedisConnection } from './redis.js';

// Port 1 is never a Valkey server, and each test disconnects at once, so nothing needs Docker.
const UNREACHABLE_URL = 'redis://127.0.0.1:1';
const logger = pino({ level: 'silent' });

describe('createRedisConnection', () => {
  it('retries commands forever for workers, as BullMQ requires', () => {
    const connection = createRedisConnection(UNREACHABLE_URL, { forWorker: true, logger });
    connection.disconnect();

    expect(connection.options.maxRetriesPerRequest).toBeNull();
  });

  it('keeps a finite retry count for producers, so a command fails instead of hanging', () => {
    const connection = createRedisConnection(UNREACHABLE_URL, { logger });
    connection.disconnect();

    expect(connection.options.maxRetriesPerRequest).toBeGreaterThan(0);
  });

  it('reads host, port and password from the URL', () => {
    const connection = createRedisConnection('redis://:s3cret@127.0.0.1:1', { logger });
    connection.disconnect();

    expect(connection.options).toMatchObject({ host: '127.0.0.1', port: 1, password: 's3cret' });
  });
});
