# Learning path: #11 Valkey response cache

Companion to issue #11. Claude writes this one in checkpoints and stops after each to explain the
why and the trade-off; you review. Part 1 is the design and what to look for in each checkpoint.
Part 2 records what each piece taught, Part 3 describes the cache as built with its failure
modes, and Part 4 is what to revise.

**Goal:** explain in 30 seconds what makes two requests "the same", why the cache sits outside the
rate limiter, and why it fails open when the limiter fails closed.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue; this doc
- [x] Checkpoint 1: `getRedisCacheUrl()` in `@gtm/config`
- [x] Checkpoint 2: `requestCacheKey(method, url)`
- [x] Checkpoint 3: `cachedFetch` in `@gtm/infra`
- [x] Checkpoint 4: wiring; `cache` field in the Companies House request log
- [x] Checkpoint 5: live run (2026-10-29): a re-run with a new run id made zero requests; lessons; PR

## Part 1: the design

### The problem in one paragraph

Today a same-day re-run makes no API calls only because it reuses the same job ids, so BullMQ skips
it. A run with a new run id, a retried job, or enrichment in weeks 3–4 would ask Companies House
again for data fetched minutes earlier. Each of those calls costs a rate-limit token and, for paid
providers later, money. A cache in Valkey makes a repeat call free across runs, workers and restarts.

### Where it sits

```
CompaniesHouseClient
  └─ fetch = cachedFetch( rateLimitedFetch( globalThis.fetch, bucket ), cache )
```

- **Around `fetch`, like the limiter.** The client doesn't change: the same decorator pattern as
  #10, now two layers deep.
- **Outside the limiter.** The outer wrapper runs first, so a hit returns before a token is taken.
  Swap the order and every hit would still wait for, and spend, a token.
- **Raw HTTP responses, not parsed results.** The cache stores status, content type and body. When a
  schema changes, cached responses are simply parsed again; nothing needs clearing. The same wrapper
  will serve Hunter and Apollo later. Trade-off: the cache can't tell a good 200 from a nonsense one;
  zod still checks every body when it's read.

### What makes two requests "the same"

- **Method plus URL, with query parameters sorted**, hashed with SHA-256: `cache:http:v1:<hash>`.
  `?a=1&b=2` and `?b=2&a=1` are the same request.
- **No headers, `Authorization` included.** The data doesn't depend on which key asked, and a secret
  must never end up in a Valkey key (keys show up in `KEYS`, `SCAN` and monitoring tools).
- **`v1`** clears every entry at once if the stored format changes: bump it, and old keys are never
  read again and expire on their own.

### What is cached, and for how long

| Response                    | Cached for | Why                                                                    |
| --------------------------- | ---------- | ---------------------------------------------------------------------- |
| `200` to a `GET`            | 24 hours   | Companies House data changes slowly; the milestone is same-day re-runs |
| `404` to a `GET`            | 1 hour     | "No matches" is a real answer, but a new company can appear            |
| 401, 429, 5xx, other errors | Never      | They describe a moment, not the data                                   |
| Non-`GET` requests          | Never      | Only reads are safe to replay                                          |
| A body larger than 5 MB     | Never      | Caps what one entry can take, since local Valkey can't evict           |

Caching a 404 is called **negative caching**. It's the reason the TTL depends on the status.

### Fail open, where the limiter fails closed

If the cache's Valkey can't be read or written, log a warning and call the real `fetch`, which still
goes through the limiter. A corrupt entry is a miss, and is deleted.

| Component    | When Valkey is down | Why                                                                  |
| ------------ | ------------------- | -------------------------------------------------------------------- |
| Rate limiter | Fail **closed**     | Allowing requests nobody is counting risks a 429 storm               |
| Cache        | Fail **open**       | The cache is an optimisation: losing it costs speed, not correctness |

The question to ask of any shared dependency: _if it disappears, is it safer to stop or to carry on?_

### Valkey memory: why `REDIS_CACHE_URL` exists

BullMQ needs `noeviction`: Valkey must never throw a job away. A cache wants the opposite: old
entries thrown away under memory pressure. One instance can't have both policies. Locally we share
one instance and keep it safe with an expiry on every entry and a 5 MB cap per entry. In production
(weeks 11–12) ElastiCache sets a memory limit, and a full cache would make BullMQ's writes fail, so
`REDIS_CACHE_URL` (defaulting to `REDIS_URL`) lets the deploy point the cache at a separate cluster
with `allkeys-lru`, with no code change.

### Seeing hits

The cache adds `x-cache: hit` or `x-cache: miss` to the responses it returns, and the client's
request log line gains a `cache` field from that header. Without it, a cache hit would still log a
"companies house request" line and look like a real call.

## What to look for in each checkpoint

| Checkpoint | Read                                          | Be able to say                                                                             |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1          | `getRedisCacheUrl` and its tests              | Why a default to `REDIS_URL` rather than a required variable                               |
| 2          | `requestCacheKey` and its tests               | Why sort the query, why hash, why no headers                                               |
| 3          | `cachedFetch`, its unit and integration tests | Why a body can only be read once, and what the wrapper does about it; every fail-open path |
| 4          | `index.ts`, the client's log line             | What breaks if the two wrappers are swapped                                                |
| 5          | The live-run numbers                          | How the logs prove "zero duplicate calls"                                                  |

## Part 2: lessons

| Lesson                                                                                     | Name to search                       | Where it showed up                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| A cache key decides what "the same request" means; when in doubt, keep requests apart      | Cache key normalisation              | Path and repeated-parameter order are left as they are                                            |
| One line can do two jobs; remove it and watch which tests fail                             | Mutation testing                     | `searchParams.sort()` also re-encodes the query (`,` vs `%2C`): 4 tests failed, not 1             |
| Hash keys that come from user-visible data                                                 | Data minimisation                    | Query strings can carry search terms; keys show up in `SCAN` and monitoring                       |
| A response body is a stream: it can only be read once                                      | Fetch API body; `Response.clone()`   | The wrapper reads it to store it, then returns a fresh `Response` from the text                   |
| Responses from `fetch` have read-only headers; build a new `Response` around the same body | Headers guard ("immutable")          | Adding `x-cache` threw until the body was re-wrapped                                              |
| Don't read what you won't keep                                                             | Streaming                            | Uncacheable or oversized bodies pass through as streams, unread                                   |
| After decoding, wire headers lie                                                           | `content-encoding`, `content-length` | They're dropped on a miss, since the body is now decoded text                                     |
| A tiny interface beats faking a big client                                                 | Interface segregation; adapter       | `CacheStore` (3 methods) instead of ioredis's many `set` overloads                                |
| Types from the DOM aren't there in a Node-only project; take them from the value           | `ConstructorParameters`              | `BodyInit` didn't exist; `ConstructorParameters<typeof Response>[0]` did                          |
| Decorator order matters, and nothing errors when it's wrong                                | Middleware ordering                  | Limiter outside the cache: every hit still spent a token. Now a test pins it                      |
| Ask of every shared dependency: if it disappears, stop or carry on?                        | Fail-open vs fail-closed             | The cache carries on; the limiter stops                                                           |
| A default can hide a deploy mistake                                                        | Secure defaults                      | Forget `REDIS_CACHE_URL` in production and the cache silently shares BullMQ's `noeviction` Valkey |
| When some logs are out of reach, measure from shared state                                 | Observability                        | The live run counted cache keys and watched the bucket key, which every worker touches            |

## Part 3: the cache as built

### Shape

```
CompaniesHouseClient
  └─ fetch = companiesHouseFetch(...)                         apps/worker/src/ingest/http.ts
       = cachedFetch(                                         packages/infra/src/cache/cached-fetch.ts
           rateLimitedFetch(globalThis.fetch, bucket),        #10
           redisCacheStore(cacheConnection))                  packages/infra/src/cache/cache-store.ts

GET → requestCacheKey → store.get
  hit:  Response from the entry (x-cache: hit)                no token, no request
  miss: fetch → 200/404 and ≤ 5 MB? store with TTL → fresh Response (x-cache: miss)
        anything else → the body stream, unread (x-cache: miss)
```

| File                                                  | Role                                                      |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `packages/config/src/index.ts`                        | `getRedisCacheUrl()`: `REDIS_CACHE_URL`, else `REDIS_URL` |
| `packages/infra/src/cache/request-key.ts`             | `requestCacheKey`: method + normalised URL, SHA-256       |
| `packages/infra/src/cache/cache-store.ts`             | `CacheStore` and the Valkey adapter (`SET … PX`)          |
| `packages/infra/src/cache/cached-fetch.ts`            | The wrapper: rules, hit/miss, fail open                   |
| `apps/worker/src/ingest/http.ts`                      | `companiesHouseFetch`: the order, with a test             |
| `packages/integrations/src/companies-house/client.ts` | The `cache` field on the request log line                 |

### Settings

| Setting        | Value                                    | Why                                                       |
| -------------- | ---------------------------------------- | --------------------------------------------------------- |
| Key            | `cache:http:v1:<sha256 of method + URL>` | Short, opaque; `v1` abandons everything at once if needed |
| 200            | 24 hours                                 | Data changes slowly; same-day re-runs                     |
| 404            | 1 hour                                   | Negative caching; a new company can appear                |
| Other statuses | Not cached                               | They describe a moment                                    |
| Methods        | `GET` only                               | Only reads are safe to replay                             |
| Max entry      | 5 MB                                     | Local Valkey can't evict; a 5,000-item page is about 3 MB |
| Where          | `REDIS_CACHE_URL`, default `REDIS_URL`   | A separate, evicting cluster in production                |

### The live run (2026-10-29)

SIC 62020, 50 per page, 6 pages; three workers (one started for the test, plus `pnpm dev`).

| Run                    | Jobs | Cache entries after | Tokens taken                          | Log lines (my worker) |
| ---------------------- | ---- | ------------------- | ------------------------------------- | --------------------- |
| `cache-a` (first)      | 6    | 6                   | yes                                   | 3 misses, 64–304 ms   |
| `cache-b` (new run id) | 6    | still 6             | **none**: bucket key never reappeared | 2 hits, 1–2 ms        |

So a re-run under a new run id made zero Companies House requests across all workers. Before #11,
only a same-run-id re-run did, and only because BullMQ deduped the jobs.

### Failure modes and how each is handled

| Failure                                               | Handling                                                                  | Test                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| The cache's Valkey is down (read)                     | Logged; treated as a miss; the request goes through the limiter as normal | Unit; integration ("fails open") |
| The cache's Valkey is down (write)                    | Logged; the response is still returned                                    | Unit                             |
| A corrupt or wrong-shaped entry                       | Logged; deleted; treated as a miss; a good entry replaces it              | Unit                             |
| A 401, 429 or 5xx                                     | Never cached; returned as it came                                         | Unit; integration (500)          |
| A non-`GET` request                                   | Passed straight through; the store isn't touched                          | Unit                             |
| A body over 5 MB (declared or actual)                 | Returned in full, not stored; a declared one isn't even read              | Unit                             |
| `fetch` itself fails (incl. `RateLimitExceededError`) | The error comes out unchanged; nothing stored                             | Unit                             |
| An entry's TTL runs out                               | Valkey deletes it; the next request is a miss                             | Integration                      |
| Two workers miss the same URL at once                 | Both fetch; both store the same thing. Accepted (see gaps)                | By design                        |
| Cache placed inside the limiter by mistake            | A test fails: a hit must take no token                                    | Unit (`http.test.ts`)            |
| Data changes at Companies House within 24 hours       | Served stale until the entry expires                                      | Accepted (see gaps)              |

### Known gaps

- **The AWS deploy must set `REDIS_CACHE_URL`** to a separate cluster with `allkeys-lru`. Nothing
  fails at startup if it's forgotten; the cache would share BullMQ's `noeviction` instance.
- **Up to 24 hours stale.** A company dissolved this morning can still show as active. Fine for
  prospecting; a reason to shorten the TTL for anything that drives sending (week 8).
- **No single-flight lock.** Simultaneous misses on one URL each fetch it. Rare, because job ids
  dedupe pages, and the limiter keeps it safe.
- **No hit-rate metric.** Hits are visible per log line, not as a number over time (week 10).
- **Keys aren't human-readable.** The entry stores its URL, so `GET <key>` in `valkey-cli` shows
  what it holds.

## Part 4: what to revise

### The five ideas that matter most

1. **What "the same request" means.** Normalise what can't change the answer; keep apart what
   might. _Revise:_ `request-key.ts` and its two test groups.
2. **Bodies are streams.** Read once, re-wrap, pass through what you won't keep. _Revise:_
   `cachedFetch`'s miss path.
3. **Order of decorators.** Cache outside the limiter, and a test that fails if they swap.
   _Revise:_ `http.ts` and `http.test.ts`.
4. **Fail open vs fail closed.** The same question for every shared dependency. _Revise:_ the table
   in Part 1.
5. **Separate what needs different guarantees.** BullMQ needs `noeviction`; a cache needs eviction.
   _Revise:_ "Valkey memory" in Part 1.

### Exercises (on a scratch branch)

1. **Swap the wrappers** in `http.ts`, run a live ingest twice, and watch the limiter's waits on
   the second run. Then explain why the cache "worked" (no API calls) but the budget still drained.
2. **Single-flight.** Use `SET key value NX PX 5000` as a lock so only one worker fetches a missing
   URL while the others wait for the entry. What happens if the lock holder dies?
3. **Stale-while-revalidate.** Serve an entry older than 12 hours but refresh it in the
   background. What does that buy, and what does it cost?
4. **Measure memory.** After an ingest, run `MEMORY USAGE <key>` on a few entries and estimate
   the cache's size for a full 273,000-company ingest at 5,000 per page.

### Read again (about 1 hour)

- MDN: "Using the Fetch API" (body streams), `Response()`, `Headers` (guards), `URLSearchParams.sort()`.
- Valkey docs: `SET` (`PX`, `NX`), key eviction and `maxmemory-policy`.
- AWS docs: "Caching strategies" for ElastiCache (lazy loading vs write-through, TTLs).
- BullMQ docs: "Going to production" (why `noeviction`).

## Self-check (answer out loud)

1. Why does the cache wrap the rate-limited fetch, and not the other way round?
2. What two requests should share a cache entry, and which header must never be part of the key?
3. Why cache a 404, and why for less time than a 200?
4. Why never cache a 429 or a 500?
5. Why does the cache fail open when the limiter fails closed?
6. Why can't BullMQ and a cache share one Valkey in production, and how does `REDIS_CACHE_URL` help?
7. What does caching raw HTTP buy you over caching parsed results, and what does it cost?
8. Two workers miss the same URL at the same moment. What happens, and why is it acceptable here?
