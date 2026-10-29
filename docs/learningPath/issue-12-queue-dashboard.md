# Learning path: #12 Queue dashboard (Bull Board)

Companion to issue #12, written by Claude in checkpoints. A shorter doc than #10 or #11: the issue
is mostly wiring, but it carries three ideas worth keeping: package boundaries, defence in depth,
and secure-by-default configuration.

**Goal:** explain in 30 seconds why the queue definition moved into a package, why the dashboard is
read-only twice over, and why it doesn't exist unless a password is set.

## Progress

- [x] Checkpoint 0: acceptance criteria on the issue
- [x] Checkpoint 1: `job.ts` and `enqueue.ts` moved into `@gtm/queues` (pure move; tests unchanged)
- [x] Checkpoint 2: `getQueueDashboardPassword()` in `@gtm/config`
- [x] Checkpoint 3: the `queueDashboard` Fastify plugin, read-only, behind basic auth
- [x] Checkpoint 4: wiring in the API; live check (2026-10-29); this doc; PR

## How to use it

Add a line to your `.env` (at least 12 characters), restart `pnpm dev`, and open
`http://localhost:3000/admin/queues`. Log in as `admin` with that password.

```
QUEUE_DASHBOARD_PASSWORD=<something long and local>
```

Without that line the dashboard doesn't exist (404), and the API doesn't connect to Valkey at all.

## Part 1: the design

### Shape

```
apps/api
  index.ts      password set? → Valkey connection + ingest queue → buildServer({ queueDashboard })
                onClose hook → queue.close(), connection.quit()
  server.ts     buildServer(options): /health, and the plugin only if options.queueDashboard
  queue-dashboard.ts
                basic auth (onRequest) → non-GET? 405 (onRequest) → Bull Board, readOnlyMode
packages/queues  the ingest queue's definition, shared by apps/worker and apps/api
```

### Why `@gtm/queues`

The API needed the `company-ingest` queue, defined inside `apps/worker`. Apps are things you
deploy, not libraries: an import from `apps/worker/src/...` would make the API depend on the
worker's source tree without anything in `package.json` saying so. A package makes the dependency
visible and versioned. It isn't `@gtm/infra`, because that holds generic building blocks (Valkey
connections, the limiter, the cache), while a queue called `company-ingest` with a SIC-code schema
belongs to this app. The move was its own commit, with every test unchanged, so a reviewer can see
it changed nothing.

### Read-only, twice over

1. **Bull Board's `readOnlyMode`** on every queue: its action handlers return 405.
2. **Our own guard**: any request other than `GET`/`HEAD` gets a 405 before Bull Board sees it.

Why both: the first is enforced inside each of Bull Board's routes, by Bull Board; the second is
one rule we own. Every non-`GET` route Bull Board defines changes something (retry, clean,
obliterate, add, pause, update data…), so "only `GET`" is exactly "read-only", and it covers
optional routes (metrics-history purge, when that feature is on) and routes a future version adds.
Removing the guard fails 6 tests, which shows it's doing work.

This is **defence in depth**: two independent layers, so one mistake doesn't expose everything.

### Off by default, then a password

- **Unset means off.** One variable both enables and protects the dashboard, so "on but
  unprotected" can't happen.
- **Short means refuse to start.** A warning in the logs would be missed while the weak password
  was already live.
- **Why a password at all locally:** Fastify listens on `0.0.0.0`; the live check logged
  `Server listening at http://192.168.4.128:3100`, which is your machine's address on the network.
- **Constant-time comparison of hashes.** `===` stops at the first wrong character, so response
  time leaks how much of a guess was right. Hashing first makes both sides the same length, which
  `timingSafeEqual` needs. The user and password are both always checked.
- **Auth before the read-only guard.** An anonymous request gets 401 whatever it asks for.

### Encapsulation in Fastify

The plugin's hooks apply only to routes registered inside that plugin. That's why `/admin/queues`
needs credentials and `/health` doesn't, and why the guard can't refuse a route that doesn't exist:
an unknown path never enters the plugin, and gets Fastify's plain 404 (harmless; it changes nothing).

## Part 2: lessons

| Lesson                                                         | Name to search                      | Where it showed up                                                                                        |
| -------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Apps don't import from apps; shared code goes in a package     | Package boundaries; monorepo layout | The queue definition moved to `@gtm/queues`                                                               |
| A refactor gets its own commit, proven by unchanged tests      | Refactoring; one concern per commit | Checkpoint 1: 275 and 31 tests passing before and after                                                   |
| `git mv` keeps a file's history                                | `git log --follow`                  | `job.ts` still traces back to #9                                                                          |
| Two independent layers beat one clever one                     | Defence in depth                    | `readOnlyMode` plus a GET-only guard                                                                      |
| Check a claim about a library against the installed code       | —                                   | The purge route only exists when metrics history is on, so it was a 404 here, not the gap first described |
| Hooks are scoped to the plugin that registers them             | Fastify encapsulation               | `/health` needs no credentials; an unknown route is a 404, not a 405                                      |
| Compare secrets in constant time                               | Timing attacks; `timingSafeEqual`   | Hash both, then compare; always check both fields                                                         |
| Make the safe state the default, and the unsafe one impossible | Secure by default                   | Unset password = no dashboard; short password = no start                                                  |
| An `EventEmitter` with no `error` listener crashes the process | Node.js error events                | `queue.on('error', …)` in the API and in tests                                                            |

## Part 3: as built

### Settings

| Setting         | Value                                      |
| --------------- | ------------------------------------------ |
| Path            | `/admin/queues`                            |
| User            | `admin`                                    |
| Password        | `QUEUE_DASHBOARD_PASSWORD`, 12+ characters |
| Queues shown    | `company-ingest`                           |
| Allowed methods | `GET`, `HEAD`                              |

### The live check (2026-10-29)

API on port 3100 with the password passed on the command line (`.env` untouched):

| Request                                          | Result                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `/admin/queues`, no credentials / wrong password | 401 / 401                                                               |
| `/admin/queues`, right password                  | 200, HTML                                                               |
| `/health`, no credentials                        | 200                                                                     |
| `PUT …/company-ingest/retry/failed`              | 405                                                                     |
| `…/api/queues`                                   | `company-ingest`, read-only, 42 completed jobs with their return values |
| SIGTERM                                          | Clean exit; Valkey connection closed                                    |
| No password                                      | `/admin/queues` 404; no Valkey connection                               |
| Password `short`                                 | Refused to start, exit code 1                                           |
| Logs                                             | Neither the password nor the `Authorization` header appears             |

### Failure modes

| Failure                                 | Handling                                                            | Test              |
| --------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| No or wrong credentials                 | 401 with a login prompt                                             | Unit              |
| An action (retry, clean, obliterate…)   | 405 from our guard; Bull Board's `readOnlyMode` behind it           | Unit; integration |
| Password missing                        | Dashboard not mounted; no Valkey connection                         | Unit; live        |
| Password too short                      | The API refuses to start                                            | Config unit; live |
| Valkey down while the dashboard is open | The dashboard's API calls fail; logged; the rest of the API is fine | Untested          |
| API shutdown                            | `onClose` closes the queue and the connection                       | Live              |

### Known gaps

- **Basic auth is for local use only.** It has no lockout, no users and no audit trail. The AWS
  deploy (weeks 11–12) should leave `QUEUE_DASHBOARD_PASSWORD` unset, or put the dashboard behind
  real auth.
- **One queue.** New queues (enrichment, weeks 3–4) must be added to the list in `index.ts`.
- **No HTTPS locally,** so the password crosses the network in plain text (base64 isn't encryption).
  Another reason to keep it local.

## Self-check (answer out loud)

1. Why can't `apps/api` import the queue from `apps/worker`?
2. How do you show a reviewer that a refactor changed nothing?
3. Why have a GET-only guard when Bull Board already has `readOnlyMode`?
4. Why does an anonymous `PUT` get 401 rather than 405?
5. Why compare hashes with `timingSafeEqual` instead of `===` on the passwords?
6. What are the two safe states of `QUEUE_DASHBOARD_PASSWORD`, and why is there no "on without a
   password" state?
7. Why does `/health` not need credentials when the dashboard is mounted?
