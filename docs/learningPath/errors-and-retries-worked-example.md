# Worked example: API errors and retry decisions

Reference for writing `packages/integrations/src/companies-house/errors.ts` (issue #8), and for any
later API client (Hunter, Apollo, HubSpot). It uses a **made-up weather API**, so the details
differ from Companies House on purpose. Learn the pattern here; don't copy the code.

The code below typechecks, passes lint, and its 11 tests pass under this repo's config (checked
2026-09-30).

## The core idea

When a call to an API fails, the caller (for us, a BullMQ job) needs to answer one question:
**should I try again?**

- **Try again:** the failure is probably temporary. The server hiccupped, the network blipped, or
  you were told to slow down.
- **Give up:** trying again gives the same result. The key is wrong, the request is malformed,
  or the data doesn't match the schema.

The error module exists so that this answer is decided **once, in one place**, instead of every
caller inspecting status codes itself.

## Concepts and their names

| In the code                                      | Name to search                                             | What it means                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The list of kinds, and retry yes/no              | Transient vs permanent errors ("transient fault handling") | Sorting failures by whether they can succeed on a second attempt                                       |
| `class WeatherApiError extends Error`            | Custom error classes                                       | Your own error type, so callers can recognise it and read attached data                                |
| The `kind` field                                 | Discriminated (tagged) union                               | One field whose value tells TypeScript and the caller which case it is                                 |
| `super(message, { cause })`                      | Error cause / error chaining                               | Keeping the original low-level error inside the high-level one                                         |
| `WeatherApiError.throttled(...)`                 | Static factory methods / named constructors                | Named ways to build an error that guarantee the right fields are set                                   |
| `retryable`, driven by one table                 | Single source of truth                                     | Retry rules live in one place; callers just read the answer                                            |
| `errorFromResponse(status, headers, where, now)` | Functional core, imperative shell                          | Decisions in pure functions that are easy to test; I/O (`fetch`, the clock) stays at the edges         |
| `retryAt` from a response header                 | Rate limiting and backpressure; `Retry-After`              | The server says when to come back, and you respect it                                                  |
| "Retry with backoff" for server errors           | Exponential backoff with jitter                            | Waiting longer between attempts, with randomness, so a struggling server isn't hit by everyone at once |

## Reading list (~1.5 hours, in order)

1. **Custom errors in JavaScript** (20 min)
   - javascript.info, "Custom errors, extending Error"
   - MDN, "Error() constructor" → the `options.cause` section
2. **Discriminated unions** (15 min)
   - TypeScript Handbook → "Narrowing" → "Discriminated unions"
3. **Transient faults and retries** (30 min)
   - Microsoft Azure Architecture Center, "Retry pattern" (vendor-neutral)
   - AWS Builders' Library, "Timeouts, retries, and backoff with jitter"
4. **HTTP status classes and 429** (10 min)
   - MDN, "HTTP response status codes" (4xx = you did something wrong, 5xx = they did)
   - MDN, "429 Too Many Requests" and the "Retry-After" header
5. **Where this ends up: BullMQ retries** (15 min)
   - BullMQ docs, "Retrying failing jobs" and "Stop retrying jobs" (`UnrecoverableError`)
6. **Optional:** Gary Bernhardt, "Boundaries" (talk), for functional core / imperative shell

## The code: `weather-errors.ts`

```ts
// A made-up Weather API client's errors. Same pattern as CompaniesHouseError, different details.

// 1. The kinds: every way a call can fail, named by what the CALLER should do about it.
export type WeatherErrorKind =
  | 'bad_key' // 401/403: our credentials are wrong
  | 'throttled' // 429: too many requests; the server says when to come back
  | 'unavailable' // 5xx: their side is broken, probably temporarily
  | 'timeout' // no response within our time limit
  | 'network' // never reached them (DNS failure, connection reset)
  | 'bad_data' // 200, but the body wasn't what our schema expects
  | 'rejected'; // any other 4xx: our request itself is wrong

// 2. The retry table, as data. `Record<WeatherErrorKind, boolean>` makes TypeScript insist on an
//    entry for every kind: add a kind above and this line fails to compile until you decide.
const RETRYABLE: Record<WeatherErrorKind, boolean> = {
  bad_key: false, // a wrong key stays wrong
  throttled: true, // after retryAt
  unavailable: true, // with backoff
  timeout: true,
  network: true,
  bad_data: false, // retrying returns the same bad data
  rejected: false, // sending the same wrong request again won't help
};

interface Details {
  status?: number;
  retryAt?: Date;
  cause?: unknown;
}

export class WeatherApiError extends Error {
  readonly kind: WeatherErrorKind;
  readonly status: number | undefined;
  readonly retryAt: Date | undefined;

  // 3. Private constructor: callers must use the named factories below, so a `throttled` error
  //    can't be created without a retryAt.
  private constructor(kind: WeatherErrorKind, message: string, details: Details = {}) {
    super(message, { cause: details.cause }); // 4. cause keeps the original low-level error
    this.name = 'WeatherApiError'; // shows in stack traces and logs instead of plain "Error"
    this.kind = kind;
    this.status = details.status;
    this.retryAt = details.retryAt;
  }

  // 5. Single source of truth: callers read this; nobody re-derives it from status codes.
  get retryable(): boolean {
    return RETRYABLE[this.kind];
  }

  // Named constructors ("static factory methods"): each one requires exactly what its kind needs.
  static badKey(where: string, status: number): WeatherApiError {
    return new WeatherApiError('bad_key', `${where} → ${status}: check the API key`, { status });
  }
  static throttled(where: string, retryAt: Date): WeatherApiError {
    return new WeatherApiError(
      'throttled',
      `${where} → 429: retry after ${retryAt.toISOString()}`,
      {
        status: 429,
        retryAt,
      },
    );
  }
  static unavailable(where: string, status: number): WeatherApiError {
    return new WeatherApiError('unavailable', `${where} → ${status}`, { status });
  }
  static rejected(where: string, status: number): WeatherApiError {
    return new WeatherApiError('rejected', `${where} → ${status}`, { status });
  }
  static timeout(where: string, cause: unknown): WeatherApiError {
    return new WeatherApiError('timeout', `${where}: no response in time`, { cause });
  }
  static network(where: string, cause: unknown): WeatherApiError {
    return new WeatherApiError('network', `${where}: could not reach the API`, { cause });
  }
  static badData(where: string, cause: unknown): WeatherApiError {
    return new WeatherApiError('bad_data', `${where}: response did not match the schema`, {
      cause,
    });
  }
}

const DEFAULT_RETRY_DELAY_MS = 60_000;

// 6. The HTTP → error mapping as a PURE function: plain values in, an error out. No fetch, no clock
//    (`now` is a parameter), so every branch is testable with one line.
//    Returns null for statuses that aren't errors, which the client handles itself.
export function errorFromResponse(
  status: number,
  headers: Headers,
  where: string,
  now: Date = new Date(),
): WeatherApiError | null {
  if (status < 400) return null;
  if (status === 401 || status === 403) return WeatherApiError.badKey(where, status);
  if (status === 429) {
    // THIS API's Retry-After is "seconds from now" (a delay). Companies House's x-ratelimit-reset is
    // different: an absolute epoch-seconds timestamp. Same idea, different arithmetic.
    const seconds = Number(headers.get('retry-after'));
    const delayMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS;
    return WeatherApiError.throttled(where, new Date(now.getTime() + delayMs));
  }
  if (status >= 500) return WeatherApiError.unavailable(where, status);
  return WeatherApiError.rejected(where, status);
}

// 7. How a caller uses it: `kind` is a discriminant, so `switch` narrows and the compiler checks
//    every case is handled (the `never` line fails to compile if a kind is missed).
export function describeNextStep(err: WeatherApiError): string {
  switch (err.kind) {
    case 'throttled':
      return `wait until ${err.retryAt?.toISOString() ?? 'later'}, then retry`;
    case 'unavailable':
    case 'timeout':
    case 'network':
      return 'retry with backoff';
    case 'bad_key':
    case 'bad_data':
    case 'rejected':
      return 'stop and alert a human';
    default: {
      const unhandled: never = err.kind;
      return unhandled;
    }
  }
}
```

## The tests: `weather-errors.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { WeatherApiError, describeNextStep, errorFromResponse } from './weather-errors.js';

const where = 'GET /forecast?city=Belfast';
const noHeaders = new Headers();
const now = new Date('2026-09-30T12:00:00Z');

describe('errorFromResponse', () => {
  it('returns null for success statuses', () => {
    expect(errorFromResponse(200, noHeaders, where)).toBeNull();
  });

  it.each([
    [401, 'bad_key', false],
    [403, 'bad_key', false],
    [400, 'rejected', false],
    [404, 'rejected', false],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
  ])('maps %i to %s (retryable: %s)', (status, kind, retryable) => {
    const err = errorFromResponse(status, noHeaders, where);
    expect(err?.kind).toBe(kind);
    expect(err?.retryable).toBe(retryable);
    expect(err?.status).toBe(status);
  });

  it('turns Retry-After (seconds from now) into an absolute retryAt', () => {
    const err = errorFromResponse(429, new Headers({ 'retry-after': '30' }), where, now);
    expect(err?.kind).toBe('throttled');
    expect(err?.retryAt).toEqual(new Date('2026-09-30T12:00:30Z'));
  });

  it('falls back to 60 seconds when Retry-After is missing or garbage', () => {
    for (const headers of [noHeaders, new Headers({ 'retry-after': 'soon' })]) {
      expect(errorFromResponse(429, headers, where, now)?.retryAt).toEqual(
        new Date('2026-09-30T12:01:00Z'),
      );
    }
  });
});

describe('WeatherApiError', () => {
  it('is a real Error with a name, and keeps the original cause', () => {
    const original = new TypeError('fetch failed');
    const err = WeatherApiError.network(where, original);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WeatherApiError);
    expect(err.name).toBe('WeatherApiError');
    expect(err.cause).toBe(original);
    expect(err.retryable).toBe(true);
  });

  it('tells the caller what to do next', () => {
    expect(describeNextStep(WeatherApiError.badData(where, new Error('zod')))).toBe(
      'stop and alert a human',
    );
    expect(describeNextStep(WeatherApiError.timeout(where, new Error('t')))).toBe(
      'retry with backoff',
    );
  });
});
```

## How the numbered comments map to the concepts

1. **Kinds**, named by what the caller should do, not by status code: error classification.
2. **`RETRYABLE: Record<Kind, boolean>`** is the retry table as data. The `Record` type means a new
   kind won't compile until you decide whether it's retryable.
3. **The private constructor plus static factories** are named constructors. You can't create a
   `throttled` error without a `retryAt`.
4. **`{ cause }`** is error chaining. The test checks the original `TypeError` is still reachable.
5. **The `retryable` getter** is the single source of truth. Callers never look at status codes.
6. **`errorFromResponse` is pure**: functional core. Even the clock is a parameter (`now`), which
   is why the 429 test can assert an exact time instead of depending on when it runs.
7. **`switch (err.kind)` with `never`** is a discriminated union at work. Delete a `case`, and
   TypeScript reports that `err.kind` isn't `never`.

## How Companies House differs (don't copy these parts)

- **The 429 header.** This API's `Retry-After: 30` means "30 seconds from now". Companies House's
  `x-ratelimit-reset: 1790679987` is an **absolute time in epoch seconds**. Different arithmetic,
  and the seconds-to-milliseconds (×1000) trap still applies.
- **The fallback.** Companies House states its window (`x-ratelimit-window: 5m`), so a 60-second
  guess isn't needed.
- **404s.** Here, 404 maps to `rejected`. For Companies House, the _client_ handles 404 before any
  error mapping runs: profile → `null`, advanced search → empty page (it returns 404 with an empty
  body when nothing matches). The error mapping should never see a 404.
- **Kind names.** Use #8's: `unauthorized`, `rate_limited`, `server`, `timeout`,
  `invalid_response`, `http`, plus `network` if you add it.

## Exercises

1. Add a kind `maintenance` (a 503 with a special header) in your head. Which places _must_ change,
   and how does TypeScript force each one?
2. Why is `now` a parameter of `errorFromResponse`, and not of `WeatherApiError.throttled`?
3. `retryable` is a getter. Would it appear if you logged the error with pino?

<details>
<summary>Answers</summary>

1. **Forced by the compiler:** the `WeatherErrorKind` union (you add it there), the `RETRYABLE`
   record (missing key → compile error), and the `switch` in `describeNextStep` (the `never` line
   → compile error). **Up to you:** a `WeatherApiError.maintenance(...)` factory, and a branch in
   `errorFromResponse` for the special header. The compiler checks decisions; it can't know
   which statuses map to the new kind.
2. `errorFromResponse` is where "seconds from now" must become an absolute time, so it's the one
   place that needs to know the time. The factory takes an absolute `retryAt` that's already
   worked out, so it never reads the clock. Keeping the clock out of everything except that one
   parameter keeps the rest deterministic and easy to test.
3. **No.** Class getters live on the prototype and aren't enumerable, and pino's error serializer
   copies the error's enumerable properties. So `kind`, `status` and `retryAt` (set in the
   constructor) appear in logs, and `retryable` doesn't. If you want it logged, add it explicitly
   (`log.warn({ err, retryable: err.retryable }, ...)`) or make it a real property set in the
   constructor.

</details>
