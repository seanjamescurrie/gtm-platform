# Learning path: #8 Companies House client

Companion to issue #8 (hand-written). Part 1 records what each piece of the work taught, with
names you can search. Part 2 describes the client as built. Part 3 is what to revise, with
exercises. Reference: [errors and retries worked example](errors-and-retries-worked-example.md).

**Goal:** explain every decision in `packages/integrations/src/companies-house/` in 30 seconds:
what it does, why, and what it costs.

## Progress

- [x] Checkpoint 1: `getCompaniesHouseApiKey` in `@gtm/config`
- [x] Checkpoint 2: response schemas and real fixtures
- [x] `errors.ts`: error kinds, retry table, status mapping
- [x] Checkpoint 3: `client.ts`, the HTTP core
- [x] Checkpoint 4: `advancedSearch` and `getCompanyProfile`, logging, exports
- [x] Smoke test against the live API (2026-10-02): real search, real profile, real 404, key never logged
- [ ] PR merged, and Part 3 revised

## Part 1: lessons

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

### Client (checkpoints 3–4)

| Lesson                                                                                                     | Name to search                           | Where it bit us                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| An injected dependency only helps if the code **uses** it                                                  | Dependency injection                     | Calling global `fetch` instead of `this.fetch`: the tests hit the real internet       |
| `+` binds tighter than `??`, so `a ?? b + c` means `a ?? (b + c)`                                          | Operator precedence                      | Every request went to the bare domain; use `new URL(path, base)` instead              |
| `x ?? undefined` does nothing; the default goes on the right of `??`                                       | Nullish coalescing                       | `timeoutMs ?? 0` made `AbortSignal.timeout(0)` abort every request instantly          |
| Keep a `try` around **only** the call that can fail in the way the `catch` handles                         | Scope of exception handlers              | Your own `unauthorized`/`rate_limited` errors were caught and re-wrapped as `network` |
| `throw` only real errors: `const e = f(); if (e) throw e;`                                                 | Null checks; `only-throw-error`          | `throw errorFromResponse(...)` threw `null` on every 200                              |
| Read the body **after** checking the status                                                                | —                                        | `response.json()` on a 401/500 HTML body threw a `SyntaxError` first                  |
| Map names at the boundary in **both** directions: response fields _and_ query parameters                   | Anti-corruption layer                    | `status` → `company_status`; the typo `company_names_includes` is silently ignored    |
| Truthiness drops real values: `if (0)` is false                                                            | Truthy/falsy; `!== undefined`            | `startIndex: 0` (the first page) would never be sent                                  |
| A generic helper (`<S extends z.ZodType>` → `z.output<S>`) gives every method a typed result with no `any` | TypeScript generics                      | `schema?: any` caused 10 lint errors and untyped returns                              |
| Let each caller decide what "not found" means; don't make the helper inspect which schema it got           | Separation of concerns                   | Comparing `schema === advancedSearchPageSchema` inside the helper                     |
| A type annotation must be honest: `T \| null` can't go into a `T`                                          | Type narrowing                           | TS2719 "two different types with this name"; **read the last line** of the error      |
| `??` can't help when the left side is never `null`: `Number(x)` always returns a number                    | Constant nullishness                     | `Number(header) ?? undefined` still logged `0` for a missing header                   |
| Don't keep secrets longer than needed; build what you need from them once                                  | Least privilege                          | The raw key was stored on the client; now only the auth header is                     |
| A client shouldn't read config; the caller injects it. Never import another package by relative path       | Dependency injection; package boundaries | `../../../config/src/index.js` inside `client.ts`                                     |
| Copy-paste can bring in invisible characters                                                               | `no-irregular-whitespace`                | A non-breaking space on the logging line                                              |
| `tsx -e` compiles to CommonJS, so no top-level `await`; wrap the code in an `async` function               | CJS vs ESM                               | The first smoke-test command failed                                                   |
| A test is only proven when it **fails against the bug**                                                    | Mutation testing                         | The missing-header test was checked by putting the bug back                           |
| Writing everything at once tangles bugs together; make **one test** pass at a time (`vitest -t "name"`)    | Test-driven development (TDD)            | The first client draft: 1 of 20 passing, three bugs hiding each other                 |

### Companies House quirks (checked against the live API)

- **Advanced search** (`/advanced-search/companies`) filters by `sic_codes` and `company_status`
  on the server, returns up to 5,000 items per page, and each item includes `sic_codes`.
- **`sic_codes` can be comma-joined or repeated;** both mean OR (62011 + 62012 → 129,973 hits).
- **No matches is an HTTP 404 with an empty body,** not a 200 with `hits: 0`.
- **Profile not found is a 404** with body `{ timestamp, message, request_id }`, not the documented
  `errors` array. Decide on 404 from the status code; never parse the body.
- **Profiles use `type`; search items use `company_type`.** Only profiles have `etag`.
- **Addresses are sparse:** any field can be missing, including the whole address.
- **Rate-limit headers:** `x-ratelimit-limit` (600), `x-ratelimit-remain` (note: not
  `remaining`), `x-ratelimit-reset` (absolute epoch seconds), `x-ratelimit-window` (`5m`).
- **Auth:** HTTP Basic, API key as the username, empty password.

## Part 2: the client, as built (`client.ts`)

### Shape

One private generic helper, `companiesHouseHttpClient<S>({ path, query, schema })`, does the HTTP
work and returns `z.output<S> | null`, where `null` means "not found". Two public methods use it:

- `advancedSearch(query)` returns `AdvancedSearchPage`, turning `null` into `{ hits: 0, items: [] }`.
- `getCompanyProfile(companyNumber)` returns `CompanyProfile | null`, passing `null` through.

Same status code, two meanings: **each method decides what its own 404 means.**

### Options (dependency injection)

| Option      | Default                                          | Why it's injectable                                                    |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `apiKey`    | required                                         | The caller gets it from `getCompaniesHouseApiKey()`                    |
| `logger`    | required                                         | The caller passes a pino child that already carries the correlation id |
| `fetch`     | `globalThis.fetch`                               | Tests pass a fake; #10 (rate limiter) and #11 (cache) wrap it later    |
| `baseUrl`   | `https://api.company-information.service.gov.uk` | Tests, and a sandbox if you ever need one                              |
| `timeoutMs` | `10_000`                                         | Short in tests; tune after timing a `size=5000` search                 |

The `Authorization` header is built once in the constructor, and the raw key isn't stored.

### The request pipeline

1. **URL:** `new URL(path, baseUrl)`, then `url.search = query.toString()`. Each method maps its
   own camelCase options to Companies House names, skipping `undefined` (not falsy) values.
2. **Request:** `GET` with the prebuilt `Authorization` header and `AbortSignal.timeout(timeoutMs)`.
3. **`fetch` inside a narrow `try`:** a `TimeoutError` → `timeout`; anything else → `network`.
   Nothing else is inside the `try`.
4. **Log once:** `method`, `path`, `status`, `durationMs` (rounded), and `rateLimitRemain`
   (`undefined` when the header is missing). Never headers, the key or the auth value.
5. **404** → return `null`. The body isn't read.
6. **Other errors:** `const error = errorFromResponse(...); if (error) throw error;`
7. **Body:** `response.json()` in its own `try` (invalid JSON → `invalidResponse`), then
   `schema.safeParse(body)` (failure → `invalidResponse` with the `ZodError` as cause).

### Failure modes and how each is handled

| Failure                                     | Handling                                             | Retry? | Test                                     |
| ------------------------------------------- | ---------------------------------------------------- | ------ | ---------------------------------------- |
| No response within the timeout              | `timeout`, cause = `TimeoutError`                    | Yes    | `no response within timeoutMs → timeout` |
| DNS failure / connection reset              | `network`, cause = the `TypeError`                   | Yes    | `fetch throwing … → network`             |
| Bad or missing key (401/403)                | `unauthorized`                                       | No     | `401 → unauthorized`; errors tests       |
| Rate limited (429)                          | `rate_limited`, `retryAt` = reset time, ≥ now        | Yes    | `429 → rate_limited …`; errors tests     |
| Companies House outage (5xx)                | `server_error`                                       | Yes    | `500 → server_error`                     |
| Our request is wrong (other 4xx)            | `http`, with `status`                                | No     | `400 → http`                             |
| Search matches nothing (404, empty body)    | `{ hits: 0, items: [] }`                             | —      | `advanced search: 404 … no matches`      |
| Company doesn't exist (404)                 | `null`                                               | —      | `profile: 404 means no such company`     |
| 200 but not JSON                            | `invalid_response`                                   | No     | `200 with a body that is not JSON`       |
| 200 but the wrong shape                     | `invalid_response`, cause = `ZodError`               | No     | `200 with a body that fails the schema`  |
| Sparse data (missing SIC codes, address, …) | Parses; `sicCodes` defaults to `[]`                  | —      | schema tests                             |
| Rate-limit header missing                   | `rateLimitRemain` omitted from the log, not `0`      | —      | `logs no rateLimitRemain when … missing` |
| Key leaking into logs                       | Only the method, path, status and numbers are logged | —      | `never logs the API key …`               |

## Part 3: what to revise

### The six ideas that matter most

Revise these first; they come back in every later integration (Hunter, Apollo, HubSpot) and in
interviews.

1. **Validate at the boundary, from real data.** Fixtures are recorded responses; schemas are
   written until they parse; output is camelCase and typed. _Revise:_ `schemas.ts`, the schema tests.
2. **Classify errors by what the caller should do.** One error class, a `kind`, a `RETRYABLE`
   table, `cause` vs `status`. _Revise:_ `errors.ts` and the worked example.
3. **Absolute times vs delays.** `x-ratelimit-reset` is a moment, not a duration; seconds vs
   milliseconds; clamping. _Revise:_ `retryAtFrom` and its tests.
4. **Dependency injection makes code testable and extensible.** `fetch`, `logger` and `apiKey` come
   in from outside, which is how the tests run offline and how #10 and #11 will plug in.
   _Revise:_ the constructor, and `setup()` in `client.test.ts`.
5. **Narrow `try` blocks.** Catch only the failure you mean to translate. _Revise:_ the `fetch`
   call in `client.ts`, and the "Client" lessons table above.
6. **JavaScript's sharp edges:** `??` vs `||`, truthiness, operator precedence, `Number(null)`.
   _Revise:_ the "Client" and "Errors" lessons tables.

### Exercises (on a scratch branch)

1. **Put a bug back, and predict which tests fail before you run them.** Try each:
   `fetch` instead of `this.fetch`; widen the `try` to cover the status checks; `if (startIndex)`;
   `throw errorFromResponse(...)` without the null check. Were your predictions right?
2. **Add a third endpoint** (e.g. `GET /company/{number}/officers`, needed in weeks 3–4): a fixture,
   a schema, a method and tests. Notice how little of the helper changes; that's the payoff of the
   generic helper and "each method decides what 404 means".
3. **Wrap `fetch`** with a function that logs every URL it's called with, and pass it in as the
   `fetch` option. That's the shape #10 and #11 will take.
4. **Explain the 429 path end to end, out loud:** header → `retryAtFrom` → `rateLimited` →
   `retryable` → what #9's BullMQ job will do with it.

### Read again (~1 hour)

- MDN: "Using the Fetch API", `AbortSignal.timeout()`, `URL`, `URLSearchParams`.
- MDN: "Nullish coalescing operator (??)" and "Operator precedence" (find `??` and `+` in the table).
- TypeScript Handbook: "Generics", and "Narrowing" (for `T | null`).
- zod docs: `safeParse`, `.default()`, `.extend()`, and `z.output`.
- Microsoft Azure Architecture Center: "Retry pattern".

## Self-check (answer out loud)

1. Why do the schemas live in `integrations`, not `db`?
2. Why is a 404 not an error, and why does it mean different things for the two methods?
3. Which error kinds should a BullMQ job retry, and how does it know without checking status codes?
4. What would go wrong if `retryAt` added `now` to `x-ratelimit-reset`?
5. Why inject `fetch` instead of importing it, and which two later issues depend on that?
6. Why must a fake `fetch` in a timeout test listen to the abort signal?
7. Why is the `try` around `fetch` so small? What happened when it wasn't?
8. Why does the client take an `apiKey` instead of reading `COMPANIES_HOUSE_API_KEY` itself?
9. Why is `rateLimitRemain` omitted, rather than `0`, when the header is missing?
10. What does the generic `<S extends z.ZodType>` buy you over `schema: any`?
