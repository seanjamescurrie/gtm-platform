# Learning path: ADR-001 Foundations

Companion to [ADR-001](../adr/001-monorepo-and-tooling.md).

**Goal:** for each decision, give a 30-second answer covering what you chose, why, what it costs,
and when you'd change it.

**Format:** each step has three parts:

- **Read:** one piece of documentation
- **Break:** an experiment on a throwaway branch (`git switch -c scratch/adr-001`)
- **Say:** a question to answer out loud, without notes

**Time:** about 4–5 hours, spread over week 2. Delete the scratch branch when you're done.

## Session 1: workspace basics (decisions 1–4, ~90 min)

### 1. pnpm strictness

- **Read:** pnpm docs, "Motivation" and "Symlinked `node_modules` structure".
- **Break:** in `apps/api/src/server.ts`, add `import { z } from 'zod'` (zod belongs to
  `@gtm/config`, not the API). Run `pnpm typecheck` and `pnpm dev`, see it fail, then add zod to
  `apps/api/package.json` properly.
- **Say:** "Why pnpm over npm workspaces?"

### 2. Internal packages ship TypeScript source

- **Break:** run `node apps/api/src/index.ts` without `tsx`. Node 22.19 strips types natively.
  Find out what breaks, and why that means production needs a bundle step.
- **Say:** "What's the cost of having no build step?"

### 3. ESM with NodeNext

- **Read:** TypeScript handbook, "Modules – Choosing compiler options".
- **Break:** remove `.js` from `import { buildServer } from './server.js'` in
  `apps/api/src/index.ts`, run `pnpm typecheck`, and read the error.
- **Say:** "Why do your TypeScript imports end in `.js`?"

### 4. Version pinning

- **Break:** delete one entry from `pnpm-lock.yaml` and run `pnpm install --frozen-lockfile`.
  Then run `nvm use 18` and `pnpm -v` to see the unclear crash listed under Negative consequences.
- **Say:** "How do you guarantee CI runs what you tested?"

## Session 2: quality gates (decisions 5, 6, 9, ~75 min)

### 5. Type-aware lint

- **Read:** typescript-eslint docs for `no-floating-promises` and `no-misused-promises`.
- **Break:** in `apps/worker/src/index.ts`, call an async function without `await`, and see
  `pnpm lint` catch it. Then add an `eslint-disable` comment without a `-- reason`.
- **Say:** "Give an example of a bug your lint setup catches that tests might not."

### 6. Vitest and the unit/integration split

- **Break:** run `TEST_DATABASE_URL=postgres://gtm:gtm@localhost:5432/gtm pnpm test:int`. The
  guard should refuse. Explain why it exists.
- **Do:** with `pnpm test:watch` running, write one new unit test that uses `vi.fn()`.
- **Say:** "How do you keep tests from touching your dev data?"

### 7. CI

- **Read:** the probe comment on PR #63, then GitHub docs on "service containers" and "security
  hardening: using third-party actions" (pinning to a SHA).
- **Say:** "How do you know your CI can actually fail?"

## Session 3: data and infrastructure (decisions 7–8, ~90 min)

### 8. Committed migrations

- **Do:** add a nullable `website text` column to `companies` in `packages/db/src/schema.ts`,
  run `pnpm --filter @gtm/db db:generate`, read the SQL, and run `pnpm --filter @gtm/db migrate`.
- **Break:** do what the ADR warns against. Delete and regenerate that migration, and watch
  `migrate` fail. That makes "append-only once merged" stick.
- **Compare:** run `drizzle-kit push` against a throwaway database, and notice that nothing is
  recorded.
- **Clean up:** throw the branch away, then `docker compose down -v && docker compose up -d --wait`
  and `pnpm --filter @gtm/db migrate` to get back to a clean dev database.
- **Say:** "Why migrations instead of `push`, and why can't you edit a merged one?"

### 9. Valkey and `noeviction`

- **Break:** in `docker compose exec redis valkey-cli`, run `CONFIG SET maxmemory 1mb` and
  `CONFIG SET maxmemory-policy allkeys-lru`, write keys in a loop, and watch the old ones
  disappear. Those keys could have been BullMQ jobs. Switch back to `noeviction` and see the
  write error instead.
- **Clean up:** `docker compose down -v && docker compose up -d --wait`.
- **Say:** "What happens to BullMQ if Redis evicts keys?" and "Why Valkey rather than Redis?"

### 10. Temporal dev server

- **Do:** open `localhost:8233`, then create and list a namespace with
  `docker compose exec temporal temporal operator namespace create --namespace scratch --address 127.0.0.1:7233`.
  That's enough until weeks 5–6.

## Finish (~30 min)

- Answer every **Say** question out loud, without looking. Where you stumble, reread that Decision
  entry and its Negative consequence.
- Pick the three "Revisit when" triggers most likely to fire first (likely: Valkey service in CI,
  the bundle step, Vitest `projects`). Check you can explain what you'd change and why.
- **Interview framing:** open with the Context ("one developer, 12 weeks, learning goal, AWS
  later") and let each decision follow from it. That's the story the ADR tells.

## Progress

- [ ] Session 1: workspace basics
- [ ] Session 2: quality gates
- [ ] Session 3: data and infrastructure
- [ ] Finish: out-loud answers and revisit triggers
