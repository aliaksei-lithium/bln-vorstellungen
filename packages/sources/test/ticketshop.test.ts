import { berlinToday } from '@bln/shared';
import { describe, expect, it } from 'vitest';
import { IcalConfig, icalAdapter } from '../src/ical';
import { parseFeed } from '../src/rss';
import { TicketShopConfig, ticketShopAdapter } from '../src/ticketshop';
import type { SourceContext } from '../src/types';

const today = berlinToday();
const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ctx = (body: string): SourceContext => ({
  today,
  fetch: (async () => new Response(body)) as unknown as typeof fetch,
  toMarkdown: async (h) => h,
  log: () => {},
});

describe('ticketshop adapter (SO36)', () => {
  const shop = {
    products: [
      {
        id: 99538,
        title: 'WALLS OF JERICHO',
        subtitle: 'Special Guest: SHÆTTERED &amp; WAVES LIKE WALLS',
        supertitle: 'Konzert',
        valid_start_on: plus(8),
        time_open: '19:30',
        time_begin: '20:00',
        sold_out_status: 'sold_out',
        city: 'Berlin',
        url: '/produkte/99538-tickets-walls-of-jericho',
        best_price: '33,10&#x202F;€',
        max_price: '33,10&#x202F;€',
        image: { url: '/uploads/so36/ticket/image/99538/woj.png' },
      },
      { id: 2, title: 'GAYHANE', supertitle: 'Party', valid_start_on: plus(9), time_begin: '23:00', city: 'Berlin' },
      {
        id: 5,
        title: 'HEISSKALT / PALEBLOOM',
        subtitle: 'Vom Stehen und Fallen & Mit Liebe Gebraut LIVE – Tour 2026',
        supertitle: 'Konzert',
        valid_start_on: plus(9),
        time_begin: '20:00',
        best_price: '0,00 €',
        city: 'Berlin',
      },
      {
        id: 3,
        title: 'BLOODY HAWK',
        supertitle: 'Konzert',
        valid_start_on: plus(10),
        time_begin: '20:00',
        city: 'Bochum',
      },
      {
        id: 4,
        title: 'OLD SHOW',
        supertitle: 'Konzert',
        valid_start_on: plus(-3),
        time_begin: '20:00',
        city: 'Berlin',
      },
    ],
  };
  const config = TicketShopConfig.parse({
    url: 'https://www.so36.com/tickets.json',
    venue: { name: 'SO36', address: 'Oranienstraße 190, 10999 Berlin' },
  });

  it('keeps upcoming shows in the city and maps them without an LLM', async () => {
    const r = await ticketShopAdapter.fetch(ctx(JSON.stringify(shop)), config, null);
    expect(r.items.map((i) => i.externalId)).toEqual(['99538', '2', '5']);
    const [woj] = ticketShopAdapter.mapItem!(r.items[0]!, config)!;
    expect(woj).toMatchObject({
      title: 'WALLS OF JERICHO',
      description: 'Special Guest: SHÆTTERED & WAVES LIKE WALLS',
      category: 'concert',
      occurrences: [{ start: `${plus(8)}T20:00`, doorsAt: `${plus(8)}T19:30`, note: 'ausverkauft' }],
      venue: { name: 'SO36' },
      performers: [{ name: 'WALLS OF JERICHO' }, { name: 'SHÆTTERED' }, { name: 'WAVES LIKE WALLS' }],
      price: { currency: 'EUR', min: 33.1 },
      urls: { official: 'https://www.so36.com/produkte/99538-tickets-walls-of-jericho' },
      imageUrl: 'https://www.so36.com/uploads/so36/ticket/image/99538/woj.png',
    });
    const [party] = ticketShopAdapter.mapItem!(r.items[1]!, config)!;
    expect(party).toMatchObject({ category: 'club', performers: [], price: null });
    const [tour] = ticketShopAdapter.mapItem!(r.items[2]!, config)!;
    expect(tour).toMatchObject({ performers: [{ name: 'HEISSKALT' }, { name: 'PALEBLOOM' }], price: null });
  });
});

describe('ical city filter (RAZAM)', () => {
  it('drops events in other cities', async () => {
    const d = plus(5).replace(/-/g, '');
    const vevent = (summary: string, location: string) =>
      `BEGIN:VEVENT\nUID:${summary}\nDTSTART;TZID=Europe/Berlin:${d}T190000\nSUMMARY:${summary}\nLOCATION:${location}\nEND:VEVENT`;
    const ics = `BEGIN:VCALENDAR\n${vevent('Concert', 'Hotel Continental\\, Elsenstr. 87\\, Berlin\\, 12435')}\n${vevent('Forum', 'Gasteig\\, München')}\n${vevent('Online', '')}\nEND:VCALENDAR`;
    const config = IcalConfig.parse({ url: 'https://razam.de/events/?ical=1', city: 'Berlin' });
    const r = await icalAdapter.fetch(ctx(ics), config, null);
    expect(r.items.map((i) => i.externalId)).toEqual(['Concert']);
  });
});

describe('ical skip (Soulcat)', () => {
  it('leaves out events whose title matches', async () => {
    const d = plus(5).replace(/-/g, '');
    const vevent = (summary: string) =>
      `BEGIN:VEVENT\nUID:${summary}\nDTSTART;TZID=Europe/Berlin:${d}T210000\nSUMMARY:${summary}\nEND:VEVENT`;
    const ics = `BEGIN:VCALENDAR\n${vevent('DJ Lobotomy - Vinyl Session')}\n${vevent('CL: BVB - Betis Sevilla (Backroom)')}\nEND:VCALENDAR`;
    const config = IcalConfig.parse({ url: 'https://soulcat-berlin.com/events/?ical=1', skip: '^CL:|bundesliga' });
    const r = await icalAdapter.fetch(ctx(ics), config, null);
    expect(r.items.map((i) => i.externalId)).toEqual(['DJ Lobotomy - Vinyl Session']);
    expect(IcalConfig.safeParse({ url: 'https://x.test/a.ics', skip: '(' }).success).toBe(false);
  });
});

describe('parseFeed', () => {
  it('reads only the newest entries when asked', () => {
    const item = (n: number) => `<item><title>Post ${n}</title><guid>${n}</guid><description>x</description></item>`;
    const xml = `<rss><channel>${[1, 2, 3, 4].map(item).join('')}</channel></rss>`;
    expect(parseFeed(xml, 2).map((e) => e.title)).toEqual(['Post 1', 'Post 2']);
    expect(parseFeed(xml)).toHaveLength(4);
  });
});
