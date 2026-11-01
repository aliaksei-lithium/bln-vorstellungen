import type { AgendaItem, Category } from './schemas';
import { hasTime } from './time';

/** Typical length in minutes when a source gives no end time (clash checks, calendar export). */
export const TYPICAL_MINUTES: Partial<Record<Category, number>> = {
  club: 300,
  opera: 180,
  theatre: 150,
  concert: 150,
  dance: 120,
  cinema: 130,
  talk: 90,
  exhibition: 90,
};
export const typicalMinutes = (category: Category): number => TYPICAL_MINUTES[category] ?? 120;

const minutesOf = (local: string) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));

/**
 * Items on the same day whose time ranges overlap; returns, per occurrence id, the title it clashes with. Items
 * without a known time cannot clash.
 */
export function clashes(items: AgendaItem[]): Map<string, string> {
  const out = new Map<string, string>();
  const timed = items.filter((i) => hasTime(i.startLocal, i.category));
  for (const a of timed) {
    const aStart = minutesOf(a.startLocal);
    const aEnd = a.endLocal ? minutesOf(a.endLocal) : aStart + typicalMinutes(a.category);
    for (const b of timed) {
      if (a === b || a.startLocal.slice(0, 10) !== b.startLocal.slice(0, 10)) continue;
      const bStart = minutesOf(b.startLocal);
      const bEnd = b.endLocal ? minutesOf(b.endLocal) : bStart + typicalMinutes(b.category);
      if (aStart < bEnd && bStart < aEnd) {
        out.set(a.occurrenceId, b.title);
        break;
      }
    }
  }
  return out;
}
