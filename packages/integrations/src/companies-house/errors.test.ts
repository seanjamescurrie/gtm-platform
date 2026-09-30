import { describe, expect, it } from 'vitest';
import { CompaniesHouseError, errorFromResponse } from './errors.js';

const where = 'GET /company/NI642876';

// A real x-ratelimit-reset value (epoch SECONDS), and a fixed "now" two minutes before it,
// so every time-based assertion is exact and doesn't depend on when the test runs.
const RESET_EPOCH_SECONDS = 1790679987;
const RESET_AT = new Date(RESET_EPOCH_SECONDS * 1000);
const NOW = new Date(RESET_AT.getTime() - 2 * 60_000);
const FIVE_MINUTES_MS = 5 * 60_000;

function rateLimitHeaders(reset: string): Headers {
  return new Headers({
    'x-ratelimit-limit': '600',
    'x-ratelimit-remain': '0',
    'x-ratelimit-reset': reset,
    'x-ratelimit-window': '5m',
  });
}

describe('errorFromResponse: 429 rate limiting', () => {
  it('uses x-ratelimit-reset as an absolute time in epoch seconds', () => {
    const err = errorFromResponse(429, rateLimitHeaders(String(RESET_EPOCH_SECONDS)), where, NOW);

    expect(err?.kind).toBe('rate_limited');
    expect(err?.status).toBe(429);
    expect(err?.retryable).toBe(true);
    // Not NOW + 1790679987 seconds (a delay), and not 1790679987 milliseconds (1970).
    expect(err?.retryAt).toEqual(RESET_AT);
  });

  it.each([
    ['missing', new Headers()],
    ['not a number', rateLimitHeaders('soon')],
    ['empty', rateLimitHeaders('')],
    ['zero', rateLimitHeaders('0')],
  ])('falls back to a full 5-minute window when the reset header is %s', (_label, headers) => {
    const err = errorFromResponse(429, headers, where, NOW);

    expect(err?.kind).toBe('rate_limited');
    expect(err?.retryAt).toEqual(new Date(NOW.getTime() + FIVE_MINUTES_MS));
  });

  it('never returns a retryAt in the past, even if the reset time has already passed', () => {
    const oneMinuteAgo = String(Math.floor(NOW.getTime() / 1000) - 60);

    const err = errorFromResponse(429, rateLimitHeaders(oneMinuteAgo), where, NOW);

    expect(err?.retryAt).toEqual(NOW);
  });

  it('puts the request and the retry time in the message', () => {
    const err = errorFromResponse(429, rateLimitHeaders(String(RESET_EPOCH_SECONDS)), where, NOW);

    expect(err?.message).toContain(where);
    expect(err?.message).toContain(RESET_AT.toISOString());
  });
});

describe('errorFromResponse: status mapping', () => {
  it.each([200, 201, 204, 304])('returns null for %i (not an error)', (status) => {
    expect(errorFromResponse(status, new Headers(), where, NOW)).toBeNull();
  });

  it.each([
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [400, 'http', false],
    [405, 'http', false],
    [422, 'http', false],
    [500, 'server_error', true],
    [502, 'server_error', true],
    [503, 'server_error', true],
  ])('maps %i to %s (retryable: %s) and records the status', (status, kind, retryable) => {
    const err = errorFromResponse(status, new Headers(), where, NOW);

    expect(err).toBeInstanceOf(CompaniesHouseError);
    expect(err?.kind).toBe(kind);
    expect(err?.retryable).toBe(retryable);
    expect(err?.status).toBe(status);
    expect(err?.message).toContain(where);
    expect(err?.message).toContain(String(status));
  });

  it('only sets retryAt on rate_limited errors', () => {
    for (const status of [400, 401, 500]) {
      expect(errorFromResponse(status, new Headers(), where, NOW)?.retryAt).toBeUndefined();
    }
  });
});

describe('CompaniesHouseError', () => {
  it('is a real Error with its own name', () => {
    const err = CompaniesHouseError.serverError(where, 500);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CompaniesHouseError);
    expect(err.name).toBe('CompaniesHouseError');
  });

  // Arrow wrappers: the factories are only looked up when a test runs, so a missing one fails
  // that test alone instead of breaking the whole file while it loads.
  it.each([
    ['timeout', true, (w: string, c: unknown) => CompaniesHouseError.timeout(w, c)],
    ['network', true, (w: string, c: unknown) => CompaniesHouseError.network(w, c)],
    [
      'invalid_response',
      false,
      (w: string, c: unknown) => CompaniesHouseError.invalidResponse(w, c),
    ],
  ] as const)(
    '%s keeps the original error as cause (retryable: %s)',
    (kind, retryable, factory) => {
      const original = new Error('low-level failure');

      const err = factory(where, original);

      expect(err.kind).toBe(kind);
      expect(err.cause).toBe(original);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBeUndefined();
      expect(err.message).toContain(where);
    },
  );

  it('builds the status-based kinds directly', () => {
    expect(CompaniesHouseError.unauthorized(where, 401).kind).toBe('unauthorized');
    expect(CompaniesHouseError.http(where, 400).kind).toBe('http');
    expect(CompaniesHouseError.rateLimited(where, RESET_AT).retryAt).toEqual(RESET_AT);
  });
});
