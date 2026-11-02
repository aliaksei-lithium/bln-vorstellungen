import { USER_AGENT } from '@bln/sources';

/**
 * Event images (docs/09, 2026-11-02). Sources give an image URL (JSON-LD `image`, iCal `ATTACH`, a Telegram flyer);
 * events from HTML pages get their official page's `og:image`. The cron fetches a few per run, shrinks each once
 * with the Images binding to one WebP of at most 800 px (one unique transformation, 5,000 a month free) and keeps
 * it in R2 under a key that changes with the source URL, so it can be served as immutable. An event's image is
 * deleted once its last date has passed: nobody opens it any more and R2 stays at the size of the live programme.
 */

/** Per cron run (every 15 min): ~1,000 a day at most, well under the monthly free transformations at hobby volume. */
export const IMAGES_PER_RUN = 10;
/** Past events keep their image this long, for anyone opening a link from last night. */
const KEEP_DAYS = 2;
/** A failed image is tried again after this long; one that never works costs one fetch a day. */
const RETRY_DAYS = 1;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const SIZE = 800;
const QUALITY = 72;
const DAY_MS = 86_400_000;

export const imageUrl = (key: string | null | undefined): string | null => (key ? `/api/img/${key}` : null);

type Pending = { id: string; image_src: string | null; image_key: string | null; url_official: string | null };

/** Stores images for upcoming events that have none yet, soonest first. Returns how many were stored. */
export async function fetchImages(env: Env, now = new Date(), limit = IMAGES_PER_RUN): Promise<number> {
  // New events first; an image that failed (host down, monthly quota) gets another try a day later.
  const { results } = await env.DB.prepare(
    `SELECT id, image_src, image_key, url_official FROM events
      WHERE status = 'published' AND next_start_utc IS NOT NULL
        AND (image_checked_at IS NULL OR (image_key IS NULL AND image_src IS NOT NULL AND image_checked_at < ?))
        AND (image_src IS NOT NULL OR url_official IS NOT NULL)
      ORDER BY image_checked_at IS NOT NULL, next_start_utc LIMIT ?`,
  )
    .bind(new Date(now.getTime() - RETRY_DAYS * DAY_MS).toISOString(), limit)
    .all<Pending>();
  let stored = 0;
  for (const ev of results) {
    let src = ev.image_src;
    let key: string | null = null;
    try {
      if (!src && isEventPage(ev.url_official!)) src = await pageImage(ev.url_official!);
      if (src) key = await storeImage(env, ev.id, src);
      if (key) stored++;
    } catch (err) {
      // The transformation quota (9422), a host that is down or a broken image: tried again in RETRY_DAYS.
      console.warn('image', { event: ev.id, src, err: String(err) });
    }
    await env.DB.prepare(
      `UPDATE events SET image_src = COALESCE(image_src, ?), image_key = COALESCE(?, image_key), image_checked_at = ?
        WHERE id = ?`,
    )
      .bind(src, key, now.toISOString(), ev.id)
      .run();
    if (key && ev.image_key && ev.image_key !== key) await env.MEDIA.delete(ev.image_key);
  }
  return stored;
}

/** Fetches, shrinks and stores one image; the R2 key, or null when the URL is not an image. */
export async function storeImage(env: Env, eventId: string, src: string): Promise<string | null> {
  const res = await fetch(src, { headers: { 'user-agent': USER_AGENT, accept: 'image/*' } });
  const type = res.headers.get('content-type')?.split(';')[0] ?? '';
  if (!res.ok || !res.body || !type.startsWith('image/') || type === 'image/svg+xml') {
    await res.body?.cancel();
    return null;
  }
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body.cancel();
    return null;
  }
  const out = await env.IMAGES.input(res.body)
    .transform({ width: SIZE, height: SIZE, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: QUALITY });
  const key = `events/${eventId}/${await shortHash(src)}.webp`;
  // R2 needs a known length: the transformed image is small, so buffer it.
  const bytes = await new Response(out.image()).arrayBuffer();
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
  return key;
}

/**
 * Whether a link is an event's own page rather than the venue's home or programme page, which some sources give
 * as every event's link: their image is the venue's (or one event's flyer), not this event's.
 */
export function isEventPage(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return (
      !!path &&
      !/(^|\/)(de|en|programm?e?|spielplan|events?|veranstaltungen|kalender|calendar|termine|tickets)$/i.test(path)
    );
  } catch {
    return false;
  }
}

/** The image of an event's own page: its `og:image`, else the first content image (see findPageImage). */
export async function pageImage(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('html')) {
    await res.body?.cancel();
    return null;
  }
  return findPageImage(await readStart(res.body), res.url || url);
}

/** The first MAX_PAGE_BYTES of a page: event pages put their photo near the top. */
async function readStart(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (html.length < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return html;
}

/** An attribute's value, quoted or not (`content=https://… property=og:image` is valid HTML). */
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3])?.replace(/&amp;/g, '&') : undefined;
};

const NOT_A_PHOTO = /logo|favicon|icon|sprite|avatar|placeholder|default|blur|pixel|spacer|\.svg|\.gif/i;
const decoded = (url: string) => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

/**
 * The page's own image, absolute: `og:image` (or `twitter:image`); without one, the first `<img>` that looks like a
 * photo (theatres such as DT and Staatsoper have no og:image but open the page with the production photo). Lazy
 * images give the real file in a srcset (the largest entry up to 1600 px wins) or `data-src`. Never a logo.
 */
export function findPageImage(html: string, base: string): string | null {
  const abs = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      const url = new URL(raw.trim(), base);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const prop of ['og:image:secure_url', 'og:image', 'twitter:image']) {
    for (const tag of metas) {
      if ((attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase() !== prop) continue;
      const url = abs(attr(tag, 'content'));
      // A site-wide logo says nothing about the event: look in the page instead.
      if (url && !NOT_A_PHOTO.test(decoded(new URL(url).pathname))) return url;
    }
  }
  const body = html.slice(Math.max(0, html.search(/<body\b/i)));
  for (const tag of body.match(/<img\b[^>]*>/gi) ?? []) {
    const srcset = attr(tag, 'data-srcset') ?? attr(tag, 'srcset');
    // "a.jpg 480w,b.jpg 1600w": entries split at a comma before the next URL (some sites leave out the space).
    const best = [...(srcset ?? '').matchAll(/(?:^|,)\s*([^\s,]\S*)\s+(\d+)w/g)]
      .map((m) => ({ u: m[1], w: Number(m[2]) }))
      .filter((c) => c.w <= 1600)
      .sort((a, b) => b.w - a.w)[0]?.u;
    const url = abs(best ?? attr(tag, 'data-src') ?? attr(tag, 'src'));
    if (!url || NOT_A_PHOTO.test(decoded(url))) continue;
    if (!/\.(jpe?g|png|webp|avif)(\?|$|&)/i.test(decoded(url))) continue;
    return url;
  }
  return null;
}

/** Drops the images of events that are over (or merged away). Returns how many were deleted. */
export async function dropPastImages(env: Env, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, image_key FROM events
      WHERE image_key IS NOT NULL
        AND (status IN ('merged', 'cancelled') OR (next_start_utc IS NULL AND COALESCE(last_start_at, '') < ?))
      LIMIT 100`,
  )
    .bind(before)
    .all<{ id: string; image_key: string }>();
  if (!results.length) return 0;
  await env.MEDIA.delete(results.map((r) => r.image_key));
  await env.DB.batch(results.map((r) => env.DB.prepare('UPDATE events SET image_key = NULL WHERE id = ?').bind(r.id)));
  return results.length;
}

async function shortHash(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
