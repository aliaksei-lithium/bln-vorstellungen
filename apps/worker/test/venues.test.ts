import { env, exports } from 'cloudflare:workers';
import { berlinLocalToUtc } from '@bln/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { refreshAllNextDates } from '../src/pipeline/next-dates';

/** The venue page: its header, its events through `?venue=`, and members' interest on every list row. */

const day = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const at = `${day}T20:00`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO venues (id, name, address, district) VALUES ('v_page', 'Page Hall', 'Hallstr. 1', 'Wedding'),
         ('v_else', 'Elsewhere', NULL, 'Mitte')`,
    ),
    ...[
      ['vp_one', 'v_page'],
      ['vp_two', 'v_page'],
      ['vp_else', 'v_else'],
    ].flatMap(([id, venue]) => [
      env.DB.prepare(
        `INSERT INTO events (id, slug, title, lang, category, venue_id, dedup_key, created_by)
         VALUES (?, ?, ?, 'en', 'concert', ?, ?, 't')`,
      ).bind(id, id, id, venue, `${id}-k`),
      env.DB.prepare(
        `INSERT INTO occurrences (id, event_id, start_local, start_utc, status) VALUES (?, ?, ?, ?, 'scheduled')`,
      ).bind(`${id}_0`, id, at, berlinLocalToUtc(at)),
    ]),
    env.DB.prepare(
      `INSERT INTO users (id, name, email) VALUES ('u_vp1', 'A', 'vp1@example.org'), ('u_vp2', 'B', 'vp2@example.org')`,
    ),
    env.DB.prepare(
      `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
       VALUES ('u_vp1', 'vp_one', 90, '[]', 1, '2026-01-01T00:00:00Z'), ('u_vp2', 'vp_one', 71, '[]', 1, '2026-01-01T00:00:00Z')`,
    ),
  ]);
  await refreshAllNextDates(env.DB);
});

describe('venue page', () => {
  it('gives the venue with its count, and only its events', async () => {
    const v = await exports.default.fetch('https://x/api/venues/v_page');
    expect(v.status).toBe(200);
    expect(await v.json()).toMatchObject({ id: 'v_page', name: 'Page Hall', district: 'Wedding', upcoming: 2 });
    expect((await exports.default.fetch('https://x/api/venues/nope')).status).toBe(404);

    const res = await exports.default.fetch(`https://x/api/events?venue=v_page&from=${day}&to=${day}`);
    const { items } = (await res.json()) as { items: { slug: string; interest?: number }[] };
    expect(items.map((i) => i.slug).sort()).toEqual(['vp_one', 'vp_two']);
    // Members' average, rounded; nothing for an event nobody's taste has scored.
    expect(items.find((i) => i.slug === 'vp_one')?.interest).toBe(81);
    expect(items.find((i) => i.slug === 'vp_two')?.interest).toBeUndefined();
  });
});
