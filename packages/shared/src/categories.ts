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

export type Frequency = 'often' | 'less' | 'rarely';
/** Below these scores an event of a `less` or `rarely` category stays out of the inbox and picks. */
export const FREQUENCY_MIN_SCORE: Record<Exclude<Frequency, 'often'>, number> = { less: 60, rarely: 75 };

/**
 * Reorders a best-first list so no category holds more than `share` of the places so far, swapping only events of
 * similar relevance: the next place goes to the best remaining event within `gap` points of the top one that keeps
 * its category under the share; when none does, simply to the top one. Nothing is dropped.
 */
export function mixCategories<T extends { category: Category; score: number }>(
  items: T[],
  share = 1 / 3,
  gap = 15,
): T[] {
  const left = [...items].sort((a, b) => b.score - a.score);
  const out: T[] = [];
  const counts = new Map<Category, number>();
  while (left.length) {
    const top = left[0]!;
    const cap = Math.max(1, Math.ceil((out.length + 1) * share));
    const i = left.findIndex((it) => it.score >= top.score - gap && (counts.get(it.category) ?? 0) < cap);
    const [next] = left.splice(Math.max(0, i), 1);
    out.push(next!);
    counts.set(next!.category, (counts.get(next!.category) ?? 0) + 1);
  }
  return out;
}
