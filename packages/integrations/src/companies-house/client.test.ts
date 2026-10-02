import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { CompaniesHouseClient } from './client.js';
import { CompaniesHouseError } from './errors.js';

// A fake v4 key. Never use a real key in tests.
const API_KEY = '00000000-0000-4000-8000-000000000000';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;
const BASE_URL = 'https://api.company-information.service.gov.uk';

type ClientOptions = ConstructorParameters<typeof CompaniesHouseClient>[0];
type Responder = (request: Request) => Response | Promise<Response>;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remain': '599', ...headers },
  });
}

// Captures everything the client logs, as parsed JSON lines and as raw text.
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(line: string) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines, raw };
}

// Builds a client around a fake fetch. Every call is normalised into a Request, so tests can
// inspect the URL, method, headers and signal the same way whatever form the client passes.
function setup(respond: Responder, options: Partial<ClientOptions> = {}) {
  const requests: Request[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  });
  const logs = captureLogs();
  const client = new CompaniesHouseClient({
    apiKey: API_KEY,
    logger: logs.logger,
    fetch: fetchMock,
    ...options,
  });
  return { client, requests, fetchMock, logs };
}

function onlyUrl(requests: Request[]): URL {
  expect(requests).toHaveLength(1);
  return new URL(requests[0]?.url ?? '');
}

// Behaves like real fetch when its signal aborts: it rejects with the signal's reason
// (a DOMException named 'TimeoutError' for AbortSignal.timeout). A fake that ignored the
// signal would hang the test forever instead of failing.
function neverResponds(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      // `reason` is typed `any`; for AbortSignal.timeout it is a DOMException, which is an Error.
      reject(request.signal.reason as Error);
    });
  });
}

async function caught(promise: Promise<unknown>): Promise<CompaniesHouseError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CompaniesHouseError);
    return err as CompaniesHouseError;
  }
  throw new Error('expected the call to throw');
}

describe('CompaniesHouseClient: requests', () => {
  it('sends GET to the default base URL with Basic auth and a timeout signal', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('company-profile.json')));

    await client.getCompanyProfile('NI642876');

    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(`${BASE_URL}/company/NI642876`);
    expect(request?.headers.get('authorization')).toBe(EXPECTED_AUTH);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a custom base URL when given one', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('company-profile.json')), {
      baseUrl: 'https://sandbox.example.test',
    });

    await client.getCompanyProfile('NI642876');

    expect(onlyUrl(requests).origin).toBe('https://sandbox.example.test');
  });

  it('URL-encodes the company number in the profile path', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('company-profile.json')));

    await client.getCompanyProfile('SC 12/3');

    expect(onlyUrl(requests).pathname).toBe('/company/SC%2012%2F3');
  });

  it('puts every SIC code in the advanced search query', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('advanced-search.json')));

    await client.advancedSearch({ sicCodes: ['62011', '62012', '62020'] });

    const url = onlyUrl(requests);
    expect(url.pathname).toBe('/advanced-search/companies');
    // Companies House accepts comma-joined or repeated sic_codes (both mean OR), so check the
    // codes that were sent rather than one exact format.
    const sent = url.searchParams.getAll('sic_codes').flatMap((value) => value.split(','));
    expect(sent).toEqual(['62011', '62012', '62020']);
  });

  it('maps optional search parameters to Companies House names', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('advanced-search.json')));

    await client.advancedSearch({
      sicCodes: ['62012'],
      status: 'active',
      size: 500,
      startIndex: 1000,
      incorporatedFrom: '2015-01-01',
    });

    const params = onlyUrl(requests).searchParams;
    expect(params.get('company_status')).toBe('active');
    expect(params.get('size')).toBe('500');
    expect(params.get('start_index')).toBe('1000');
    expect(params.get('incorporated_from')).toBe('2015-01-01');
  });

  it('leaves out parameters that were not given', async () => {
    const { client, requests } = setup(() => jsonResponse(loadFixture('advanced-search.json')));

    await client.advancedSearch({ sicCodes: ['62012'] });

    const params = onlyUrl(requests).searchParams;
    for (const name of ['company_status', 'size', 'start_index', 'incorporated_from']) {
      expect(params.has(name)).toBe(false);
    }
  });
});

describe('CompaniesHouseClient: successful responses', () => {
  it('returns a parsed advanced search page', async () => {
    const { client } = setup(() => jsonResponse(loadFixture('advanced-search.json')));

    const page = await client.advancedSearch({ sicCodes: ['62012'] });

    expect(page.hits).toBe(5513772);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.companyNumber).toBe('NI019095');
  });

  it('returns a parsed company profile, including the etag', async () => {
    const { client } = setup(() => jsonResponse(loadFixture('company-profile.json')));

    const profile = await client.getCompanyProfile('NI642876');

    expect(profile?.companyNumber).toBe('NI642876');
    expect(profile?.companyType).toBe('ltd');
    expect(typeof profile?.etag).toBe('string');
  });
});

describe('CompaniesHouseClient: 404 means something different per method', () => {
  it('advanced search: 404 with an empty body means no matches', async () => {
    const { client } = setup(() => new Response(null, { status: 404 }));

    await expect(client.advancedSearch({ sicCodes: ['62012'] })).resolves.toEqual({
      hits: 0,
      items: [],
    });
  });

  it('profile: 404 means no such company', async () => {
    const { client } = setup(() => jsonResponse(loadFixture('not-found.json'), 404));

    await expect(client.getCompanyProfile('00000000')).resolves.toBeNull();
  });
});

describe('CompaniesHouseClient: error statuses throw CompaniesHouseError', () => {
  it('401 → unauthorized', async () => {
    const { client } = setup(() => new Response(null, { status: 401 }));

    const err = await caught(client.getCompanyProfile('NI642876'));

    expect(err.kind).toBe('unauthorized');
    expect(err.status).toBe(401);
  });

  it('429 → rate_limited, retrying at the x-ratelimit-reset time', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 120; // two minutes from now
    const { client } = setup(
      () =>
        new Response(null, {
          status: 429,
          headers: { 'x-ratelimit-reset': String(resetSeconds), 'x-ratelimit-remain': '0' },
        }),
    );

    const err = await caught(client.advancedSearch({ sicCodes: ['62012'] }));

    expect(err.kind).toBe('rate_limited');
    expect(err.retryAt).toEqual(new Date(resetSeconds * 1000));
  });

  it('500 → server_error (retryable)', async () => {
    const { client } = setup(() => new Response('<html>oops</html>', { status: 500 }));

    const err = await caught(client.advancedSearch({ sicCodes: ['62012'] }));

    expect(err.kind).toBe('server_error');
    expect(err.retryable).toBe(true);
  });

  it('400 → http (not retryable)', async () => {
    const { client } = setup(() => new Response(null, { status: 400 }));

    const err = await caught(client.advancedSearch({ sicCodes: ['62012'] }));

    expect(err.kind).toBe('http');
    expect(err.status).toBe(400);
  });
});

describe('CompaniesHouseClient: failures before a response', () => {
  it('fetch throwing (DNS failure, connection reset) → network, keeping the cause', async () => {
    const failure = new TypeError('fetch failed');
    const { client } = setup(() => Promise.reject(failure));

    const err = await caught(client.getCompanyProfile('NI642876'));

    expect(err.kind).toBe('network');
    expect(err.cause).toBe(failure);
  });

  it('no response within timeoutMs → timeout', async () => {
    const { client } = setup(neverResponds, { timeoutMs: 20 });

    const err = await caught(client.getCompanyProfile('NI642876'));

    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect((err.cause as Error | undefined)?.name).toBe('TimeoutError');
  });
});

describe('CompaniesHouseClient: responses that fail validation', () => {
  it('200 with a body that is not JSON → invalid_response', async () => {
    const { client } = setup(() => new Response('not json', { status: 200 }));

    const err = await caught(client.advancedSearch({ sicCodes: ['62012'] }));

    expect(err.kind).toBe('invalid_response');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('200 with a body that fails the schema → invalid_response, with the zod error as cause', async () => {
    const profile = structuredClone(loadFixture('company-profile.json')) as Record<string, unknown>;
    delete profile.company_number;
    const { client } = setup(() => jsonResponse(profile));

    const err = await caught(client.getCompanyProfile('NI642876'));

    expect(err.kind).toBe('invalid_response');
    expect(err.cause).toBeInstanceOf(ZodError);
  });
});

describe('CompaniesHouseClient: logging', () => {
  it('logs method, path, status, duration and rate-limit-remaining for each request', async () => {
    const { client, logs } = setup(() => jsonResponse(loadFixture('company-profile.json')));

    await client.getCompanyProfile('NI642876');

    const line = logs.lines.find((entry) => entry.status === 200);
    expect(line).toMatchObject({
      method: 'GET',
      path: '/company/NI642876',
      status: 200,
      rateLimitRemain: 599,
    });
    expect(typeof line?.durationMs).toBe('number');
  });

  it('logs no rateLimitRemain when the header is missing, rather than 0', async () => {
    // Number(null) is 0, which would make a response without the header look rate-limited.
    const { client, logs } = setup(
      () =>
        new Response(JSON.stringify(loadFixture('company-profile.json')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await client.getCompanyProfile('NI642876');

    const line = logs.lines.find((entry) => entry.status === 200);
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty('rateLimitRemain');
  });

  it('logs rateLimitRemain: 0 when the header really says 0', async () => {
    const { client, logs } = setup(() =>
      jsonResponse(loadFixture('company-profile.json'), 200, { 'x-ratelimit-remain': '0' }),
    );

    await client.getCompanyProfile('NI642876');

    expect(logs.lines.find((entry) => entry.status === 200)?.rateLimitRemain).toBe(0);
  });

  it('never logs the API key or the Authorization header, even when requests fail', async () => {
    const responses: Responder[] = [
      () => jsonResponse(loadFixture('company-profile.json')),
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 500 }),
    ];
    let call = 0;
    const { client, logs } = setup((request) => responses[call++]?.(request) ?? new Response());

    await client.getCompanyProfile('NI642876');
    await client.getCompanyProfile('NI642876').catch(() => undefined);
    await client.getCompanyProfile('NI642876').catch(() => undefined);

    const everything = logs.raw.join('');
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(EXPECTED_AUTH);
    expect(everything.toLowerCase()).not.toContain('authorization');
  });
});
