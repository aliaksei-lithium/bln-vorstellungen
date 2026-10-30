import { berlinToday } from '@bln/shared';

export type When = 'all' | 'today' | 'tomorrow' | 'weekend' | 'week';

export const WHEN_LABELS: Record<When, string> = {
  all: 'All upcoming',
  today: 'Today',
  tomorrow: 'Tomorrow',
  weekend: 'Weekend',
  week: 'Next 7 days',
};

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Date range in Berlin for a "when" chip. Weekend is the coming Saturday and Sunday (or today if it is one). */
export function whenRange(when: When, today = berlinToday()): { from?: string; to?: string } {
  switch (when) {
    case 'today':
      return { from: today, to: today };
    case 'tomorrow':
      return { from: addDays(today, 1), to: addDays(today, 1) };
    case 'week':
      return { from: today, to: addDays(today, 6) };
    case 'weekend': {
      const wd = weekday(today);
      if (wd === 0) return { from: today, to: today };
      const sat = addDays(today, (6 - wd + 7) % 7);
      return { from: sat, to: addDays(sat, 1) };
    }
    default:
      return {};
  }
}

/** "Today" / "Tomorrow" label for a day header, or empty. */
export function relativeDay(date: string, today = berlinToday()): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return '';
}
