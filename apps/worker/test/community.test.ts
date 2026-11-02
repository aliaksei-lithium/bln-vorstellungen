import { env, exports } from 'cloudflare:workers';
import type { ExtractedEvent } from '@bln/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { VenueIndex, resolveEvent } from '../src/pipeline/resolve';

/** Community filters: Browse's "Belarusian" takes RAZAM's events and any event about Belarus, in four languages. */

const day = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const ev = (title: string, description: string): ExtractedEvent => ({
  title,
  description,
  lang: 'en',
  category: 'concert',
  genres: [],
  occurrences: [{ start: `${day}T20:00` }],
  venue: { name: 'Community Hall' },
  performers: [],
  price: null,
  urls: {},
  confidence: 0.9,
  needsReview: false,
  sourceQuote: title,
});

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sources (id, name, type, config, schedule_minutes, community) VALUES
         ('s_by', 'RAZAM', 'ical', '{}', 360, 'belarusian'), ('s_other', 'Other', 'ical', '{}', 360, NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at) VALUES
         ('raw-by', 's_by', 'a', 'h-by', 'ical', 'x', '2026-01-01T00:00:00Z'),
         ('raw-other', 's_other', 'b', 'h-other', 'ical', 'x', '2026-01-01T00:00:00Z')`,
    ),
  ]);
  const venues = await VenueIndex.load(env.DB);
  const prov = (rawItemId: string) => ({ rawItemId, model: 'm', promptVersion: null, createdBy: 'source' });
  await resolveEvent(env.DB, venues, ev('Karova Belaya live', 'A concert programme.'), prov('raw-by'));
  await resolveEvent(env.DB, venues, ev('Сабраныя нанова', 'Паэтычны перформанс пра Беларусь.'), prov('raw-other'));
  await resolveEvent(env.DB, venues, ev('Lesung', 'Neue Literatur aus Weißrussland.'), prov('raw-other'));
  await resolveEvent(env.DB, venues, ev('Minsk Underground', 'Noise from the capital.'), prov('raw-other'));
  await resolveEvent(env.DB, venues, ev('Unrelated jazz night', 'Trio from Hamburg.'), prov('raw-other'));
});

describe('Belarusian filter', () => {
  it("lists the community's events and events about Belarus, nothing else", async () => {
    const res = await exports.default.fetch(`https://x/api/events?via=belarusian&from=${day}&to=${day}`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { title: string }[] };
    expect(items.map((i) => i.title).sort()).toEqual(
      ['Karova Belaya live', 'Lesung', 'Minsk Underground', 'Сабраныя нанова'].sort(),
    );
  });
});
