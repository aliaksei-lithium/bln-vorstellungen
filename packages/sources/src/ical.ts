import { berlinToday, cleanTitle, guessCategory, htmlToText, truncate, utcToBerlinLocal } from '@bln/shared';
import { z } from 'zod';
import {
  baseConfig,
  fetchText,
  finalize,
  isPlaceholder,
  isUpcoming,
  looksFree,
  pickCategory,
  pickLang,
  safeUrl,
  stripPresenter,
  type LocalTime,
} from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * iCalendar feeds (venues, The Events Calendar on WordPress, Luma, Meetup). One VEVENT = one raw item, mapped
 * directly without an LLM. Line-based parsing only, well inside the CPU budget.
 */

export const IcalConfig = z.object({
  ...baseConfig,
  /** Keep at most this many upcoming VEVENTs per run. */
  maxItems: z.number().int().min(1).max(500).default(200),
});
export type IcalConfig = z.infer<typeof IcalConfig>;

type Prop = { name: string; params: Record<string, string>; value: string };

/** Unfolds continuation lines and returns each VEVENT block (nested VALARMs dropped). */
export function splitVEvents(text: string): string[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: string[] = [];
  let cur: string[] | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = [];
      depth = 0;
    } else if (cur && line.startsWith('BEGIN:')) depth++;
    else if (cur && line.startsWith('END:') && depth > 0) depth--;
    else if (line === 'END:VEVENT' && cur) {
      out.push(cur.join('\n'));
      cur = null;
    } else if (cur && depth === 0 && line) cur.push(line);
  }
  return out;
}

function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

export function parseVEvent(block: string): Map<string, Prop[]> {
  const props = new Map<string, Prop[]>();
  for (const line of block.split('\n')) {
    const p = parseLine(line);
    if (p) props.set(p.name, [...(props.get(p.name) ?? []), p]);
  }
  return props;
}

const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

const UTC_TZIDS = /^(utc|gmt|etc\/utc|z)$/i;

/** DTSTART/DTEND → Berlin local. Floating times and other TZIDs are read as Berlin wall-clock time. */
export function icalDate(p: Prop | undefined): LocalTime | null {
  if (!p) return null;
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h || p.params.VALUE === 'DATE') return { local: `${y}-${mo}-${d}T00:00`, dateOnly: true };
  if (z || UTC_TZIDS.test(p.params.TZID ?? '')) {
    return { local: utcToBerlinLocal(`${y}-${mo}-${d}T${h}:${mi}:00Z`), dateOnly: false };
  }
  return { local: `${y}-${mo}-${d}T${h}:${mi}`, dateOnly: false };
}

const DAY = 86_400_000;
const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const localMs = (local: string) => Date.parse(`${local}:00Z`);
const msLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * Minimal RRULE expansion: DAILY and WEEKLY (with INTERVAL, COUNT, UNTIL, BYDAY) inside a horizon. Arithmetic is
 * on wall-clock time, so a weekly 20:00 stays 20:00 across the DST switch. Other frequencies keep only the first
 * date; venues rarely use them for performances.
 */
export function expandRRule(
  startLocal: string,
  rrule: string,
  exdates: Set<string>,
  opts: { horizonDays?: number; max?: number; today?: string } = {},
): string[] {
  const { horizonDays = 120, max = 60, today = berlinToday() } = opts;
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=') as [string, string]));
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? icalDate({ name: 'UNTIL', params: {}, value: r.UNTIL })?.local : undefined;
  const horizon = msLocal(Date.parse(`${today}T00:00:00Z`) + horizonDays * DAY);
  const start = localMs(startLocal);
  const out: string[] = [];
  let seen = 0;
  const take = (ms: number) => {
    const l = msLocal(ms);
    if (l < startLocal) return true;
    if ((until && l > until) || l > horizon || seen >= count) return false;
    seen++;
    if (!exdates.has(l) && isUpcoming(l, today)) out.push(l);
    return out.length < max;
  };
  if (r.FREQ === 'DAILY') {
    for (let ms = start; take(ms); ms += interval * DAY);
  } else if (r.FREQ === 'WEEKLY') {
    const byday = (r.BYDAY ?? '').split(',').map((d) => WEEKDAY.indexOf(d.slice(-2)));
    const days = byday.filter((d) => d >= 0).sort((a, b) => a - b);
    if (!days.length) days.push(new Date(start).getUTCDay());
    const weekStart = start - new Date(start).getUTCDay() * DAY;
    weeks: for (let w = weekStart; ; w += interval * 7 * DAY) {
      for (const d of days) if (!take(w + d * DAY)) break weeks;
    }
  } else take(start);
  return out;
}

const first = (props: Map<string, Prop[]>, name: string) => props.get(name)?.[0];
const text = (props: Map<string, Prop[]>, name: string) => {
  const p = first(props, name);
  return p ? unescapeText(p.value).trim() : '';
};

/** Drops properties that change on every export without the event changing, so the content hash stays stable. */
const VOLATILE = /^(DTSTAMP|SEQUENCE)[;:]/;

export const icalAdapter: SourceAdapter<IcalConfig> = {
  type: 'ical',
  configSchema: IcalConfig,
  defaultScheduleMinutes: 6 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, config.url, cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const blocks = splitVEvents(res.text);
    const items: RawItem[] = [];
    let skipped = 0;
    for (const block of blocks) {
      const props = parseVEvent(block);
      const start = icalDate(first(props, 'DTSTART'));
      const end = icalDate(first(props, 'DTEND'));
      const recurring = props.has('RRULE');
      if (!start || (!recurring && !isUpcoming((end ?? start).local, ctx.today)) || items.length >= config.maxItems) {
        skipped++;
        continue;
      }
      const content = block
        .split('\n')
        .filter((l) => !VOLATILE.test(l))
        .join('\n');
      const uid = text(props, 'UID') || `${text(props, 'SUMMARY')}|${start.local}`;
      const rid = first(props, 'RECURRENCE-ID')?.value;
      items.push({
        externalId: rid ? `${uid}|${rid}` : uid,
        contentHash: await contentHash(content),
        kind: 'ical',
        content,
        url: safeUrl(text(props, 'URL')),
      });
    }
    return { items, cursor: res.cursor, stats: { fetched: blocks.length, skipped } };
  },

  mapItem(item, config) {
    const props = parseVEvent(item.content);
    if (/^cancel/i.test(text(props, 'STATUS'))) return [];
    const start = icalDate(first(props, 'DTSTART'));
    if (!start) return [];
    const end = icalDate(first(props, 'DTEND'));
    const title = stripPresenter(cleanTitle(text(props, 'SUMMARY')), config.venue?.name);
    if (isPlaceholder(title)) return [];
    const description = truncate(htmlToText(text(props, 'DESCRIPTION')), 4000);
    const location = text(props, 'LOCATION');
    const all = `${title}\n${description}`;

    const rrule = first(props, 'RRULE')?.value;
    const exdates = new Set(
      (props.get('EXDATE') ?? []).flatMap((p) =>
        p.value.split(',').map((v) => icalDate({ ...p, value: v })?.local ?? ''),
      ),
    );
    const starts = rrule ? expandRRule(start.local, rrule, exdates) : [start.local];
    const durationMs = end && !start.dateOnly ? localMs(end.local) - localMs(start.local) : 0;
    const occurrences = starts
      .filter((s) => rrule || isUpcoming(end && !end.dateOnly ? end.local : s))
      .map((s) => ({
        start: s,
        ...(durationMs > 0 && durationMs < 2 * DAY ? { end: msLocal(localMs(s) + durationMs) } : {}),
        ...(start.dateOnly ? { note: 'ganztägig' } : {}),
        ...(config.venue && location && !/^https?:/.test(location) ? { note: location } : {}),
      }));
    if (!occurrences.length) return [];

    let venue: { name: string; address?: string } | null = config.venue ?? null;
    if (!venue && location && !/^https?:/i.test(location)) {
      const [name, ...rest] = location.split(',').map((s) => s.trim());
      venue = name ? { name, ...(rest.length ? { address: rest.join(', ') } : {}) } : null;
    }
    const official = safeUrl(text(props, 'URL')) ?? safeUrl(description.match(/https?:\/\/\S+/)?.[0]);
    const image = (props.get('ATTACH') ?? []).map((p) => p.value).find((v) => /\.(jpe?g|png|webp)(\?|$)/i.test(v));
    const categories = text(props, 'CATEGORIES');

    const ev = finalize({
      title,
      ...(description ? { description } : {}),
      lang: pickLang(config.lang, all),
      category: pickCategory(categories ? guessCategory(categories) : null, config.category, title, description),
      genres: [],
      occurrences,
      venue,
      performers: [],
      price: looksFree(all) ? { currency: 'EUR', free: true } : null,
      urls: official ? { official } : {},
      ...(safeUrl(image) ? { imageUrl: safeUrl(image) } : {}),
      confidence: 0.9,
      needsReview: false,
      sourceQuote: truncate(`${title} · ${first(props, 'DTSTART')?.value ?? ''}`, 300),
    });
    return ev ? [ev] : [];
  },
};
