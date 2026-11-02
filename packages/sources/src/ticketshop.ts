import { cleanTitle, decodeEntities, truncate, type Category } from '@bln/shared';
import { z } from 'zod';
import { baseConfig, fetchText, finalize, isPlaceholder, isUpcoming, pickCategory, pickLang, safeUrl } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * A venue's ticket shop that publishes its product list as JSON (`/tickets.json`; SO36's shop). One product = one
 * show, mapped directly without an LLM: title, support act, date, doors and start, image, price, sold out.
 */

export const TicketShopConfig = z.object({
  ...baseConfig,
  /** Shops also sell tours in other cities: keep only products in this one. */
  city: z.string().trim().min(2).default('Berlin'),
  maxItems: z.number().int().min(1).max(500).default(200),
});
export type TicketShopConfig = z.infer<typeof TicketShopConfig>;

const Product = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  subtitle: z.string().nullish(),
  supertitle: z.string().nullish(),
  valid_start_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time_open: z.string().nullish(),
  time_begin: z.string().nullish(),
  sold_out_status: z.string().nullish(),
  city: z.string().nullish(),
  url: z.string().nullish(),
  best_price: z.string().nullish(),
  max_price: z.string().nullish(),
  image: z.object({ url: z.string().nullish() }).nullish(),
  hero_image: z.object({ url: z.string().nullish() }).nullish(),
});
type Product = z.infer<typeof Product>;

/** The shop's own words for what a product is. */
const KIND: Record<string, Category> = { konzert: 'concert', party: 'club', lesung: 'talk', kino: 'cinema' };

const time = (t: string | null | undefined) => (t && /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, '0') : null);

/** "33,10 €" → 33.1. */
const euros = (s: string | null | undefined): number | undefined => {
  const m = decodeEntities(s ?? '').match(/(\d+)(?:[.,](\d{1,2}))?/);
  return m ? Number(`${m[1]}.${m[2] ?? 0}`) : undefined;
};

export const ticketShopAdapter: SourceAdapter<TicketShopConfig> = {
  type: 'ticketshop',
  configSchema: TicketShopConfig,
  defaultScheduleMinutes: 12 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, config.url, cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const raw = (JSON.parse(res.text) as { products?: unknown[] }).products ?? [];
    const items: RawItem[] = [];
    for (const p of raw) {
      const r = Product.safeParse(p);
      if (!r.success || items.length >= config.maxItems) continue;
      const product = r.data;
      if (product.city && product.city.toLowerCase() !== config.city.toLowerCase()) continue;
      if (!isUpcoming(product.valid_start_on, ctx.today)) continue;
      const content = JSON.stringify(product);
      items.push({
        externalId: String(product.id),
        contentHash: await contentHash(content),
        kind: 'json',
        content,
        ...(product.url ? { url: new URL(product.url, config.url).toString() } : {}),
      });
    }
    return { items, cursor: res.cursor, stats: { fetched: raw.length, skipped: raw.length - items.length } };
  },

  mapItem(item, config) {
    const p = JSON.parse(item.content) as Product;
    const title = cleanTitle(decodeEntities(p.title));
    if (!title || isPlaceholder(title)) return [];
    const support = decodeEntities(p.subtitle ?? '').trim();
    const begin = time(p.time_begin) ?? time(p.time_open);
    const doors = time(p.time_open);
    const soldOut = p.sold_out_status === 'sold_out';
    const min = euros(p.best_price);
    const max = euros(p.max_price);
    const image = p.image?.url ?? p.hero_image?.url;
    const category = pickCategory(KIND[(p.supertitle ?? '').toLowerCase()], config.category, title, support);
    // The bill: "A / B / C" in the title, plus a subtitle only when it names acts ("Support: X & Y"); other
    // subtitles are tour names.
    const billed = /^(support|special guests?|with|mit)\s*:?\s+/i.exec(support);
    const acts = [
      ...title.split(/\s+\/\s+/),
      ...(billed ? support.slice(billed[0].length).split(/\s*(?:,|&|\+|\/)\s*/) : []),
    ].filter((n) => n.trim().length > 1);
    const ev = finalize({
      title,
      ...(support ? { description: support } : {}),
      lang: pickLang(config.lang, `${title}\n${support}`),
      category,
      genres: [],
      occurrences: [
        {
          start: `${p.valid_start_on}T${begin ?? '00:00'}`,
          ...(doors && begin && doors !== begin ? { doorsAt: `${p.valid_start_on}T${doors}` } : {}),
          ...(soldOut ? { note: 'ausverkauft' } : {}),
        },
      ],
      venue: config.venue ?? null,
      performers: category === 'concert' ? acts.map((name) => ({ name: name.trim() })) : [],
      // The shop shows 0,00 € when no price is set (sold out, door only): unknown, not free.
      price: min ? { currency: 'EUR', min, ...(max && max > min ? { max } : {}) } : null,
      urls: item.url ? { official: item.url, tickets: item.url } : {},
      ...(image && safeUrl(new URL(image, config.url).toString())
        ? { imageUrl: new URL(image, config.url).toString() }
        : {}),
      confidence: 0.95,
      needsReview: false,
      sourceQuote: truncate(`${title} · ${p.valid_start_on} ${begin ?? ''}`, 300),
    });
    return ev ? [ev] : [];
  },
};
