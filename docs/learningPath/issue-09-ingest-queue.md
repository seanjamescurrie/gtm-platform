# Learning path: #9 BullMQ ingest queue

Companion to issue #9. Part 1 is the outline for the part you write by hand: the page processor
(checkpoint 4) and its error translation (checkpoint 5). Parts 2 and 3 (the queue as built, and
what to revise) are filled in at checkpoint 8.

**Goal:** explain every line of `apps/worker/src/ingest/processor.ts` in 30 seconds: what it does,
why it's in that order, and what happens if the process dies on that line.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue
- [x] Checkpoint 1: `getRedisUrl` in `@gtm/config`
- [x] Checkpoint 2: `createRedisConnection` in `@gtm/infra`; `bullmq` and `ioredis` installed
- [x] Checkpoint 3: `job.ts`, `map.ts`, `enqueue.ts`
- [x] Checkpoint 4: `processIngestPage` (hand-written, 16 tests)
- [x] Checkpoint 5: error translation (hand-written, 15 tests)
- [x] Checkpoint 6: worker wiring, shutdown, CLI (smoke run: 2 pages, 40 rows, re-run made no calls)
- [ ] Checkpoint 7: integration test, Valkey in CI
- [ ] Checkpoint 8: live run of 500+ companies; Parts 2 and 3 of this doc

## Part 1: how to approach the processor

### The job in one paragraph

A BullMQ job is a small JSON record in Valkey. A worker takes it, runs your function with its
`data`, and marks it completed if the function returns, or failed if it throws. A failed job with
attempts left is run again later. So your function has two duties: do one page of work, and
**fail loudly** when it couldn't, so BullMQ knows to try again. It must also be safe to run twice,
because "run again" is the normal way a queue recovers.

### Step 0: read before you write (30 min)

Read these in this order. Don't write code yet.

1. `apps/worker/src/ingest/job.ts`: the shape of `IngestPageData` and `IngestPageResult`, and why
   the job id is built the way it is.
2. `apps/worker/src/ingest/processor.ts`: the `IngestPageDeps` interface. These four things are
   the only way your function can affect the world.
3. `apps/worker/src/ingest/processor.test.ts`, top to `setup()`: how each dependency is faked, and
   what the default fake returns (a full page of 3, out of 100 hits).
4. `packages/integrations/src/companies-house/client.ts`, `advancedSearch` only: what it takes,
   what it returns, and what it returns when Companies House answers 404.
5. `packages/db/src/companies.ts`: what `upsertCompanies` returns, and what it does with an empty
   list and with a repeated company number.

**Check yourself:** without looking, write down the fields of `IngestPageData`, and what
`advancedSearch` returns for "no matches". If you can't, read again.

### Step 1: write the plan as comments (10 min)

Before any code, write the function body as 4–6 plain-English comment lines inside
`processIngestPage`, one per step. Then put them in order and ask of each gap between two lines:
_if the process died exactly here, what would the retry do?_ You are aiming for an order where
every answer is "repeat some work", never "skip some work".

Change the function to `async` and delete the `void deps; void data;` lines when you start.

### Directions: the function, line by line

The finished function is seven statements, in this order. Each one is a single line or two.

1. **Unpack the job data.** Destructure `sicCodes`, `status`, `size`, `startIndex` and `maxPages`
   from `data`.
2. **Fetch.** `await deps.client.advancedSearch(...)` with an object holding exactly four fields:
   `sicCodes`, `status`, `size`, `startIndex`. Not the whole `data` object: it also carries
   `runId` and `maxPages`, which the client doesn't take, and the first test checks for an exact
   match. Keep the result in a variable (`page` reads well).
3. **Map.** Turn `page.items` into rows with `.map(toNewCompany)`. Import `toNewCompany` from
   `./map.js`.
4. **Upsert.** `await deps.upsert(rows)` and keep the number it returns as `written`.
5. **Decide whether there is a next page.** Three named booleans, then one result:
   - the page is full: the number of items equals `size`;
   - there are hits left: `startIndex` plus the number of items is less than `page.hits`;
   - the cap isn't reached: this page's number is less than `maxPages`, where this page's number
     is `startIndex / size + 1` (start index 0 is page 1).

   If all three are true, `nextStartIndex` is `startIndex + size`. Otherwise it is `null`.

6. **Enqueue.** If `nextStartIndex` is not `null`, `await deps.enqueueNext(...)` with a copy of
   `data` whose `startIndex` is replaced (`{ ...data, startIndex: nextStartIndex }`).
7. **Log and return.** One `deps.log.info({ ...fields }, 'message')`, then return
   `{ written, hits: page.hits, nextStartIndex }`.

Rules that hold for the whole function:

- Every call on `deps` is awaited.
- No `try`/`catch` anywhere.
- No `console.log`; use `deps.log`.
- Nothing imported from `bullmq`.

### Reference: the same shape in another domain

This is a complete, working processor for a different job: syncing orders from a shop API that
pages by **page number** and reports **total pages**. It has the same seven steps. Read it for the
shape, then write yours; the paging arithmetic is different, so it can't be copied across.

```ts
interface SyncOrdersData {
  shopId: string;
  page: number; // 1-based
  perPage: number;
  maxPages: number;
}

interface SyncOrdersResult {
  saved: number;
  nextPage: number | null;
}

interface SyncOrdersDeps {
  api: {
    listOrders(query: { shopId: string; page: number; perPage: number }): Promise<{
      orders: ApiOrder[];
      totalPages: number;
    }>;
  };
  save: (rows: readonly OrderRow[]) => Promise<number>;
  enqueueNext: (data: SyncOrdersData) => Promise<unknown>;
  log: Logger;
}

export async function processOrdersPage(
  deps: SyncOrdersDeps,
  data: SyncOrdersData,
): Promise<SyncOrdersResult> {
  // 1. Unpack.
  const { shopId, page, perPage, maxPages } = data;

  // 2. Fetch exactly this page. Only the fields the API takes; no try/catch, so an error fails the job.
  const result = await deps.api.listOrders({ shopId, page, perPage });

  // 3 + 4. Map to rows, then save. `saved` is what the database reports, not what the API sent.
  const saved = await deps.save(result.orders.map(toOrderRow));

  // 5. Is there a next page? Each reason to stop has a name.
  const isFullPage = result.orders.length === perPage;
  const hasPagesLeft = page < result.totalPages;
  const underCap = page < maxPages;
  const nextPage = isFullPage && hasPagesLeft && underCap ? page + 1 : null;

  // 6. Enqueue after saving, so a crash between the two repeats this page instead of skipping it.
  if (nextPage !== null) {
    await deps.enqueueNext({ ...data, page: nextPage });
  }

  // 7. One log line, then the result.
  deps.log.info({ page, saved, nextPage }, 'orders page synced');
  return { saved, nextPage };
}
```

How the example maps onto yours:

| The orders example              | Your ingest processor                                               |
| ------------------------------- | ------------------------------------------------------------------- |
| `page` (1, 2, 3…)               | `startIndex` (0, `size`, 2 × `size`…); there is no page field       |
| `page + 1`                      | `startIndex + size`                                                 |
| `totalPages` (a count of pages) | `hits` (a count of **items**), so compare it with items seen so far |
| `page < maxPages`               | work the page number out from `startIndex` and `size` first         |
| `result.orders`, `toOrderRow`   | `page.items`, `toNewCompany`                                        |
| `deps.api`, `deps.save`         | `deps.client`, `deps.upsert`                                        |
| returns `{ saved, nextPage }`   | returns `{ written, hits, nextStartIndex }`                         |

### Step 2: one test at a time

Run a single test with:

```
pnpm exec vitest apps/worker/src/ingest/processor.test.ts -t "part of the test name"
```

Leave it running in watch mode. Make one test pass, read the diff, then move on. This is the
lesson from #8's first client draft: three bugs written together hide each other.

#### 2a. Fetch the page (1 test)

- **Test:** "searches Companies House for exactly the page the job describes".
- **Do:** call `deps.client.advancedSearch` with the four fields the test expects.
- **Think about:** the job data has six fields and the client takes four. Passing the whole `data`
  object would work at runtime; why is naming the four fields better? (The test uses an exact
  match, so it will tell you.)
- **Trap from #8:** `startIndex: 0` is the first page and is falsy. Don't guard it with `if`.

#### 2b. Store the page (2 tests)

- **Tests:** "upserts every item on the page…", "returns what was written… and the total hits".
- **Do:** map each item with `toNewCompany`, pass the rows to `deps.upsert`, start building the
  result.
- **Think about:** the second test makes the upsert report 2 for a page of 3. Where must
  `written` come from, and why would `items.length` be a lie?
- **Decide:** do you call `upsert` for an empty page? Both choices pass the tests. Pick one and be
  able to say why (hint: look at what `upsertCompanies` does with `[]`).

#### 2c. Chain the next page (2 tests)

- **Tests:** "enqueues the next page…", "upserts before it enqueues…".
- **Do:** call `deps.enqueueNext` with the same data and a new `startIndex`; return it as
  `nextStartIndex`.
- **Think about:** the next start index is `startIndex + size`. What would go wrong with
  `startIndex + items.length`? (It gives the same number on a full page. On which page does it
  differ, and do you ever enqueue after that page?)
- **Think about:** build the next job's data without changing the object you were given. Why does
  that matter for a function that may be run twice?

At this point the "stopping" tests fail because you always enqueue. That's expected.

#### 2d. Know when to stop (5 tests)

Four separate reasons to stop. Write each as a named boolean, or one named `hasNextPage`, rather
than one long condition. Take them one test at a time:

| Test                                          | The question it asks                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| "stops on an empty page"                      | What does the result look like when nothing matched?       |
| "stops on a short page"                       | Fewer items than `size`: can there be anything after it?   |
| "stops when a full page reaches the last hit" | A full page that is also the last: how do you know?        |
| "stops after maxPages pages"                  | Which page number is this job, given only its start index? |
| "carries on while under maxPages"             | Did your `maxPages` check go off by one?                   |

- **Do the arithmetic on paper first.** With `size: 3`, write the page number next to start
  indexes 0, 3, 6. Then decide whether the comparison with `maxPages` is `<` or `<=`. Off-by-one
  errors here are the most likely bug in the whole file.
- **Think about:** why isn't "short page" enough by itself? Picture 9 hits and a page size of 3.
  What would the fourth request return, and what does it cost?
- **Trap:** `hits` comes from another machine and can change between pages. Use it to stop early,
  never as the only thing that stops you.

#### 2e. Failures (3 tests) and idempotency (1 test)

- **Tests:** the three under "failures", and "is idempotent".
- **Expect:** these probably pass already. Don't move on yet. For each, say out loud _why_ it
  passes. The answer to all three is the same, and it's about what you did **not** write.
- **Rule:** don't add a `try`/`catch` to this function. Translating errors is checkpoint 5 and
  lives in a separate function. Here, an error should travel straight out.
- **Experiment:** wrap the upsert in a `try` that logs and carries on. Predict which tests fail,
  then run them. Then take it out.

#### 2f. Log once (no test)

One `deps.log.info` line per page, after the work, with `startIndex`, `written`, `hits` and
`nextStartIndex` as fields and a fixed message. `runId` and `jobId` are added by the child logger
at checkpoint 6, so don't repeat them. Never log the items.

### Step 3: prove the tests are real (15 min)

A test is only proven when it fails against the bug (#8, mutation testing). Put each bug in,
predict the failing tests, run, and undo:

1. Swap the order: enqueue first, then upsert.
2. Use `items.length` for `written`.
3. Remove the `hits` check.
4. Change your `maxPages` comparison between `<` and `<=`.
5. Enqueue with `startIndex` unchanged. (What would this do in production? Why does the job id
   save you, and what does it _not_ save you from?)

### Step 4: finish

- `pnpm exec vitest run apps/worker` shows 14 more passing tests.
- `pnpm format && pnpm lint && pnpm typecheck` are clean.
- The function is short: if it's much over 25 lines, something from checkpoint 5 or 6 has leaked in.
- Commit as one commit: `add ingest page processor (#9)`.
- Tell Claude; it reviews, then writes the failing tests for checkpoint 5.

### What's in and out of your function

| In `processIngestPage`                        | Not here (and where it goes)                                       |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Call the client, map, upsert, enqueue, return | Building the client, queue or database handle (checkpoint 6)       |
| Deciding whether there's a next page          | Validating job data with zod (the worker wrapper, checkpoint 6)    |
| One log line                                  | Catching or translating errors (checkpoint 5)                      |
|                                               | Retries, backoff, rate-limit pauses (BullMQ options; checkpoint 5) |
|                                               | Anything that imports `bullmq`                                     |

The last row is the design point: the processor doesn't know BullMQ exists. That is why it can be
tested with three fake functions, and why it could run under Temporal or SQS later unchanged.

### Crash table (fill this in yourself)

For each point, write what state the world is in and what the retry does. This is the table you'll
be asked about in an interview.

| The process dies…                              | Rows in Postgres? | Next job in Valkey? | What the retry does |
| ---------------------------------------------- | ----------------- | ------------------- | ------------------- |
| before the search returns                      |                   |                     |                     |
| after the search, before the upsert            |                   |                     |                     |
| after the upsert, before the enqueue           |                   |                     |                     |
| after the enqueue, before the job is completed |                   |                     |                     |

## Part 1b: how to approach the error translation (checkpoint 5)

### What it is

`handleIngestFailure(error, deps)` in `apps/worker/src/ingest/failure.ts`. The worker will call
it from a `catch` around `processIngestPage` (wired at checkpoint 6). It **always throws**: the
error it throws is the instruction to BullMQ.

| What was thrown                                                | What you throw                          | What BullMQ then does                               |
| -------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `CompaniesHouseError`, `retryable` false                       | `new UnrecoverableError(error.message)` | Fails the job now; no more attempts                 |
| `CompaniesHouseError`, kind `rate_limited`                     | `Worker.RateLimitError()` after a pause | Puts the job back to waiting; no attempt is used up |
| `CompaniesHouseError`, other retryable (timeout, network, 5xx) | the same error                          | Retries with backoff (`INGEST_JOB_OPTIONS`)         |
| Anything else (Postgres down, a bug, a non-`Error` value)      | the same value                          | Retries with backoff                                |

This is self-check question 3 from the #8 doc: the job knows what to do from `error.retryable`
and `error.kind`, never from a status code.

### Read first (20 min)

- `packages/integrations/src/companies-house/errors.ts`: `kind`, `retryable`, `retryAt`.
- BullMQ docs: "Retrying failing jobs", "Stop retrying jobs" (`UnrecoverableError`), and the
  manual rate-limit section of "Rate limiting" (`worker.rateLimit` and `Worker.RateLimitError`).
- `failure.test.ts`, top to bottom. `NOW` is pinned, so every duration is an exact number.

### Directions: the function, line by line

Imports you'll need: `CompaniesHouseError` from `@gtm/integrations`; `UnrecoverableError` and
`Worker` from `bullmq`. Make the function `async` and delete the two `void` lines.

1. **Not a Companies House error?** If `error` is not an `instanceof CompaniesHouseError`,
   `throw error`. Do this first: after it, TypeScript knows `error` has `kind` and `retryAt`.
2. **Rate limited?** If `error.kind === 'rate_limited'`:
   - work out the pause in milliseconds: `retryAt` as epoch milliseconds, minus
     `deps.now()` as epoch milliseconds;
   - never pause for less than `MIN_RATE_LIMIT_PAUSE_MS` (`Math.max`);
   - `await deps.pauseQueue(ms)`;
   - `throw Worker.RateLimitError()`.
3. **Not retryable?** If `!error.retryable`, `throw new UnrecoverableError(error.message)`.
4. **Otherwise** `throw error`.

Things to get right:

- **Order matters.** `rate_limited` is retryable, so check it before the `retryable` test, or it
  falls through to step 4 and is retried with backoff instead of pausing the queue.
- **`retryAt` is a moment, not a duration** (#8). `pauseQueue` wants a duration. Subtract.
- **`retryAt` is typed `Date | undefined`.** A `rate_limited` error always has one, but the
  compiler doesn't know that. Decide what the pause is when it's missing, and say why in a comment.
- **Use `deps.now()`, never `new Date()`**, or the tests can't check exact numbers.
- **`await` the pause.** If it rejects (Valkey down), that error should travel out; one test
  checks this, and it passes without a `try` if you awaited.
- **Don't log the whole error for a 429 at `error` level.** A 429 is expected behaviour; one
  `warn` line with the pause length is enough. Logging is untested.

### Reference: the same shape in another domain

A handler for a payment job. Same four branches, different error type and different way of
saying "wait": this API gives a **number of seconds**, so there's no subtraction, and it has no
minimum.

```ts
export async function handlePaymentFailure(
  error: unknown,
  deps: PaymentFailureDeps,
): Promise<never> {
  // 1. Not ours to classify: let the queue retry it the normal way.
  if (!(error instanceof PaymentApiError)) throw error;

  // 2. The provider told every caller to back off. Pause the queue, then hand the job back.
  if (error.code === 'too_many_requests') {
    await deps.pauseQueue(error.retryAfterSeconds * 1_000);
    throw Worker.RateLimitError();
  }

  // 3. Retrying can't fix this (card declined, bad request): fail now and keep the reason.
  if (!error.isTransient) throw new UnrecoverableError(error.message);

  // 4. Transient (timeout, 5xx): rethrow unchanged so the queue retries with backoff.
  throw error;
}
```

| The payment example                  | Your handler                                         |
| ------------------------------------ | ---------------------------------------------------- |
| `PaymentApiError`                    | `CompaniesHouseError`                                |
| `error.code === 'too_many_requests'` | `error.kind === 'rate_limited'`                      |
| `retryAfterSeconds * 1_000`          | `retryAt` minus now, in milliseconds, with a minimum |
| `error.isTransient`                  | `error.retryable`                                    |

### Suggested test order

```
pnpm exec vitest apps/worker/src/ingest/failure.test.ts -t "part of the test name"
```

1. "everything else" (2 tests): step 1.
2. "errors worth retrying" (3 tests): step 4. These may already pass after step 1; say why.
3. "retrying cannot fix" (4 tests): step 3.
4. "rate limited" (5 tests): step 2. Do "pauses the whole queue until retryAt" first, then the
   minimum, then the error type.

Then put two bugs back and predict the failures: move the `retryable` check above the
`rate_limited` check; and replace `deps.now()` with `new Date()`.

### Finish

- 14 more tests pass; `pnpm format && pnpm lint && pnpm typecheck` are clean.
- Commit as `add ingest failure handling (#9)`, then tell Claude for review.

## Self-check (answer out loud)

1. Why does the upsert come before the enqueue?
2. Why is the next start index `startIndex + size` and not `startIndex + items.length`?
3. Name the four stop conditions. Which one saves an API call, and which one protects you from a
   wrong `hits`?
4. Why is there no `try`/`catch` in the processor?
5. The same page is enqueued twice. What stops it running twice? If it does run twice, what stops
   duplicate rows? Those are two different mechanisms; name both.
6. Why does `written` come from the upsert and not from the page?
7. Why does the processor take `enqueueNext` as a function instead of a BullMQ queue?
8. What does `maxPages` protect you from, given about 130,000 matching companies?
9. Is `enqueueNext` recursion? What is the difference, and what does it buy you when a worker dies?
10. Why must the `rate_limited` check come before the `retryable` check?
11. Why does a 429 pause the whole queue rather than only delaying the one job?
12. What does `UnrecoverableError` save you from, for a wrong API key and 5 attempts with backoff?
