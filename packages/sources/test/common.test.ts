import { describe, expect, it } from 'vitest';
import { finalize, titleOrActs } from '../src/common';

describe('titleOrActs', () => {
  it('keeps real titles and names placeholder ones after the artists', () => {
    const acts = [{ name: 'I. S. Kalter' }];
    expect(titleOrActs('Mountains of Sand', acts)).toBe('Mountains of Sand');
    for (const t of ['N/A', 'n.a', 'n-a', 'NA', 'TBA', 't.b.a.', 'Untitled', 'Ohne Titel', '–', '']) {
      expect(titleOrActs(t, acts), t).toBe('I. S. Kalter');
    }
    expect(titleOrActs('N/A', [])).toBeNull();
    expect(titleOrActs('n-a (I. S. Kalter)', [])).toBe('I. S. Kalter');
    expect(titleOrActs('Peer Gynt (Premiere)', acts)).toBe('Peer Gynt (Premiere)');
  });

  it('drops an adapter event that has neither a title nor artists', () => {
    const ev = {
      title: 'TBA',
      lang: 'en',
      category: 'concert',
      genres: [],
      occurrences: [{ start: '2099-01-02T20:00' }],
      venue: null,
      performers: [],
      price: null,
      urls: {},
      confidence: 0.9,
      needsReview: false,
      sourceQuote: 'TBA',
    };
    expect(finalize(ev)).toBeNull();
    expect(finalize({ ...ev, performers: [{ name: 'METZ' }] })?.title).toBe('METZ');
  });
});
