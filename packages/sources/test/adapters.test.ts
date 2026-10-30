import { berlinToday, utcToBerlinLocal } from '@bln/shared';
import { describe, expect, it } from 'vitest';
import clubHtml from './fixtures/club.html?raw';
import feedXml from './fixtures/feed.xml?raw';
import jazzHtml from './fixtures/jazzclub.html?raw';
import lumaIcs from './fixtures/luma.ics?raw';
import theatreHtml from './fixtures/theatre.html?raw';
import venueIcs from './fixtures/venue.ics?raw';
import { isPlaceholder, pickCategory, toBerlinLocal } from '../src/common';
import { expandRRule, icalAdapter, IcalConfig } from '../src/ical';
import { extractJsonLd, jsonldAdapter, JsonLdConfig } from '../src/jsonld';
import { parseFeed, rssAdapter, RssConfig } from '../src/rss';
import type { FetchResult, SourceAdapter, SourceContext } from '../src/types';

const DAY = 86_400_000;
const today = berlinToday();
const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Fixtures use {{D+n}} (YYYYMMDD) and {{ISO+n}} (YYYY-MM-DD) so their dates stay in the future. */
const fill = (s: string) =>
  s
    .replace(/\{\{D\+(\d+)\}\}/g, (_, n: string) => plus(Number(n)).replace(/-/g, ''))
    .replace(/\{\{ISO\+(\d+)\}\}/g, (_, n: string) => plus(Number(n)));

function ctxFor(body: string, headers: Record<string, string> = {}): SourceContext & { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  return {
    calls,
    today,
    fetch: (async (_url: string, init: RequestInit) => {
      calls.push(init);
      const h = new Headers(init.headers);
      if (h.get('if-none-match') === '"v1"') return new Response(null, { status: 304 });
      return new Response(fill(body), { headers });
    }) as typeof fetch,
    toMarkdown: async (html) => html,
    log: () => {},
  };
}

async function run<C>(adapter: SourceAdapter<C>, config: C, body: string): Promise<FetchResult> {
  return adapter.fetch(ctxFor(body), config, null);
}

const mapAll = <C>(adapter: SourceAdapter<C>, config: C, r: FetchResult) =>
  r.items.flatMap((i) => adapter.mapItem?.(i, config) ?? []);

describe('toBerlinLocal', () => {
  it.each([
    ['2099-11-20T19:00:00.000Z', '2099-11-20T20:00'],
    ['2099-07-10T18:00:00Z', '2099-07-10T20:00'],
    ['2099-11-20T20:00+1:00', '2099-11-20T20:00'],
    ['2099-11-20T20:00:00+0100', '2099-11-20T20:00'],
    ['2099-11-20T20:00', '2099-11-20T20:00'],
  ])('%s → %s', (input, local) => {
    expect(toBerlinLocal(input)?.local).toBe(local);
  });

  it('marks date-only values and rejects junk', () => {
    expect(toBerlinLocal('2099-11-20')).toEqual({ local: '2099-11-20T00:00', dateOnly: true });
    expect(toBerlinLocal('next friday')).toBeNull();
  });
});

describe('classification helpers', () => {
  it('skips closing-day placeholders', () => {
    expect(isPlaceholder('HEUTE GESCHLOSSEN - TODAY CLOSED')).toBe(true);
    expect(isPlaceholder('Geschlossene Gesellschaft')).toBe(false);
  });

  it('prefers title keywords over the source default, and the default over description keywords', () => {
    expect(pickCategory(null, 'talk', 'Solidarity Party', '')).toBe('club');
    expect(pickCategory(null, 'talk', 'Solidarity evening', 'with a DJ afterwards')).toBe('talk');
    expect(pickCategory(null, undefined, 'Solidarity evening', 'with a DJ afterwards')).toBe('club');
    expect(pickCategory('opera', 'talk', 'Party', '')).toBe('opera');
  });
});

describe('ical adapter', () => {
  const config = IcalConfig.parse({ url: 'https://example.org/events/?ical=1' });

  it('keeps upcoming VEVENTs only and maps them without an LLM', async () => {
    const r = await run(icalAdapter, config, venueIcs);
    expect(r.stats).toEqual({ fetched: 4, skipped: 1 });
    const events = mapAll(icalAdapter, config, r);
    expect(events.map((e) => e.title)).toEqual(['Book Launch: Housing, Rent and the City', 'Weekly Jazz Jam']);

    const book = events[0]!;
    expect(book.occurrences).toEqual([{ start: `${plus(3)}T19:00`, end: `${plus(3)}T21:00` }]);
    expect(book.venue).toEqual({ name: 'Buchladen Rote Zora', address: 'Weichselstraße 12, 12045 Berlin' });
    expect(book.description).toContain('what the city could do');
    expect(book.price).toEqual({ currency: 'EUR', free: true });
    expect(book.category).toBe('talk');
    expect(book.lang).toBe('en');
    expect(book.urls.official).toBe('https://example.org/event/book-launch-housing/');
    expect(book.imageUrl).toBe('https://example.org/uploads/housing.jpg');
  });

  it('expands a weekly RRULE into occurrences of one event', async () => {
    const events = mapAll(icalAdapter, config, await run(icalAdapter, config, venueIcs));
    const jam = events.find((e) => e.title === 'Weekly Jazz Jam')!;
    expect(jam.occurrences.map((o) => o.start)).toEqual([1, 8, 15].map((n) => `${plus(n)}T20:00`));
    expect(jam.category).toBe('concert');
  });

  it('reads UTC times, quoted parameters and URLs in the description', async () => {
    const events = mapAll(icalAdapter, config, await run(icalAdapter, config, lumaIcs));
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.occurrences[0]!.start).toBe(utcToBerlinLocal(`${plus(2)}T19:00:00Z`));
    expect(e.venue?.name).toBe('Club of Polish Losers');
    expect(e.urls.official).toBe('https://luma.example/ih5k9mmr');
    expect(e.category).toBe('club');
  });

  it('hashes content without volatile DTSTAMP/SEQUENCE', async () => {
    const a = await run(icalAdapter, config, lumaIcs);
    const b = await run(icalAdapter, config, lumaIcs.replace('DTSTAMP:20261030T230708Z', 'DTSTAMP:20991231T000000Z'));
    expect(a.items[0]!.contentHash).toBe(b.items[0]!.contentHash);
  });

  it('sends the previous ETag and skips parsing on 304', async () => {
    const ctx = ctxFor(venueIcs);
    const r = await icalAdapter.fetch(ctx, config, JSON.stringify({ etag: '"v1"' }));
    expect(r.items).toHaveLength(0);
    expect(new Headers(ctx.calls[0]!.headers).get('if-none-match')).toBe('"v1"');
  });

  it('expands weekly rules with BYDAY, UNTIL and EXDATE on wall-clock time', () => {
    const dates = expandRRule(
      '2099-03-23T20:00',
      'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20990409T235959Z',
      new Set(['2099-03-30T20:00']),
      {
        today: '2099-03-01',
      },
    );
    expect(dates).toEqual(
      ['2099-03-23T20:00', '2099-03-26T20:00', '2099-04-02T20:00', '2099-04-06T20:00', '2099-04-09T20:00'].filter(
        (d) => d !== '2099-03-30T20:00',
      ),
    );
  });
});

describe('jsonld adapter', () => {
  it('finds Events in @graph, skips cancelled and past ones, and maps prices and performers', async () => {
    const config = JsonLdConfig.parse({
      url: 'https://theatre.example/spielplan',
      venue: { name: 'Example Theater', address: 'Am Festungsgraben 2, 10117 Berlin' },
      category: 'theatre',
      lang: 'de',
    });
    const r = await run(jsonldAdapter, config, theatreHtml);
    expect(r.stats).toEqual({ fetched: 5, skipped: 1 });
    const events = mapAll(jsonldAdapter, config, r);
    expect(events.map((e) => e.title)).toEqual([
      'Prinz Friedrich von Homburg',
      'Prinz Friedrich von Homburg',
      'Noise als Strategie — Workshop',
    ]);
    const [first, second, workshop] = events;
    expect(first!.venue).toEqual(config.venue);
    expect(first!.occurrences[0]).toMatchObject({ start: utcToBerlinLocal(`${plus(2)}T18:30:00Z`), note: 'Bühne' });
    expect(first!.performers).toEqual([{ name: 'Anna Example' }]);
    expect(first!.price).toEqual({ currency: 'EUR', min: 16, max: 16 });
    expect(second!.price).toEqual({ currency: 'EUR', min: 16, max: 38 });
    expect(second!.urls.tickets).toBe('https://tickets.example/homburg');
    expect(workshop!.price).toEqual({ currency: 'EUR', free: true });
  });

  it('copes with sloppy offsets, double-encoded titles and raw newlines in JSON', async () => {
    const config = JsonLdConfig.parse({ url: 'https://jazzclub.example/', category: 'concert' });
    const [e] = mapAll(jsonldAdapter, config, await run(jsonldAdapter, config, jazzHtml));
    expect(e!.title).toBe('A-TRANE PRÄSENTIERT JAZZFEST "DREAM" · TAG 3 MIT: ¡ Ya voy !');
    expect(e!.occurrences[0]).toEqual({ start: `${plus(1)}T20:00`, end: `${plus(1)}T23:50` });
    expect(e!.description).toBe('Heute Mit:\n¡ Ya voy !\n«Miraflores» Deutschlandpremiere');
    expect(e!.venue).toEqual({ name: 'A-Trane', address: 'Bleibtreustraße 1, 10623 Berlin' });
    expect(e!.price).toEqual({ currency: 'EUR', min: 28.5, max: 28.5 });
    expect(e!.category).toBe('concert');
  });

  it('reads arrays, ItemLists, door times and entities', async () => {
    const config = JsonLdConfig.parse({ url: 'https://club.example/' });
    const events = mapAll(jsonldAdapter, config, await run(jsonldAdapter, config, clubHtml));
    expect(events.map((e) => e.title)).toEqual(['ANCHORS & HEARTS', 'Community Run']);
    expect(events[0]!.occurrences[0]).toEqual({ start: `${plus(6)}T20:00`, doorsAt: `${plus(6)}T19:00` });
    expect(events[0]!.category).toBe('concert');
    expect(events[0]!.performers).toEqual([{ name: 'Anchors & Hearts' }]);
    expect(events[0]!.urls).toEqual({
      official: 'https://club.example/event/anchors-hearts/',
      tickets: 'https://tickets.example/anchors',
    });
    expect(events[1]!.category).toBe('other');
  });

  it('ignores blocks that are not JSON', () => {
    expect(extractJsonLd('<script type="application/ld+json">{oops</script>')).toEqual([]);
  });
});

describe('rss adapter', () => {
  it('parses entries into raw text items that wait for LLM extraction', async () => {
    const config = RssConfig.parse({ url: 'https://example.org/feed/' });
    const r = await run(rssAdapter, config, feedXml);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      externalId: 'https://example.org/?p=42',
      kind: 'markdown',
      url: 'https://example.org/2026/solidarity/',
      publishedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(r.items[0]!.content).toContain('Join us on Friday 13 November at 19:00 for a film and talk.');
    expect(rssAdapter.mapItem).toBeUndefined();
    expect(parseFeed(feedXml)[1]!.body).toBe('Plain text body');
  });
});
