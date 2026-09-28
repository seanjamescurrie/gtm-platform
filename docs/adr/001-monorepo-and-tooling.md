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

## Still to decide / write up in #6
- Drizzle vs Prisma/Kysely (#4)
