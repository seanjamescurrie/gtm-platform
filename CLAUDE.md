# CLAUDE.md

## What this project is

A learning project: an AI account research and outreach platform for B2B go-to-market.
It finds UK software companies (Companies House, SIC 62011/62012/62020), enriches them
through a waterfall of providers, runs a durable research agent per company, drafts
personalised outreach with RAG, and syncs results to HubSpot.

The owner is building this to learn the skills. Optimise for understanding, not speed.

Full plan, architecture and weekly goals: @docs/PLAN.md Tasks: GitHub issues, one milestone per week (read them with gh issue list / gh issue view).

## Current phase

Phase 1 (week 1–2): foundations, Companies House ingestion, BullMQ, Redis cache and rate limiting.
Do not build features from later phases unless asked.

## Stack

- TypeScript everywhere, Node 22, pnpm workspaces
- API: Fastify (`apps/api`)
- Jobs: BullMQ on Redis (`apps/worker`)
- DB: Postgres 16 + pgvector, Drizzle ORM (`packages/db`)
- External clients: `packages/integrations`
- Cache and rate limiter: `packages/infra`
- Config: zod-validated env (`packages/config`)
- Tests: Vitest
- Later: Temporal (TS SDK), Claude API, React + Vite, HubSpot, Nylas
- Deployment (weeks 11–12): AWS via CDK in TypeScript — ECS Fargate, RDS Postgres, ElastiCache, Temporal Cloud, S3 + CloudFront. Local dev stays on docker-compose; keep the app cloud-agnostic (config via env, no AWS SDK calls in app code unless asked)

## Commands

- `docker compose up -d` — Postgres, Redis, Temporal dev server
- `pnpm dev` — run api and worker in watch mode
- `pnpm test` / `pnpm lint` / `pnpm typecheck`
- `pnpm --filter @gtm/db migrate` — run migrations

## Conventions

- Strict TypeScript; no `any` without a comment explaining why
- Validate all external API responses with zod at the boundary
- Every job must be idempotent: safe to run twice with the same input
- Every outbound API call goes through the shared rate limiter and cache
- Log with pino, structured, include a correlation id
- Small PR-sized changes; one concern per commit

## Guardrails (non-negotiable)

- Never scrape LinkedIn or automate LinkedIn actions
- Never send email to addresses other than the owner's test inboxes
- Respect robots.txt; set timeouts on every scrape
- Never commit secrets; use `.env` (see `.env.example`)

## How to work with me

- Before any non-trivial change, propose a plan and wait for approval
- When I say "I'll write this one", give guidance and review only; do not write the code
- Explain the why behind design choices in 2–3 sentences, and name the trade-off
- After a feature, list the failure modes and how the code handles each
- Write tests alongside code, not after
- When a decision is architectural, draft an ADR in `docs/adr/` for me to edit

## Decisions so far

- ADR-001: pnpm monorepo, Drizzle, Vitest
- BullMQ for job-shaped work; Temporal reserved for long-running agent workflows
- Kafka deferred; optional event stream in week 9 at most
