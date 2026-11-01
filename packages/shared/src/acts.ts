import type { ExtractedEvent } from './schemas';

/** Artist names compared the way people write them: case, accents, "The" and punctuation do not count. */
export const artistKey = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const CONCERT_TYPES = new Set(['concert', 'club', 'festival']);

/**
 * The acts of an event to look up on Spotify: its performers, or for a concert-type event without any, the
 * headliner from the title ("Royal Blood: Tour 2027" → "Royal Blood").
 */
export function actsOf(e: Pick<ExtractedEvent, 'title' | 'category' | 'performers'>): string[] {
  const names = e.performers.map((p) => p.name.trim()).filter(Boolean);
  if (names.length) return [...new Map(names.map((n) => [artistKey(n), n])).values()];
  if (!CONCERT_TYPES.has(e.category)) return [];
  const head = e.title.split(/\s+[-–|]\s+|:\s/)[0]!.trim();
  return head ? [head] : [];
}
