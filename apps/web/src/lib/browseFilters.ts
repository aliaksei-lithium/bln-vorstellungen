import { Category, LangChoice, Via } from '@bln/shared';
import type { When } from './dates';

/** Within a group, choices add up: any of them matches (concert or theatre, Wedding or Mitte, German or English). */
export type Filters = { when: When; category: Category[]; district: string[]; via: Via[]; lang: LangChoice[] };
export const NO_FILTERS: Filters = { when: 'all', category: [], district: [], via: [], lang: [] };

/** The address keys the filters live in (besides `q`), also the keys of a saved default. */
export const FILTER_KEYS = ['when', 'category', 'district', 'via', 'lang'] as const;

/**
 * Filters only the owner sees (docs/09, 2026-11-21): the Telegram channels and Berlin specials are the owner's own
 * sources, not offered to others. For anyone else they are ignored when they come in a link or a saved default.
 */
export const OWNER_ONLY_VIA: readonly Via[] = ['telegram', 'specials'];
export const viaAllowed = (v: Via, isOwner: boolean) => isOwner || !OWNER_ONLY_VIA.includes(v);

const list = (s?: string) => (s ? s.split(',').filter(Boolean) : []);
const joined = (a: readonly string[]) => (a.length ? a.join(',') : undefined);

/** The filters in an address; unknown values, and owner-only ones for anyone else, are dropped. */
export function parseFilters(
  search: { when?: When; category?: string; district?: string; via?: string; lang?: string },
  isOwner: boolean,
): Filters {
  return {
    when: search.when ?? 'all',
    category: list(search.category).filter((c): c is Category => Category.safeParse(c).success),
    district: list(search.district),
    via: list(search.via).filter((v): v is Via => Via.safeParse(v).success && viaAllowed(v as Via, isOwner)),
    lang: list(search.lang).filter((l): l is LangChoice => LangChoice.safeParse(l).success),
  };
}

/** Filters as address values (undefined when unset). */
export const filterSearch = (f: Filters) => ({
  when: f.when === 'all' ? undefined : f.when,
  category: joined(f.category),
  district: joined(f.district),
  via: joined(f.via),
  lang: joined(f.lang),
});

/** These filters as the address query they live in, for saving as the default ("" when nothing is set). */
export const filterQuery = (f: Filters) =>
  new URLSearchParams(Object.entries(filterSearch(f)).filter((e): e is [string, string] => !!e[1])).toString();

/** How many filters are on, for the badge on the Filter button. */
export const activeCount = (f: Filters) =>
  (f.when !== 'all' ? 1 : 0) + f.category.length + f.via.length + f.district.length + f.lang.length;
