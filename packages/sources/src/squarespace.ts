import { cleanTitle, htmlToText, truncate, utcToBerlinLocal } from '@bln/shared';
import { z } from 'zod';
import { baseConfig, fetchText, finalize, isPlaceholder, isUpcoming, pickCategory, pickLang, safeUrl } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * A venue site on Squarespace with an events page (8MM Bar's /program). Squarespace serves any collection page as
 * JSON with `?format=json`: title, start and end (epoch ms), description (HTML), image and the event's own page.
 * Mapped directly, no LLM.
 */

export const SquarespaceConfig = z.object({
  ...baseConfig,
  maxItems: z.number().int().min(1).max(200).default(100),
});
export type SquarespaceConfig = z.infer<typeof SquarespaceConfig>;

const Item = z.object({
  id: z.string(),
  title: z.string(),
  startDate: z.number(),
  endDate: z.number().nullish(),
  body: z.string().nullish(),
  excerpt: z.string().nullish(),
  fullUrl: z.string().nullish(),
  assetUrl: z.string().nullish(),
});
type Item = z.infer<typeof Item>;

const jsonUrl = (url: string) => {
  const u = new URL(url);
  u.searchParams.set('format', 'json');
  return u.toString();
};

export const squarespaceAdapter: SourceAdapter<SquarespaceConfig> = {
  type: 'squarespace',
  configSchema: SquarespaceConfig,
  defaultScheduleMinutes: 12 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, jsonUrl(config.url), cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const page = JSON.parse(res.text) as { upcoming?: unknown[]; items?: unknown[] };
    const raw = page.upcoming ?? page.items ?? [];
    const items: RawItem[] = [];
    for (const r of raw) {
      const p = Item.safeParse(r);
      if (!p.success || items.length >= config.maxItems) continue;
      if (!isUpcoming(utcToBerlinLocal(new Date(p.data.startDate).toISOString()), ctx.today)) continue;
      const content = JSON.stringify(p.data);
      items.push({
        externalId: p.data.id,
        contentHash: await contentHash(content),
        kind: 'json',
        content,
        ...(p.data.fullUrl ? { url: new URL(p.data.fullUrl, config.url).toString() } : {}),
      });
    }
    return { items, cursor: res.cursor, stats: { fetched: raw.length, skipped: raw.length - items.length } };
  },

  mapItem(item, config) {
    const p = JSON.parse(item.content) as Item;
    const title = cleanTitle(p.title);
    if (!title || isPlaceholder(title)) return [];
    const description = truncate(htmlToText(p.body || p.excerpt || ''), 4000);
    // Minutes only: Squarespace adds stray milliseconds to start times.
    const start = utcToBerlinLocal(new Date(Math.floor(p.startDate / 60_000) * 60_000).toISOString()).slice(0, 16);
    const ev = finalize({
      title,
      ...(description ? { description } : {}),
      lang: pickLang(config.lang, `${title}\n${description}`),
      category: pickCategory(null, config.category, title, description),
      genres: [],
      occurrences: [{ start }],
      venue: config.venue ?? null,
      performers: [],
      price: null,
      urls: item.url ? { official: item.url } : {},
      ...(safeUrl(p.assetUrl) ? { imageUrl: safeUrl(p.assetUrl) } : {}),
      confidence: 0.9,
      needsReview: false,
      sourceQuote: truncate(`${title} · ${start}`, 300),
    });
    return ev ? [ev] : [];
  },
};
