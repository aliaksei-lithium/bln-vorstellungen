import { berlinToday } from '@bln/shared';
import { describe, expect, it } from 'vitest';
import { SquarespaceConfig, squarespaceAdapter } from '../src/squarespace';
import type { SourceContext } from '../src/types';

const today = berlinToday();
const at = (days: number, hourUtc: number) =>
  Date.parse(
    `${new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)}T${String(hourUtc).padStart(2, '0')}:00:00.226Z`,
  );

const ctx = (body: string): SourceContext & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    today,
    fetch: (async (u: string) => {
      urls.push(String(u));
      return new Response(body);
    }) as unknown as typeof fetch,
    toMarkdown: async (h) => h,
    log: () => {},
  };
};

describe('squarespace adapter (8MM)', () => {
  const page = {
    upcoming: [
      {
        id: 'a1',
        title: '8MM Live: Black Maracas ',
        startDate: at(5, 18),
        endDate: at(5, 19),
        body: '<p>Garage rock from <strong>Berlin</strong>.</p>',
        fullUrl: '/program/2026/11/19/8mm-live-black-maracas',
        assetUrl: 'https://images.squarespace-cdn.com/content/v1/abc/maracas.jpg',
      },
      { id: 'old', title: 'Last week', startDate: at(-7, 18), fullUrl: '/program/old' },
    ],
  };
  const config = SquarespaceConfig.parse({
    url: 'https://www.8mmbar.de/program',
    venue: { name: '8MM Bar', address: 'Schönhauser Allee 177B, 10119 Berlin' },
    category: 'concert',
  });

  it('reads the JSON view of the events page and maps upcoming events', async () => {
    const c = ctx(JSON.stringify(page));
    const r = await squarespaceAdapter.fetch(c, config, null);
    expect(c.urls[0]).toBe('https://www.8mmbar.de/program?format=json');
    expect(r.items.map((i) => i.externalId)).toEqual(['a1']);
    const [ev] = squarespaceAdapter.mapItem!(r.items[0]!, config)!;
    expect(ev).toMatchObject({
      title: '8MM Live: Black Maracas',
      description: 'Garage rock from Berlin.',
      category: 'concert',
      venue: { name: '8MM Bar' },
      urls: { official: 'https://www.8mmbar.de/program/2026/11/19/8mm-live-black-maracas' },
      imageUrl: 'https://images.squarespace-cdn.com/content/v1/abc/maracas.jpg',
    });
    // 18:00 UTC is 19:00 or 20:00 in Berlin, whole minutes.
    expect(ev!.occurrences[0]!.start).toMatch(/T(19|20):00$/);
  });
});
