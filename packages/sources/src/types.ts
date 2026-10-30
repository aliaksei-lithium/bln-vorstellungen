import type { ExtractedEvent } from '@bln/shared';
import type { ZodType } from 'zod';

/** Contract from docs/03. A new source type is one module implementing this, plus its config schema. */
export interface SourceAdapter<C = unknown> {
  /** "rss" | "ical" | "jsonld" | "html" | "browser" | "telegram" | "email" | "ra" | ... */
  type: string;
  /** Validated when a source is created or edited. */
  configSchema: ZodType<C>;
  /** Default interval for new sources of this type. */
  defaultScheduleMinutes: number;
  /** Counts against the Browser Rendering budget (10 min/day). */
  needsBrowser?: boolean;
  /** Fetch new content since `cursor`. Must be idempotent. */
  fetch(ctx: SourceContext, config: C, cursor: string | null): Promise<FetchResult>;
  /** Structured sources map items to events without an LLM. */
  mapItem?(item: RawItem, config: C): ExtractedEvent[] | null;
}

export interface FetchResult {
  /** New or changed items only. */
  items: RawItem[];
  /** Opaque: last-modified, last post id, ETag... */
  cursor: string | null;
  stats: { fetched: number; skipped: number };
}

export interface RawItem {
  /** Stable within the source. */
  externalId: string;
  /** sha256 of normalized content. */
  contentHash: string;
  kind: 'text' | 'html' | 'markdown' | 'image' | 'ical' | 'json';
  /** text/markdown/json, or an R2 key for images. */
  content: string;
  url?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}

/** What adapters may use. Adapters never touch D1; the SourceRun workflow writes. */
export interface SourceContext {
  fetch: typeof fetch;
  /** HTML → Markdown off-Worker (env.AI.toMarkdown), keeps CPU under the 10 ms cap. */
  toMarkdown(html: string, opts?: { cssSelector?: string; url?: string }): Promise<string>;
  /** Today's date in Berlin, YYYY-MM-DD. */
  today: string;
  log(message: string, data?: Record<string, unknown>): void;
}
