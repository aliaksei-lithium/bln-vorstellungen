import { describe, expect, it } from 'vitest';
import { LANG_CATEGORIES, langMatches } from './categories';
import { EventsQuery } from './schemas';

describe('langMatches', () => {
  it('passes everything when no language is chosen', () => {
    expect(langMatches({ category: 'theatre', lang: 'de' })).toBe(true);
    expect(langMatches({ category: 'theatre', lang: 'de' }, [])).toBe(true);
  });

  it('filters language-bound categories by language', () => {
    for (const category of LANG_CATEGORIES) {
      expect(langMatches({ category, lang: 'en' }, ['en'])).toBe(true);
      expect(langMatches({ category, lang: 'de' }, ['en'])).toBe(false);
      expect(langMatches({ category, lang: 'de' }, ['de', 'en'])).toBe(true);
    }
  });

  it('never filters out categories where language does not matter', () => {
    for (const category of ['concert', 'club', 'exhibition', 'dance', 'festival', 'market', 'other'] as const) {
      expect(langMatches({ category, lang: 'de' }, ['en'])).toBe(true);
    }
  });

  it('never filters out events in another or an unknown language', () => {
    expect(langMatches({ category: 'theatre', lang: 'other' }, ['en'])).toBe(true);
    expect(langMatches({ category: 'talk', lang: null }, ['de'])).toBe(true);
    expect(langMatches({ category: 'cinema' }, ['de'])).toBe(true);
  });
});

describe('EventsQuery.lang', () => {
  it('reads a comma list of de and en, and rejects others', () => {
    expect(EventsQuery.parse({ lang: 'de,en' }).lang).toEqual(['de', 'en']);
    expect(EventsQuery.safeParse({ lang: 'other' }).success).toBe(false);
    expect(EventsQuery.safeParse({ lang: 'fr' }).success).toBe(false);
  });
});
