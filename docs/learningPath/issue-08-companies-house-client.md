# Learning path: #8 Companies House client

Companion to issue #8 (hand-written). Part 1 records what the schema and error work taught,
with names you can search. Part 2 is the plan for `client.ts`. Reference:
[errors and retries worked example](errors-and-retries-worked-example.md).

**Goal:** explain every decision in `packages/integrations/src/companies-house/` in 30 seconds:
what it does, why, and what it costs.

## Progress

- [x] Checkpoint 1: `getCompaniesHouseApiKey` in `@gtm/config`
- [x] Checkpoint 2: response schemas and real fixtures
- [x] `errors.ts`: error kinds, retry table, status mapping
- [ ] Checkpoint 3: `client.ts`, the HTTP core
- [ ] Checkpoint 4: `advancedSearch` and `getCompanyProfile`, logging, exports
- [ ] PR review, and failure modes checked against tests

## Part 1: lessons so far

### Schemas (checkpoint 2)

| Lesson                                                                                               | Name to search                           | Where it bit us                                                  |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Write schemas from **real responses**, not memory or docs                                            | Contract testing; recorded fixtures      | `name` vs `company_name`; `region` required but usually absent   |
| Generating test data from your own schema only proves the schema agrees with itself                  | Circular testing; property-based testing | `zod-fixture` was removed                                        |
| A plain JavaScript operator runs **once, when the file loads**; a zod method runs **during parsing** | Schema modifiers; `.default()`           | `z.array(...) \|\| []` never applied a default                   |
| zod 4 still runs `.refine()` after an earlier check fails, so refinements must not throw             | zod 4 checks and `abort`                 | `new URL()` inside a refine threw on garbage input (#4)          |
| The **wire shape** (what the API sends) and the **storage shape** (your table) are different things  | Anti-corruption layer; boundary mapping  | Schemas live in `integrations`; mapping to DB rows happens in #9 |
| Two endpoints can describe the same thing differently; share a base, extend per endpoint             | `z.object().extend()`                    | Profile says `type`, search item says `company_type`             |
| Keep snake_case private; export only the camelCase output types                                      | Encapsulation at the boundary            | Raw schemas are not exported                                     |
| zod strips unknown keys by default. Say so in a comment, so a reader knows it's deliberate           | Strip vs strict vs passthrough objects   | Profiles have ~20 fields we don't use                            |
| Validation strictness is a trade-off: too strict fails startup, too loose fails at the first request | Fail fast; defensive validation          | Keys must be v4 UUIDs (your decision, recorded in the test)      |

### Errors

| Lesson                                                                                                       | Name to search                                     | Where it bit us                                               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| Classify failures by **what the caller should do**, not by status code                                       | Transient vs permanent errors                      | The `RETRYABLE` table                                         |
| `Record<Kind, boolean>` forces a decision for every new kind                                                 | Exhaustiveness checking                            | Adding `http` wouldn't compile until its row existed          |
| A factory takes a **`cause`** when you _caught_ something, and a **`status`** when you _received a response_ | Error chaining (`Error.cause`)                     | `invalidResponse` and `http` had each other's parameters      |
| Don't invent a `cause`: an `Error` you create yourself only repeats the message and adds a misleading stack  | Error wrapping                                     | `new Error('Unexpected status code')` was removed             |
| An **absolute time** is not a **delay**. `x-ratelimit-reset` is _when_, not _how long_                       | Epoch time; timestamps vs durations                | `now + reset` gave a retry time in 2083                       |
| Epoch **seconds** × 1000 = JavaScript **milliseconds**                                                       | Unix time                                          | Forgetting it gives January 1970                              |
| Clamp times that come from another machine's clock                                                           | Clock skew                                         | `Math.max(reset, now)` stops instant retries into another 429 |
| `Number(null)` is `0`, and `Number('soon')` is `NaN`, and `NaN <= 0` is `false`                              | JavaScript type coercion                           | Garbage headers slipped past a `<= 0` check                   |
| Keep the clock as a parameter at one edge; helpers shouldn't default to `new Date()`                         | Functional core, imperative shell; clock injection | Exact-time tests for 429s                                     |
| Copying an example is fine; **justify every line for your own case** or delete it                            | —                                                  | The weather API's `retry-after` survived two reviews          |

### Companies House quirks (checked against the live API)

- **Advanced search** (`/advanced-search/companies`) filters by `sic_codes` and `company_status`
  on the server, returns up to 5,000 items per page, and each item includes `sic_codes`.
- **No matches is an HTTP 404 with an empty body,** not a 200 with `hits: 0`.
- **Profile not found is a 404** with body `{ timestamp, message, request_id }`, not the documented
  `errors` array. Decide on 404 from the status code; never parse the body.
- **Profiles use `type`; search items use `company_type`.** Only profiles have `etag`.
- **Addresses are sparse:** any field can be missing, including the whole address.
- **Rate-limit headers:** `x-ratelimit-limit` (600), `x-ratelimit-remain` (note: not
  `remaining`), `x-ratelimit-reset` (absolute epoch seconds), `x-ratelimit-window` (`5m`).
- **Auth:** HTTP Basic, API key as the username, empty password.

## Part 2: the client (`client.ts`)

### What it has to do

One private `request` function does the HTTP work. Two public methods use it:

- `advancedSearch(params)` returns `AdvancedSearchPage`. A 404 means "no matches", so it returns
  `{ hits: 0, items: [] }`.
- `getCompanyProfile(companyNumber)` returns `CompanyProfile | null`. A 404 means "no such company",
  so it returns `null`.

Same status code, two meanings: **each method decides what its own 404 means.**

### Options (dependency injection)

| Option      | Default                                          | Why it's injectable                                                    |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `apiKey`    | required                                         | The caller gets it from `getCompaniesHouseApiKey()`                    |
| `logger`    | required                                         | The caller passes a pino child that already carries the correlation id |
| `fetch`     | `globalThis.fetch`                               | Tests pass a fake; #10 (rate limiter) and #11 (cache) wrap it later    |
| `baseUrl`   | `https://api.company-information.service.gov.uk` | Tests, and a sandbox if you ever need one                              |
| `timeoutMs` | `10_000`                                         | Short in tests; tune after timing a `size=5000` search                 |

### The request pipeline, step by step

1. **Build the URL** with `new URL(path, baseUrl)` and `URLSearchParams`. Leave out parameters that
   are `undefined`. **Experiment first:** in Postman, check whether advanced search wants
   `sic_codes=62011,62012` or `sic_codes=62011&sic_codes=62012`, by comparing `hits`.
2. **Auth header:** `Authorization: Basic ` + base64 of `` `${apiKey}:` `` (note the colon).
   `Buffer.from(...).toString('base64')` works in Node.
3. **Timeout:** pass `signal: AbortSignal.timeout(timeoutMs)` to `fetch`.
4. **Call `fetch` inside `try`/`catch`.** If it throws, no response arrived:
   - `err.name === 'TimeoutError'` → `CompaniesHouseError.timeout(where, err)`
   - anything else → `CompaniesHouseError.network(where, err)`
5. **Log once per request:** method, path, status, `durationMs`, and `x-ratelimit-remain`.
   **Never** log headers wholesale, the `Authorization` value or the key.
6. **404:** return a "not found" signal to the calling method; don't throw, and don't parse the body.
7. **Other statuses:** `const err = errorFromResponse(status, response.headers, where)`; if not
   `null`, throw it.
8. **Parse the body:** `await response.json()` inside `try`/`catch` (invalid JSON →
   `invalidResponse(where, err)`), then `schema.safeParse(body)` (failure →
   `invalidResponse(where, result.error)`). The zod error is the cause, so the logs show the exact
   field path.

`where` is `` `${method} ${path}` ``. The query string is safe to include, because the key travels
in a header.

### Testing it without the network

- **Fake fetch:** a function that returns `new Response(JSON.stringify(fixture), { status, headers })`.
  Wrap it in `vi.fn()` so you can inspect the URL and headers it was called with.
- **The timeout gotcha:** a fake that never resolves _and ignores the signal_ will hang the test
  forever. A realistic fake listens to `init.signal` and rejects when it aborts, the way real
  `fetch` does. Use a small `timeoutMs` (e.g. 20).
- **Capturing logs:** create pino with a custom destination (an object with a `write(line)` method
  that pushes to an array), then assert on the parsed lines, including that the key never appears.

### Test list

| Case                                     | Expect                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| Search, 200 with the real fixture        | Typed page; URL has the path and `sic_codes`                   |
| Any request                              | `Authorization` is `Basic base64(key + ':')`                   |
| Search, 404 with an empty body           | `{ hits: 0, items: [] }`                                       |
| Profile, 200 with the real fixture       | Typed profile, with `etag`                                     |
| Profile, 404                             | `null`                                                         |
| Company number with odd characters       | It's URL-encoded in the path                                   |
| 401 / 429 / 500 / 400                    | Throws `CompaniesHouseError` with the matching `kind`          |
| `fetch` rejects with a `TypeError`       | `network`, with `cause` being that error                       |
| `fetch` never resolves                   | `timeout` (small `timeoutMs`; fake respects the signal)        |
| 200 with invalid JSON                    | `invalid_response`                                             |
| 200 with a body missing `company_number` | `invalid_response`, with a zod error as `cause`                |
| Logs                                     | Contain status and `x-ratelimit-remain`; never contain the key |

### Suggested order, with review checkpoints

1. **Options and URL building.** Write the tests for the URL and auth header first.
2. **Status handling:** 404 per method, then `errorFromResponse`.
3. **Failures before a response:** timeout and network.
4. **Parsing:** invalid JSON, schema mismatch. → _Checkpoint 3 review_
5. **Logging**, and the public exports in `packages/integrations/src/index.ts` (the client,
   `CompaniesHouseError` and the output types). → _Checkpoint 4 review_
6. **Manual smoke test** against the real API: one `advancedSearch` for SIC `62012` and one
   `getCompanyProfile('NI642876')`. Check the logs show `x-ratelimit-remain` and no key.

### Read first (~45 min)

- MDN: "Using the Fetch API", `Response`, `Headers`, `URL` and `URLSearchParams`.
- MDN: `AbortSignal.timeout()`. Note it rejects with a `DOMException` named `'TimeoutError'`.
- MDN: "HTTP authentication" → the Basic scheme.
- pino docs: "child loggers", and the `destination` argument (for capturing logs in tests).
- Vitest docs: `vi.fn()` and mock call inspection (`mock.calls`).

## Self-check (answer out loud)

1. Why do the schemas live in `integrations`, not `db`?
2. Why is a 404 not an error, and why does it mean different things for the two methods?
3. Which error kinds should a BullMQ job retry, and how does it know without checking status codes?
4. What would go wrong if `retryAt` added `now` to `x-ratelimit-reset`?
5. Why inject `fetch` instead of importing it, and which two later issues depend on that?
6. Why must a fake `fetch` in a timeout test listen to the abort signal?
