# Project plan

The stable reference for what we're building and in what order. Day-to-day tasks
live in GitHub issues (one milestone per week). Rules and conventions live in
CLAUDE.md. Change this file deliberately, and record why in an ADR.

## Goal

Build one end-to-end AI account research and outreach platform in about 12 weeks
at 8–10 hours a week, with a demo-able core by week 6. The aim is to learn the
skills AI go-to-market (GTM) engineering roles ask for, and to be able to explain
every design decision in an interview.

## Scenario

We sell a developer-tooling product to UK software companies with 10–200
employees (SIC codes 62011, 62012, 62020). The platform:

1. Finds target companies in Companies House.
2. Enriches them through a waterfall of providers, caching every paid lookup.
3. Runs a durable research agent per company that produces an account brief.
4. Waits for human approval.
5. Drafts personalised outreach using RAG over past successful emails.
6. Sends to sandbox inboxes only, and syncs everything to HubSpot.

## Guardrails

- No LinkedIn scraping or automated LinkedIn actions; it breaks their terms.
- Email goes only to inboxes the owner controls (PECR and GDPR).
- Paid data vendors sit behind a provider interface; use free tiers plus a mock.
- Scrape only public company websites; respect robots.txt; timeouts on everything.

## Architecture

```
                 ┌──────────────────────┐
                 │   React dashboard    │  review, approve, status
                 └──────────┬───────────┘
                            │
                 ┌──────────▼───────────┐
                 │  Node API (Fastify)  │  auth, CRUD, starts jobs
                 └──────────┬───────────┘
                            │
      ┌─────────────────────▼─────────────────────┐        ┌───────────────────────┐
      │ Processing                                │        │ External services     │
      │  ┌────────────────┐  ┌──────────────────┐ │ calls  │  Companies House      │
      │  │ BullMQ workers │  │ Temporal         │ ├───────►│  Hunter / Apollo      │
      │  │ enrichment,    │  │ workflows        │ │        │  Company websites     │
      │  │ scraping       │  │ research agent,  │ │        │  Claude API           │
      │  │                │  │ approval         │ │        │  HubSpot              │
      │  └────────────────┘  └──────────────────┘ │        │  Email sandbox        │
      └─────────────────────┬─────────────────────┘        └───────────────────────┘
                            │
      ┌─────────────────────▼─────────────────────┐
      │ State                                     │
      │  Postgres + pgvector   │  Valkey          │
      │  prospects, CRM, RAG   │  queues, cache,  │
      │                        │  rate limits     │
      └───────────────────────────────────────────┘
```

**Why two processing paths:** BullMQ handles high-volume, job-shaped work
(retries, delays, per-provider rate limits). Temporal handles long-running agent
runs that need durable state, retries across crashes, and a human approval step.

## Stack

| Layer             | Choice                                                             | Why                                                                                          |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Language          | TypeScript; one small Python service later (scoring or embeddings) | Owner's strongest stack, plus one cross-language boundary                                    |
| API               | Node 22 + Fastify                                                  | Fast, typed, simple plugin model                                                             |
| Job queue         | BullMQ on Valkey                                                   | Retries, delays, rate limits built in                                                        |
| Durable execution | Temporal (TS SDK)                                                  | Most-cited in enterprise job specs; Inngest is the lighter fallback                          |
| LLM               | Claude API via the TS SDK; LangChain in one place (RAG retrieval)  | Learn tool use and prompt caching at SDK level first                                         |
| Data              | Postgres 16 + pgvector (Drizzle ORM), Valkey (Redis-compatible)    | One database for relational and vector data; Valkey is the engine ElastiCache runs (ADR-001) |
| CRM               | HubSpot developer test account                                     | Free, real OAuth and webhooks                                                                |
| Email             | Nylas sandbox or Gmail OAuth                                       | Real send path without cold-emailing anyone                                                  |
| Frontend          | React + Vite                                                       | Owner's existing strength                                                                    |
| Local infra       | docker-compose                                                     | Postgres, Valkey, Temporal dev server in one command                                         |
| Deployment        | AWS via CDK (TypeScript)                                           | Most-requested cloud; infrastructure as typed code                                           |

## Deployment target (weeks 11–12)

Local development stays on docker-compose. The app stays cloud-agnostic: config
comes from env vars, and app code doesn't call the AWS SDK.

| Local                  | AWS                              |
| ---------------------- | -------------------------------- |
| API and BullMQ workers | ECS on Fargate, one service each |
| Postgres + pgvector    | RDS for PostgreSQL               |
| Valkey                 | ElastiCache for Valkey           |
| Temporal dev server    | Temporal Cloud                   |
| `.env`                 | Secrets Manager                  |
| pino logs              | CloudWatch Logs                  |
| React dashboard        | S3 + CloudFront                  |
| Claude API             | Direct API, or Claude on Bedrock |

RDS, ElastiCache and NAT gateways bill hourly. Set a billing alarm before the
first deploy, and `cdk destroy` when not demoing.

## Phases

Each phase maps to a GitHub milestone with the same name. A phase is done only
when its **Done when** line is true.

### Week 1 — Foundations

pnpm monorepo, docker-compose, shared tsconfig/ESLint/Prettier/Vitest, Drizzle
with a `companies` table, GitHub Actions CI, ADR-001.
**Done when:** `docker compose up` plus `pnpm dev` starts the API, and CI is green.

### Week 2 — Ingestion, queues, rate limiting

Companies House client (hand-written), BullMQ ingest queue with idempotent
upserts, token-bucket rate limiter on Valkey (hand-written), Valkey response cache,
queue dashboard.
**Done when:** 500+ companies ingested without a 429, and a re-run makes zero
duplicate API calls.

### Weeks 3–4 — Waterfall enrichment

`EnrichmentProvider` interface; providers for Companies House officers, website
scraping (Playwright), Hunter, Apollo, and a mock; waterfall runner with
per-field provenance; cost ledger; dead-letter queue; ADR-002.
**Done when:** a batch run shows per-field provenance and a total cost, and
cached runs cost nothing.

### Weeks 5–6 — Durable research agent

Temporal worker and `researchAccount` workflow (hand-written); activities to
fetch pages, read filings, summarise and score fit; Claude tool-use loop with
structured output (hand-written); prompt caching; approval via Temporal signal;
crash-and-resume test; ADR-003. Optional: first CDK deploy of API + RDS.
**Done when:** 20 accounts research in parallel, survive a worker restart, and
wait for approval. This is the demo-able core.

### Week 7 — RAG personalisation

Synthetic email corpus with reply outcomes (generated by Claude), embeddings in
pgvector, drafts built from the account brief plus retrieved examples, LangChain
for retrieval.
**Done when:** each draft cites the brief facts and retrieved examples it used.

### Week 8 — Execution and deliverability

Sandbox sending, throttling, send windows, per-mailbox caps, bounce and reply
webhooks, README note on SPF/DKIM/DMARC.
**Done when:** an approved draft sends, and a reply changes the prospect's status
automatically.

### Week 9 — CRM sync

HubSpot OAuth app; push companies, contacts and activity; webhooks back into
Postgres with conflict handling. Stretch: Redpanda event stream for domain events.
**Done when:** a change in HubSpot shows up in Postgres, and vice versa.

### Week 10 — Dashboard and observability

React dashboard (prospects, workflow status, draft approval), structured logs with
correlation IDs, LLM evals with Claude as judge.
**Done when:** the whole flow runs from the UI.

### Weeks 11–12 — AWS deployment and packaging

AWS account setup, CDK stack, Temporal Cloud, Secrets Manager, S3 + CloudFront,
GitHub Actions deploy via OIDC, ADR-004 (AWS choices, SQS vs BullMQ), README,
demo video, teardown, mock interview.
**Done when:** a stranger can clone, run and understand it in 15 minutes, and
`cdk deploy` stands the whole system up on AWS.

## Working rules for Claude

- Issues labelled `hand-written`: the owner writes the first version. Guide and
  review only.
- Start each issue with a plan and wait for approval.
- Don't build features from a later phase than the current one in CLAUDE.md.
- Draft an ADR in `docs/adr/` for any architectural decision.

## Deliberately not doing

- **Kafka:** the workload is job-shaped; BullMQ fits. Revisit only for the week 9
  event-stream stretch.
- **Separate vector database:** pgvector keeps one database until scale demands more.
- **ZoomInfo / Clearbit:** not available to individuals; the provider interface
  proves the pattern.
- **LinkedIn automation:** terms of service; see Guardrails.
