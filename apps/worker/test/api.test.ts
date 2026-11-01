import { EventsResponse, HealthResponse, EventDetail } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ftsQuery } from '../src/services/events';
import { refreshAllNextDates } from '../src/pipeline/next-dates';

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
  await refreshAllNextDates(env.DB);
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
    // Several values add up: any of them matches.
    const any = EventsResponse.parse(
      await (await exports.default.fetch('https://x/api/events?category=opera,theatre')).json(),
    );
    expect(any.items.map((i) => i.slug)).toContain('hamlet');
    expect((await exports.default.fetch('https://x/api/events?category=opera,circus')).status).toBe(400);
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

describe('sources and calendar for visitors', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes, default_off) VALUES
           ('s_dt_api', 'Deutsches Theater', 'html', '{"url":"https://www.deutschestheater.de/programm/"}', 360, 0),
           ('s_off_api', 'Quiet Bar', 'ical', '{"url":"https://bar.example/?ical=1"}', 360, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes, visibility) VALUES
           ('s_priv_api', 'Private Feed', 'ical', '{}', 360, 'private')`,
      ),
      env.DB.prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at)
         VALUES ('raw-api', 's_dt_api', 'x', 'h', 'text', '', '2026-01-01T00:00:00Z'),
                ('raw-priv', 's_priv_api', 'y', 'h2', 'text', '', '2026-01-01T00:00:00Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO event_sources (event_id, raw_item_id, extracted, confidence)
         VALUES ('e1', 'raw-api', '{}', 1), ('e1', 'raw-priv', '{}', 1)`,
      ),
    ]);
  });

  it('lists public sources with which start off, without signing in', async () => {
    const res = await exports.default.fetch('https://x/api/sources');
    expect(res.status).toBe(200);
    const { sources } = (await res.json()) as { sources: { id: string; defaultOff: boolean; link: string | null }[] };
    expect(sources.find((s) => s.id === 's_off_api')).toMatchObject({ defaultOff: true, link: 'https://bar.example/' });
    expect(sources.find((s) => s.id === 's_dt_api')?.defaultOff).toBe(false);
    expect(sources.map((s) => s.id)).not.toContain('s_priv_api');
  });

  it('names the public sources of an event on its page', async () => {
    const d = EventDetail.parse(await (await exports.default.fetch('https://x/api/events/hamlet')).json());
    expect(d.sources).toEqual([
      { id: 's_dt_api', name: 'Deutsches Theater', link: 'https://www.deutschestheater.de/programm/' },
    ]);
  });

  it('gives one date as an .ics file', async () => {
    const res = await exports.default.fetch('https://x/api/events/hamlet/ics?date=o1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const ics = await res.text();
    expect(ics).toContain(`DTSTART;TZID=Europe/Berlin:${inDays(3, '19:30').replace(/[-:]/g, '')}00`);
    expect(ics).toContain('SUMMARY:Hamlet');
    expect(ics).toContain('LOCATION:Deutsches Theater\\, Schumannstraße 13a');
    expect(ics).toContain('URL:https://x/e/hamlet');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect((await exports.default.fetch('https://x/api/events/hamlet/ics?date=nope')).status).toBe(404);
  });
});

describe('ftsQuery', () => {
  it('quotes words and makes the last a prefix', () => {
    expect(ftsQuery('peer gy"nt')).toBe('"peer" "gynt"*');
  });
});
