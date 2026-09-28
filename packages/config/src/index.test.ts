import { describe, expect, it } from 'vitest';
import { getApiPort, getDatabaseUrl } from './index.js';

describe('getApiPort', () => {
  it('defaults to 3000 when API_PORT is unset or empty', () => {
    expect(getApiPort({})).toBe(3000);
    expect(getApiPort({ API_PORT: '' })).toBe(3000);
  });

  it('parses a valid port', () => {
    expect(getApiPort({ API_PORT: '8080' })).toBe(8080);
  });

  it.each(['abc', '0', '65536', '-1', '30.5'])('rejects API_PORT=%j', (raw) => {
    expect(() => getApiPort({ API_PORT: raw })).toThrow(/API_PORT must be an integer/);
  });
});

describe('getDatabaseUrl', () => {
  it('accepts postgres and postgresql URLs', () => {
    expect(getDatabaseUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/gtm' })).toBe(
      'postgres://u:p@localhost:5432/gtm',
    );
    expect(getDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/gtm' })).toBe(
      'postgresql://localhost/gtm',
    );
  });

  it('fails clearly when unset or empty', () => {
    expect(() => getDatabaseUrl({})).toThrow('DATABASE_URL is not set');
    expect(() => getDatabaseUrl({ DATABASE_URL: '' })).toThrow('DATABASE_URL is not set');
  });

  it.each(['not a url', 'mysql://localhost/gtm', 'postgres://localhost', 'postgres://localhost/'])(
    'rejects DATABASE_URL=%j',
    (raw) => {
      expect(() => getDatabaseUrl({ DATABASE_URL: raw })).toThrow(/^DATABASE_URL /);
    },
  );

  it('never includes the value (and its password) in the error', () => {
    let message = '';
    try {
      getDatabaseUrl({ DATABASE_URL: 'mysql://user:s3cret@host/db' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^DATABASE_URL /);
    expect(message).not.toContain('s3cret');
  });
});
