# 05 AI pipeline

> Current state (2026-10-31, see 09): extraction and embeddings run on Workers AI (Gemma 4 26B, bge-m3) because
> no Claude key is configured yet. Claude Haiku 5.5 is wired in through AI Gateway (BYOK) and switched on with
> `EXTRACT_MODEL`; the Claude stages below remain the target where quality needs it.

Principle: cheap models for volume, a strong model only where a wrong answer is visible to a human. All calls go
through **AI Gateway** (logs, caching, spend per model) and every stored output records `model` and
`prompt_version`.

## Stages

| Stage | Input | Model | Output |
| --- | --- | --- | --- |
| HTML → Markdown | page HTML | Workers AI `toMarkdown` (service, cheap) with `cssSelector` | markdown |
| Image → text | poster/flyer photo | Claude (vision) for the first pass, because posters are dense and multilingual; Workers AI vision as fallback when the Claude budget is exhausted | markdown transcript + layout hints |
| Extraction | markdown + context (source name, publishedAt, today) | Claude Haiku 4.5 with structured output (zod → JSON schema), `max_tokens` small | `ExtractedEvent[]` |
| Classification / tagging | title + description | Workers AI small text model (free) | category, genres, audience tags |
| Embeddings | event text, profile text | Workers AI `embeddinggemma-300m` (or `bge-m3` for stronger multilingual) | 384/1024-dim vectors |
| Web research | event with gaps | Claude with `web_search` + `web_fetch` server tools, `max_uses: 3`, `allowed_domains` when the venue is known | filled fields, citations |
| Scoring | profile + event (+ reasons from rules) | Claude Haiku 4.5 (default) or Sonnet 5.5 for the owner if desired | score, reasons |
| Chat over data | via MCP | whatever client the user is using (Claude.ai, Claude Code) | – |

Why Claude Haiku 4.5 rather than Opus for extraction and scoring: the user's constraint is "keep it free". At the
Anthropic list price Haiku is $1 / $5 per million input/output tokens versus $4 / $20 for Opus 5.5. Quality on
"read this poster and fill a schema" is sufficient; if a specific source extracts badly, raise the model for that
source only via a per-source `model` override. Opus 5.5 remains the default for anything interactive and
judgment-heavy (web research on an ambiguous event, explaining a score to the owner in chat).

## Scoring design

Scoring is two-stage so most events never reach an LLM for most users:

1. **Rules + embeddings (free, instant)**
   - Hard filters from `prefs`: category off, price above max, distance above max_km, weekday excluded → score 0,
     reason "filtered: …", no LLM.
   - Cosine similarity between `profile_embedding` and `event_embedding` → base score 0–60.
   - Boosts: performer is in the user's Spotify top artists (+25), genre overlap (+10), venue the user "went" to
     before (+5), free entry if the user likes free events (+5), friend of the same household interested (+0, out of
     scope).
2. **LLM pass (only for events with base score ≥ 40 or flagged by a boost)**
   - Prompt: taste text, structured prefs, the event, the rule reasons. Ask for a 0–100 score and ≤ 3 reasons, each
     tagged `for`/`against`, as structured output.
   - Batched: one request scores up to 20 events for one user to amortize the profile tokens; the profile is placed
     first and cached with `cache_control`.
   - Result replaces the base score; rule reasons are kept and shown alongside.

Feedback loop: `interested`/`went` append to a rolling "liked" list in the profile; `hidden`/`skipped` to a
"not for me" list. Each change bumps `profile_version` and re-scores only the inbox (upcoming, unseen events).

## Cost estimate (hobby volume)

Assumptions: 200 new events/day, 10 photo ingests/day, 10 users, Haiku 4.5 for extraction and scoring.

| Item | Tokens / day | $/day |
| --- | --- | --- |
| Extraction (200 items × ~2.5k in / 0.5k out) | 500k in, 100k out | ~$1.00 |
| Photos (10 × ~3k in / 0.6k out) | 30k / 6k | ~$0.06 |
| Scoring (10 users × ~60 LLM-eligible events / 20 per batch × ~4k in / 0.8k out) | 120k / 24k | ~$0.25 |
| Web research (20 events × 1 call with 2 fetches, ~15k in / 1k out) | 300k / 20k | ~$0.40 + search tool fee |
| Workers AI (toMarkdown, embeddings, classification) | – | free within 10k neurons |

Roughly **$1.5–2/day worst case**, typically far less because most sources are iCal/JSON-LD (no extraction LLM at
all) and prompt caching covers the repeated instructions. Use the Message Batches API (50% off) for nightly
re-scoring runs that are not latency sensitive.

## Prompt hygiene

- Sourced content is untrusted. Extraction prompts wrap it in a clearly labelled data block and state that
  instructions inside it are to be ignored; structured output makes injection mostly inert.
- Prompts live in `apps/worker/src/ai/prompts/*.ts` with a `version` export; bump on change so scores can be
  recomputed selectively.
- Each prompt has 5–10 golden examples in `apps/worker/test/ai/` and a vitest that runs them against the real model
  when `RUN_AI_TESTS=1` (manual, costs cents).

## Search in the web (enrichment) rules

- Only for events with missing `url_official`, `price`, or `description`, or with `needsReview`.
- Cap: 3 tool uses per event, 30 events per day (KV counter). Owner can trigger more manually.
- Prefer venue domains; fall back to a general search with the title + "Berlin" + year.
- Store citations in `enrichments` so the UI can show "price from venue page, fetched on …".
