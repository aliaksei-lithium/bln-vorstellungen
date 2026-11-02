import type { Category, EventListItem } from '@bln/shared';

/** Events a compact day shows: the strongest few, so a day with fifty listings stays readable. */
export const PER_DAY = 6;

/**
 * At most this many per category in a compact day. Exhibitions and talks crowd the lists (one gallery-openings
 * calendar lists a dozen a day), so they get one place each; the rest may take three.
 */
const CAP: Partial<Record<Category, number>> = { exhibition: 1, talk: 1, market: 1, other: 1 };
const DEFAULT_CAP = 3;

/**
 * One day's highlights, in the day's own time order: ranked by members' interest (their average score), then by
 * having an image, then by being listed by several sources; capped per category.
 */
export function dayHighlights(items: EventListItem[], max = PER_DAY): EventListItem[] {
  // A day that already fits is shown whole.
  if (items.length <= max) return items;
  const ranked = [...items].sort(
    (a, b) =>
      (b.interest ?? -1) - (a.interest ?? -1) ||
      Number(!!b.image) - Number(!!a.image) ||
      (b.sources?.length ?? 0) - (a.sources?.length ?? 0),
  );
  const perCategory = new Map<Category, number>();
  const kept = new Set<EventListItem>();
  for (const it of ranked) {
    if (kept.size >= max) break;
    const n = perCategory.get(it.category) ?? 0;
    if (n >= (CAP[it.category] ?? DEFAULT_CAP)) continue;
    perCategory.set(it.category, n + 1);
    kept.add(it);
  }
  return items.filter((it) => kept.has(it));
}
