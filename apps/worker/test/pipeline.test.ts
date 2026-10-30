import { berlinToday, type ExtractedEvent } from '@bln/shared';
import { jsonldAdapter, JsonLdConfig, type SourceContext } from '@bln/sources';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveEvent, VenueIndex } from '../src/pipeline/resolve';
import { dispatchDueSources } from '../src/pipeline/scheduler';
import { finishRun, resolveItems, startRun, storeRawItems } from '../src/pipeline/source-run';

const DAY = 86_400_000;
const plus = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const prov = { rawItemId: 'raw-x', model: 'adapter:test@1', promptVersion: null, createdBy: 'source' };

const candidate = (over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  title: 'Die Möwe',
  lang: 'de',
  category: 'theatre',
  genres: [],
  occurrences: [{ start: `${plus(2)}T19:30` }],
  venue: { name: 'Schaubühne', address: 'Kurfürstendamm 153, 10709 Berlin' },
  performers: [{ name: 'Ensemble Schaubühne' }],
  price: { currency: 'EUR', min: 15, max: 48 },
  urls: { official: 'https://example.org/moewe' },
  confidence: 0.95,
  needsReview: false,
  sourceQuote: 'Die Möwe',
  ...over,
});

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO venues (id, name, aliases, address, district) VALUES
         ('v_gorki', 'Maxim Gorki Theater', '["Gorki"]', 'Am Festungsgraben 2, 10117 Berlin', 'Mitte')`,
    ),
    env.DB.prepare(
      `INSERT INTO sources (id, name, type, config, schedule_minutes) VALUES
         ('s_ld', 'Example Theater', 'jsonld', '{"url":"https://theatre.example/","venue":{"name":"Gorki"},"category":"theatre"}', 720)`,
    ),
    env.DB.prepare(
      `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at)
       VALUES ('raw-x', 's_ld', 'x', 'hash-x', 'json', '{}', '2026-01-01T00:00:00Z')`,
    ),
  ]);
});

describe('resolveEvent', () => {
  it('creates the event, a venue with its district, performers and a search row', async () => {
    const venues = await VenueIndex.load(env.DB);
    const r = await resolveEvent(env.DB, venues, candidate(), prov);
    expect(r.created).toBe(true);
    const ev = await env.DB.prepare(
      `SELECT e.slug, e.status, v.name AS venue, v.district FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`,
    )
      .bind(r.eventId)
      .first();
    expect(ev).toEqual({ slug: 'mowe', status: 'published', venue: 'Schaubühne', district: 'Wilmersdorf' });
    expect(await count('SELECT COUNT(*) AS n FROM event_performers WHERE event_id = ?', r.eventId)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'ensemble'`)).toBe(1);
    const src = await env.DB.prepare('SELECT model, confidence FROM event_sources WHERE event_id = ?')
      .bind(r.eventId)
      .first();
    expect(src).toEqual({ model: 'adapter:test@1', confidence: 0.95 });
  });

  it('merges another date of the same production into the same event', async () => {
    const venues = await VenueIndex.load(env.DB);
    const a = await resolveEvent(env.DB, venues, candidate({ occurrences: [{ start: `${plus(9)}T19:30` }] }), prov);
    const b = await resolveEvent(env.DB, venues, candidate({ title: 'DIE MÖWE!' }), prov);
    expect(a.created).toBe(false);
    expect(b.created).toBe(false);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE title = 'Die Möwe'`)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM occurrences WHERE event_id = ?', a.eventId)).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM events_fts WHERE event_id = ?', a.eventId)).toBe(1);
  });

  it('matches venues by alias and keeps different titles apart', async () => {
    const venues = await VenueIndex.load(env.DB);
    const r = await resolveEvent(env.DB, venues, candidate({ title: 'Hamlet', venue: { name: 'GORKI' } }), prov);
    const row = await env.DB.prepare('SELECT venue_id FROM events WHERE id = ?').bind(r.eventId).first();
    expect(row).toEqual({ venue_id: 'v_gorki' });
    expect(r.created).toBe(true);
  });

  it('holds low-confidence candidates as drafts in the review queue', async () => {
    const venues = await VenueIndex.load(env.DB);
    const r = await resolveEvent(env.DB, venues, candidate({ title: 'Unklar', confidence: 0.4 }), prov);
    expect(await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind(r.eventId).first()).toEqual({
      status: 'draft',
    });
    expect(await count(`SELECT COUNT(*) AS n FROM review_queue WHERE event_id = ?`, r.eventId)).toBe(1);
  });
});

describe('source run steps', () => {
  const html = `<script type="application/ld+json">{"@graph":[
    {"@type":"TheaterEvent","name":"Prinz Friedrich von Homburg","url":"https://theatre.example/homburg","startDate":"${plus(3)}T18:30:00Z","location":{"name":"Bühne"}},
    {"@type":"TheaterEvent","name":"Prinz Friedrich von Homburg","url":"https://theatre.example/homburg","startDate":"${plus(10)}T18:30:00Z","location":{"name":"Bühne"}},
    {"@type":"TheaterEvent","name":"Noise als Strategie","url":"https://theatre.example/noise","startDate":"${plus(4)}T15:00:00Z"}
  ]}</script>`;
  const ctx: SourceContext = {
    fetch: (async () => new Response(html)) as unknown as typeof fetch,
    toMarkdown: async (s) => s,
    today: berlinToday(),
    log: () => {},
  };
  const config = JsonLdConfig.parse({ url: 'https://theatre.example/', venue: { name: 'Gorki' }, category: 'theatre' });

  it('stores, resolves and finishes; a re-run adds nothing', async () => {
    const runId = await startRun(env, 's_ld', 'wf-1');
    const fetched = await jsonldAdapter.fetch(ctx, config, null);
    const ids = await storeRawItems(env.DB, 's_ld', fetched.items);
    expect(ids).toHaveLength(3);
    const r = await resolveItems(env, 's_ld', ids);
    expect(r).toEqual({ created: 2, updated: 1, failed: 0 });
    await finishRun(env, runId, 's_ld', { status: 'ok', cursor: null, fetched: 3, newItems: 3, ...r });

    const homburg = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(o.note) AS note, e.venue_id FROM events e JOIN occurrences o ON o.event_id = e.id
        WHERE e.title = 'Prinz Friedrich von Homburg'`,
    ).first();
    expect(homburg).toEqual({ n: 2, note: 'Bühne', venue_id: 'v_gorki' });
    expect(
      await count(`SELECT COUNT(*) AS n FROM raw_items WHERE source_id = 's_ld' AND extraction_status = 'done'`),
    ).toBe(3);

    const again = await jsonldAdapter.fetch(ctx, config, null);
    expect(await storeRawItems(env.DB, 's_ld', again.items)).toEqual([]);
    // Even re-resolving the same items creates nothing new.
    expect(await resolveItems(env, 's_ld', ids)).toEqual({ created: 0, updated: 3, failed: 0 });
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE title LIKE 'Prinz Friedrich%'`)).toBe(1);
    expect(
      await count(`SELECT COUNT(*) AS n FROM occurrences o JOIN events e ON e.id = o.event_id
                         WHERE e.title LIKE 'Prinz Friedrich%'`),
    ).toBe(2);

    const run = await env.DB.prepare('SELECT status, events_created FROM source_runs WHERE id = ?').bind(runId).first();
    expect(run).toEqual({ status: 'ok', events_created: 2 });
    const src = await env.DB.prepare('SELECT last_status, stats FROM sources WHERE id = ?').bind('s_ld').first<{
      last_status: string;
      stats: string;
    }>();
    expect(src?.last_status).toBe('ok');
    expect(JSON.parse(src!.stats)).toMatchObject({ runs: 1, eventsCreated: 2 });
  });
});

describe('dispatchDueSources', () => {
  it('starts each due source once and pushes next_run_at forward', async () => {
    await env.DB.prepare(
      `INSERT INTO sources (id, name, type, config, schedule_minutes) VALUES ('s_due', 'Due', 'ical', '{"url":"https://x.example/a.ics"}', 360),
              ('s_off', 'Off', 'ical', '{"url":"https://x.example/b.ics"}', 360)`,
    ).run();
    await env.DB.prepare(`UPDATE sources SET enabled = 0 WHERE id = 's_off'`).run();
    await env.DB.prepare(`UPDATE sources SET next_run_at = '2999-01-01T00:00:00Z' WHERE id = 's_ld'`).run();
    const started: string[] = [];
    const fake = async (_e: Env, id: string) => {
      started.push(id);
      return `wf-${id}`;
    };
    const now = new Date();
    await dispatchDueSources(env, now, fake);
    await dispatchDueSources(env, now, fake);
    expect(started).toEqual(['s_due']);
    const next = await env.DB.prepare(`SELECT next_run_at FROM sources WHERE id = 's_due'`).first<{
      next_run_at: string;
    }>();
    expect(Date.parse(next!.next_run_at) - now.getTime()).toBe(360 * 60_000);
  });
});
