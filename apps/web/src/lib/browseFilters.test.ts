import { describe, expect, it } from 'vitest';
import { activeCount, filterQuery, NO_FILTERS, parseFilters } from './browseFilters';

describe('parseFilters', () => {
  it('reads languages and drops unknown values', () => {
    const f = parseFilters({ category: 'theatre,circus', lang: 'en,fr,other', via: 'scans,nope' }, false);
    expect(f.category).toEqual(['theatre']);
    expect(f.lang).toEqual(['en']);
    expect(f.via).toEqual(['scans']);
  });

  it('ignores owner-only sources for anyone but the owner', () => {
    expect(parseFilters({ via: 'telegram,specials,belarusian' }, false).via).toEqual(['belarusian']);
    expect(parseFilters({ via: 'telegram,specials,belarusian' }, true).via).toEqual([
      'telegram',
      'specials',
      'belarusian',
    ]);
  });
});

describe('filterQuery and activeCount', () => {
  it('saves and counts the language with the other filters', () => {
    const f = {
      ...NO_FILTERS,
      when: 'week' as const,
      category: ['talk' as const],
      lang: ['de' as const, 'en' as const],
    };
    expect(filterQuery(f)).toBe('when=week&category=talk&lang=de%2Cen');
    expect(activeCount(f)).toBe(4);
    expect(filterQuery(NO_FILTERS)).toBe('');
    // A saved default round-trips through the address.
    expect(parseFilters(Object.fromEntries(new URLSearchParams(filterQuery(f))), false)).toEqual(f);
  });
});
