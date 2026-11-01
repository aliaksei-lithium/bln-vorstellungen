import { htmlToText, truncate } from '@bln/shared';
import { z } from 'zod';
import { USER_AGENT } from './common';
import { contentHash } from './hash';
import type { RawItem, SourceAdapter } from './types';

/**
 * Public Telegram channels through their web preview, `https://t.me/s/<channel>` (docs/09: no bot, no API key).
 * The page lists the latest ~20 posts; the cursor is the highest post number seen, so each run hands over only
 * new posts. Text posts are bundled into a few chunks (one LLM call each, not one per post); a post that is mostly
 * a flyer becomes its own item with a `[Photo: url]` line, which the extractor reads with vision.
 */

export const TelegramConfig = z.object({
  /** Channel username, as in t.me/<channel>. */
  channel: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{3,63}$/, 'A public channel username, e.g. "berlinpunk"'),
  /** Characters per text chunk handed to the extractor. */
  chunkChars: z.number().int().min(2000).max(30_000).default(10_000),
  /** Flyer posts read with vision per run (each costs about $0.003). */
  maxPhotos: z.number().int().min(0).max(20).default(5),
  /** A post with less text than this and a photo is read from the photo. */
  photoTextBelow: z.number().int().min(0).max(2000).default(280),
});
export type TelegramConfig = z.infer<typeof TelegramConfig>;

export type TelegramPost = { id: number; text: string; photos: string[]; date: string | null; url: string };

/** Splits the preview page into posts. Plain string work on ~130 kB; well inside the CPU budget. */
export function parseTelegramPage(html: string, channel: string): TelegramPost[] {
  const posts: TelegramPost[] = [];
  const parts = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const part of parts) {
    const id = Number(new RegExp(`data-post="${channel}/(\\d+)"`, 'i').exec(part)?.[1]);
    if (!Number.isInteger(id)) continue;
    // The text block holds only inline tags (b, i, a, br), so the first closing div ends it.
    const textHtml = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(part)?.[1] ?? '';
    const text = htmlToText(textHtml.replace(/<br\s*\/?>/gi, '\n')).trim();
    const photos = [...part.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\(['"]?([^'")]+)/g)].map(
      (m) => m[1]!,
    );
    const date = /<time datetime="([^"]+)"/.exec(part)?.[1] ?? null;
    posts.push({ id, text, photos, date, url: `https://t.me/${channel}/${id}` });
  }
  return posts.sort((a, b) => a.id - b.id);
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');

export const telegramAdapter: SourceAdapter<TelegramConfig> = {
  type: 'telegram',
  configSchema: TelegramConfig,
  defaultScheduleMinutes: 120,

  async fetch(ctx, config, cursor) {
    const url = `https://t.me/s/${config.channel}`;
    const res = await ctx.fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
    if (!res.ok) throw new Error(`t.me answered ${res.status} for ${config.channel}`);
    const posts = parseTelegramPage(await res.text(), config.channel);
    if (!posts.length) throw new Error(`No posts found for "${config.channel}"; is it a public channel?`);
    const last = Number(cursor) || 0;
    const fresh = posts.filter((p) => p.id > last);

    const items: RawItem[] = [];
    const flyers = fresh.filter((p) => p.photos.length && p.text.length < config.photoTextBelow);
    for (const p of flyers.slice(0, config.maxPhotos)) {
      const content = `Post ${p.id}, published ${day(p.date)}:\n${p.text}\n\n[Photo: ${p.photos[0]}]`;
      items.push({
        externalId: `${config.channel}/${p.id}`,
        contentHash: await contentHash(content),
        kind: 'text',
        content,
        url: p.url,
        ...(p.date ? { publishedAt: p.date } : {}),
      });
    }
    // Everything else with text, bundled; posts too short to announce anything are skipped.
    const texts = fresh.filter((p) => !flyers.includes(p) && p.text.length >= 40);
    let chunk: TelegramPost[] = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const content = chunk
        .map((p) => `--- Post ${p.id}, published ${day(p.date)} (${p.url}) ---\n${truncate(p.text, 4000)}`)
        .join('\n\n');
      items.push({
        externalId: `${config.channel}/${chunk[0]!.id}-${chunk.at(-1)!.id}`,
        contentHash: await contentHash(content),
        kind: 'text',
        content,
        url: chunk.length === 1 ? chunk[0]!.url : url,
        ...(chunk.at(-1)!.date ? { publishedAt: chunk.at(-1)!.date! } : {}),
      });
      chunk = [];
      size = 0;
    };
    for (const p of texts) {
      if (size && size + p.text.length > config.chunkChars) await flush();
      chunk.push(p);
      size += p.text.length;
    }
    await flush();

    return {
      items,
      cursor: String(Math.max(last, ...posts.map((p) => p.id))),
      stats: {
        fetched: posts.length,
        skipped: posts.length - fresh.length + (fresh.length - flyers.length - texts.length),
      },
    };
  },
};
