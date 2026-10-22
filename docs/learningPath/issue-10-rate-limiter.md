# Learning path: #10 Valkey token-bucket rate limiter

Companion to issue #10 (hand-written). Part 1 is the plan and the directions for the parts you
write: the Lua script and `createTokenBucket` (checkpoint 1), `rateLimitedFetch` (checkpoint 2)
and the failure-handler change (checkpoint 3). Part 2 records what each piece taught, Part 3
describes the limiter as built with its failure modes, and Part 4 is what to revise.

**Goal:** explain in 30 seconds why the limiter is a Lua script, whose clock it uses, and what
happens to a request when there's no token.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue; this doc
- [x] Checkpoint 1: Lua script and `createTokenBucket` (hand-written, 34 tests)
- [x] Checkpoint 2: `rateLimitedFetch` and `RateLimitExceededError` (hand-written, 17 tests)
- [x] Checkpoint 3: limiter errors in `handleIngestFailure` (hand-written, 6 tests)
- [x] Checkpoint 4: wiring; live run (2026-10-22): 3 workers, 2 parallel runs, 30 requests in 10.9 s, no 429
- [x] Checkpoint 5: lessons, the limiter as built, PR

## Part 1: the plan

### The problem in one paragraph

Companies House allows 600 requests per 5 minutes **per API key**. Today the worker stays under
that with `concurrency: 1` and backs off after a 429. That only holds for one process running one
run. Two worker processes, or two runs in parallel, each send at full speed and learn about the
limit from a 429. The fix is one counter that every worker shares, kept where they can all see it:
Valkey.

### Rate-limiting algorithms, briefly

| Algorithm              | How it works                                                                | Trade-off                                              |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Fixed window counter   | Count requests per clock window (e.g. per 5 minutes); reset at the boundary | Simple; allows 2× the limit across a boundary          |
| Sliding log            | Store a timestamp per request; count those in the last window               | Exact; memory grows with the limit                     |
| Sliding window counter | Weighted mix of the current and previous window's counts                    | Close to exact, cheap; an approximation                |
| **Token bucket**       | Tokens refill at a steady rate up to a capacity; each request takes one     | Smooth rate with a bounded burst; two numbers to store |
| Leaky bucket / GCRA    | Requests drain at a fixed rate; GCRA stores one timestamp                   | Very smooth; harder to explain                         |

We use a **token bucket**: it smooths requests to a steady rate, allows a small burst after a
quiet spell, and its state is two numbers.

### Design

- **State:** one Valkey hash per limiter, key `ratelimit:companies-house`, fields `tokens` and
  `updatedAt` (milliseconds).
- **One Lua script does the whole check atomically.** Valkey runs a script start to finish with no
  other command in between, so two workers can't both read "1 token left" and both take it. This is
  the core idea of the issue.
- **Valkey's clock.** The script reads `TIME`, so every worker on every machine refills from one
  clock. Trade-off: tests can't pin the time; they use small rates and short real waits.
- **Expiry.** A bucket that has refilled to full is the same as a bucket that doesn't exist (a
  missing key means "full"). So the key can expire once it would have refilled, and idle limiters
  clean themselves up.
- **Policy for Companies House:** capacity 10, refill 1.8 tokens per second. That is 90% of the
  2 per second that 600 per 5 minutes allows, leaving headroom for manual calls and smoke tests.
  Trade-off: a burst never exceeds 10 requests.
- **Where requests wait:** `rateLimitedFetch(fetch, bucket, { maxWaitMs })` wraps `fetch` and is
  passed into `CompaniesHouseClient` through the `fetch` option from #8. With a token, it calls the
  real `fetch`. Without one, it sleeps if the wait fits within `maxWaitMs` (5 s); otherwise it
  throws `RateLimitExceededError` with `retryAt`, and the #9 failure handler pauses the queue.
- **Fail closed:** if Valkey is down, the limiter throws and the job retries with backoff. Failing
  open would mean unlimited requests exactly when nothing is counting them.

### Files

| File                                                                               | Who writes it                    |
| ---------------------------------------------------------------------------------- | -------------------------------- |
| `packages/infra/src/rate-limiter/token-bucket.lua`                                 | You                              |
| `packages/infra/src/rate-limiter/token-bucket.ts`                                  | You (Claude writes the skeleton) |
| `packages/infra/src/rate-limiter/token-bucket.int.test.ts`, `token-bucket.test.ts` | Claude (failing tests)           |
| `packages/infra/src/rate-limiter/rate-limited-fetch.ts`                            | You (Claude writes the skeleton) |
| `packages/infra/src/rate-limiter/rate-limited-fetch.test.ts`                       | Claude (failing tests)           |
| `apps/worker/src/ingest/failure.ts`                                                | You (one new rule)               |
| `apps/worker/src/index.ts`                                                         | Claude (wiring, checkpoint 4)    |

The skeleton at checkpoint 1 fixes the exact names and types; this doc describes them.

## Part 1a: Lua in 20 minutes

You only need a small part of Lua. Each item below was checked against the project's Valkey 8.1.

### The language

```lua
local capacity = tonumber(ARGV[1])  -- `local` for every variable; tonumber turns a string into a number
if tokens >= cost then              -- if … then … elseif … else … end
  tokens = tokens - cost            -- no `-=` or `++`
end
local smaller = math.min(a, b)      -- also math.max, math.floor, math.ceil
local list = { 1, 2, 'x' }          -- a table; indexes start at 1, not 0
local first = list[1]
local text = tostring(1.75)         -- '1.75'
-- a comment; `~=` means "not equal"; `..` joins strings
```

### Calling Valkey from a script

- `KEYS` and `ARGV` are the two input tables. Every key the script touches must come in `KEYS`
  (Valkey uses them to route the script in a cluster). Everything else goes in `ARGV`.
- **Everything in `ARGV` arrives as a string.** `ARGV[1] + 1` happens to work, but compare with
  `tonumber(ARGV[1])` or you'll compare strings.
- `redis.call('HSET', KEYS[1], 'tokens', 1.75)` runs a command. If it fails, the whole script
  fails and the caller gets an error.

### Four traps (verified)

| Trap                                                         | What you see                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| A missing value comes back as **`false`**, not `nil`         | `HMGET` on a new key gives `{ false, false }`               |
| `TIME` returns **two strings**: seconds and **micro**seconds | `{ '1792101537', '877030' }`                                |
| A fraction returned from the script is **cut to an integer** | `return 1.75` arrives as `1`; `return {1, 2.9}` as `[1, 2]` |
| Storing a fraction in a hash is fine                         | `HSET … 1.75` then `HGET` gives `'1.75'`                    |

So: return whole numbers as numbers, and anything fractional with `tostring`, then parse it back
in TypeScript.

### Try it in valkey-cli

```
docker compose exec redis valkey-cli eval "return redis.call('TIME')" 0
docker compose exec redis valkey-cli eval "return { 1, 2.9, tostring(2.9) }" 0
```

The `0` is the number of keys that follow. With one key:
`eval "<script>" 1 mykey arg1 arg2`.

## Part 1b: checkpoint 1, the bucket

### Read first (30 min)

1. This doc's Part 1 and Part 1a.
2. The skeleton and the failing tests (Claude writes them at the start of checkpoint 1).
3. `packages/infra/src/redis.ts`: the connection you'll call `eval` on.
4. Valkey docs: "Scripting with Lua" (introduction), and the `EVAL` and `TIME` command pages.

### Reference: the same shape in another domain

A **daily quota** (at most N calls per key per UTC day), written with the same building blocks.
It's a fixed-window counter, a different algorithm, so it can't be copied across, but every
Valkey and Lua mechanic you need appears in it. It runs as written against the project's Valkey.

```lua
-- Daily quota: allow at most ARGV[1] calls per key per UTC day.
-- KEYS[1]: the quota's hash key. ARGV[1]: the daily limit (arrives as a string).
local limit = tonumber(ARGV[1])

-- TIME returns { seconds, microseconds }, both as strings.
local time = redis.call('TIME')
local nowSeconds = tonumber(time[1])
local today = math.floor(nowSeconds / 86400)

-- HMGET returns one entry per field; a missing field is `false`, not nil.
local stored = redis.call('HMGET', KEYS[1], 'day', 'used')
local used = 0
if stored[1] and tonumber(stored[1]) == today then
  used = tonumber(stored[2])
end

local allowed = 0
if used < limit then
  used = used + 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'day', today, 'used', used)
-- The quota resets at midnight UTC, so the key is useless after that.
redis.call('EXPIRE', KEYS[1], 86400 - (nowSeconds % 86400))

-- Integers come back intact; a fraction would be cut to an integer, so send it as a string.
return { allowed, limit - used, tostring(used / limit) }
```

And the TypeScript that calls it:

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Read once, when the module loads, from the file next to this one.
const QUOTA_SCRIPT = readFileSync(new URL('./quota.lua', import.meta.url), 'utf8');

// The script's reply is data from another system: validate its shape like any API response.
const replySchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.number().int(), z.string()]);

export async function useQuota(connection: RedisConnection, key: string, limit: number) {
  // eval(script, number of keys, ...keys, ...args). Numbers are sent as strings.
  const reply: unknown = await connection.eval(QUOTA_SCRIPT, 1, key, limit);
  const [allowed, remaining, usedFraction] = replySchema.parse(reply);
  return { allowed: allowed === 1, remaining, usedFraction: Number(usedFraction) };
}
```

### Directions: the Lua script, line by line

Inputs: `KEYS[1]` is the bucket key. `ARGV[1]` is the capacity, `ARGV[2]` the refill rate in
tokens per second, `ARGV[3]` the cost of this request (usually 1).

1. **Read the inputs** into three `local` numbers with `tonumber`.
2. **Read the clock.** `redis.call('TIME')`, then work out `nowMs` from seconds and microseconds.
   Check the arithmetic: 1 second is 1,000 ms; 1 microsecond is 1/1,000 ms.
3. **Read the state.** `HMGET` the two fields. If `tokens` is missing (`false`), this is a new or
   expired bucket: start it **full**, with `updatedAt` = now.
4. **Refill.** Elapsed ms since `updatedAt`, never negative (`math.max(0, …)`; a failover to a
   replica can step the clock back). New tokens = elapsed in seconds × rate. Add them, and cap at
   the capacity with `math.min`.
5. **Take, or work out the wait.**
   - Enough tokens for `cost`: subtract, `allowed` = 1, wait = 0.
   - Not enough: `allowed` = 0, and the wait is how long the missing part takes to refill:
     (cost − tokens) ÷ rate, in **milliseconds**, rounded **up** (`math.ceil`). Rounding down
     would make the caller retry a moment too early and be refused again.
6. **Write the state back:** `tokens` and `updatedAt` = now. Do this whether or not you allowed
   the request, so the stored state always means "as of now".
7. **Set the expiry** with `PEXPIRE`: the time until the bucket would be full again,
   (capacity − tokens) ÷ rate in ms, rounded up, and at least 1. After that, "missing" and "full"
   mean the same thing, so the key can go.
8. **Return** `{ allowed, waitMs, tostring(tokens) }`. `tokens` is usually fractional, so it goes
   back as a string (trap 3).

### Directions: `createTokenBucket`, line by line

1. **Load the script once** at module level with `readFileSync(new URL(…, import.meta.url))`, as
   in the reference.
2. **Validate the options** when the bucket is created, not on every call: a non-empty key, an
   integer capacity of at least 1, a refill rate above 0. Bad options are a programming error;
   throw at startup.
3. **`take(cost = 1)`**: reject a cost that isn't a whole number from 1 to `capacity`. A cost
   above capacity could never succeed, so the caller would wait forever.
4. **Call the script** with `connection.eval(script, 1, key, capacity, refillPerSecond, cost)`.
5. **Parse the reply** with a zod tuple, as in the reference, and return
   `{ allowed, retryAfterMs, tokensLeft }` with `tokensLeft` turned back into a number.
6. **No `try`/`catch`.** If Valkey is down, the error goes straight out. That's "fail closed".

### Suggested order

Run the bucket tests with `pnpm exec vitest run --config vitest.int.config.ts packages/infra`
(Valkey must be running). Take them in this order:

1. The option-validation unit tests (no Valkey), to get the TypeScript shape right.
2. "allows exactly capacity takes", with only steps 1–3, 5, 6 and 8 of the script.
3. "reports how long to wait": the `math.ceil` arithmetic.
4. "refills over time", then "never above capacity": step 4.
5. "fractional tokens survive": if this fails, check traps 3 and 4.
6. "two connections share one budget" and "50 takes at once allow exactly 10": these should pass
   with no extra work. Say out loud **why**; the answer is the reason the script exists.
7. "the key expires": step 7.

## Part 1c: checkpoint 2, `rateLimitedFetch`

### What it is

A function that takes a `fetch` and returns another `fetch`. The new one takes a token from the
bucket before every request. It is a **decorator** (or wrapper): the caller can't tell it apart
from the real `fetch`, so it plugs into `CompaniesHouseClient` through the `fetch` option from #8
without changing the client.

File: `packages/infra/src/rate-limiter/rate-limited-fetch.ts`. Tests:
`rate-limited-fetch.test.ts`, 17 of them, no Valkey: the bucket, `fetch`, `sleep` and the clock
are all fakes, and the fake clock only moves when your code calls `sleep`.

### Read first (15 min)

- The skeleton: `RateLimitExceededError`, `RateLimitedFetchOptions`, and the signature.
- `rate-limited-fetch.test.ts`, top to `setup()`: how `take` is scripted with a list of results,
  and how the fake `sleep` moves the fake clock.
- `packages/integrations/src/companies-house/errors.ts`: the `CompaniesHouseError` constructor, for
  the error-class pattern (`super(message)`, then `this.name`).
- MDN: `AbortSignal.throwIfAborted()` and `AbortSignal.reason`.

### What it must do

| Situation                                                | What happens                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| The bucket has a token                                   | Call the real `fetch` with the same arguments; return its result  |
| No token; waiting fits before the deadline               | `sleep(retryAfterMs)`, then ask the bucket again                  |
| No token; waiting would end after the deadline           | Throw `RateLimitExceededError(key, now + retryAfterMs)`, no sleep |
| The bucket throws (Valkey down)                          | Let the error out; never call `fetch` (fail closed)               |
| The caller's `signal` has fired, before or during a wait | Reject with `signal.reason`; never call `fetch`                   |
| `maxWaitMs` is negative or not a number                  | Throw when `rateLimitedFetch` is called, naming `maxWaitMs`       |

### Directions: `RateLimitExceededError`

1. In the constructor, pass `super()` a message that names the key and `retryAt` as an ISO string
   (`retryAt.toISOString()`), e.g. `ratelimit:companies-house: no token until 2026-…Z`.
2. Set `this.name = 'RateLimitExceededError'`, so logs and stack traces say what it is.
3. Keep the two `readonly` fields as they are.

### Directions: `rateLimitedFetch`, line by line

**Once, when `rateLimitedFetch` is called:**

1. Unpack `maxWaitMs`, `sleep` and `now` from the options, with defaults for the last two: a real
   sleep (`new Promise((resolve) => setTimeout(resolve, ms))`) and `Date.now`.
2. Check `maxWaitMs` is a finite number of 0 or more; otherwise throw an error that mentions
   `maxWaitMs`. Like the bucket's options, a bad value is a programming error: stop at startup.

**On every request**, in the `async (input, init) => { … }` function you return:

3. Work out the **deadline once**: `now() + maxWaitMs`. Not inside the loop: every wait for this
   request counts against the same budget.
4. Loop (`for (;;)` or `while (true)`):
   1. If the caller's signal has fired, stop: `init?.signal?.throwIfAborted()`.
   2. `await bucket.take()`.
   3. If allowed, `return fetch(input, init)`. Same arguments, untouched.
   4. Otherwise, work out when the wait would end: `now() + retryAfterMs`. If that is **after**
      the deadline (strictly greater; ending exactly on it is fine), throw
      `new RateLimitExceededError(bucket.key, new Date(thatTime))`.
   5. Otherwise `await sleep(retryAfterMs)` and go round again.

**Why loop instead of sleeping once:** the bucket is shared. While this worker sleeps, another may
take the token it was waiting for, so after the sleep it must ask again.

Rules for the whole function:

- **No `try`/`catch`.** A bucket error, an abort and a `fetch` error all travel out unchanged.
- **Never call `Date.now()` or `setTimeout` directly** inside the request function; use `now` and
  `sleep`, or the tests can't control time.
- **Pass `input` and `init` through untouched.** The client's `Authorization` header and timeout
  signal are in `init`.

### Reference: the same shape for a different job

A wrapper that retries a `503 Service Unavailable` within a time budget, using the server's
`Retry-After` header. Same skeleton (options checked once, a deadline per request, a loop, an
injected sleep and clock, the abort check), but it decides on the **response** rather than a
token, and when the budget runs out it returns the last response instead of throwing.

```ts
export function retryOn503(
  fetch: typeof globalThis.fetch,
  {
    maxWaitMs,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: { maxWaitMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): typeof globalThis.fetch {
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new Error(`maxWaitMs must be 0 or more, got ${maxWaitMs}`);
  }

  return async (input, init) => {
    const deadline = now() + maxWaitMs;
    for (;;) {
      init?.signal?.throwIfAborted();
      const response = await fetch(input, init);
      if (response.status !== 503) return response;

      // Retry-After is a number of seconds here (it can also be a date; not handled).
      const waitMs = Number(response.headers.get('retry-after') ?? '1') * 1_000;
      if (now() + waitMs > deadline) return response; // out of budget: let the caller see the 503
      await sleep(waitMs);
    }
  };
}
```

| The 503 example                          | Your `rateLimitedFetch`                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| Calls `fetch` first, then decides        | Asks the bucket first; calls `fetch` only with a token          |
| Wait comes from the `Retry-After` header | Wait comes from `retryAfterMs` in the bucket's result           |
| Out of budget: returns the 503           | Out of budget: throws `RateLimitExceededError` with `retryAt`   |
| No shared state                          | The bucket is shared, which is why it asks again after sleeping |

### Suggested order

```
pnpm exec vitest packages/infra/src/rate-limiter/rate-limited-fetch.test.ts -t "part of the name"
```

1. The two `RateLimitExceededError` tests.
2. "options" (the `maxWaitMs` check).
3. "with a token" (3 tests): take, then fetch.
4. "waiting for a token" (3 tests): the loop and `sleep`.
5. "giving up" (3 tests): the deadline. Do the arithmetic for "counts every wait against one
   deadline" on paper first.
6. "failing closed": should pass already. Say why.
7. "the caller's abort signal" (2 tests): one line, in the right place.
8. "uses a real clock and a real sleep": the defaults.

Then put two bugs back and predict the failures: work the deadline out inside the loop; and use
`>=` instead of `>` against the deadline.

### Traps

- **The request timeout is already running.** The Companies House client creates its
  `AbortSignal.timeout(10_000)` before it calls `fetch`, so the wait for a token eats into it. The
  abort check stops a wait the caller has given up on, and `maxWaitMs` (5 s in the worker) keeps
  the wait well inside the timeout.
- **`retryAt` is a moment, not a duration** (#8, #9 again): `new Date(now() + retryAfterMs)`, not
  `new Date(retryAfterMs)`, which is a date in January 1970.
- **Don't consume `init`.** Reading or cloning it (e.g. a request body) would change what the real
  `fetch` receives.

### Finish

- 17 tests pass; `pnpm format && pnpm lint && pnpm typecheck` are clean.
- Commit as `add rate-limited fetch (#10)`, then ask Claude for review.

## Part 1d: checkpoint 3, the failure handler

### What it is

When `rateLimitedFetch` gives up, it throws `RateLimitExceededError`. But that error never reaches
`handleIngestFailure` as itself: the Companies House client catches anything `fetch` throws and
wraps it as a `network` error, with the original as `cause` (#8). Today the handler sees "network
error, retryable" and retries with backoff, which hits the same empty bucket again. The new rule:
look down the `cause` chain, and if a `RateLimitExceededError` is there, treat it like a 429.

File: `apps/worker/src/ingest/failure.ts`. Tests: six new ones in `failure.test.ts`, under "our
own rate limiter gave up". Five fail now; "still retries an ordinary network error" passes already
and must stay passing, so the rule can't catch every network error.

### How the error arrives

```
CompaniesHouseError  kind: 'network', retryable: true
  └─ cause: RateLimitExceededError  key: 'ratelimit:companies-house', retryAt: 12:00:06
```

The last test builds this for real: a real `CompaniesHouseClient` whose `fetch` is a
`rateLimitedFetch` over a bucket that always refuses. If the client ever changes how it wraps
errors, that test is the one that notices.

### Reference: walking a cause chain, for a different error

Finding a Postgres deadlock (error code `40P01`) anywhere in a chain, for example under a
Drizzle error. Same walk, different test at each step:

```ts
function hasDeadlock(error: unknown): boolean {
  let current: unknown = error;
  // A depth cap, because nothing stops a chain from pointing back at itself.
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if ('code' in current && current.code === '40P01') return true;
    current = current.cause;
  }
  return false;
}
```

- `current` is `unknown` because a `cause` can be anything, not only an `Error`.
- `current instanceof Error` in the loop condition both stops at the end of the chain and narrows
  the type, so `.cause` is allowed.

### Directions

1. **Import** `RateLimitExceededError` from `@gtm/infra`.
2. **Write a small helper** that walks the chain and returns the `RateLimitExceededError` it finds,
   or `undefined`. Return the error itself, not `true`: you need its `retryAt`. Cap the depth, as
   in the reference.
3. **Call it first** in `handleIngestFailure`, before the `instanceof CompaniesHouseError` check.
   It's the most specific case, and when thrown directly it isn't a `CompaniesHouseError` at all.
4. **If found:** pause exactly as for a 429. The pause is `retryAt` minus now, at least
   `MIN_RATE_LIMIT_PAUSE_MS`; log one `warn` line; `await deps.pauseQueue(...)`; throw
   `Worker.RateLimitError()`. `retryAt` is always set here, so there's no unknown-reset case.
5. **Everything below stays as it is.**

**Worth doing:** the 429 branch and the new branch now share "work out the pause, log, pause,
throw". Move that into one helper that takes a `retryAt` (and a log message), so the two can't
drift apart. Your call; say why either way.

### Suggested order

1. "when thrown directly": steps 1, 3 and 4, without the chain walk.
2. "the cause of a network error": add the walk, one level.
3. "further down the cause chain": the walk handles any depth without changes, if you wrote it as
   a loop.
4. "the minimum": should pass if you reused the 429 arithmetic.
5. "still retries an ordinary network error": still passing? Then your rule only matches the
   limiter's error.
6. The end-to-end test.

Then put a bug back: check `instanceof CompaniesHouseError` first. Which tests fail, and why?

### Finish

- All 21 tests in `failure.test.ts` pass; `pnpm format && pnpm lint && pnpm typecheck` are clean.
- Commit as `pause the queue when the rate limiter gives up (#10)`, then ask Claude for review.

## Part 2: lessons

### The bucket (hand-written)

| Lesson                                                                                               | Name to search                         | Where it bit us                                                                        |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Each client library has its own call shape; read the one you're using                                | ioredis `eval` vs node-redis `eval`    | `{ keys, arguments }` (node-redis) sent `[object Object]` as the key; `ARGV` was empty |
| Read the **first** type error: it often names the real problem                                       | TS2769 "No overload matches this call" | It pointed at the `eval` call before any test ran                                      |
| A schema describes the **wire format**, not the type you want; convert afterwards                    | Boundary validation                    | Changing the third reply field to `z.number()` refused every real reply                |
| Lua cuts fractions to integers on return; send them as strings                                       | Lua → RESP conversion                  | Why `tokensLeft` is `tostring(tokens)` and a string in the schema                      |
| A missing hash field is `false` in Lua, and `tonumber(false)` is `nil`, so `or` can supply a default | Lua truthiness                         | `tonumber(stored[1]) or capacity`: your compact version                                |
| Not writing on a refusal is still correct, if the stored pair stays "tokens as of `updatedAt`"       | Invariants                             | Your design; it saves a write when the limiter is busiest                              |
| Fakes can't catch a wrong call to the real system; that's what integration tests are for             | Test doubles; integration tests        | The fake connection ignored its arguments, so the unit tests passed                    |
| Regexes in tests are case-sensitive                                                                  | —                                      | `/cost/` didn't match `Cost must…`                                                     |

### The fetch wrapper and the failure handler (hand-written)

| Lesson                                                                                          | Name to search                     | Where it bit us                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A check after `Math.min` against the same bound can never be true                               | Dead code; tautological conditions | The give-up check never fired, so the wrapper slept instead of handing back                                |
| Zero is often a valid setting; check the boundary the tests name                                | Boundary values                    | `maxWaitMs <= 0` refused "never wait"                                                                      |
| A moment is not a duration, **again**                                                           | Timestamps vs durations            | `pause = retryAt.getTime()`: a 56-year pause (after `x-ratelimit-reset` in #8 and `getMilliseconds` in #9) |
| Name values by kind: `waitEndsAt`, `retryAt` (moments); `pauseMs`, `retryAfterMs` (durations)   | Naming                             | `waitTime` held a moment, and read like a length of time                                                   |
| Duplicated logic drifts; one helper makes the drift impossible                                  | DRY; single source of truth        | The limiter's copy of the pause arithmetic went wrong while the 429 copy stayed right                      |
| pino takes fields in the **first** argument; anything after the message fills `%s` placeholders | pino log method signature          | `{ key }` as the third argument was silently dropped                                                       |
| Errors arrive wrapped; look down the `cause` chain, with a depth cap                            | Error chaining; `Error.cause`      | The client delivers the limiter's error as a retryable `network` error                                     |
| Copied log messages lie                                                                         | —                                  | "rate limited by companies house" on a pause our own limiter caused                                        |

### Design

| Lesson                                                                                           | Name to search                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| A shared counter needs read-modify-write as **one** step; a Lua script is that step in Valkey    | Atomicity; race conditions; check-then-act |
| One clock for all workers (Valkey's `TIME`) is what makes a limit shared                         | Clock skew                                 |
| A missing key and a full bucket mean the same thing, so the key can expire once it would be full | Self-cleaning state; TTL                   |
| Fail closed when the thing doing the counting is down                                            | Fail-open vs fail-closed                   |
| Wrap `fetch` instead of changing the client; wrap the bucket to add logging                      | Decorator pattern                          |
| Wait briefly in place; beyond a budget, hand the work back to the queue                          | Backpressure                               |
| A wait inside a request counts against that request's timeout                                    | Timeout budgets                            |

## Part 3: the limiter as built

### Shape

```
CompaniesHouseClient
  └─ fetch = rateLimitedFetch(globalThis.fetch, bucket, { maxWaitMs: 5_000 })
                │
                └─ bucket = loggingBucket(createTokenBucket(connection, COMPANIES_HOUSE_RATE_LIMIT))
                              │
                              └─ EVAL token-bucket.lua 1 ratelimit:companies-house 10 1.8 1
                                   TIME → refill → take or wait → HSET + PEXPIRE

On give-up: RateLimitExceededError → wrapped by the client as `network` (cause)
          → handleIngestFailure finds it in the cause chain → worker.rateLimit(pause) → job back to wait
```

| File                                                    | Role                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/infra/src/rate-limiter/token-bucket.lua`      | The atomic check (hand-written)                                                |
| `packages/infra/src/rate-limiter/token-bucket.ts`       | Options and cost checks, `eval`, reply validation (hand-written)               |
| `packages/infra/src/rate-limiter/rate-limited-fetch.ts` | Wait or hand back; `RateLimitExceededError` (hand-written)                     |
| `apps/worker/src/ingest/failure.ts`                     | Limiter errors and 429s pause the queue (hand-written, plus the shared helper) |
| `apps/worker/src/ingest/rate-limit.ts`                  | The Companies House policy, and `loggingBucket`                                |
| `apps/worker/src/index.ts`                              | Wiring                                                                         |

### Settings

| Setting    | Value                       | Why                                                                |
| ---------- | --------------------------- | ------------------------------------------------------------------ |
| Key        | `ratelimit:companies-house` | One budget per API key, shared by every worker                     |
| Refill     | 1.8 tokens per second       | 90% of 600 per 5 minutes; headroom for manual calls                |
| Capacity   | 10                          | A small burst after an idle spell; 10 + 1.8 × 300 = 550 < 600      |
| Max wait   | 5 s                         | Well inside the client's 10 s request timeout                      |
| Expiry     | Time until full again       | An idle bucket removes itself                                      |
| Connection | Its own, producer-style     | Fails after a few retries when Valkey is down, rather than hanging |

### The live run (2026-10-22)

Three workers (two started for the test, plus `pnpm dev`) and two runs at once (SIC 62011 and
62012, 20 per page, 15 pages each): **30 requests in 10.9 s**, which is the 10-token burst plus
1.8 per second × 10.9 s ≈ 29.6. No 429s, no failed jobs. Each logged wait was about 460–480 ms,
as expected between tokens at 1.8 per second. No wait reached 5 s, so no queue pause happened.

### Failure modes and how each is handled

| Failure                                                              | Handling                                                                                       | Test                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Several workers (or runs) want tokens at once                        | One atomic script; exactly `capacity` succeed, the rest are told how long to wait              | Integration: "50 takes at once…"                 |
| Workers on different machines with different clocks                  | The script reads Valkey's clock, not the caller's                                              | By design                                        |
| Clock steps back (failover to a replica)                             | Elapsed time is clamped at 0, so no tokens are removed                                         | Untested                                         |
| Short wait for a token                                               | The request sleeps and asks again (another worker may have taken it)                           | Unit: "waiting for a token"                      |
| Long wait (more than 5 s)                                            | `RateLimitExceededError` → queue paused until `retryAt` → job back to waiting, no attempt used | Unit, including end to end through a real client |
| The caller's request timeout fires while waiting                     | The wait stops and rejects with the timeout reason; the client reports a `timeout`             | Unit: "the caller's abort signal"                |
| Valkey down                                                          | `take` rejects (fail closed); the job retries with backoff                                     | Unit: "fails closed"                             |
| Malformed reply from the script                                      | zod rejects it; the job retries                                                                | Unit: "rejects a reply where…"                   |
| Bad options or cost (a programming error)                            | Thrown at startup or on the call, with the field named                                         | Unit                                             |
| Idle bucket                                                          | Its key expires once it would be full again                                                    | Integration: "expires the key…"                  |
| Companies House still answers 429 (limit shared with something else) | The #9 handling: queue paused until `x-ratelimit-reset`                                        | #9 tests                                         |

### Known gaps

- **A queue pause hasn't happened in a live run.** The path is covered by unit tests, including
  one through a real `CompaniesHouseClient`, but the live run never waited 5 s.
- **The script is sent in full on every call** (`EVAL`). `EVALSHA` with a cached hash (ioredis's
  `defineCommand`) would save bandwidth; not worth the complexity at 1.8 requests per second.
- **One policy, hard-coded.** Other providers (weeks 3–4) will need their own buckets; a policy
  table can come when there's a second one.
- **Companies House request logs still lack `runId`/`jobId`** (from #9; planned for #43).

## Part 4: what to revise

### The five ideas that matter most

1. **Atomicity.** Why "read, then write" from TypeScript breaks with two workers, and why a Lua
   script doesn't. _Revise:_ `token-bucket.lua`; the "50 takes at once" test.
2. **Whose clock.** One clock for every worker is what makes the limit shared. _Revise:_ the
   `TIME` lines; Part 1's design notes.
3. **The wire format is the boundary.** Lua's truncation decides the reply's shape; zod checks it
   before TypeScript trusts it. _Revise:_ the reply schema and its comment.
4. **Moments vs durations, for the last time.** `retryAt`, `waitEndsAt` vs `pauseMs`,
   `retryAfterMs`. _Revise:_ `pauseQueueUntil` and `rateLimitedFetch`.
5. **Decorators.** `rateLimitedFetch` and `loggingBucket` add behaviour without changing what they
   wrap. _Revise:_ how the client gets its `fetch` in `index.ts`.

### Exercises (on a scratch branch)

1. **Break atomicity on purpose.** Write `take` in TypeScript as `HMGET`, compute, `HSET` (no
   script), and run the "50 takes at once" test. How many are allowed? Why?
2. **Force a queue pause live.** Set the refill to 0.1 per second, start a run, and watch for
   "rate limiter out of tokens, pausing queue" and the job going back to waiting.
3. **Swap the algorithm.** Rewrite the script as a fixed-window counter (the quota example in
   Part 1b is close). What does a burst across a window boundary allow?
4. **`EVALSHA`.** Use ioredis's `defineCommand` to cache the script. What happens after Valkey
   restarts and forgets it?
5. **Explain the give-up path end to end, out loud:** refused take → `waitEndsAt` past the
   deadline → `RateLimitExceededError` → wrapped as `network` → `findRateLimitExceededError` →
   `pauseQueueUntil` → `worker.rateLimit` → the job back in `wait`.

### Read again (about 1 hour)

- Valkey docs: "Scripting with Lua", `EVAL`, `EVALSHA`, `TIME`, `PEXPIRE`.
- Stripe engineering blog: "Scaling your API with rate limiters" (token bucket in Redis, and when
  to fail open).
- Cloudflare blog: "How we built rate limiting capable of scaling to millions of domains"
  (sliding window counters).
- MDN: `Error.cause`, `AbortSignal.throwIfAborted()`.

## Self-check (answer out loud)

1. Why can't the limiter be "read the count, then write the count" from TypeScript?
2. Why use Valkey's clock instead of `Date.now()`? What does it cost in testing?
3. Why does a missing key mean a **full** bucket, and how does that make expiry safe?
4. Why is the wait rounded up, not down?
5. Why does `tokens` come back as a string?
6. Why 1.8 per second and not 2? What does the capacity of 10 allow, and what does it prevent?
7. Fail open or fail closed when Valkey is down, and why for this project?
8. What happens to a request that waits 4 s for a token, given the client's 10 s timeout?
9. How does a `RateLimitExceededError` thrown inside `fetch` reach the failure handler?
10. Name two other rate-limiting algorithms and the trade-off each makes.
11. Why does the limiter's error reach the handler as a `network` error, and what would happen if
    the handler didn't look at the cause?
