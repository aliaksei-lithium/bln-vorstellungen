import { describe, expect, it } from 'vitest';
import { berlinLocalToUtc, formatDateTime, formatPrice, utcToBerlinLocal } from './time';

describe('Berlin time', () => {
  it('converts winter and summer local times', () => {
    expect(berlinLocalToUtc('2026-12-10T20:00')).toBe('2026-12-10T19:00:00.000Z');
    expect(berlinLocalToUtc('2026-07-10T20:00')).toBe('2026-07-10T18:00:00.000Z');
  });

  it('handles the DST switch days', () => {
    // 2026-10-25: clocks go back 03:00 → 02:00. 02:30 happens twice; pick the first (summer) instant.
    expect(berlinLocalToUtc('2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z');
    expect(berlinLocalToUtc('2026-10-25T20:00')).toBe('2026-10-25T19:00:00.000Z');
    // 2026-03-29: clocks jump 02:00 → 03:00.
    expect(berlinLocalToUtc('2026-03-29T20:00')).toBe('2026-03-29T18:00:00.000Z');
  });

  it('round-trips', () => {
    for (const l of ['2026-01-01T00:00', '2026-06-21T23:59', '2026-10-30T19:30']) {
      expect(utcToBerlinLocal(berlinLocalToUtc(l))).toBe(l);
    }
  });

  it('formats the Berlin way', () => {
    expect(formatDateTime('2026-10-30T20:00')).toBe('Fr 30.10. · 20:00');
    expect(formatPrice({ isFree: true })).toBe('frei');
    expect(formatPrice({ isFree: false, priceMin: 18, priceMax: 64 })).toBe('ab 18 €');
    expect(formatPrice({ isFree: false, priceMin: 12 })).toBe('12 €');
    expect(formatPrice({ isFree: false, priceMin: 9.5, priceMax: 12 })).toBe('ab 9,50 €');
  });
});
