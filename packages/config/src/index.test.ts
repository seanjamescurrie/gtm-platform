import { describe, expect, it } from 'vitest';
import { getApiPort } from './index.js';

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
