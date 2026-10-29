# Learning path: #11 Valkey response cache

Companion to issue #11. Claude writes this one in checkpoints and stops after each to explain the
why and the trade-off; you review. Part 1 is the design and what to look for in each checkpoint.
Parts 2–4 (lessons, the cache as built, what to revise) are filled in at checkpoint 5.

**Goal:** explain in 30 seconds what makes two requests "the same", why the cache sits outside the
rate limiter, and why it fails open when the limiter fails closed.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue; this doc
- [x] Checkpoint 1: `getRedisCacheUrl()` in `@gtm/config`
- [x] Checkpoint 2: `requestCacheKey(method, url)`
- [ ] Checkpoint 3: `cachedFetch` in `@gtm/infra`
- [ ] Checkpoint 4: wiring; `cache` field in the Companies House request log
- [ ] Checkpoint 5: live run (re-run with a new run id makes zero requests); lessons; PR

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

## Self-check (answer out loud)

1. Why does the cache wrap the rate-limited fetch, and not the other way round?
2. What two requests should share a cache entry, and which header must never be part of the key?
3. Why cache a 404, and why for less time than a 200?
4. Why never cache a 429 or a 500?
5. Why does the cache fail open when the limiter fails closed?
6. Why can't BullMQ and a cache share one Valkey in production, and how does `REDIS_CACHE_URL` help?
7. What does caching raw HTTP buy you over caching parsed results, and what does it cost?
8. Two workers miss the same URL at the same moment. What happens, and why is it acceptable here?
