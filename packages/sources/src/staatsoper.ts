import { cleanTitle, decodeEntities, truncate, type Category } from '@bln/shared';
import { z } from 'zod';
import { USER_AGENT, baseConfig, finalize, isPlaceholder, isUpcoming, pickCategory } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter, SourceContext } from './types';

/**
 * Staatsoper Unter den Linden's Spielplan, read without an LLM. The site has no iCal, JSON-LD or API (checked
 * 2026-11-21, docs/09), but its listing is clean server-rendered HTML: one `<article data-termin-id>` per
 * performance with a `<time datetime>`, the room, the production link, prices and a sold-out flag. The first page
 * shows only today and tomorrow; later weeks load as fragments (`/de/spielplan/_f/DD-MM-YYYY`, linked from
 * `data-pagination-fragment-url`, about a week each, never across a month end), so the adapter walks them.
 *
 * One raw item per production and venue, carrying all its upcoming dates: one event with N occurrences.
 */

export const StaatsoperConfig = z.object({
  ...baseConfig,
  /** Weekly pages to read after the first; 16 ≈ four months ahead. Each is ~50–130 KB. */
  maxPages: z.number().int().min(1).max(40).default(16),
  /** Rooms inside the house: the config venue applies and the room becomes the date's note. */
  rooms: z
    .array(z.string().min(1))
    .default(['Staatsoper Unter den Linden', 'Apollosaal', 'Probebühne 1', 'Alter Orchesterprobensaal']),
  /** Dates carrying one of these labels are not open to the public. */
  skipLabels: z.array(z.string().min(1)).default(['Schulvorstellung', 'Kita-Vorstellung']),
});
export type StaatsoperConfig = z.infer<typeof StaatsoperConfig>;

export type Termin = {
  id: string;
  /** Berlin wall clock, "YYYY-MM-DDTHH:mm". */
  start: string;
  place: string;
  labels: string[];
  title: string;
  /** Production page, site-relative, without the #event anchor. */
  path: string;
  info: string;
  soldOut: boolean;
  free: boolean;
  prices: number[];
  tickets?: string;
  cast: { name: string; role?: string }[];
};

type Production = {
  title: string;
  info: string;
  venue: { name: string; address?: string } | null;
  performers: { name: string; role?: string }[];
  dates: { start: string; note?: string; labels: string[]; free: boolean; prices: number[]; tickets?: string }[];
};

/** Tags out, entities decoded; soft hyphens ("Sym&shy;pho&shy;nie…", for hyphenation) and zero-width spaces gone. */
const text = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/&shy;/g, ''))
    .replace(/[\u00ad\u200b]/g, '')
    .replace(/[\u2009\u00a0\s]+/g, ' ')
    .trim();

const between = (s: string, start: string, end: string): string | null => {
  const i = s.indexOf(start);
  if (i < 0) return null;
  const j = s.indexOf(end, i + start.length);
  return j < 0 ? null : s.slice(i + start.length, j);
};

const MAX_CAST = 6;

/** Every performance on one Spielplan page or fragment, in page order. */
export function parseTermine(html: string): Termin[] {
  const out: Termin[] = [];
  const parts = html.split('<article class="termin-list__item');
  for (const part of parts.slice(1)) {
    // Sections found with indexOf, so each regex runs over a few hundred characters, not the whole article
    // (the cast list makes some 10 KB): a season is ~2.5 MB of HTML and the CPU budget is 10 ms.
    const end = part.indexOf('</article>');
    const a = end < 0 ? part : part.slice(0, end);
    const more = a.indexOf('id="mehr-infos-');
    const head = more < 0 ? a : a.slice(0, more);
    const ticketsAt = a.indexOf('class="termin__ticket-infos"');
    const sale = ticketsAt < 0 ? '' : a.slice(ticketsAt);
    const id = /data-termin-id="(\d+)"/.exec(head)?.[1];
    const when = /<time datetime="(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(head);
    const link = /class="termin__title[^"]*">\s*<a href="([^"#]+)[^"]*">([\s\S]*?)<\/a>/.exec(head);
    if (!id || !when || !link) continue;
    const place = text(between(head, 'class="termin__spielstaette">', '</div>') ?? '');
    const labels = [
      ...(between(head, 'class="termin__kalendarien">', '</ul>') ?? '').matchAll(/<li[^>]*>([^<]*)<\/li>/g),
    ]
      .map((m) => text(m[1]!).replace(/,$/, '').trim())
      .filter(Boolean);
    const info = text(between(head, 'class="termin__werkinfo">', '</div>') ?? '');
    // "€ 85 70 60 46 …": the price categories, in one span after the euro sign (an entity in fragments, the
    // character on the first page), plus a reduced price when one is printed ("ermäßigt 4€").
    const priceList = /(?:&euro;|€)(?:&#8201;|\s)*<span[^>]*>([^<]*)<\/span>/.exec(sale)?.[1] ?? '';
    const reduced = sale.includes('ermäßigt')
      ? (/ermäßigt\s*(\d+(?:,\d{1,2})?)\s*(?:€|&euro;)/.exec(sale)?.[1] ?? '')
      : '';
    const prices = [...`${decodeEntities(priceList)} ${reduced}`.matchAll(/\d+(?:,\d{1,2})?/g)]
      .map((m) => Number(m[0].replace(',', '.')))
      .filter((n) => n > 0);
    const tickets = /href="(https:\/\/tickets\.staatsoper-berlin\.de\/[^"]+)"/.exec(sale)?.[1];
    const cast: Termin['cast'] = [];
    const castList = between(a, 'class="besetzung__liste', '</ul>') ?? '';
    for (const m of castList.matchAll(
      /<span class="besetzung__rolle">([^<]*)<\/span>\s*<div class="besetzung__beteiligte-liste">\s*<div[^>]*>\s*<a[^>]*><span>([^<]*)<\/span>/g,
    )) {
      if (cast.length >= MAX_CAST) break;
      const name = text(m[2]!);
      const role = text(m[1]!).replace(/:$/, '');
      if (name) cast.push(role ? { name, role } : { name });
    }
    out.push({
      id,
      start: `${when[1]}T${when[2]}`,
      place,
      labels,
      title: cleanTitle(text(link[2]!)),
      path: link[1]!,
      info,
      soldOut: sale.includes('class="termin__ausverkauft"'),
      free: sale.includes('Eintritt frei'),
      prices,
      ...(tickets ? { tickets: decodeEntities(tickets) } : {}),
      cast,
    });
  }
  return out;
}

/** The fragment that follows this page, or null at a month end. */
export const nextFragment = (html: string): string | null =>
  /id="next-link"[^>]*data-pagination-fragment-url="([^"]+)"/.exec(html)?.[1] ?? null;

/** "2026-11-29" → "01-12-2026": the first fragment of the following month. */
export function firstOfNextMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `01-${String(nm).padStart(2, '0')}-${ny}`;
}

async function getPage(ctx: SourceContext, url: string): Promise<string | null> {
  const res = await ctx.fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

const isGuestTour = (t: Termin) => /\bGastspiel\b/i.test(t.title);

/** The venue an entry happens at: the house (room as note), another Berlin hall, or none ("mobil"). */
function placeOf(
  t: Termin,
  config: StaatsoperConfig,
): { venue: { name: string; address?: string } | null; room?: string } {
  const house = config.venue ?? { name: 'Staatsoper Unter den Linden' };
  if (!t.place || config.rooms.includes(t.place)) {
    return t.place && t.place !== house.name ? { venue: house, room: t.place } : { venue: house };
  }
  if (/^mobil$/i.test(t.place)) return { venue: null };
  // "Philharmonie Berlin - Großer Saal": the hall is the venue, the room its note.
  const [name, room] = t.place.split(/\s+-\s+/, 2) as [string, string | undefined];
  return room ? { venue: { name }, room } : { venue: { name } };
}

/** Groups performances into productions (one per production page and venue). */
export function groupTermine(termine: Termin[], config: StaatsoperConfig, today: string): Map<string, Production> {
  const out = new Map<string, Production>();
  const seen = new Set<string>();
  for (const t of termine) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (!isUpcoming(t.start, today) || isGuestTour(t) || isPlaceholder(t.title)) continue;
    if (t.labels.some((l) => config.skipLabels.includes(l))) continue;
    const { venue, room } = placeOf(t, config);
    const key = `${t.path}|${venue?.name ?? '-'}`;
    let p = out.get(key);
    if (!p) {
      p = { title: t.title, info: t.info, venue, performers: t.cast, dates: [] };
      out.set(key, p);
    }
    const note = [room, t.soldOut ? 'ausverkauft' : null].filter(Boolean).join(' · ');
    p.dates.push({
      start: t.start,
      ...(note ? { note } : {}),
      labels: t.labels,
      free: t.free,
      prices: t.prices,
      ...(t.tickets ? { tickets: t.tickets } : {}),
    });
  }
  return out;
}

/** The site's own words for what a production is; titles like "Kinderkonzert" defeat word-boundary keywords. */
function categoryOf(p: Production): Category | null {
  const s = `${p.title} ${p.info} ${p.dates.flatMap((d) => d.labels).join(' ')}`;
  if (/ballett|tanz|dance/i.test(s)) return 'dance';
  if (/\bf(ü|ue)hrung/i.test(p.title)) return 'other'; // tours; not "Die Entführung aus dem Serail"
  if (/konzert|liederabend|kammermusik|symphoni|sinfoni|recital/i.test(s)) return 'concert';
  if (/oper\b|opera/i.test(s)) return 'opera';
  return null;
}

export const staatsoperAdapter: SourceAdapter<StaatsoperConfig> = {
  type: 'staatsoper',
  configSchema: StaatsoperConfig,
  defaultScheduleMinutes: 24 * 60,

  async fetch(ctx, config) {
    const first = await getPage(ctx, config.url);
    if (first === null) throw new Error(`GET ${config.url} → 404`);
    const base = new URL(config.url);
    const fragments = `${base.pathname.replace(/\/?$/, '/')}_f/`;
    const termine = parseTermine(first);
    let next = nextFragment(first);
    let last = termine.at(-1)?.start.slice(0, 10) ?? ctx.today;
    let pages = 1;
    for (let i = 0; i < config.maxPages; i++) {
      const url = new URL(next ?? `${fragments}${firstOfNextMonth(last)}`, base).toString();
      const html = await getPage(ctx, url);
      if (html === null) break; // past the end of the published season
      pages++;
      const found = parseTermine(html);
      if (!found.length) break;
      termine.push(...found);
      last = found.at(-1)!.start.slice(0, 10);
      next = nextFragment(html);
    }
    const items: RawItem[] = [];
    for (const [key, p] of groupTermine(termine, config, ctx.today)) {
      const content = JSON.stringify(p);
      items.push({
        externalId: key,
        contentHash: await contentHash(content),
        kind: 'json',
        content,
        url: new URL(key.split('|')[0]!, base).toString(),
      });
    }
    ctx.log('staatsoper pages read', { pages, performances: termine.length, productions: items.length });
    return { items, cursor: null, stats: { fetched: termine.length, skipped: 0 } };
  },

  mapItem(item, config) {
    const p = JSON.parse(item.content) as Production;
    if (!p.dates.length) return [];
    const prices = p.dates.flatMap((d) => d.prices);
    const allFree = p.dates.every((d) => d.free);
    const labels = [...new Set(p.dates.flatMap((d) => d.labels))].filter((l) => !/zum letzten mal/i.test(l));
    const description = [p.info, labels.join(', ')].filter(Boolean).join(' · ');
    const tickets = p.dates.find((d) => d.tickets)?.tickets;
    const ev = finalize({
      title: p.title,
      ...(description ? { description } : {}),
      lang: config.lang ?? 'de',
      category: pickCategory(categoryOf(p), config.category, p.title, p.info),
      genres: [],
      occurrences: p.dates.map((d) => ({ start: d.start, ...(d.note ? { note: d.note } : {}) })),
      venue: p.venue,
      performers: p.performers,
      price: allFree
        ? { currency: 'EUR', free: true }
        : prices.length
          ? {
              currency: 'EUR',
              min: Math.min(...prices),
              ...(Math.max(...prices) > Math.min(...prices) ? { max: Math.max(...prices) } : {}),
            }
          : null,
      urls: { ...(item.url ? { official: item.url } : {}), ...(tickets ? { tickets } : {}) },
      confidence: 0.95,
      needsReview: false,
      sourceQuote: truncate(`${p.title} · ${p.dates.map((d) => d.start).join(', ')}`, 300),
    });
    return ev ? [ev] : [];
  },
};
