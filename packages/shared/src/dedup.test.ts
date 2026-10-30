import { describe, expect, it } from 'vitest';
import { dedupKey, normalizeTitle, slugify } from './dedup';
import { ExtractedEvent } from './schemas';

describe('dedup', () => {
  it('normalizes titles', () => {
    expect(normalizeTitle('Die Zauberflöte – LIVE!')).toBe('zauberflote');
    expect(normalizeTitle('Straße der Besten')).toBe('strasse besten');
  });

  it('builds keys from title, venue and first date', () => {
    expect(dedupKey('Hamlet', 'v_dt', '2026-10-30T19:30')).toBe('hamlet|v_dt|2026-10-30');
    expect(dedupKey('HAMLET (Tickets)', 'v_dt', '2026-10-30T20:00')).toBe('hamlet|v_dt|2026-10-30');
  });

  it('slugifies', () => {
    expect(slugify('Mahler: Symphony No. 5')).toBe('mahler-symphony-no-5');
  });
});

describe('ExtractedEvent', () => {
  it('rejects events without dates', () => {
    const r = ExtractedEvent.safeParse({
      title: 'Peer Gynt',
      lang: 'de',
      category: 'theatre',
      genres: [],
      occurrences: [],
      venue: { name: 'Schaubühne' },
      performers: [],
      price: null,
      urls: {},
      confidence: 0.9,
      needsReview: false,
      sourceQuote: 'Peer Gynt, Schaubühne',
    });
    expect(r.success).toBe(false);
  });
});
