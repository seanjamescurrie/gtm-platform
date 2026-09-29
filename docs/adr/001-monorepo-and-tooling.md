# ADR-001: Foundations: monorepo, tooling and local infrastructure

- Status: Accepted
- Date: 2026-09-28
- Implemented in: #57, #59, #60, #61, #62, #63

## Context

- Several deployables (API, BullMQ worker, later a Temporal worker and a React dashboard) must
  share config, database access and API clients, without publishing packages to a registry.
- One developer, 8–10 hours a week, for about 12 weeks. The goal is learning, and being able to
  explain every choice in an interview, so fewer well-understood tools beat feature-rich ones.
- TypeScript on Node 22 is fixed (see CLAUDE.md). The codebase is new, so there is no legacy module
  format or build setup to keep.
- Most of the work is asynchronous and job-shaped (queues, workers, retries). A promise nobody
  awaits there loses work silently instead of failing.
- The data needs relational tables and vector search, and must run the same way on a laptop now
  and on managed AWS services in weeks 11–12. App code stays cloud-agnostic until then.
- Builds must be reproducible on the laptop and in CI. The laptop is a work machine whose global
  npm config points at a private corporate registry.
- Some tests need a real database; the everyday edit–test loop should not need Docker.
- Budget: free tiers and open-source tools only.

## Decision

1. **Monorepo on pnpm workspaces, with no task runner.** Deployables live in `apps/*`, shared
   code in `packages/*`, and scripts run with `pnpm -r`. pnpm's strict `node_modules` stops a
   package importing a dependency it hasn't declared, so missing dependencies fail at install
   rather than in production. (#57)
2. **Internal packages ship TypeScript source, with no per-package build.** Each package exports
   `./src/index.ts`, and apps run under `tsx`. Edits in any package hot-reload straight into the
   apps, and a stale `dist/` can't exist. (#57)
3. **ESM everywhere, with `NodeNext` module resolution.** TypeScript then checks imports using the
   same rules Node uses at runtime, and we avoid CommonJS/ESM interop bugs. (#57)
4. **Exact, repo-owned versions.** Node comes from `.nvmrc` and `engines` (with `engineStrict`),
   pnpm from `packageManager` via corepack, and every dependency is pinned to an exact version. A
   project `.npmrc` forces the public npm registry, and dependency install scripts run only when
   allowlisted. The laptop, CI and future containers resolve identical versions. (#57)
5. **Type-aware ESLint for bugs, Prettier for formatting, run separately, with configs at the repo
   root.** typescript-eslint's `recommendedTypeChecked` plus `no-floating-promises` and
   `no-misused-promises` catch the async mistakes that matter in worker code (it caught a real one
   on day one). A disable comment must give a reason, which enforces the "no `any` without a
   comment" rule. (#59)
6. **Vitest, with one root config and a split between unit and integration tests.** Vitest runs
   ESM + TypeScript with no transform setup. `pnpm test` runs every package's unit tests in one
   pass with no Docker. `pnpm test:int` runs against a real Postgres, in a separate `*_test`
   database that the test setup creates and migrates. A guard refuses any database name without
   the `_test` suffix. (#59, #62)
7. **Drizzle ORM on node-postgres, with committed SQL migrations.** The schema is TypeScript,
   `drizzle-kit generate` produces SQL that gets reviewed in PRs, and the same files will run on
   RDS. Schema changes never use `drizzle-kit push`. (#62)
8. **Local infrastructure in docker-compose: Postgres 16 + pgvector, Valkey, and the Temporal CLI
   dev server.** All images are pinned, health-checked, and bound to `127.0.0.1`. Valkey matches
   the engine ElastiCache offers, and Postgres extensions are enabled by migrations, not init
   scripts, so local and AWS stay identical. (#61)
9. **CI on GitHub Actions runs the same commands as local.** It has two parallel jobs (checks,
   and integration against a Postgres service container), a frozen-lockfile install, and actions
   pinned to commit SHAs. Required on `main` via a ruleset. (#63)

## Alternatives considered

- **npm or yarn workspaces:** they hoist dependencies, so an undeclared import works locally and
  fails later.
- **Turborepo / Nx:** a task graph and remote cache pay off across dozens of packages. With six
  packages and no build step, they're config to learn that buys nothing yet.
- **Per-package builds (`tsc -b`, project references):** they add a watch process per package and
  stale-`dist/` bugs, to solve a publishing problem we don't have.
- **CommonJS:** it's where the ecosystem is moving away from, and mixing formats causes interop bugs.
- **Biome (one tool for lint and format):** faster, but it has no type-aware rules, and those
  are the rules this codebase needs most.
- **`eslint-plugin-prettier`:** it turns formatting into lint errors, which makes lint slower and noisier.
- **Jest:** its ESM + TypeScript support still needs transform config.
- **`node:test`:** built into Node, but thin on mocking, watch mode and TypeScript ergonomics.
- **Prisma:** it needs a separate engine binary and a codegen step, and its query layer is further
  from the SQL.
- **Kysely:** a good query builder, but it has no schema or migration story of its own.
- **postgres.js:** faster, with a nicer API, but less widely used and less common in examples.
  Speed doesn't matter at our scale.
- **Redis 8:** licence changes, and ElastiCache's cheaper engine is Valkey. **Redis 7.4** would be
  a drop-in if ever needed.
- **Temporal `auto-setup`:** it needs its own database schema plus a UI container. Temporal
  Cloud replaces local Temporal in production anyway.
- **`docker compose` inside CI:** service containers are native to Actions, and the runner
  health-checks them.

## Consequences

**Positive**

- One install, one lint run, one test run and one CI workflow cover the whole repo.
- A change in any package reaches the apps immediately, with no build or publish step.
- The laptop and CI use identical tool versions; drift fails at install instead of at runtime.
- The async bugs most likely in queue and worker code are caught at lint time.
- The same migrations, database engine and cache engine run locally and on AWS.
- The everyday loop (`pnpm test`) is fast and needs no Docker.
- CI has been shown to fail on a failing test, a formatting error and lockfile drift, so green
  means something.

**Negative**

- Versions are held back by other tools. pnpm stays on 11 because the corepack bundled with
  Node 22 can't launch pnpm 12. TypeScript stays on 5.9 because typescript-eslint supports
  `<6.1`. Pinning also means every upgrade is manual.
- On Node versions older than 22.13, the install fails with an unclear pnpm crash instead of
  the friendly engines error.
- Every runtime must understand TypeScript. Production images will need a bundle step
  (tsup/esbuild).
- Relative imports need `.js` extensions.
- No build caching: CI re-runs every check on every push.
- Type-aware linting runs the TypeScript compiler, so it's slower than syntax-only linting.
- Shared config lives at the repo root; splitting the repo would mean extracting it into packages.
- One Vitest config means one test environment for every package.
- Integration tests need Docker running and a separate command.
- Drizzle is pre-1.0 (pinned to 0.45), so upgrades may bring breaking changes.
- **Migrations are append-only once merged.** The migrator applies any journal entry newer than
  the last one applied, so regenerating a merged migration makes existing databases re-run it.
  Generated migration files are excluded from Prettier for the same reason.
- Valkey differs from the "Redis" named in PLAN.md. App code and env vars keep the `REDIS_*` names.
- The Postgres image tag lives in two files (`compose.yaml` and `ci.yml`), cross-referenced by
  comments.

**Revisit when**

- CI takes more than ~5 minutes, or the repo passes ~15 packages → add Turborepo (it's
  additive on top of pnpm workspaces).
- The first deployable image is built (weeks 11–12) → add a per-app bundle step.
- The corepack bundled with our Node version can launch pnpm 12 → upgrade pnpm.
- typescript-eslint supports TypeScript 7 → evaluate TS 7, which type-checks much faster.
- A package needs a different test environment (e.g. the dashboard needs jsdom) → switch the
  root config to Vitest `projects`.
- The codebase is past week 6 and lint findings are rare → try `strictTypeChecked`.
- Drizzle 1.0 is stable → upgrade, and recheck how the migrator decides what to apply.
- Tests need Valkey or Temporal (week 2's rate limiter and cache) → add those service containers
  to CI.
- The AWS engine choice changes in weeks 11–12 → update the local image to match.
