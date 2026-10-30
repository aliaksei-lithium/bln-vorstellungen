import { EventsResponse, HealthResponse, EventDetail } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ftsQuery } from '../src/api/events';

const inDays = (n: number, time: string) => {
  const d = new Date(Date.now() + n * 86_400_000);
  const local = `${d.toISOString().slice(0, 10)}T${time}`;
  return local;
};

beforeAll(async () => {
  const { berlinLocalToUtc } = await import('@bln/shared');
  const dates = [inDays(1, '19:30'), inDays(3, '19:30'), inDays(5, '18:00')];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO venues (id, name, address, district) VALUES ('v1', 'Deutsches Theater', 'Schumannstraße 13a', 'Mitte')`,
    ),
    env.DB.prepare(
      `INSERT INTO events (id, slug, title, lang, category, venue_id, price_min, price_max, dedup_key, created_by)
       VALUES ('e1', 'hamlet', 'Hamlet', 'de', 'theatre', 'v1', 18, 64, 'hamlet|v1|x', 'test')`,
    ),
    ...dates.map((l, i) =>
      env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, 'e1', ?, ?)`).bind(
        `o${i}`,
        l,
        berlinLocalToUtc(l),
      ),
    ),
    env.DB.prepare(`INSERT INTO events_fts (event_id, title, venue) VALUES ('e1', 'Hamlet', 'Deutsches Theater')`),
  ]);
});

describe('api', () => {
  it('reports health with a DB ping', async () => {
    const res = await exports.default.fetch('https://x/api/health');
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json()).db).toBe('ok');
  });

  it('lists an event once, at its next date, with the count of further dates', async () => {
    const res = await exports.default.fetch('https://x/api/events');
    const body = EventsResponse.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ slug: 'hamlet', venueName: 'Deutsches Theater', priceMax: 64, moreDates: 2 });
    expect(body.items[0]?.next.startLocal).toBe(inDays(1, '19:30'));
  });

  it('filters by category and search text', async () => {
    const none = EventsResponse.parse(
      await (await exports.default.fetch('https://x/api/events?category=opera')).json(),
    );
    expect(none.items).toHaveLength(0);
    const hit = EventsResponse.parse(await (await exports.default.fetch('https://x/api/events?q=haml')).json());
    expect(hit.items.map((i) => i.slug)).toEqual(['hamlet']);
  });

  it('returns detail with all occurrences and 404 for unknown slugs', async () => {
    const res = await exports.default.fetch('https://x/api/events/hamlet');
    const detail = EventDetail.parse(await res.json());
    expect(detail.occurrences).toHaveLength(3);
    expect(detail.venue?.district).toBe('Mitte');
    expect((await exports.default.fetch('https://x/api/events/nope')).status).toBe(404);
  });

  it('rejects bad query input', async () => {
    expect((await exports.default.fetch('https://x/api/events?category=circus')).status).toBe(400);
  });
});

describe('ftsQuery', () => {
  it('quotes words and makes the last a prefix', () => {
    expect(ftsQuery('peer gy"nt')).toBe('"peer" "gynt"*');
  });
});
