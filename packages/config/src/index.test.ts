import { describe, expect, it } from 'vitest';
import { getApiPort, getCompaniesHouseApiKey, getDatabaseUrl } from './index.js';

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

describe('getCompaniesHouseApiKey', () => {
  // Decision: keys must be RFC 4122 v4 UUIDs, the format Companies House issues today.
  // Trade-off: if Companies House ever issues a non-v4 key, startup fails and this rule must change.
  // Fake v4 keys only (version nibble 4, variant 8/9/a/b). Never use a real key in tests.
  const FAKE_KEY = '00000000-0000-4000-8000-000000000000';

  it('returns a v4 UUID key, in either case', () => {
    expect(getCompaniesHouseApiKey({ COMPANIES_HOUSE_API_KEY: FAKE_KEY })).toBe(FAKE_KEY);
    expect(
      getCompaniesHouseApiKey({ COMPANIES_HOUSE_API_KEY: 'ABCDEF01-2345-4789-ABCD-EF0123456789' }),
    ).toBe('ABCDEF01-2345-4789-ABCD-EF0123456789');
  });

  it('says "is not set" when unset or empty', () => {
    expect(() => getCompaniesHouseApiKey({})).toThrow(/^COMPANIES_HOUSE_API_KEY is not set$/);
    expect(() => getCompaniesHouseApiKey({ COMPANIES_HOUSE_API_KEY: '' })).toThrow(
      /^COMPANIES_HOUSE_API_KEY is not set$/,
    );
  });

  it.each([
    ['36 hyphens', '-'.repeat(36)],
    ['no hyphens', '00000000000000000000000000000000'],
    ['wrong grouping', '0000-00000000-0000-0000-000000000000'],
    ['non-hex characters', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['trailing character', `${FAKE_KEY}0`],
    ['surrounding whitespace', ` ${FAKE_KEY} `],
    ['well-formed but not v4 (version 1)', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['well-formed but not v4 (all zeros)', '00000000-0000-0000-0000-000000000000'],
    ['v4 version but wrong variant', '00000000-0000-4000-0000-000000000000'],
  ])('rejects a malformed key (%s) with a reason other than "is not set"', (_label, raw) => {
    let message = '';
    try {
      getCompaniesHouseApiKey({ COMPANIES_HOUSE_API_KEY: raw });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^COMPANIES_HOUSE_API_KEY /);
    expect(message).not.toMatch(/is not set/);
  });

  it('never includes the value in the error', () => {
    const almostKey = 'deadbeef-0000-4000-8000-00000000000'; // one character short
    let message = '';
    try {
      getCompaniesHouseApiKey({ COMPANIES_HOUSE_API_KEY: almostKey });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^COMPANIES_HOUSE_API_KEY /);
    expect(message).not.toContain('deadbeef');
  });
});
