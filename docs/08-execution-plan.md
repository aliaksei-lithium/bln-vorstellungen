# 08 Execution plan

Written for the model that implements this. Each phase ends with something deployed and usable. Do not start a
phase before the previous one is deployed and its checklist is green.

## Phase 0 – Skeleton (deployable "hello")

- pnpm workspace, TypeScript strict, ESLint + Prettier, Vitest.
- `apps/worker`: Hono app, `wrangler.jsonc` with bindings: D1 `DB`, R2 `MEDIA`, KV `CACHE`, AI `AI`, Workflows
  (`SOURCE_RUN`, `EXTRACT_ITEM`, `ENRICH_EVENT`, `SCORE_EVENTS`, `PHOTO_INGEST`), DO `MCP_AGENT`, static assets from
  `apps/web/dist`, cron `*/15 * * * *`.
- `apps/web`: Vite React, TanStack Router, Tailwind, shadcn/ui initialised, dark mode, one page.
- `packages/shared`: zod schemas for `Event`, `Occurrence`, `Venue`, `Performer`, `ExtractedEvent`, `SourceConfig`.
- Drizzle schema + first migration for all tables in [04](04-data-model.md). FTS5 table via raw SQL migration.
- GitHub → Workers Builds deploy on push to `main`. `.dev.vars.example`.
- Checklist: `wrangler deploy` works; `/api/health` returns DB ping; web page renders; CI green.

## Phase 1 – Public list from structured sources

- Adapters: `ical`, `rss`, `jsonld`. Registry + `SourceAdapter` interface. Unit tests with fixture files.
- `SourceRun` Workflow, cron dispatcher, `sources` admin API (owner only; owner = first user, auth comes in phase 2,
  so temporarily gate admin with a shared secret header).
- Resolve step: venues (exact + alias match), dedup by `dedup_key`, occurrences upsert.
- Public API: `GET /api/events?from&to&category&district&q`, `GET /api/events/:slug`. Cached 5 min via Cache API.
- Web: public list + detail + filters. Mobile layout.
- Seed 5–10 iCal/JSON-LD sources (Berlin Bühnen houses, theleftberlin, a Luma calendar).
- Checklist: events appear within 15 min of adding a source; re-running a source creates zero duplicates; row
  reads per list request < 500.

## Phase 2 – Auth, profiles, scoring

- better-auth with D1 adapter, Google + GitHub providers, session cookie. Owner flag.
- Profile page and API. `profile_embedding` computed with Workers AI on save.
- `ScoreEvents` Workflow: rules + embeddings stage, then Claude Haiku 4.5 batch stage with structured output and
  prompt caching. Triggered after each `SourceRun` for all users, and after profile change for one user.
- Inbox, Agenda, mark/rate endpoints, keyboard shortcuts, swipe on mobile.
- iCal export per user (`/api/me/agenda.ics`, token in URL).
- Checklist: new event → scored for all users within one cron cycle; score reasons visible; a hidden event never
  returns to the inbox.

## Phase 3 – LLM extraction sources and manual input

- Adapters: `html` (toMarkdown + extraction), `telegram`, `text`, `photo`. `ExtractItem` Workflow with the
  extraction prompt, golden tests.
- Photo upload endpoint → R2 → `PhotoIngest` Workflow (Claude vision) → review/confirm UI.
- Review queue (low confidence, possible duplicates) + admin review page.
- MCP server (`McpAgent`), read tools first, then write tools. Auth: API keys first, OAuth (better-auth `mcp`
  plugin) second. Test with Claude Code and Claude.ai custom connector.
- Checklist: a photographed poster becomes a correct event in under 2 minutes; a Telegram channel source produces
  events without duplicates across posts; MCP `list_events` works from Claude Code.

## Phase 4 – Enrichment and research

- `email` adapter via Email Routing. `browser` adapter with per-run time budget.
- `ra`, `bandsintown` adapters; Spotify import into profile.
- `EnrichEvent` Workflow: geocoding (Nominatim with KV cache, polite rate), performer linking (MusicBrainz),
  web research with Claude server tools under the caps in [05](05-ai-pipeline.md), citations stored.
- Admin usage page with D1/AI/Claude counters.
- Checklist: enrichment never exceeds daily caps; usage page matches the Cloudflare dashboard within 10%.

## Phase 5 – Polish

- Semantic search, similar events, `cmd+k` palette.
- Weekly digest (requires an email sender; Resend free tier or defer).
- Merge tool for venues/performers; alias learning from merges.
- Accessibility pass, Lighthouse ≥ 95 mobile, i18n of UI strings (en/de).

## Working agreements for the implementer

- Keep PRs per phase bullet. Every adapter gets fixture-based tests; every prompt gets golden examples.
- Measure D1 rows read/written with the `meta` object in dev and fail a test if the public list query exceeds
  budget.
- When a Cloudflare limit is unclear, check the docs (the limits changed in 2025–2026: DO free tier, Browser
  Rendering minutes, D1 enforcement, Vectorize paid-only). Record what you verified in `docs/09-decisions.md`.
- Ask the owner before adding any paid dependency or exceeding the free plan.
