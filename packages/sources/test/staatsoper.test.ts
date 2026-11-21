import { describe, expect, it } from 'vitest';
import { StaatsoperConfig, firstOfNextMonth, parseTermine, staatsoperAdapter } from '../src/staatsoper';
import type { SourceContext } from '../src/types';
import firstPage from './fixtures/staatsoper.html?raw';
import dec01 from './fixtures/staatsoper-01-12.html?raw';
import nov23 from './fixtures/staatsoper-23-11.html?raw';

// Trimmed copies of the real pages (2026-11-21): the first page shows today and tomorrow and links the next week
// as a fragment; 23-11's fragment ends the month without a link; December's links a week that is not there (404).
const BASE = 'https://www.staatsoper-berlin.de';
const pages: Record<string, string> = {
  [`${BASE}/de/spielplan/`]: firstPage,
  [`${BASE}/de/spielplan/_f/23-11-2026`]: nov23,
  [`${BASE}/de/spielplan/_f/01-12-2026`]: dec01,
};

const ctx = (requested: string[] = []): SourceContext => ({
  today: '2026-11-21',
  fetch: (async (url: string) => {
    requested.push(url);
    return pages[url] ? new Response(pages[url]) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch,
  toMarkdown: async (h) => h,
  log: () => {},
});

const config = StaatsoperConfig.parse({
  url: `${BASE}/de/spielplan/`,
  venue: { name: 'Staatsoper Unter den Linden', address: 'Unter den Linden 7, 10117 Berlin' },
  category: 'opera',
  lang: 'de',
});

async function run() {
  const requested: string[] = [];
  const r = await staatsoperAdapter.fetch(ctx(requested), config, null);
  const events = r.items.flatMap((i) => staatsoperAdapter.mapItem!(i, config) ?? []);
  return { r, events, requested, byTitle: (t: string) => events.filter((e) => e.title === t) };
}

describe('staatsoper adapter', () => {
  it('reads every performance on a page', () => {
    const t = parseTermine(firstPage);
    expect(t.map((x) => [x.start, x.title])).toEqual([
      ['2026-11-21T19:00', 'La Calisto'],
      ['2026-11-22T11:00', 'Kinderkonzert II'],
      ['2026-11-22T12:30', 'Kinderkonzert II'],
      ['2026-11-22T18:00', 'L’incoronazione di Poppea'],
    ]);
    expect(t[1]).toMatchObject({ place: 'Apollosaal', soldOut: true });
    expect(t[2]).toMatchObject({ soldOut: false, prices: [8, 4] });
    // "85 70 60 — 36 25 11 9": a tier not on sale that night is a dash.
    expect(t[3]!.prices).toEqual([85, 70, 60, 36, 25, 11, 9]);
    expect(t[3]!.cast[0]).toEqual({ name: 'Diego Fasolis', role: 'Musikalische Leitung' });
  });

  it('follows the weekly fragments, jumps to the next month at a month end, stops at a 404', async () => {
    const { requested } = await run();
    expect(requested).toEqual([
      `${BASE}/de/spielplan/`,
      `${BASE}/de/spielplan/_f/23-11-2026`,
      `${BASE}/de/spielplan/_f/01-12-2026`,
      `${BASE}/de/spielplan/_f/08-12-2026`,
    ]);
    expect(firstOfNextMonth('2026-12-31')).toBe('01-01-2027');
  });

  it('makes one event per production with all its dates', async () => {
    const { byTitle } = await run();
    const [poppea] = byTitle('L’incoronazione di Poppea');
    expect(poppea).toMatchObject({
      category: 'opera',
      venue: { name: 'Staatsoper Unter den Linden' },
      occurrences: [{ start: '2026-11-22T18:00' }, { start: '2026-11-24T19:00' }],
      price: { currency: 'EUR', min: 9, max: 85 },
      urls: { official: `${BASE}/de/veranstaltungen/l-incoronazione-di-poppea.94/` },
      description: 'Claudio Monteverdi · Barocktage 2026',
    });
    expect(poppea!.performers.length).toBeGreaterThan(0);
    const [kids] = byTitle('Kinderkonzert II');
    expect(kids).toMatchObject({
      category: 'concert',
      occurrences: [
        { start: '2026-11-22T11:00', note: 'Apollosaal · ausverkauft' },
        { start: '2026-11-22T12:30', note: 'Apollosaal' },
      ],
    });
  });

  it('leaves out school performances and guest tours abroad', async () => {
    const { events, byTitle } = await run();
    expect(events.some((e) => /Gastspiel/.test(e.title))).toBe(false);
    // Kinderkonzert II also had a school date on 23.11.
    expect(byTitle('Kinderkonzert II')[0]!.occurrences).toHaveLength(2);
  });

  it('puts concerts elsewhere at their own hall and cleans hyphenation from titles', async () => {
    const { byTitle } = await run();
    const [sym] = byTitle('Symphoniekonzert III');
    expect(sym).toMatchObject({
      category: 'concert',
      venue: { name: 'Philharmonie Berlin' },
      occurrences: [{ start: '2026-12-09T20:00', note: 'Großer Saal' }],
    });
    expect(byTitle('Die Entführung aus dem Serail')[0]!.category).toBe('opera');
    const [live] = byTitle('Staatsoper für alle - Live-Übertragung: Die Zarenbraut');
    expect(live).toMatchObject({ venue: { name: 'Bebelplatz' }, price: { free: true } });
  });

  it('drops dates before today', async () => {
    const requested: string[] = [];
    const later = { ...ctx(requested), today: '2026-11-23' };
    const r = await staatsoperAdapter.fetch(later, config, null);
    const titles = r.items.flatMap((i) => staatsoperAdapter.mapItem!(i, config) ?? []).map((e) => e.title);
    expect(titles).not.toContain('La Calisto');
    expect(titles).not.toContain('Kinderkonzert II');
  });
});
