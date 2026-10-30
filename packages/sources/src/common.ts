import {
  Category,
  ExtractedEvent,
  Lang,
  berlinToday,
  guessCategory,
  guessLang,
  utcToBerlinLocal,
  type Category as CategoryT,
} from '@bln/shared';
import { z } from 'zod';
import type { SourceContext } from './types';

/** Config fields shared by the structured adapters. */
export const VenueOverride = z.object({ name: z.string().min(1), address: z.string().optional() });

export const baseConfig = {
  url: z.url(),
  /** Single-venue sources: every event happens here; the feed's own location becomes the occurrence note (a room). */
  venue: VenueOverride.optional(),
  /** Fallback when the item itself gives no usable category. */
  category: Category.optional(),
  /** Forces the language when the source is known to publish in one. */
  lang: Lang.optional(),
};

export const USER_AGENT =
  'Mozilla/5.0 (compatible; BLN-Vorstellungen/0.1; +https://bln-vorstellungen.aliaksei-zhynhiarouski.workers.dev)';
const MAX_BYTES = 4_000_000;

type HttpCursor = { etag?: string; lastModified?: string };

/**
 * GET with conditional headers from the previous run's cursor, so unchanged feeds cost one 304 and no parsing.
 * Returns null on 304.
 */
export async function fetchText(
  ctx: SourceContext,
  url: string,
  cursor: string | null,
): Promise<{ text: string; cursor: string | null } | null> {
  let prev: HttpCursor;
  try {
    prev = cursor ? (JSON.parse(cursor) as HttpCursor) : {};
  } catch {
    prev = {};
  }
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*' };
  if (prev.etag) headers['if-none-match'] = prev.etag;
  if (prev.lastModified) headers['if-modified-since'] = prev.lastModified;
  const res = await ctx.fetch(url, { headers, redirect: 'follow' });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error(`GET ${url} is too large`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`GET ${url} is too large`);
  const next: HttpCursor = {};
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag) next.etag = etag;
  if (lastModified) next.lastModified = lastModified;
  return { text, cursor: etag || lastModified ? JSON.stringify(next) : null };
}

export type LocalTime = { local: string; dateOnly: boolean };

/**
 * Any date string a feed may use → Berlin wall-clock "YYYY-MM-DDTHH:mm". Accepts date-only, local, "Z" and
 * offsets, including sloppy ones seen in the wild ("+1:00", "+0100").
 */
export function toBerlinLocal(value: string | undefined | null): LocalTime | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { local: `${v}T00:00`, dateOnly: true };
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i);
  if (!m) return null;
  const [, date, hh, mm, ss, tz] = m;
  if (!tz) return { local: `${date}T${hh}:${mm}`, dateOnly: false };
  let iso = `${date}T${hh}:${mm}:${ss ?? '00'}`;
  if (tz.toUpperCase() === 'Z') iso += 'Z';
  else {
    const t = tz.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
    if (!t) return null;
    iso += `${t[1]}${t[2]!.padStart(2, '0')}:${t[3] ?? '00'}`;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { local: utcToBerlinLocal(new Date(ms)), dateOnly: false };
}

/** True when the Berlin-local date-time is today or later. */
export const isUpcoming = (local: string, today: string = berlinToday()): boolean => local.slice(0, 10) >= today;

export function safeUrl(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const FREE = /\b(eintritt frei|freier eintritt|free entry|free admission|admission free|kostenlos|gratis)\b/i;
export const looksFree = (text: string): boolean => FREE.test(text);

/**
 * Category, strongest signal first: the item's own type, keywords in the title, the source default, keywords in
 * the description, then "other".
 */
export function pickCategory(
  specific: CategoryT | null | undefined,
  fallback: CategoryT | undefined,
  title: string,
  description = '',
): CategoryT {
  return specific ?? guessCategory(title) ?? fallback ?? guessCategory(description) ?? 'other';
}

/** Listings that are not events: closing days and similar placeholders some venues publish as entries. */
const PLACEHOLDER = /^(heute\s+)?geschlossen\b|\b(today|we are) closed\b|^closed\b|^ruhetag\b|^betriebsferien\b/i;
export const isPlaceholder = (title: string): boolean => PLACEHOLDER.test(title.trim());

export const pickLang = (forced: Lang | undefined, text: string): Lang => forced ?? guessLang(text) ?? 'other';

/** Validates a candidate; adapters drop items that do not fit the schema instead of failing the run. */
export function finalize(candidate: unknown): ExtractedEvent | null {
  const r = ExtractedEvent.safeParse(candidate);
  return r.success ? r.data : null;
}
