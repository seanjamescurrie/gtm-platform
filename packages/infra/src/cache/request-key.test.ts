import { describe, expect, it } from 'vitest';
import { CACHE_KEY_PREFIX, requestCacheKey } from './request-key.js';

const BASE = 'https://api.company-information.service.gov.uk';
const SEARCH = `${BASE}/advanced-search/companies?sic_codes=62011,62012&company_status=active&size=500&start_index=0`;

const key = (url: string | URL, method = 'GET') => requestCacheKey(method, url);

describe('requestCacheKey', () => {
  it('is the prefix plus a SHA-256 hex digest', () => {
    expect(key(SEARCH)).toMatch(/^cache:http:v1:[0-9a-f]{64}$/);
    expect(key(SEARCH).startsWith(CACHE_KEY_PREFIX)).toBe(true);
  });

  it('is the same for the same request', () => {
    expect(key(SEARCH)).toBe(key(SEARCH));
  });

  describe('requests that mean the same thing share a key', () => {
    it.each([
      [
        'query parameters in a different order',
        `${BASE}/advanced-search/companies?start_index=0&size=500&company_status=active&sic_codes=62011,62012`,
      ],
      [
        'a comma written as %2C',
        `${BASE}/advanced-search/companies?sic_codes=62011%2C62012&company_status=active&size=500&start_index=0`,
      ],
      [
        'an upper-case host and the default port',
        `https://API.Company-Information.Service.GOV.uk:443/advanced-search/companies?sic_codes=62011,62012&company_status=active&size=500&start_index=0`,
      ],
      ['a #fragment, which is never sent', `${SEARCH}#results`],
    ])('%s', (_label, url) => {
      expect(key(url)).toBe(key(SEARCH));
    });

    it('a space written as %20 or +', () => {
      expect(key(`${BASE}/search?q=acme%20ltd`)).toBe(key(`${BASE}/search?q=acme+ltd`));
    });

    it('an empty query string and none', () => {
      expect(key(`${BASE}/company/00000001?`)).toBe(key(`${BASE}/company/00000001`));
    });

    it('the method in any case', () => {
      expect(key(SEARCH, 'get')).toBe(key(SEARCH, 'GET'));
    });

    it('a URL object and the same URL as a string', () => {
      expect(key(new URL(SEARCH))).toBe(key(SEARCH));
    });
  });

  describe('different requests get different keys', () => {
    it.each([
      ['a different page', SEARCH.replace('start_index=0', 'start_index=500')],
      ['a different parameter value', SEARCH.replace('active', 'dissolved')],
      ['an extra parameter', `${SEARCH}&incorporated_from=2020-01-01`],
      ['a different path', `${BASE}/company/00000001`],
      ['a different host', SEARCH.replace(BASE, 'https://api.example.com')],
    ])('%s', (_label, url) => {
      expect(key(url)).not.toBe(key(SEARCH));
    });

    it('a different method', () => {
      expect(key(SEARCH, 'HEAD')).not.toBe(key(SEARCH, 'GET'));
    });

    it('a trailing slash: servers may treat /a and /a/ differently', () => {
      expect(key(`${BASE}/company/00000001/`)).not.toBe(key(`${BASE}/company/00000001`));
    });

    it("a repeated parameter's values in a different order: their order can carry meaning", () => {
      expect(key(`${BASE}/search?x=1&x=2`)).not.toBe(key(`${BASE}/search?x=2&x=1`));
    });
  });

  it('never contains anything readable from the URL', () => {
    const k = key(`${BASE}/search?q=person@example.com&company_name_includes=acme`);

    expect(k).not.toContain('example.com');
    expect(k).not.toContain('acme');
    expect(k).not.toContain('search');
  });

  it('rejects a relative URL, since without a host two APIs could share a key', () => {
    expect(() => key('/company/00000001')).toThrow();
  });
});
