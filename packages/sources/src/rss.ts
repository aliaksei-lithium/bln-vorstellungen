import { cleanTitle, decodeEntities, htmlToText, truncate } from '@bln/shared';
import { z } from 'zod';
import { fetchText, safeUrl } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * RSS 2.0 and Atom. An entry is a raw item of free text: posts describe events in prose, so there is no `mapItem`;
 * the items wait for LLM extraction (ExtractItem, phase 3). Feeds are small, so a regex scan is fine.
 */

export const RssConfig = z.object({
  url: z.url(),
  maxItems: z.number().int().min(1).max(200).default(50),
});
export type RssConfig = z.infer<typeof RssConfig>;

const CDATA = /^<!\[CDATA\[([\s\S]*?)\]\]>$/;

function tag(block: string, ...names: string[]): string {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) {
      const v = m[1]!.trim();
      return v.match(CDATA)?.[1] ?? decodeEntities(v);
    }
  }
  return '';
}

const atomLink = (block: string) =>
  block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
  block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1];

export type FeedEntry = { id: string; title: string; link?: string; published?: string; body: string };

export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((b) => {
    const link = safeUrl(tag(b, 'link')) ?? safeUrl(atomLink(b));
    const title = cleanTitle(tag(b, 'title'));
    const published = tag(b, 'pubDate', 'published', 'updated', 'dc:date');
    const body = htmlToText(tag(b, 'content:encoded', 'content', 'description', 'summary'));
    return { id: tag(b, 'guid', 'id') || link || title, title, link, published: published || undefined, body };
  });
}

export const rssAdapter: SourceAdapter<RssConfig> = {
  type: 'rss',
  configSchema: RssConfig,
  defaultScheduleMinutes: 6 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, config.url, cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const entries = parseFeed(res.text);
    const items: RawItem[] = [];
    for (const e of entries.slice(0, config.maxItems)) {
      const content = truncate([`# ${e.title}`, e.link, e.body].filter(Boolean).join('\n\n'), 20_000);
      const publishedMs = e.published ? Date.parse(e.published) : NaN;
      items.push({
        externalId: e.id,
        contentHash: await contentHash(content),
        kind: 'markdown',
        content,
        ...(e.link ? { url: e.link } : {}),
        ...(Number.isFinite(publishedMs) ? { publishedAt: new Date(publishedMs).toISOString() } : {}),
      });
    }
    return { items, cursor: res.cursor, stats: { fetched: entries.length, skipped: entries.length - items.length } };
  },
};
