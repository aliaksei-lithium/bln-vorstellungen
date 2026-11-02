import type { EventListItem } from '@bln/shared';
import { describe, expect, it } from 'vitest';
import { dayHighlights } from './highlights';

const ev = (slug: string, over: Partial<EventListItem> = {}): EventListItem => ({
  slug,
  title: slug,
  category: 'concert',
  venueName: null,
  district: null,
  priceMin: null,
  priceMax: null,
  isFree: false,
  next: { startLocal: '2026-11-05T20:00', startUtc: '2026-11-05T19:00:00.000Z' },
  moreDates: 0,
  ...over,
});

describe('dayHighlights', () => {
  it('keeps the strongest few in time order, one exhibition at most', () => {
    const day = [
      ev('gallery-a', { category: 'exhibition', interest: 90 }),
      ev('gallery-b', { category: 'exhibition', interest: 85 }),
      ev('gallery-c', { category: 'exhibition', interest: 80 }),
      ev('punk', { interest: 70 }),
      ev('jazz', { interest: 40 }),
      ev('play', { category: 'theatre', interest: 60 }),
      ev('unscored', { image: '/api/img/x.webp' }),
    ];
    expect(dayHighlights(day, 4).map((e) => e.slug)).toEqual(['gallery-a', 'punk', 'jazz', 'play']);
  });

  it('shows a day that already fits whole', () => {
    const day = [ev('talk-a', { category: 'talk' }), ev('talk-b', { category: 'talk' })];
    expect(dayHighlights(day, 6)).toHaveLength(2);
  });

  it('prefers events with an image and several sources when nobody has scored them', () => {
    const day = [ev('plain'), ev('pictured', { image: '/i.webp' }), ev('listed', { sources: ['a', 'b'] })];
    expect(dayHighlights(day, 2).map((e) => e.slug)).toEqual(['pictured', 'listed']);
  });
});
