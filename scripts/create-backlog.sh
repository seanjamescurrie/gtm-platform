#!/usr/bin/env bash
# Creates labels, milestones and issues for the AI GTM platform backlog.
#
# Usage (from inside your cloned repo, after `gh auth login`):
#   ./scripts/create-backlog.sh             # create everything
#   DRY_RUN=1 ./scripts/create-backlog.sh   # preview without changing anything
#
# Safe to re-run: existing labels are updated, existing milestones and
# issues (matched by exact title) are skipped.

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] $*" >&2
  else
    "$@"
  fi
}

command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not logged in. Run: gh auth login"; exit 1; }

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "Target repo: $REPO"
[[ "$DRY_RUN" == "1" ]] && echo "(dry run: nothing will be created)"

WEEKS="week-1 week-2 week-3-4 week-5-6 week-7 week-8 week-9 week-10 week-11-12"

milestone_title() {
  case "$1" in
    week-1)     echo "Week 1 — Foundations" ;;
    week-2)     echo "Week 2 — Ingestion, queues, rate limiting" ;;
    week-3-4)   echo "Weeks 3–4 — Waterfall enrichment" ;;
    week-5-6)   echo "Weeks 5–6 — Durable research agent" ;;
    week-7)     echo "Week 7 — RAG personalisation" ;;
    week-8)     echo "Week 8 — Execution and deliverability" ;;
    week-9)     echo "Week 9 — CRM sync" ;;
    week-10)    echo "Week 10 — Dashboard and observability" ;;
    week-11-12) echo "Weeks 11–12 — AWS deployment and packaging" ;;
    *) echo "Unknown week: $1" >&2; exit 1 ;;
  esac
}

milestone_done() {
  case "$1" in
    week-1)     echo "docker compose up plus pnpm dev starts the API, and CI is green." ;;
    week-2)     echo "500+ companies ingested without a 429, and a re-run makes zero duplicate API calls." ;;
    week-3-4)   echo "A batch run shows per-field provenance and a total cost, and cached runs cost nothing." ;;
    week-5-6)   echo "20 accounts research in parallel, survive a worker restart, and wait for approval." ;;
    week-7)     echo "Each draft cites the brief facts and retrieved examples it used." ;;
    week-8)     echo "An approved draft sends, and a reply changes the prospect's status automatically." ;;
    week-9)     echo "A change in HubSpot shows up in Postgres, and vice versa." ;;
    week-10)    echo "The whole flow runs from the UI." ;;
    week-11-12) echo "A stranger can clone, run and understand it in 15 minutes, and cdk deploy stands the whole system up on AWS." ;;
  esac
}

# ---------------------------------------------------------------- labels
echo
echo "== Labels"
label() { run gh label create "$1" --color "$2" --description "$3" --force; }

for wk in $WEEKS; do
  label "$wk" "ededed" "$(milestone_title "$wk")"
done
label "feat"    "1d76db" "New functionality"
label "chore"   "c5def5" "Setup, tooling, infrastructure"
label "docs"    "0e8a16" "README, ADRs, write-ups"
label "test"    "fbca04" "Tests and resilience checks"
label "stretch" "d4c5f9" "Optional; only if time allows"
label "aws"     "ff9900" "AWS infrastructure and deployment (CDK)"
label "hand-written" "b60205" "Write this one yourself before involving Claude"

# ------------------------------------------------------------ milestones
echo
echo "== Milestones"
existing_ms="$(gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[].title')"
for wk in $WEEKS; do
  t="$(milestone_title "$wk")"
  if grep -Fxq "$t" <<<"$existing_ms"; then
    echo "Exists:  $t"
  else
    run gh api "repos/$REPO/milestones" -f title="$t" -f description="Done when: $(milestone_done "$wk")" >/dev/null
    echo "Created: $t"
  fi
done

# ---------------------------------------------------------------- issues
echo
echo "== Issues"
existing_issues="$(gh issue list --state all --limit 1000 --json title --jq '.[].title')"
created=0
skipped=0

# Format: week-label|type|title   (titles ending in "(hand-written)" get the hand-written label)
while IFS='|' read -r wk type title; do
  [[ -z "$wk" || "$wk" == \#* ]] && continue

  if grep -Fxq "$title" <<<"$existing_issues"; then
    echo "Skip:    $title"
    skipped=$((skipped + 1))
    continue
  fi

  ms="$(milestone_title "$wk")"
  labels="$wk,$type"
  note=""
  if [[ "$title" == *"(hand-written)" ]]; then
    labels="$labels,hand-written"
    note=$'\n\n> Write this one yourself first. Use Claude for review and explanation only.'
  fi
  [[ "$title" == "(Stretch)"* ]] && labels="$labels,stretch"
  [[ "$title" == *"AWS"* || "$title" == *"CDK"* ]] && labels="$labels,aws"

  body="Part of **$ms**.

**Milestone done when:** $(milestone_done "$wk")

### Acceptance criteria
- [ ] _Add before starting_$note"

  run gh issue create --title "$title" --body "$body" --label "$labels" --milestone "$ms" </dev/null >/dev/null
  echo "Created: $title"
  created=$((created + 1))
  [[ "$DRY_RUN" == "1" ]] || sleep 1   # stay well under GitHub's secondary rate limits
done <<'EOF'
# Week 1 — Foundations
week-1|chore|Set up pnpm monorepo with the Phase 1 layout
week-1|chore|Add docker-compose with Postgres (pgvector), Redis and Temporal dev server
week-1|chore|Configure shared tsconfig, ESLint, Prettier and Vitest
week-1|feat|Set up Drizzle ORM with a first companies migration
week-1|chore|Add GitHub Actions CI: lint, typecheck, test
week-1|docs|Write ADR-001: monorepo and tooling
week-1|chore|Register for a Companies House API key

# Week 2 — Ingestion, queues, rate limiting
week-2|feat|Companies House client with typed responses (hand-written)
week-2|feat|BullMQ ingest queue: search by SIC code, idempotent upsert
week-2|feat|Redis token-bucket rate limiter shared by all workers (hand-written)
week-2|feat|Redis response cache with TTL keyed by request
week-2|chore|Add a queue dashboard (Bull Board)

# Weeks 3–4 — Waterfall enrichment
week-3-4|feat|EnrichmentProvider interface returning partial profile plus cost
week-3-4|feat|Provider: Companies House officers
week-3-4|feat|Provider: website scraper with Playwright, robots.txt and timeouts
week-3-4|feat|Providers: Hunter and Apollo free tiers
week-3-4|feat|Provider: mock provider for tests and demos
week-3-4|feat|Waterfall runner with per-field provenance
week-3-4|feat|Cost ledger for every paid lookup
week-3-4|feat|Dead-letter queue and retry with backoff
week-3-4|docs|Write ADR-002: waterfall ordering and caching policy

# Weeks 5–6 — Durable research agent
week-5-6|feat|Temporal worker and researchAccount workflow (hand-written)
week-5-6|feat|Research activities: fetch page, read filings, summarise, score fit
week-5-6|feat|Claude tool-use loop producing a structured account brief (hand-written)
week-5-6|feat|Prompt caching for system prompt and tool definitions
week-5-6|feat|Human approval step via Temporal signal
week-5-6|test|Prove the workflow resumes after its worker is killed
week-5-6|docs|Write ADR-003: Temporal vs Inngest
week-5-6|chore|(Stretch) Deploy the API and RDS to AWS with a first CDK stack

# Week 7 — RAG personalisation
week-7|feat|Generate a synthetic email corpus with reply outcomes
week-7|feat|Embed the corpus in pgvector with similarity search
week-7|feat|Draft emails from the account brief plus retrieved examples
week-7|feat|Use LangChain for the retrieval step

# Week 8 — Execution and deliverability
week-8|feat|Send email via Nylas sandbox or Gmail OAuth (own inboxes only)
week-8|feat|Throttling, send windows and per-mailbox daily caps
week-8|feat|Bounce and reply webhooks update prospect status
week-8|docs|README note on SPF, DKIM and DMARC

# Week 9 — CRM sync
week-9|chore|Create HubSpot developer test account and OAuth app
week-9|feat|Push companies, contacts and email activity to HubSpot
week-9|feat|HubSpot webhooks into Postgres with conflict handling
week-9|feat|(Stretch) Redpanda event stream for domain events

# Week 10 — Dashboard and observability
week-10|feat|React dashboard: prospects, workflow status, draft approval
week-10|feat|Structured logging with correlation IDs across services
week-10|feat|LLM evals: Claude-as-judge scoring of draft quality

# Weeks 11–12 — AWS deployment and packaging
week-11-12|chore|AWS account setup: billing alarm, MFA, IAM Identity Center user, CDK bootstrap
week-11-12|chore|CDK stack: VPC, ECS Fargate for API and worker, RDS Postgres with pgvector, ElastiCache
week-11-12|chore|Temporal Cloud namespace with the Temporal worker on ECS (AWS)
week-11-12|chore|Secrets Manager for API keys and CloudWatch log groups (AWS)
week-11-12|chore|Host the React dashboard on S3 + CloudFront (AWS)
week-11-12|chore|GitHub Actions deploy to AWS via OIDC, no long-lived keys
week-11-12|docs|Write ADR-004: AWS service choices, including SQS vs BullMQ
week-11-12|docs|README: problem, architecture diagram, how to run, trade-offs
week-11-12|docs|Complete the ADR log
week-11-12|docs|Record a 3-minute demo video on the AWS deployment
week-11-12|chore|Tear down the AWS stack with cdk destroy after recording
week-11-12|chore|Mock interview on each phase with Claude
EOF

echo
echo "Done: $created created, $skipped skipped."
