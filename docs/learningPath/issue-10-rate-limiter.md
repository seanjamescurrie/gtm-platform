# Learning path: #10 Valkey token-bucket rate limiter

Companion to issue #10 (hand-written). Part 1 is the plan and the directions for the parts you
write: the Lua script and `createTokenBucket` (checkpoint 1), `rateLimitedFetch` (checkpoint 2)
and the failure-handler change (checkpoint 3). Parts 2–4 (lessons, the limiter as built, what to
revise) are filled in at checkpoint 5.

**Goal:** explain in 30 seconds why the limiter is a Lua script, whose clock it uses, and what
happens to a request when there's no token.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue; this doc
- [x] Checkpoint 1: Lua script and `createTokenBucket` (hand-written, 34 tests)
- [ ] Checkpoint 2: `rateLimitedFetch` and `RateLimitExceededError` (hand-written)
- [ ] Checkpoint 3: limiter errors in `handleIngestFailure` (hand-written)
- [ ] Checkpoint 4: wiring into the worker; live run with two workers and two parallel runs
- [ ] Checkpoint 5: lessons, the limiter as built, PR

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

## Part 1c: checkpoint 2, `rateLimitedFetch` (outline)

Full directions arrive with the checkpoint 2 tests. The shape:

- `rateLimitedFetch(fetch, bucket, { maxWaitMs, sleep?, now? })` returns a function with the same
  signature as `fetch`.
- Work out a **deadline** once: now + `maxWaitMs`.
- Loop: `take()`. If allowed, return `fetch(input, init)`. If not, and now + `retryAfterMs` is
  past the deadline, throw `RateLimitExceededError` with `retryAt` = now + `retryAfterMs`.
  Otherwise sleep for `retryAfterMs` and loop.
- `sleep` and `now` are injected so the tests don't wait in real time.
- **Trap:** the Companies House client starts its 10 s timeout **before** it calls `fetch`, so time
  spent waiting for a token counts against it. Keep `maxWaitMs` well under the timeout.

## Part 1d: checkpoint 3, the failure handler (outline)

The client wraps anything `fetch` throws as a `network` `CompaniesHouseError`, with the original as
`cause` (#8). So a `RateLimitExceededError` reaches `handleIngestFailure` one level down. The new
rule: walk the `cause` chain; if it contains a `RateLimitExceededError`, pause the queue until its
`retryAt` and hand the job back, exactly as for a 429. It's the most specific case, so it goes first.

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
