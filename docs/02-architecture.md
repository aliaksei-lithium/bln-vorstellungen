# 02 Architecture

## Decision summary

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) | First-class on Workers; every Cloudflare binding, the Agents SDK, the MCP SDK and the OAuth provider are TS-first. See "The Kotlin question". |
| HTTP framework | Hono | Tiny, Workers-native, typed routes, middleware for auth, works with better-auth and the MCP handler. |
| Frontend | React 19 + Vite + TanStack Router + TanStack Query + Tailwind v4 + shadcn/ui | Best-supported stack for AI design tools and implementing models; shadcn gives clean, accessible primitives without a heavy design system. |
| Deployment shape | **One Worker** serving API + static assets + MCP + cron + email | Simplest to deploy and reason about, cheapest on the free plan, one `wrangler deploy`. Split later only if needed. |
| Database | D1 (SQLite) via Drizzle ORM | Free, relational, FTS5 for text search, migrations via Drizzle Kit. |
| Files | R2 | Uploaded photos and cached source snapshots. 10 GB free. |
| Cache / small state | KV | Geocoding cache, source ETags, rate-limit counters. |
| Background jobs | Workflows | Durable, retryable, step-based; free. Replaces Queues (paid). |
| Scheduling | 1 cron trigger (every 15 min) that dispatches due sources into Workflows | Free plan allows 5 cron triggers per account; one dispatcher is enough. |
| Realtime/agent state | Durable Objects (SQLite-backed) | Free. Used by the MCP agent session and for per-source locks. |
| Inbound email | Email Routing → Worker `email()` handler | Free. Newsletters become a source. |
| Headless browser | Browser Rendering | 10 min/day free. Only for sources that need JS rendering; budgeted per source. |
| AI, bulk | Workers AI | 10k neurons/day free: embeddings, cheap classification, image description, `toMarkdown`. |
| AI, quality | Claude via AI Gateway | Extraction from photos and messy pages, final scoring with explanation. Paid per token, cents per day at this volume. |
| Auth | better-auth (D1 adapter) with Google + GitHub sign-in; its `mcp` plugin for MCP OAuth; API keys for scripts | Single auth system for web and MCP; no password storage. |
| Observability | Workers Logs + a tiny `/admin/usage` page reading D1 meta + AI Gateway analytics | Enough for a hobby project; no paid APM. |

## Request and job flow

```
                 ┌──────────────────────────── Cloudflare Worker (apps/worker) ────────────────────────────┐
browser ──HTTPS──▶ Hono router                                                                             │
                 │  /            static assets (apps/web build)                                            │
                 │  /api/*       JSON API (public + authed)                                                │
                 │  /api/auth/*  better-auth                                                               │
                 │  /mcp         MCP server (streamable HTTP), OAuth-protected ── Durable Object (session) │
                 │  /admin/*     owner-only                                                                │
cron ────────────▶ scheduled()  → find due sources → create Workflow instance per source                  │
email ───────────▶ email()      → store raw MIME in R2 → create raw_item → create Workflow (extract)       │
                 │                                                                                         │
                 │  Workflows: SourceRun(sourceId) | ExtractItem(rawItemId) | EnrichEvent(eventId)         │
                 │             | ScoreEvents(userId, eventIds[]) | PhotoIngest(uploadId)                   │
                 │                                                                                         │
                 │  Bindings: D1, R2, KV, AI, BROWSER, WORKFLOWS, DO, EMAIL, AI_GATEWAY                   │
                 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

Why Workflows for everything asynchronous: each step is retried independently, state survives Worker restarts, and
the 10 ms CPU limit applies per step rather than per whole job. A source run that fetches a page, converts it,
calls an LLM and writes 40 events is five or six steps, each mostly waiting on the network.

## Free-tier budget (Workers Free, verified against Cloudflare docs, Oct 2026)

| Product | Free allowance | How we stay inside |
| --- | --- | --- |
| Workers requests | 100,000 / day | Public site + API + cron + workflow steps all count. Hobby traffic is far below. Cache public list responses in KV/Cache API. |
| Workers CPU | **10 ms per invocation** | Hard constraint. No DOM parsing of large HTML in-Worker. Use `env.AI.toMarkdown()` (HTML→Markdown off-Worker), Browser Rendering `/markdown`, or the source's own API. Keep JSON payloads small, avoid heavy regex over big strings. |
| Cron triggers | 5 per account | Use 1. |
| D1 | 5 M rows read / day, 100 k rows written / day, 5 GB | Index everything queried; paginate; batch writes. Since Sept 2026 D1 **fails** queries above the daily limit, so the usage page must show today's counters. Scoring writes one row per (user,event); 20 users × 200 new events/day = 4 k rows. Fine. |
| KV | 100 k reads, 1 k writes / day | Writes are the scarce side: use KV for caches that change rarely (geocoding, ETags). Do not use KV as a queue or counter. |
| R2 | 10 GB, 1 M class A ops / month | Photos and snapshots only. |
| Workflows | 100 k executions / day (shared with requests), 1,024 steps per instance, 100 concurrent, 3-day retention | One instance per source run / per item. Keep steps coarse. |
| Durable Objects | Free, SQLite-backed | MCP sessions, source locks. |
| Workers AI | 10,000 neurons / day | Embeddings (~1 neuron per few texts) and small-model classification. Some large models are paid-only; stick to the free catalogue (`glm-4.7-flash`, `gemma-4-26b-a4b-it`, `embeddinggemma-300m`, `bge-m3`, the `toMarkdown` service). |
| Browser Rendering | 10 min / day, 3 concurrent | Only for sources flagged `needsBrowser`. Budget ~20 s per run → ~30 runs/day. |
| Email Routing | Free (inbound) | Email **sending** needs Workers Paid; for digests use the user's own SMTP via Resend free tier or skip until paid. |
| Vectorize | **Paid plan only** | Not used. Semantic search is done with embeddings stored in D1 and cosine similarity computed over a candidate set (≤ 2,000 upcoming events × 384 dims is a few ms). |
| Queues | **Paid plan only** | Not used; Workflows instead. |
| AI Gateway | Free | Put Claude calls through it for logs, caching and cost tracking. |

Expected paid cost: Claude API usage only. See [05 AI pipeline](05-ai-pipeline.md) for the estimate (order of
€1–3/month at 200 new events/day with photo ingests).

## The Kotlin question

Short answer: **not for the backend on Cloudflare**. Longer answer:

- Workers run V8 isolates. Supported languages are JavaScript/TypeScript, Python (beta) and Rust, plus anything
  compiled to WebAssembly. Cloudflare's own docs list Kotlin only as "compiles to Wasm".
- Kotlin/Wasm targets browsers and WASI; there is no Cloudflare bindings layer for it. D1, R2, KV, Workflows,
  Durable Objects, Workers AI, Browser Rendering, Email handlers, the Agents SDK, the MCP server SDK and the Workers
  OAuth Provider all expose JS APIs only. You would write a JS shim per binding and lose typed access.
- Kotlin/JS could in principle target the Workers runtime, but there is no community template, no Wrangler
  integration, and every library above would be used through `dynamic`. Debugging and the 1 s startup limit make
  this a research project, not a hobby backend.
- The 10 ms CPU limit on the free plan punishes large bundles; Kotlin/JS or Kotlin/Wasm runtime overhead eats into
  it.

If Kotlin matters to you, the places where it fits without fighting the platform are: a future Kotlin Multiplatform
mobile client talking to the same API, or an optional local CLI/ingest tool. The plan keeps the API boring JSON so
either is possible later.

## Monorepo layout

```
bln-vorstellungen/
  apps/
    worker/            Hono app, wrangler.jsonc, Workflows, DO classes, Drizzle schema + migrations
    web/               Vite React SPA, built into apps/worker/public (static assets binding)
  packages/
    shared/            zod schemas (Event, Occurrence, Venue, Performer, Source config, MCP tool inputs), utils
    sources/           adapters: rss.ts, ical.ts, html.ts, browser.ts, telegram.ts, email.ts, ra.ts, ... + registry
  docs/
  package.json         pnpm workspaces, turbo optional
```

Local dev: `wrangler dev` with local D1/R2/KV emulation, `vite dev` proxied to it. Deploy: GitHub → Workers Builds
(free CI on Cloudflare) or `wrangler deploy` from a GitHub Action.

## Security notes

- Public endpoints are read-only and cached. Writes require a session or an API key.
- Owner role is a column on `users`; the first user created becomes owner.
- Uploaded images are served through the Worker with auth, not from a public R2 bucket.
- LLM prompts treat all sourced content as untrusted data: extraction prompts are instructed to ignore instructions
  found in the content, and outputs are validated with zod before touching the DB.
- Rate-limit the photo upload and web research endpoints per user (KV counter is fine at 1 k writes/day if keyed
  per user per hour; or use a DO).
