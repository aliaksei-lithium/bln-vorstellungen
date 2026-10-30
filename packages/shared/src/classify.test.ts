import { describe, expect, it } from 'vitest';
import { districtFromAddress, guessCategory, guessLang } from './classify';
import { cleanTitle, decodeEntities, htmlToText } from './text';

describe('guessCategory', () => {
  it.each([
    ['Die Zauberflöte – Oper in zwei Aufzügen', 'opera'],
    ['Halloween Party with DJs', 'club'],
    ['Lesung: Neue Berliner Stimmen', 'talk'],
    ['Late Jazz Session', 'concert'],
    ['Vernissage: Fotografie der 20er Jahre', 'exhibition'],
    ['Weihnachtsmarkt am Gendarmenmarkt', 'market'],
    ['Kabarett am Abend', 'theatre'],
  ] as const)('%s → %s', (text, cat) => {
    expect(guessCategory(text)).toBe(cat);
  });

  it('does not read street names or business jargon as markets', () => {
    expect(guessCategory('Coffee & Lift at Holmes Place Gendarmenmarkt')).toBeNull();
    expect(guessCategory('GTM Hackathon: go-to-market for founders')).toBeNull();
    expect(guessCategory('Vintage Market at Arena')).toBe('market');
  });

  it('returns null when nothing matches', () => {
    expect(guessCategory('Community Run at Café TonTon')).toBeNull();
  });
});

describe('guessLang', () => {
  it('tells German from English by function words', () => {
    expect(guessLang('Die Arbeit bespielt das Foyer und den großen Saal mit Musik')).toBe('de');
    expect(guessLang('Join us for the first party of the season and bring a friend')).toBe('en');
    expect(guessLang('Hamlet')).toBeNull();
  });
});

describe('districtFromAddress', () => {
  it('maps unambiguous Berlin postal codes', () => {
    expect(districtFromAddress('Ackerstraße 168, 10115 Berlin, Germany')).toBe('Mitte');
    expect(districtFromAddress('Skalitzer Straße 85-86, 10997 Berlin')).toBe('Kreuzberg');
    expect(districtFromAddress('Hauptstraße 1, 80331 München')).toBeNull();
    expect(districtFromAddress(null)).toBeNull();
  });
});

describe('text', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('ANCHORS &#038; HEARTS &quot;live&quot; &auml;')).toBe('ANCHORS & HEARTS "live" ä');
  });

  it('turns HTML into plain text with line breaks', () => {
    expect(htmlToText('<p>Heute <strong>mit</strong>:</p><p>¡ Ya voy !<br />Miraflores</p>')).toBe(
      'Heute mit:\n¡ Ya voy !\nMiraflores',
    );
  });

  it('makes one-line titles from multi-line HTML', () => {
    expect(cleanTitle('JAZZFEST &quot;DREAM&quot;:&lt;br&gt;TAG 3')).toBe('JAZZFEST "DREAM" · TAG 3');
  });
});
