import type { Category, Prefs } from './schemas';

/** English UI labels. */
export const CATEGORY_LABELS: Record<Category, string> = {
  concert: 'Concert',
  club: 'Club',
  kink: 'Sex-positive & kink',
  theatre: 'Theatre',
  opera: 'Opera',
  dance: 'Dance',
  exhibition: 'Exhibition',
  talk: 'Talk',
  cinema: 'Film',
  festival: 'Festival',
  market: 'Market',
  other: 'Other',
};

/**
 * Categories that are hidden unless a signed-in user switches them on (docs/09, 2026-11-01): never in public lists,
 * search or "more like this", and scored 0 for everyone else. The event page itself stays reachable by its link.
 */
export const OPT_IN_CATEGORIES: readonly Category[] = ['kink'];

/** The opt-in categories this user (or an anonymous visitor) does not see. */
export const hiddenCategories = (prefs?: Pick<Prefs, 'categoriesOn'> | null): Category[] =>
  OPT_IN_CATEGORIES.filter((c) => !prefs?.categoriesOn.includes(c));
