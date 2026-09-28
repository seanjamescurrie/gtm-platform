import { describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from './test-db.js';

describe('getTestDatabaseUrl', () => {
  it('defaults to the local gtm_test database', () => {
    expect(getTestDatabaseUrl({})).toBe('postgres://gtm:gtm@localhost:5432/gtm_test');
  });

  it('accepts an override ending in _test', () => {
    expect(getTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://ci@db:5432/app_test' })).toBe(
      'postgres://ci@db:5432/app_test',
    );
  });

  it('refuses a database that is not clearly a test one', () => {
    expect(() => getTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://gtm@localhost/gtm' })).toThrow(
      /must point at a database ending in "_test"/,
    );
  });
});
