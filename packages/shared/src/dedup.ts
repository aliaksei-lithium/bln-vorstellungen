/** Dedup keys per docs/04: normalized(title) + venue_id + date of first occurrence. */

const STOP_WORDS = new Set(['live', 'konzert', 'concert', 'tickets', 'ticket', 'der', 'die', 'das', 'the', 'a', 'an']);

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ');
}

export function dedupKey(title: string, venueId: string | null, firstStartLocal: string): string {
  return `${normalizeTitle(title)}|${venueId ?? '-'}|${firstStartLocal.slice(0, 10)}`;
}

/** URL-safe slug, ASCII only. */
export function slugify(text: string, maxLength = 60): string {
  const s = normalizeTitle(text).replace(/ /g, '-');
  return s.slice(0, maxLength).replace(/-+$/, '') || 'event';
}
