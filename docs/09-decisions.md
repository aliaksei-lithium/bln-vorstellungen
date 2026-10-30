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
- **2026-10-02 · React + Vite + TanStack + Tailwind + shadcn/ui.** Best coverage by design tools and implementing
  models. Rejected: SvelteKit (good, but weaker design-tool output), Next.js on Workers via OpenNext (heavier than
  needed; no SSR requirement since public pages can be cached JSON + client render; revisit if SEO matters).
