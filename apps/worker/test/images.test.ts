import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VenueIndex, resolveEvent } from '../src/pipeline/resolve';
import { dropPastImages, fetchImages, findPageImage, isEventPage } from '../src/services/images';

/** Event images (docs/09, 2026-11-02): found, shrunk once into R2, served immutable, dropped when the event is over. */

const DAY_MS = 86_400_000;

/** The Images binding, standing in for Cloudflare's: records the transform and returns fixed bytes. */
function fakeImages(calls: unknown[]) {
  const t = {
    transform(o: unknown) {
      calls.push(o);
      return t;
    },
    output: async (o: unknown) => {
      calls.push(o);
      return { image: () => new Response('webp-bytes').body!, contentType: () => 'image/webp' };
    },
  };
  return { input: () => t } as unknown as ImagesBinding;
}

const withImages = (images: ImagesBinding) => Object.assign(Object.create(env) as Env, { IMAGES: images });

async function addEvent(id: string, cols: Record<string, string | null>) {
  const names = Object.keys(cols);
  await env.DB.prepare(
    `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by${names.map((n) => `, ${n}`).join('')})
     VALUES (?, ?, ?, 'en', 'concert', ?, 't'${names.map(() => ', ?').join('')})`,
  )
    .bind(id, id, id, `${id}-k`, ...Object.values(cols))
    .run();
}

afterEach(() => vi.restoreAllMocks());

describe('findPageImage', () => {
  it('reads og:image, resolves it against the page and skips logos', () => {
    const page = (meta: string) => `<html><head><title>x</title>${meta}</head>`;
    expect(
      findPageImage(page('<meta property="og:image" content="/media/show.jpg?w=1&amp;h=2">'), 'https://v.de/e/1'),
    ).toBe('https://v.de/media/show.jpg?w=1&h=2');
    expect(findPageImage(page(`<meta content='https://cdn.x/a.png' name='twitter:image'>`), 'https://v.de/')).toBe(
      'https://cdn.x/a.png',
    );
    expect(findPageImage(page('<meta property="og:image" content="/img/logo.png">'), 'https://v.de/')).toBeNull();
    // Unquoted attributes (Bar jeder Vernunft).
    expect(findPageImage(page('<meta content=https://v.de/a%20b.jpg property=og:image>'), 'https://v.de/')).toBe(
      'https://v.de/a%20b.jpg',
    );
    // No og:image: the first photo in the page, the real file of a lazy image, never the logo or a blur placeholder.
    const body = (imgs: string) =>
      `<html><head><meta property="og:image" content="/logo.png"></head><body>${imgs}</body></html>`;
    expect(
      findPageImage(
        body(
          '<img src="/logo.svg"><img class="lazy" data-src="/fileadmin/show_e15.jpg" src="/fileadmin/show_blur.jpg">',
        ),
        'https://dt.de/p/x',
      ),
    ).toBe('https://dt.de/fileadmin/show_e15.jpg');
    const thumb = (w: number, q: number) => `https://t.de/${w}x0/filters:quality(${q})/https%3A%2F%2Fso.de%2Fm%2Fa.jpg`;
    expect(
      findPageImage(
        body(
          `<img data-srcset="${thumb(480, 60)} 480w,${thumb(1600, 80)} 1600w,${thumb(2400, 80)} 2400w" src="${thumb(150, 10)}/blur(20)">`,
        ),
        'https://so.de/',
      ),
    ).toBe(thumb(1600, 80));
    expect(findPageImage(page('<meta name="description" content="x">'), 'https://v.de/')).toBeNull();
  });
});

describe('isEventPage', () => {
  it('tells an event page from a venue home or programme page', () => {
    expect(isEventPage('https://www.deutschestheater.de/programm/produktionen/polaris')).toBe(true);
    expect(isEventPage('https://a-trane.de/Events-Directory/a-trane-praesentiert-x/')).toBe(true);
    expect(isEventPage('https://www.schokoladen-mitte.de/')).toBe(false);
    expect(isEventPage('https://www.pankeculture.com/programme/')).toBe(false);
    expect(isEventPage('https://www.berliner-ensemble.de/spielplan')).toBe(false);
    expect(isEventPage('https://venue.test/de/')).toBe(false);
  });
});

describe('event images', () => {
  it('stores one shrunk image per upcoming event, from the source or the page, and serves it', async () => {
    const soon = new Date(Date.now() + DAY_MS).toISOString();
    await addEvent('img-src', { next_start_utc: soon, image_src: 'https://img.test/poster.jpg' });
    await addEvent('img-page', { next_start_utc: soon, url_official: 'https://venue.test/show' });
    await addEvent('img-none', { next_start_utc: soon });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://venue.test/show') {
        return new Response('<head><meta property="og:image" content="/pics/show.png"></head>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.startsWith('https://img.test/') || url.startsWith('https://venue.test/pics/')) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('nope', { status: 404 });
    });
    const calls: unknown[] = [];
    const e = withImages(fakeImages(calls));

    // Other tests' events may be pending too; each run takes the soonest few.
    while ((await fetchImages(e, new Date(), 50)) > 0);
    const rows = await env.DB.prepare(
      `SELECT id, image_src, image_key, image_checked_at FROM events WHERE id LIKE 'img-%' ORDER BY id`,
    ).all<{ id: string; image_src: string | null; image_key: string | null; image_checked_at: string | null }>();
    const by = Object.fromEntries(rows.results.map((r) => [r.id, r]));
    expect(by['img-src']!.image_key).toMatch(/^events\/img-src\/[0-9a-f]{12}\.webp$/);
    expect(by['img-page']!.image_src).toBe('https://venue.test/pics/show.png');
    expect(by['img-page']!.image_key).toMatch(/^events\/img-page\//);
    expect(by['img-none']).toMatchObject({ image_key: null, image_checked_at: null });
    expect(calls).toContainEqual({ width: 800, height: 800, fit: 'scale-down' });
    expect(calls).toContainEqual({ format: 'image/webp', quality: 72 });

    const res = await exports.default.fetch(`https://x/api/img/${by['img-src']!.image_key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('webp-bytes');
    expect((await exports.default.fetch('https://x/api/img/events/nope/x.webp')).status).toBe(404);

    // Lists and the detail page carry the URL.
    const detail = (await (await exports.default.fetch('https://x/api/events/img-src')).json()) as { image: string };
    expect(detail.image).toBe(`/api/img/${by['img-src']!.image_key}`);
  });

  it('follows each source: no page lookups for `feed`, nothing for `none`', async () => {
    const soon = new Date(Date.now() + 2 * DAY_MS).toISOString();
    await env.DB.batch(
      (['feed', 'none'] as const).flatMap((mode) => [
        env.DB.prepare(
          `INSERT INTO sources (id, name, type, config, schedule_minutes, image_mode) VALUES (?, ?, 'html', '{}', 60, ?)`,
        ).bind(`s_mode_${mode}`, mode, mode),
        env.DB.prepare(
          `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at)
           VALUES (?, ?, 'x', ?, 'markdown', 'x', '2026-01-01T00:00:00Z')`,
        ).bind(`raw_mode_${mode}`, `s_mode_${mode}`, `h_${mode}`),
      ]),
    );
    await addEvent('img-mode-feed', { next_start_utc: soon, url_official: 'https://mode.test/feed-event' });
    await addEvent('img-mode-none', { next_start_utc: soon, image_src: 'https://mode.test/none.jpg' });
    await env.DB.batch(
      (['feed', 'none'] as const).map((mode) =>
        env.DB.prepare(
          `INSERT INTO event_sources (event_id, raw_item_id, extracted, confidence, model) VALUES (?, ?, '{}', 1, 'm')`,
        ).bind(`img-mode-${mode}`, `raw_mode_${mode}`),
      ),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 404 }));
    while ((await fetchImages(withImages(fakeImages([])), new Date(), 50)) > 0);
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('mode.test'))).toEqual([]);
    const rows = await env.DB.prepare(`SELECT image_key, image_checked_at FROM events WHERE id LIKE 'img-mode-%'`).all<{
      image_key: string | null;
      image_checked_at: string | null;
    }>();
    expect(rows.results.every((r) => r.image_key === null && r.image_checked_at !== null)).toBe(true);
  });

  it('tries a failed image again a day later', async () => {
    await addEvent('img-retry', {
      next_start_utc: new Date(Date.now() + 9 * DAY_MS).toISOString(),
      image_src: 'https://down.test/p.jpg',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }));
    const e = withImages(fakeImages([]));
    const tried = () => fetchSpy.mock.calls.filter(([u]) => String(u) === 'https://down.test/p.jpg').length;
    const now = new Date();
    await fetchImages(e, now, 100);
    await fetchImages(e, now, 100);
    expect(tried()).toBe(1);
    await fetchImages(e, new Date(now.getTime() + 2 * DAY_MS), 100);
    expect(tried()).toBe(2);
  });

  it('drops the image once the event is over', async () => {
    await env.MEDIA.put('events/img-old/abc.webp', 'x');
    await addEvent('img-old', {
      image_key: 'events/img-old/abc.webp',
      last_start_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    });
    await env.MEDIA.put('events/img-live/abc.webp', 'x');
    await addEvent('img-live', {
      image_key: 'events/img-live/abc.webp',
      next_start_utc: new Date(Date.now() + DAY_MS).toISOString(),
    });
    expect(await dropPastImages(env)).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA.head('events/img-old/abc.webp')).toBeNull();
    expect(await env.MEDIA.head('events/img-live/abc.webp')).not.toBeNull();
    const old = await env.DB.prepare(`SELECT image_key FROM events WHERE id = 'img-old'`).first();
    expect(old).toEqual({ image_key: null });
  });

  it('keeps the source image URL and retries when a later source brings one', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes) VALUES ('s_img', 'Img', 'jsonld', '{"url":"https://img.test/"}', 720)`,
      ),
      env.DB.prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at)
         VALUES ('raw-img', 's_img', 'x', 'hash-img', 'json', '{}', '2026-01-01T00:00:00Z')`,
      ),
    ]);
    const venues = await VenueIndex.load(env.DB);
    const start = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
    const ev = {
      title: 'Image Merge Night',
      lang: 'en' as const,
      category: 'concert' as const,
      genres: [],
      occurrences: [{ start: `${start}T20:00` }],
      venue: { name: 'Image Hall' },
      performers: [],
      price: null,
      urls: {},
      confidence: 0.9,
      needsReview: false,
      sourceQuote: 'x',
    };
    const prov = { rawItemId: 'raw-img', model: 'm', promptVersion: 'p', createdBy: 'source' };
    const { eventId } = await resolveEvent(env.DB, venues, ev, prov);
    await env.DB.prepare(`UPDATE events SET image_checked_at = 'then' WHERE id = ?`).bind(eventId).run();
    await resolveEvent(env.DB, venues, { ...ev, imageUrl: 'https://img.test/later.jpg' }, prov);
    const row = await env.DB.prepare('SELECT image_src, image_checked_at FROM events WHERE id = ?')
      .bind(eventId)
      .first();
    expect(row).toEqual({ image_src: 'https://img.test/later.jpg', image_checked_at: null });
  });
});
