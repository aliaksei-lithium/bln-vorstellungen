import type { Category, Lang } from './schemas';

/**
 * Deterministic guesses for structured sources that carry no category or language. Cheap and explainable; the
 * LLM extractor (phase 3) and enrichment (phase 4) can overwrite them with better data.
 */

/** Checked in order: the first category with a keyword hit wins, so specific ones come before broad ones. */
const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ['opera', /\b(oper|opera|operette|operetta)\b/i],
  ['dance', /\b(tanz|dance|ballett?|choreogra\w*)\b/i],
  ['cinema', /\b(film|kino|cinema|screening|filmvorführung|movie)\b/i],
  ['exhibition', /\b(ausstellung|exhibition|vernissage|finissage|galerie|gallery)\b/i],
  [
    'market',
    /\b(floh|trödel|weihnachts|wochen|kunst|design|nacht|bauern)markt\b|\b(flea|christmas|night|farmers'?|design|vintage|craft) market\b|\b(bazaar|basar)\b/i,
  ],
  ['festival', /\bfestival\b/i],
  ['club', /\b(party|rave|dj|djs|techno|clubnacht|club night|house music|disco)\b/i],
  [
    'talk',
    /\b(talk|vortrag|lecture|lesung|reading|diskussion|discussion|panel|podium\w*|gespräch|workshop|book launch|buchvorstellung|seminar|meetup)\b/i,
  ],
  [
    'concert',
    /\b(konzert|concert|live music|band|jazz|orchester|orchestra|symphon\w*|sinfoni\w*|quartett?|recital|songwriter|gig|chor|choir)\b/i,
  ],
  ['theatre', /\b(theater|theatre|schauspiel|bühne|kabarett|cabaret|comedy|improv|musical|premiere)\b/i],
];

export function guessCategory(text: string): Category | null {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(text)) return cat;
  return null;
}

const DE = /\b(der|die|das|und|mit|ist|nicht|für|ein|eine|auf|im|zum|zur|wir|sie|uhr)\b/gi;
const EN = /\b(the|and|with|is|not|for|a|an|on|we|you|of|to|this)\b/gi;

/** Original language of a text, by counting function words. Returns null when there is too little to tell. */
export function guessLang(text: string): Lang | null {
  const de = text.match(DE)?.length ?? 0;
  const en = text.match(EN)?.length ?? 0;
  if (de + en < 3) return null;
  if (de > en * 1.2) return 'de';
  if (en > de * 1.2) return 'en';
  return null;
}

/**
 * Neighbourhoods offered as list filters. A venue's district is set by hand for seeded venues, from the postal code
 * for new ones, and by geocoding later (phase 4).
 */
export const DISTRICTS = [
  'Mitte',
  'Kreuzberg',
  'Friedrichshain',
  'Prenzlauer Berg',
  'Neukölln',
  'Charlottenburg',
  'Wilmersdorf',
  'Schöneberg',
  'Tiergarten',
  'Moabit',
  'Wedding',
] as const;
export type District = (typeof DISTRICTS)[number];

/** Postal codes that sit (almost) entirely in one neighbourhood. Codes that straddle a border are left out. */
const PLZ_DISTRICT: Record<string, District> = {};
const plz = (d: District, codes: string) => codes.split(' ').forEach((c) => (PLZ_DISTRICT[c] = d));
plz('Mitte', '10115 10117 10119 10178 10179');
plz('Kreuzberg', '10961 10963 10965 10967 10969 10997 10999');
plz('Friedrichshain', '10243 10245 10247 10249');
plz('Prenzlauer Berg', '10405 10407 10409 10435 10437 10439');
plz('Neukölln', '12043 12045 12047 12049 12051 12053 12055 12057 12059');
plz('Charlottenburg', '10585 10587 10589 10623 10625 10627 10629 14057 14059');
plz('Wilmersdorf', '10707 10709 10711 10713 10715 10717 10719');
plz('Schöneberg', '10777 10779 10781 10783 10823 10825 10827 10829');
plz('Tiergarten', '10785 10787');
plz('Moabit', '10551 10553 10555 10559');
plz('Wedding', '13347 13349 13351 13353 13357 13359');

/** "Ackerstraße 168, 10115 Berlin" → "Mitte". Null when the address has no unambiguous Berlin postal code. */
export function districtFromAddress(address: string | null | undefined): District | null {
  const code = address?.match(/\b(1[0-4]\d{3})\b/)?.[1];
  return (code && PLZ_DISTRICT[code]) || null;
}
