import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';

export type RedisConnection = Redis;

export interface RedisConnectionOptions {
  /**
   * BullMQ workers wait on blocking commands, so a command must be retried until Valkey is back
   * rather than rejected; BullMQ refuses a worker connection without this. Producers leave it
   * off, so `queue.add()` fails after a few retries instead of hanging while Valkey is down.
   */
  forWorker?: boolean;
  logger?: Logger;
}

// One place that builds Valkey connections: BullMQ now, the rate limiter (#10) and cache (#11) later.
export function createRedisConnection(
  url: string,
  { forWorker = false, logger = pino({ name: 'redis' }) }: RedisConnectionOptions = {},
): RedisConnection {
  const connection = new Redis(url, {
    connectTimeout: 5_000,
    ...(forWorker ? { maxRetriesPerRequest: null } : {}),
  });
  // ioredis reconnects by itself; this only records why. Log the error, never the URL (it can hold a password).
  connection.on('error', (err) => logger.error({ err }, 'valkey connection error'));

  return connection;
}
