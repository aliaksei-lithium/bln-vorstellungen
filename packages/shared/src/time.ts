/** Europe/Berlin wall-clock helpers. Berlin has DST, so never add fixed offsets by hand. */

export const TZ = 'Europe/Berlin';
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function berlinParts(ms: number) {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of Berlin from UTC at the given instant, in ms (3_600_000 in winter, 7_200_000 in summer). */
function offsetAt(ms: number): number {
  const p = berlinParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * "2026-10-30T20:00" (Berlin) → "2026-10-30T19:00:00.000Z".
 * Ambiguous autumn times (02:00–02:59 on the last Sunday of October) resolve to the first, summer-time instant.
 */
export function berlinLocalToUtc(local: string): string {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Invalid local date-time: ${local}`);
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const first = asUtc - offsetAt(asUtc - 2 * 3_600_000);
  const second = asUtc - offsetAt(first);
  return new Date(Math.min(first, second)).toISOString();
}

/** UTC instant → "2026-10-30T20:00" in Berlin. */
export function utcToBerlinLocal(utc: string | Date): string {
  const p = berlinParts(new Date(utc).getTime());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-10-30T20:00" → "Fr 30.10." */
export function formatDay(local: string): string {
  const [y, m, d] = local.slice(0, 10).split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${local.slice(8, 10)}.${local.slice(5, 7)}.`;
}

/** "2026-10-30T20:00" → "20:00" */
export const formatTime = (local: string): string => local.slice(11, 16);

/** "2026-10-30T20:00" → "Fr 30.10. · 20:00" */
export const formatDateTime = (local: string): string => `${formatDay(local)} · ${formatTime(local)}`;

/** Berlin price conventions: "frei", "ab 18 €", "12 €". */
export function formatPrice(p: { isFree: boolean; priceMin?: number | null; priceMax?: number | null }): string | null {
  if (p.isFree) return 'frei';
  if (p.priceMin == null) return null;
  const n = Number.isInteger(p.priceMin) ? String(p.priceMin) : p.priceMin.toFixed(2).replace('.', ',');
  return p.priceMax != null && p.priceMax > p.priceMin ? `ab ${n} €` : `${n} €`;
}

/** Today's date in Berlin as YYYY-MM-DD. */
export const berlinToday = (now: Date = new Date()): string => utcToBerlinLocal(now).slice(0, 10);
