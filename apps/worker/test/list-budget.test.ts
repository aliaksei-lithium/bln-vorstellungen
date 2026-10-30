import { EventsResponse, berlinLocalToUtc } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PAGE_SIZE } from '../src/api/events';
import { refreshAllNextDates } from '../src/pipeline/next-dates';

const EVENTS = 120;
const DATES = 6;
const DAY = 86_400_000;
const local = (days: number, hh: number) =>
  `${new Date(Date.now() + days * DAY).toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:00`;

beforeAll(async () => {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO venues (id, name, district) VALUES ('v1', 'Volksbühne', 'Mitte'), ('v2', 'SO36', 'Kreuzberg')`,
    ),
  ];
  for (let i = 0; i < EVENTS; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (id, slug, title, lang, category, venue_id, dedup_key, created_by) VALUES (?, ?, ?, 'de', ?, ?, ?, 'test')`,
      ).bind(`e${i}`, `event-${i}`, `Event ${i}`, i % 3 ? 'concert' : 'theatre', i % 2 ? 'v1' : 'v2', `k${i}`),
    );
    for (let d = 0; d < DATES; d++) {
      const l = local(1 + ((i + d * 7) % 50), 18 + (i % 4));
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`,
        ).bind(`o${i}-${d}`, `e${i}`, l, berlinLocalToUtc(l)),
      );
    }
  }
  await env.DB.batch(stmts);
  await refreshAllNextDates(env.DB);
});

async function page(query = '') {
  const res = await exports.default.fetch(`https://x/api/events${query}`);
  expect(res.status).toBe(200);
  return { body: EventsResponse.parse(await res.json()), rowsRead: Number(res.headers.get('x-d1-rows-read')) };
}

describe('public list row budget (docs/08 phase 1 checklist)', () => {
  it('reads fewer than 500 rows per list request', async () => {
    const { body, rowsRead } = await page();
    expect(body.items).toHaveLength(PAGE_SIZE);
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(500);
  });

  it('pages through every event exactly once, each at its next date', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body, rowsRead } = await page(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      expect(rowsRead).toBeLessThan(500);
      seen.push(...body.items.map((i) => i.slug));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(EVENTS);
    expect(new Set(seen).size).toBe(EVENTS);
  });

  it('keeps the budget with a category filter', async () => {
    const { body, rowsRead } = await page('?category=theatre');
    expect(body.items).toHaveLength(EVENTS / 3);
    expect(body.items.every((i) => i.category === 'theatre')).toBe(true);
    expect(rowsRead).toBeLessThan(500);
  });

  it('keeps the budget for a date window and lists each event at its first date in it', async () => {
    const from = local(10, 0).slice(0, 10);
    const to = local(16, 0).slice(0, 10);
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const { body, rowsRead } = await page(
        `?from=${from}&to=${to}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(rowsRead).toBeLessThan(500);
      expect(body.items.every((i) => i.next.startLocal >= from && i.next.startLocal <= `${to}T23:59`)).toBe(true);
      seen.push(...body.items.map((i) => i.slug));
      cursor = body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor from the other plan', async () => {
    const { body } = await page();
    const res = await exports.default.fetch(
      `https://x/api/events?from=2099-01-01&cursor=${encodeURIComponent(body.nextCursor!)}`,
    );
    expect(res.status).toBe(400);
  });
});
