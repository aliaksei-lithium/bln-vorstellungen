import { describe, expect, it } from 'vitest';
import { googleCalendarUrl } from './agenda';

describe('googleCalendarUrl', () => {
  const params = (url: string): Record<string, string> =>
    Object.fromEntries(
      url
        .split('?')[1]!
        .split('&')
        .map((kv) => kv.split('=').map(decodeURIComponent)),
    );

  it('keeps Berlin wall-clock time and uses the typical length without an end', () => {
    const p = params(
      googleCalendarUrl({
        title: 'Slowdive & Friends',
        category: 'concert',
        startLocal: '2026-11-14T20:00',
        location: 'Columbiahalle, Berlin',
        url: 'https://example.org/e/slowdive',
      }),
    );
    expect(p).toMatchObject({
      action: 'TEMPLATE',
      text: 'Slowdive & Friends',
      dates: '20261114T200000/20261114T223000',
      ctz: 'Europe/Berlin',
      location: 'Columbiahalle, Berlin',
    });
  });

  it('makes an all-day entry when the source gave no time', () => {
    const p = params(
      googleCalendarUrl({ title: 'Show', category: 'exhibition', startLocal: '2026-12-31T00:00', url: 'https://x.y' }),
    );
    expect(p.dates).toBe('20261231/20270101');
    expect(p.location).toBeUndefined();
  });
});
