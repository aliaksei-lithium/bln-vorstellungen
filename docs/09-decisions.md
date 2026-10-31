# 09 Decisions

Format: date · decision · why · alternatives rejected. Newer entries supersede older ones on the same topic.

- **2026-10-02 · TypeScript, not Kotlin, for the backend.** Cloudflare's runtime and every binding/SDK we need are
  JS-first; Kotlin would run only via Wasm or Kotlin/JS with hand-written shims and no tooling. Rejected: Kotlin/Wasm
  on Workers; Ktor on a VPS (breaks "Cloudflare, free"). Kotlin stays an option for a future KMP mobile client.
- **2026-10-02 · One Worker for API, static site, MCP, cron, email.** Simplest deploy and cheapest. Rejected:
  separate Pages project + API Worker (Pages is in maintenance mode in favour of Workers static assets); separate
  MCP Worker (can be split later behind the OAuth provider's split API if needed).
- **2026-10-02 · Workflows instead of Queues.** Queues require Workers Paid; Workflows are free and give retries and
  step state. Rejected: DO alarms as a job queue (works but reinvents retries).
- **2026-10-02 · No Vectorize.** Paid-plan only. Embeddings stored in D1, cosine computed over the upcoming-events
  candidate set. Revisit if upcoming events exceed ~10k.
- **2026-10-02 · D1 over DO-SQLite as the main store.** D1 gives one shared relational DB with migrations, FTS5 and
  the dashboard; DO SQLite is per-object. DO still used for MCP sessions and locks.
- **2026-10-02 · HTML parsing happens off-Worker.** The 10 ms CPU cap on the free plan makes DOM parsing of large
  pages risky. Use `env.AI.toMarkdown` with `cssSelector`, Browser Rendering `/markdown`, or JSON-LD. Rejected:
  cheerio/linkedom in-Worker (fine for small pages; allowed only behind a size guard).
- **2026-10-02 · Event vs. occurrence model.** Theatre and opera are the core use case; one production has many
  Vorstellungen. Rejected: one row per date (duplicates in lists and scoring).
- **2026-10-02 · better-auth for web and MCP auth.** One system, social login, D1 adapter, `mcp` plugin for OAuth
  and `apiKey` plugin for tokens. Alternative kept open: `@cloudflare/workers-oauth-provider` v1 for MCP if the
  better-auth plugin proves unreliable on Workers.
- **2026-10-02 · Claude Haiku 4.5 as the default extraction/scoring model; Opus 5.5 for interactive, judgment-heavy
  calls.** Driven by the "keep it free" constraint; per-source model override allowed.
- **2026-10-02 · Facebook has no automated adapter.** No public events API, scraping violates ToS and breaks
  constantly. Manual photo/text input only.
- **2026-10-02 · Telegram via `t.me/s/<channel>` HTML preview.** No bot or API credentials; works for public
  channels. Rejected: MTProto client (needs a phone session; not free-tier friendly on Workers).
- **2026-10-30 · Design direction D ("strict cards", Moss accent, TV-tower background).** Chosen by the owner
  over A–C after a clickable mockup (`design/mockup-d`, deployed as the separate Worker
  `bln-vorstellungen-mockup`). Square 1px ink frames, Figtree, see-through rows over the tower; shadcn tokens are
  mapped onto D's palette in `apps/web/src/index.css`.
- **2026-10-30 · Phase 0 tooling, verified while scaffolding.** `@cloudflare/vitest-pool-workers` is deprecated and
  renamed to `@cloudflare/vitest-plugin` (Vitest 4; `env`/`exports` now come from `cloudflare:workers`); CLAUDE.md's
  mention means this package. TypeScript pinned to 6.0 because typescript-eslint does not support 7 yet. Node 25 no
  longer ships corepack, so pnpm is installed globally. better-auth core tables are created up front with plural
  names (`users`, `sessions`, `accounts`, `verifications`); configure better-auth with `usePlural: true` in phase 2.
  FTS5 (`events_fts`) is maintained by the resolve step, not by triggers, because it needs venue and performer names.
- **2026-10-31 · Resolve matches on title + venue, not on the first date.** docs/04's `dedup_key` includes the
  first date, which would split a production whose 12 Vorstellungen arrive as 12 feed items (Gorki publishes it
  that way). The key keeps the docs/04 format, but resolve looks up its `title|venue|` prefix and merges into the
  most recent such event if its last date is at most 90 days ago. A band returning to the same club after a
  longer gap becomes a new event. The 0.6–0.9 similarity review (`possible_duplicate`) is deferred to phase 3,
  where LLM-extracted titles make it worth it.
- **2026-10-31 · Public list pages through `events.next_start_*`.** Scanning occurrences cost up to 2,400 rows
  per page (measured, 120 events × 6 dates). `events` now carries `next_start_utc`, `next_start_local` and
  `upcoming_count`, refreshed by resolve and by a sweep in the 15-min cron (only events whose next date passed).
  "All upcoming" pages through `events_next_idx` with a cursor; date windows (today/weekend/week) still scan
  occurrences, with the index forced (`INDEXED BY` + `CROSS JOIN`) because the planner otherwise starts from all
  events. Measured rows read per page: 82 default, 80 category, 160 district, 120 search, 164 week window
  (`test/list-budget.test.ts` fails above 500). Rejected: a plain `GROUP BY event` over occurrences.
- **2026-10-31 · Workers Caching instead of the Cache API.** The Cache API does nothing on `workers.dev`. Workers
  Caching (`cache.enabled` in wrangler.jsonc) caches by `Cache-Control`, also on `workers.dev`, keyed by Worker
  version. Public event responses: `public, max-age=60, s-maxage=120` + `Cache-Tag: events`; every other `/api`
  response defaults to `no-store` (otherwise heuristic caching would apply). Trade-off: with caching on, static
  asset requests count as Worker requests (fine against 100k/day at hobby volume). A purge after each source run
  needs a call from the fetch entrypoint (purges are per entrypoint); not worth it at a 2-min TTL.
- **2026-10-31 · Admin API gated by `Authorization: Bearer <ADMIN_TOKEN>`** until owner sign-in (phase 2). The
  `Authorization` header also makes Workers Caching bypass, so admin responses are never cached.
- **2026-10-31 · Structured adapters, no LLM.** `ical` (minimal RRULE: DAILY/WEEKLY with COUNT/UNTIL/BYDAY/EXDATE
  on wall-clock time; DTSTAMP/SEQUENCE dropped before hashing so unchanged events stay unchanged) and `jsonld`
  (indexOf scan for blocks, so 1 MB pages stay cheap; tolerant of sloppy offsets like `+1:00` and of raw line
  breaks in JSON). Both send `If-None-Match`/`If-Modified-Since` from the cursor. Category: item type → title
  keywords → source default → description keywords → `other`. `rss` stores entries as `pending` raw items for
  LLM extraction in phase 3. Closing-day placeholders ("HEUTE GESCHLOSSEN") are skipped.
- **2026-10-31 · Starter sources (`apps/worker/seed/sources.sql`).** Verified on this date: The Left Berlin
  (iCal), Luma Berlin discover feed (iCal), Maxim Gorki Theater, A-Trane, Privatclub, Bar jeder Vernunft
  (JSON-LD). Checked and not usable without the `html` adapter: berlin-buehnen.de (403), Berliner Ensemble,
  Staatsoper, Deutsches Theater, Volksbühne, Konzerthaus, SO36, Berghain, Lido, Astra and others (no feed, no
  JSON-LD). Komische Oper links one `.ics` per performance; a `sitemap`-style adapter could follow those.
- **2026-10-31 · Workflow step budget.** Workers Free allows 3,000 Workflow steps per day and 1,024 per instance.
  A SourceRun is start + fetch + one step per 8 new items + finish; unchanged feeds cost 3 steps (most answer
  304). Six sources at 6–12 h intervals use well under 100 steps a day after the first import (~50 steps).
- **2026-10-31 · Extraction runs on Workers AI until a Claude key exists.** docs/05 names Claude Haiku 4.5 for
  extraction; there is no Anthropic key yet, and Workers AI is free within 10k neurons a day. Model:
  `@cf/google/gemma-4-26b-a4b-it` with thinking off (`chat_template_kwargs.enable_thinking=false`: 2 s and
  3 neurons instead of 16 s and 18 on the same answer). Output via `json_object` mode with the schema in the
  prompt: strict `json_schema` mode looped on whitespace until max_tokens in 2 of 12 golden runs and tripled
  output tokens. Requiring every schema field made the model invent end times and doors, so only essentials are
  required and `extract.ts` backfills doors, single prices and free entry from the quoted text. Costs measured
  on real pages: ~65–200 neurons per 16k-character chunk, ~60 s. Spend is metered in `usage_counters` and capped
  at 8,000 neurons/day (`DAILY_NEURON_BUDGET`); items left over stay `pending` for the next run. All calls go
  through the auto-created `default` AI Gateway. Swapping in Claude later = a second provider in `ai/models.ts`.
- **2026-10-31 · Golden examples run through the dev server, not Vitest.** The Worker tests have no remote
  bindings, so `pnpm --filter @bln/worker golden` (with `RUN_AI_TESTS=1`) posts `test/ai/extract.golden.json` to
  the admin dry-run endpoint and checks titles, categories, date counts, doors and prices. ~80 neurons per run.
- **2026-10-31 · Embeddings: bge-m3, int8, one KV index.** `@cf/baai/bge-m3` (multilingual, ~0.01 neurons per
  event). Vectors are L2-normalized and quantized to int8 (1 KB per event) in `event_embeddings`; the cron embeds
  new upcoming events and packs all upcoming vectors into one KV value, rebuilt when stale or every 6 h. "More
  like this" and search by meaning scan it in memory: zero D1 rows, one KV read per isolate per 10 min. Floors
  checked by hand: related events score 0.45–0.6, unrelated below 0.4. Revisit (Vectorize on a paid plan, or
  per-category shards) past ~5k upcoming events.
- **2026-10-31 · `html` adapter = Markdown chunks.** Page → `env.AI.toMarkdown` (optional `cssSelector`) →
  images and empty links stripped → chunks of 16k characters at paragraph boundaries, at most `maxChunks` per
  page. With a single-venue source the venue comes from the config; the model's venue (often the room) becomes
  the date's note. Starter html sources: Berliner Ensemble, Deutsches Theater, Staatsoper (daily).
- **2026-10-31 · Claude goes through AI Gateway with a stored key (BYOK), not a Worker secret.** The same `env.AI`
  binding calls `anthropic/claude-haiku-5.5` in Anthropic Messages format; AI Gateway takes the Anthropic key
  stored under Provider Keys with alias `default`, so the Worker never holds it, and adds logs, cost analytics,
  caching, retries and dollar spend limits for free. Without a stored key the gateway answers "Insufficient AI
  Gateway credits" (verified), so extraction falls back to Workers AI per item. Opt-in via `EXTRACT_MODEL` in
  wrangler.jsonc vars; our own cap `CLAUDE_DAILY_USD` (default $0.50) is metered in `usage_counters`. Haiku 5.5
  ($0.10/$0.50 per M tokens, cheaper than the Haiku 4.5 docs/05 planned for) uses structured outputs
  (`output_config.format`, closed schema), effort `low`, thinking off, cacheable system prompt. Rejected: a
  `ANTHROPIC_API_KEY` Worker secret calling api.anthropic.com directly (no gateway logs/limits, key in the Worker).
- **2026-10-02 · React + Vite + TanStack + Tailwind + shadcn/ui.** Best coverage by design tools and implementing
  models. Rejected: SvelteKit (good, but weaker design-tool output), Next.js on Workers via OpenNext (heavier than
  needed; no SSR requirement since public pages can be cached JSON + client render; revisit if SEO matters).
