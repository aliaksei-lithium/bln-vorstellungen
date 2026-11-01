import { describe, expect, it } from 'vitest';
import { parseTelegramPage, telegramAdapter, TelegramConfig } from '../src/telegram';
import type { SourceContext } from '../src/types';
import page from './fixtures/telegram.html?raw';

const ctx = (html: string): SourceContext => ({
  fetch: (async () => new Response(html)) as typeof fetch,
  toMarkdown: async (h) => h,
  today: '2026-11-02',
  log: () => {},
});

describe('telegram', () => {
  it('splits the channel preview into posts with text, photos and dates', () => {
    const posts = parseTelegramPage(page, 'berlinnoise');
    expect(posts.map((p) => p.id)).toEqual([101, 102, 103]);
    expect(posts[0]).toMatchObject({
      text: 'Sa 14.11. Noise night at Cassiopeia\nDoors 20:00, Eintritt 12 €\nwith Static Bloom',
      photos: [],
      date: '2026-11-01T10:00:00+00:00',
      url: 'https://t.me/berlinnoise/101',
    });
    expect(posts[1]!.photos).toEqual(['https://cdn4.telesco.pe/file/flyer-102.jpg']);
  });

  it('hands over only new posts: flyers as photo items, the rest bundled, chatter skipped', async () => {
    const config = TelegramConfig.parse({ channel: 'berlinnoise' });
    const first = await telegramAdapter.fetch(ctx(page), config, null);
    expect(first.cursor).toBe('103');
    expect(first.items.map((i) => i.externalId)).toEqual(['berlinnoise/102', 'berlinnoise/101-101']);
    expect(first.items[0]!.content).toContain('[Photo: https://cdn4.telesco.pe/file/flyer-102.jpg]');
    expect(first.items[1]!.content).toContain('--- Post 101, published 2026-11-01');

    const again = await telegramAdapter.fetch(ctx(page), config, first.cursor);
    expect(again.items).toEqual([]);
    expect(() => TelegramConfig.parse({ channel: 'https://t.me/x' })).toThrow();
  });
});
