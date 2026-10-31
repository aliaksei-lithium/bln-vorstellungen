import { truncate } from '@bln/shared';
import { z } from 'zod';
import { baseConfig, fetchText } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * Any programme page. The page is converted to Markdown off-Worker (`env.AI.toMarkdown`, optionally narrowed with
 * a CSS selector) and stored in chunks; the LLM extractor (ExtractItem) turns each chunk into events. The workhorse
 * for venues that publish neither iCal nor JSON-LD.
 */

export const HtmlConfig = z.object({
  ...baseConfig,
  /** Narrows the conversion to the programme, e.g. "main" or ".spielplan". Less noise, fewer tokens. */
  cssSelector: z.string().min(1).optional(),
  /**
   * Characters per raw item; a long programme becomes several items so one LLM call stays small and its JSON
   * fits in max_tokens (a 16k chunk of a dense Spielplan did not).
   */
  chunkChars: z.number().int().min(2000).max(60_000).default(10_000),
  /** Upper bound on chunks per page, so a huge page cannot eat the daily AI budget. */
  maxChunks: z.number().int().min(1).max(20).default(8),
});
export type HtmlConfig = z.infer<typeof HtmlConfig>;

/** Splits Markdown at blank lines (paragraph boundaries) into chunks of at most `size` characters. */
export function chunkMarkdown(md: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of md.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${para}` : para.length > size ? truncate(para, size) : para;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Drops Markdown noise that costs tokens and carries no event data: images, empty links, repeated blank lines. */
export function compactMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const htmlAdapter: SourceAdapter<HtmlConfig> = {
  type: 'html',
  configSchema: HtmlConfig,
  defaultScheduleMinutes: 24 * 60,

  async fetch(ctx, config, cursor) {
    const res = await fetchText(ctx, config.url, cursor);
    if (!res) return { items: [], cursor, stats: { fetched: 0, skipped: 0 } };
    const md = compactMarkdown(
      await ctx.toMarkdown(res.text, {
        url: config.url,
        ...(config.cssSelector ? { cssSelector: config.cssSelector } : {}),
      }),
    );
    const chunks = chunkMarkdown(md, config.chunkChars);
    const items: RawItem[] = [];
    for (const [i, chunk] of chunks.slice(0, config.maxChunks).entries()) {
      items.push({
        externalId: `${config.url}#${i + 1}`,
        contentHash: await contentHash(chunk),
        kind: 'markdown',
        content: chunk,
        url: config.url,
        meta: { chunk: i + 1, of: chunks.length },
      });
    }
    return {
      items,
      cursor: res.cursor,
      stats: { fetched: chunks.length, skipped: Math.max(0, chunks.length - items.length) },
    };
  },
};
