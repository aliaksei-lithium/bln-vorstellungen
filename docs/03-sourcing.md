# 03 Sourcing

Sourcing must be generic enough that an odd new source (a Telegram chat, a venue's RSS, a monthly PDF programme, a
photographed poster) is one adapter file plus a config row, not a redesign.

## Pipeline

```
Source (config row) ──run──▶ RawItem[] ──extract──▶ ExtractedEvent[] ──resolve──▶ Event + Occurrence[] (+ Venue, Performer)
```

1. **Fetch** (adapter): produce raw items from the source. A raw item is "a chunk of content that might describe
   one or more events": one RSS entry, one Telegram post, one HTML page, one email, one photo. Each has a stable
   `externalId` (or content hash) so re-runs skip what was already seen.
2. **Extract** (shared, AI): turn a raw item into zero or more `ExtractedEvent` candidates with a structured
   schema and a confidence. Adapters that already return structured data (iCal, RA GraphQL) skip the LLM and map
   directly.
3. **Resolve** (shared): match candidates against existing events (dedup), venues and performers; create or update;
   record `event_sources` links so every event can show where it came from.
4. **Enrich** (shared, async): see [05 AI pipeline](05-ai-pipeline.md).

## Adapter interface

```ts
// packages/sources/src/types.ts
export interface SourceAdapter<C = unknown> {
  type: string;                       // "rss" | "ical" | "html" | "browser" | "telegram" | "email" | "ra" | ...
  configSchema: ZodType<C>;           // validated when a source is created/edited
  defaultSchedule: string;            // cron-ish, e.g. "every 6h"
  needsBrowser?: boolean;             // counts against the 10 min/day budget
  /** Fetch new content since `cursor`. Must be idempotent. */
  fetch(ctx: SourceContext, config: C, cursor: string | null): Promise<FetchResult>;
  /** Optional: structured sources map items to events without an LLM. */
  mapItem?(item: RawItem, config: C): ExtractedEvent[] | null;
}

export interface FetchResult {
  items: RawItem[];                   // new or changed items only
  cursor: string | null;              // opaque: last-modified, last post id, ETag...
  stats: { fetched: number; skipped: number };
}

export interface RawItem {
  externalId: string;                 // stable within the source
  contentHash: string;                // sha256 of normalized content
  kind: "text" | "html" | "markdown" | "image" | "ical" | "json";
  content: string;                    // text/markdown/json, or R2 key for images
  url?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}
```

`SourceContext` gives adapters `fetch`, `env.AI.toMarkdown`, the browser binding (if allowed), R2 for snapshots and
a logger. Adapters never write to D1 directly; the Workflow does, so the DB contract is in one place.

## Extraction schema (what the LLM must produce)

```ts
ExtractedEvent {
  title: string
  description?: string
  lang: "de" | "en" | "other"
  category: "concert" | "club" | "theatre" | "opera" | "dance" | "exhibition" | "talk" | "cinema" | "festival" | "market" | "other"
  genres: string[]
  occurrences: { start: string /* ISO local */, end?: string, doorsAt?: string, note?: string }[]
  venue: { name: string, address?: string } | null
  performers: { name: string, role?: string }[]
  price: { min?: number, max?: number, currency: "EUR", free?: boolean, note?: string } | null
  urls: { official?: string, tickets?: string }
  imageUrl?: string
  confidence: number        // 0..1
  needsReview: boolean
  sourceQuote: string       // the exact text the event was read from, for the review UI
}
```

Dates in sourced content are often relative or partial ("Fr. 12.10., 20 Uhr", "every Thursday in November").
The extractor is given the item's `publishedAt` and today's date, and must emit absolute dates or set
`needsReview`.

## Adapter catalogue

| Type | Mechanism | Needs | Notes |
| --- | --- | --- | --- |
| `rss` | fetch + parse RSS/Atom (small XML, fine in-Worker for typical feeds) | – | Entry = raw item. |
| `ical` | fetch `.ics`, parse VEVENTs | – | Direct map, no LLM. Many venues and theleftberlin.com publish iCal. |
| `html` | fetch page → `env.AI.toMarkdown({html, cssSelector})` → LLM extract | – | The workhorse for venue sites. Config: url, cssSelector, pagination hints. |
| `browser` | Browser Rendering `/markdown` or Puppeteer → LLM | browser budget | For JS-rendered sites. Config includes `maxSeconds`. |
| `telegram` | fetch `https://t.me/s/<channel>` HTML preview (server-rendered, paginates with `?before=`) → toMarkdown → LLM | – | No bot or API key needed for public channels. Posts with photos: download image → vision path. |
| `email` | Email Routing → `email()` handler → parse MIME (postal-mime) → raw item | a routed address like `events@yourdomain` | Subscribe venue newsletters with that address. Attachments/images go to R2. |
| `photo` | user upload or MCP → R2 → vision extraction | – | Manual source, one raw item per upload. |
| `text` | pasted text / URL from UI or MCP | – | Manual. URL variant delegates to `html`. |
| `ra` | Resident Advisor GraphQL (`ra.co/graphql`, area 34 = Berlin) | – | Structured; direct map. Unofficial, may need UA header; keep polite rate. |
| `eventbrite` | public search endpoints / organizer feeds | – | Structured. |
| `bandsintown` | public artist events API | app id (free) | Use per-user followed artists → "your artists in Berlin". |
| `songkick` | metro area events, if API access is granted | key | Optional. |
| `jsonld` | fetch page, read `<script type="application/ld+json">` `Event` objects | – | Many ticket pages expose schema.org Event; cheap and exact. Try before `html`. |
| `sitemap` | discover event pages from sitemap, then `jsonld`/`html` per page | – | For large venue sites. |
| `spotify` | **not an event source**: imports the user's top artists/genres into the taste profile | user OAuth | Combined with `bandsintown`/`ra` lineups for matching. |
| `facebook` | **no automated adapter.** Facebook blocks scraping and has no public events API. | – | Manual: screenshot → `photo`, or paste → `text`. Document this limitation in the UI. |

## Berlin source starter list

Theatre / opera / classical (the "Vorstellungen"):
- berlin-buehnen.de Spielplan (aggregates ~100 stages; check for iCal/JSON per event page; else `html`/`jsonld`)
- Berliner Ensemble, Deutsches Theater, Schaubühne, Volksbühne, Maxim Gorki, HAU, Sophiensæle, Radialsystem
- Staatsoper, Deutsche Oper, Komische Oper, Berliner Philharmonie, Konzerthaus, Pierre Boulez Saal
- Berlin Bühnen and the houses often publish iCal or JSON-LD; prefer those.

Music / clubs:
- Resident Advisor (area 34), Berghain/Panorama Bar programme, Gretchen, Lido, SO36, Kantine am Berghain, Silent
  Green, Haus der Berliner Festspiele (Jazzfest), A-Trane, b-flat, Zig Zag
- Bandsintown / Songkick for followed artists

Listings / magazines:
- Rausgegangen (rausgegangen.de, Berlin section), tip Berlin, Exberliner, Gratis in Berlin, berlin.de/events,
  visitBerlin event calendar, theleftberlin.com (RSS + iCal), Museumsportal Berlin (exhibitions)

Community:
- Public Telegram channels (expat event channels, venue channels), newsletters (via `email` adapter), Luma Berlin
  calendars (lu.ma exposes iCal per calendar), Meetup (iCal per group)

Each goes into the `sources` table with its adapter config; nothing is hardcoded.

## Scheduling

A single cron trigger (`*/15 * * * *`) runs `scheduled()`, which selects sources where `next_run_at <= now` and
`enabled`, acquires a per-source lock (DO or a conditional D1 update), and starts a `SourceRun` Workflow per source.
Default intervals: iCal/RSS 6 h, html 12–24 h, telegram 2 h, ra daily, browser daily. Manual "run now" from the
admin page or MCP starts the same Workflow.

`SourceRun` steps: `fetch` → `storeRawItems` (dedup by hash) → for each new item `extract` (fan-out to
`ExtractItem` Workflows, bounded concurrency) → `finalize` (update cursor, counts, next_run_at, error).
