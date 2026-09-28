# ADR-001: Monorepo and tooling

- Status: Draft (notes collected during #1; finish in #6)
- Date: 2026-09-27

## Context

One developer, about 12 weeks, several deployables (API, worker, later a Temporal worker and a
dashboard) sharing config, DB access and API clients.

## Decisions (notes so far)

### pnpm workspaces, no Turborepo/Nx

- pnpm's strict `node_modules` means a package can't import a dependency it didn't declare.
- Six packages don't need a task graph or remote cache. Plain `pnpm -r` is less to learn.
- Trade-off: no build caching. Adding Turbo later is small if CI gets slow.

### Internal packages export TypeScript source

- `"exports": { ".": "./src/index.ts" }`: no per-package build, no stale `dist/`, and edits hot-reload
  through `tsx watch` (verified).
- Trade-off: every runtime must understand TS (`tsx` in dev). Production images need a bundle
  step (tsup/esbuild), planned for weeks 11–12.

### ESM with `module`/`moduleResolution: NodeNext`

- Matches Node's real resolution rules; avoids CJS/ESM interop problems later.
- Trade-off: relative imports need a `.js` extension.

### Version pinning

- Node: `.nvmrc` (22) + `engines` `>=22.13.0` + `engineStrict: true` in `pnpm-workspace.yaml`.
  22.13 is pnpm 11's own minimum. Below that, pnpm crashes before our engines check can run.
- pnpm: `packageManager: pnpm@11.28.0` via corepack. **Not 12**: pnpm 12 ships a native binary
  layout that the corepack bundled with Node 22 (0.34) can't launch (`Cannot find module .../bin/pnpm.cjs`).
- TypeScript 5.9, not 7: typescript-eslint (needed in #3) supports `typescript <6.1.0`.
- `@types/node` tracks our Node major (22.x), not the latest.

### Registry and install scripts

- Project `.npmrc` sets `registry=https://registry.npmjs.org/` so this repo never inherits a
  user-level private registry.
- pnpm blocks dependency install scripts by default. Allowlist them one by one in `allowBuilds`
  (currently only `esbuild`, which tsx needs).

### Shared config at the repo root (#3)

- `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json` and `vitest.config.ts` live at the
  root, not in `@gtm/*-config` packages. One repo with nothing published, so a config package would
  add a layer without buying anything.
- Trade-off: splitting repos later would mean extracting these into packages.

### ESLint: flat config, typescript-eslint `recommendedTypeChecked`

- Type-aware rules catch async bugs that matter in queue/worker code: `no-floating-promises` and
  `no-misused-promises`. The second flagged a real bug on day one: async `shutdown` passed to
  `process.once`, where a rejected `app.close()` would have been an unhandled rejection.
- The CLAUDE.md rule "no `any` without a comment" is enforced: `no-explicit-any: error` plus
  `eslint-comments/require-description`, so a disable needs `-- reason`. Unused disables are errors.
- Not `strictTypeChecked` yet: too noisy while learning. Revisit later.
- Trade-off: type-aware linting runs the TS compiler, so it's slower than syntax-only linting.

### Prettier runs separately from ESLint

- `eslint-config-prettier` (loaded last) turns off ESLint's style rules; no `eslint-plugin-prettier`.
  Lint output is about bugs, formatting is fast, and each tool has one job.
- Trade-off: two commands (`lint`, `format:check`) instead of one.

### Vitest over Jest, one root config

- Vitest runs ESM + TypeScript natively with no transform setup; Jest's ESM support still needs
  extra config. The API is Jest-compatible, so the knowledge carries over.
- One root `vitest.config.ts` with an explicit `include` gives one run and one report; `LOG_LEVEL=silent`
  keeps Fastify logs out of test output.
- Trade-off: it can't give packages different environments. Switch to Vitest `projects` when the
  React dashboard (week 10) needs jsdom.

### Local infrastructure (#2)

- **Valkey 8.1 instead of Redis**, under the service name `redis`. Valkey is the Linux Foundation
  fork of Redis 7.2, with the same protocol, supported by BullMQ, and offered by ElastiCache as its
  cheaper engine. Running it locally gives dev/prod parity for weeks 11–12. App code and env vars
  stay `REDIS_*`. Trade-off: PLAN.md says "Redis"; `redis:7.4-alpine` would be a drop-in if needed.
- **`maxmemory-policy noeviction` + AOF persistence.** BullMQ stores jobs as keys, and eviction
  would silently drop them. Trade-off: a full Redis fails writes loudly instead.
- **pgvector enabled by the Drizzle migration (#4), not a Docker init script.** RDS never runs
  init scripts, so the migration must do it anyway; doing it once keeps local and AWS identical.
- **Temporal CLI dev server** (`temporalio/temporal`, SQLite, UI built in) instead of `auto-setup`
  plus its own DB and a UI container. Temporal Cloud replaces it in production. The image runs as
  a non-root user, so its volume mounts over `/home/temporal` to inherit that ownership.
- Ports bind to `127.0.0.1` (dev credentials never reachable from the network); health checks
  plus `docker compose up -d --wait` so nothing starts before its dependencies are ready.

### Database access: Drizzle + node-postgres (#4)

- **Drizzle over Prisma or Kysely.** The schema is TypeScript and generates reviewable SQL
  migrations. Queries read like SQL, so what runs is obvious. It has no separate engine binary or
  codegen step (unlike Prisma), and still has a schema/migration story (unlike Kysely, a query
  builder only). Trade-off: a smaller ecosystem than Prisma, and pre-1.0 (pinned to 0.45; 1.0 is
  still RC).
- **`pg` (node-postgres) with a `Pool`**: the most widely used driver, and what RDS examples
  assume. The pool needs an `'error'` handler, or an idle client dropping its connection crashes
  the process. Trade-off: postgres.js is faster with a nicer API, which doesn't matter at our scale.
- **Committed migrations (`drizzle-kit generate` + `migrate`), never `push`.** Reviewed SQL, and
  the same files run on RDS. Migrations are **append-only once merged**: the migrator applies any
  journal entry newer than the last one applied, so regenerating a migration makes existing
  databases re-run it. Learned this the hard way during #4. Generated files are in
  `.prettierignore`, so formatting never rewrites them.
- **`companies` schema:** a surrogate `uuid` PK plus a unique `company_number` (text: `NI`/`SC`
  prefixes and leading zeros) as the upsert key. `status`/`company_type` are text, validated by zod
  at the boundary, not Postgres enums, because Companies House can add values and an enum would
  fail inserts mid-ingest. `sic_codes text[]` with a GIN index for overlap filters. Dates use
  `mode: 'string'` to avoid JS `Date` timezone shifts.
- **Integration tests use a separate `*_test` database** created by Vitest global setup, with a
  guard that refuses any other database name, because the tests truncate tables. They run via
  `pnpm test:int`, so `pnpm test` needs no Docker.
- **Env:** `getDatabaseUrl()` is the first zod-validated env value, and its errors never echo the
  URL (it contains the password). Scripts load `.env` with Node's `--env-file-if-exists`, so no
  dotenv dependency.

## Still to decide / write up in #6

- Nothing outstanding for week 1; finalise status, context and consequences.
