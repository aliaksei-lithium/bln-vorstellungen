import { cleanTitle, htmlToText, truncate, type Category } from '@bln/shared';
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
  toBerlinLocal,
} from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * schema.org Event objects in `<script type="application/ld+json">` blocks. Many venue and ticket pages expose
 * them; cheap and exact, so try this before the LLM-based `html` adapter. One Event object = one raw item.
 */

export const JsonLdConfig = z.object({
  ...baseConfig,
  maxItems: z.number().int().min(1).max(500).default(200),
});
export type JsonLdConfig = z.infer<typeof JsonLdConfig>;

type Node = Record<string, unknown>;

/** Finds JSON-LD blocks with indexOf, not a DOM or a page-wide regex: pages can be over 1 MB. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  for (;;) {
    const at = html.indexOf('application/ld+json', i);
    if (at < 0) break;
    const open = html.indexOf('>', at);
    const close = open < 0 ? -1 : html.indexOf('</script', open);
    if (close < 0) break;
    i = close;
    const raw = html.slice(open + 1, close).trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      try {
        // Raw line breaks inside strings are the usual culprit.
        // eslint-disable-next-line no-control-regex
        out.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')));
      } catch {
        /* not JSON; skip */
      }
    }
  }
  return out;
}

const typesOf = (n: Node): string[] => [n['@type']].flat().filter((t): t is string => typeof t === 'string');
const isEvent = (n: Node) => typesOf(n).some((t) => /(Event|Festival)$/.test(t)) && typeof n.startDate === 'string';

/** Walks @graph, ItemList and similar wrappers and returns every Event-like node. */
export function collectEvents(data: unknown, out: Node[] = [], depth = 0): Node[] {
  if (depth > 8 || !data || typeof data !== 'object') return out;
  if (Array.isArray(data)) {
    for (const d of data) collectEvents(d, out, depth + 1);
    return out;
  }
  const n = data as Node;
  if (isEvent(n)) {
    out.push(n);
    return out;
  }
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'event', 'events']) {
    if (key in n) collectEvents(n[key], out, depth + 1);
  }
  return out;
}

const TYPE_CATEGORY: Record<string, Category> = {
  TheaterEvent: 'theatre',
  ComedyEvent: 'theatre',
  MusicEvent: 'concert',
  DanceEvent: 'dance',
  ScreeningEvent: 'cinema',
  ExhibitionEvent: 'exhibition',
  VisualArtsEvent: 'exhibition',
  EducationEvent: 'talk',
  LiteraryEvent: 'talk',
  Festival: 'festival',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const asNodes = (v: unknown): Node[] => [v].flat().filter((x): x is Node => !!x && typeof x === 'object');

function addressOf(a: unknown): string | undefined {
  if (typeof a === 'string') return a.trim() || undefined;
  const n = asNodes(a)[0];
  if (!n) return undefined;
  const city = [str(n.postalCode), str(n.addressLocality)].filter(Boolean).join(' ');
  return [str(n.streetAddress), city].filter(Boolean).join(', ') || undefined;
}

function prices(offers: unknown): { min?: number; max?: number; free: boolean; tickets?: string } {
  const nums: number[] = [];
  let tickets: string | undefined;
  for (const o of asNodes(offers)) {
    tickets ??= safeUrl(o.url);
    for (const k of ['price', 'lowPrice', 'highPrice']) {
      const n = parseFloat(str(o[k]).replace(',', '.'));
      if (Number.isFinite(n) && n >= 0) nums.push(n);
    }
  }
  if (!nums.length) return { free: false, ...(tickets ? { tickets } : {}) };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { free: max === 0, ...(max > 0 ? { min, max } : {}), ...(tickets ? { tickets } : {}) };
}

function names(v: unknown): { name: string }[] {
  const raw = [v].flat().map((p) => (typeof p === 'string' ? p : str((p as Node | null)?.name)));
  const seen = new Set<string>();
  return raw
    .map((n) => cleanTitle(n, 120))
    .filter((n) => n && !seen.has(n) && seen.add(n))
    .slice(0, 20)
    .map((name) => ({ name }));
}

export const jsonldAdapter: SourceAdapter<JsonLdConfig> = {
  type: 'jsonld',
  configSchema: JsonLdConfig,
  defaultScheduleMinutes: 12 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, config.url, cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const nodes = extractJsonLd(res.text).flatMap((d) => collectEvents(d));
    const items: RawItem[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    for (const n of nodes) {
      const start = toBerlinLocal(str(n.startDate));
      const end = toBerlinLocal(str(n.endDate));
      const id = `${safeUrl(n.url) || str(n['@id']) || str(n.name)}|${str(n.startDate)}`;
      if (!start || !isUpcoming((end ?? start).local, ctx.today) || seen.has(id) || items.length >= config.maxItems) {
        skipped++;
        continue;
      }
      seen.add(id);
      const content = JSON.stringify(n);
      items.push({
        externalId: id,
        contentHash: await contentHash(content),
        kind: 'json',
        content,
        url: safeUrl(n.url),
      });
    }
    return { items, cursor: res.cursor, stats: { fetched: nodes.length, skipped } };
  },

  mapItem(item, config) {
    const n = JSON.parse(item.content) as Node;
    if (/(Cancelled|Postponed)$/.test(str(n.eventStatus))) return [];
    const start = toBerlinLocal(str(n.startDate));
    if (!start) return [];
    const end = toBerlinLocal(str(n.endDate));
    const title = cleanTitle(str(n.name));
    if (isPlaceholder(title)) return [];
    const description = truncate(htmlToText(str(n.description)), 4000);
    const all = `${title}\n${description}`;

    const door = str(n.doorTime);
    const doorsAt = /^\d{2}:\d{2}/.test(door)
      ? `${start.local.slice(0, 10)}T${door.slice(0, 5)}`
      : toBerlinLocal(door)?.local;
    const places = asNodes(n.location).filter((l) => str(l.name) || l.address);
    const roomNote = config.venue
      ? places
          .map((p) => cleanTitle(str(p.name)))
          .filter(Boolean)
          .join(', ')
      : '';
    const occurrence = {
      start: start.local,
      ...(end && !end.dateOnly && end.local > start.local && end.local.slice(0, 10) <= start.local.slice(0, 10)
        ? { end: end.local }
        : {}),
      ...(doorsAt && doorsAt < start.local ? { doorsAt } : {}),
      ...(roomNote ? { note: roomNote } : start.dateOnly ? { note: 'ganztägig' } : {}),
    };

    let venue: { name: string; address?: string } | null = config.venue ?? null;
    if (!venue && places[0]) {
      const name = cleanTitle(str(places[0].name), 120);
      const address = addressOf(places[0].address);
      if (name || address) venue = { name: name || address!, ...(address && address !== name ? { address } : {}) };
    }

    const p = prices(n.offers);
    const free = p.free || n.isAccessibleForFree === true || looksFree(all);
    const image = [n.image]
      .flat()
      .map((i) => (typeof i === 'string' ? i : str((i as Node | null)?.url)))
      .find((i) => safeUrl(i));
    const official = safeUrl(n.url) ?? safeUrl(n['@id']);
    const typeCategory = typesOf(n)
      .map((t) => TYPE_CATEGORY[t])
      .find(Boolean);

    const ev = finalize({
      title,
      ...(description ? { description } : {}),
      lang: pickLang(config.lang, all),
      category: pickCategory(typeCategory, config.category, title, description),
      genres: [],
      occurrences: [occurrence],
      venue,
      performers: names(n.performer),
      price:
        free || p.min !== undefined
          ? { currency: 'EUR', ...(free ? { free: true } : { min: p.min, max: p.max }) }
          : null,
      urls: { ...(official ? { official } : {}), ...(p.tickets ? { tickets: p.tickets } : {}) },
      ...(image ? { imageUrl: safeUrl(image) } : {}),
      confidence: 0.95,
      needsReview: false,
      sourceQuote: truncate(`${title} · ${str(n.startDate)}`, 300),
    });
    return ev ? [ev] : [];
  },
};
