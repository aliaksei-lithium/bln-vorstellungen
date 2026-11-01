import {
  EventDetail,
  berlinLocalToUtc,
  berlinToday,
  type EventListItem,
  type EventsQuery,
  type EventsResponse,
} from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { embedTexts } from '../ai/embed';
import { neuronsLeft } from '../ai/models';
import { loadIndex, nearest, vectorOf } from '../ai/vector-index';

/**
 * Public event reads, shared by the REST API and the MCP tools. One row per event at its next occurrence in range
 * (an event is never repeated per date). Plain SQL keeps rows read per request predictable for the D1 budget.
 */

const DAY_MS = 86_400_000;
export const PAGE_SIZE = 40;
/** A show that started a few minutes ago still counts as "next" until the cron sweep moves the event on. */
const GRACE_MS = 20 * 60_000;
/**
 * Below these cosines, matches are noise for bge-m3 on short event texts. Checked by hand on the starter sources:
 * related events score 0.45–0.6 (same house, same theme), unrelated ones below 0.4.
 */
const MIN_SEARCH = 0.45;
const MIN_SIMILAR = 0.45;

const listItem = (r: Record<string, unknown>): EventListItem => ({
  slug: String(r.slug),
  title: String(r.title),
  category: r.category as EventListItem['category'],
  venueName: (r.venue_name as string | null) ?? null,
  district: (r.district as string | null) ?? null,
  priceMin: (r.price_min as number | null) ?? null,
  priceMax: (r.price_max as number | null) ?? null,
  isFree: Boolean(r.is_free),
  next: { startLocal: String(r.next_local), startUtc: String(r.next_utc) },
  moreDates: Number(r.more_dates),
  ...(r.lang === 'de' || r.lang === 'en' ? { lang: r.lang } : {}),
});

/**
 * Two plans, both paging with a cursor and listing each event once at its next date in range:
 *  - no date window ("All upcoming"): pages through the events index on the denormalized next date, so rows
 *    read ≈ page size, however many dates the events have;
 *  - a date window (today, weekend, week): scans that window's occurrences in time order and keeps each event's
 *    first date in it. Windows are a few days, so the scan stays small.
 */
export async function listEvents(
  db: D1Database,
  q: EventsQuery,
  pageSize = PAGE_SIZE,
): Promise<EventsResponse & { rowsRead: number }> {
  const today = berlinToday();
  const from = q.from ?? today;
  const to = q.to ?? new Date(Date.parse(from) + 60 * DAY_MS).toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 60_000) * 60_000 - GRACE_MS;
  const fromUtc = from <= today ? new Date(now).toISOString() : berlinLocalToUtc(`${from}T00:00`);
  const toUtc = berlinLocalToUtc(`${to}T23:59`);
  const windowed = q.from !== undefined || q.to !== undefined;
  const cursor = parseCursor(q.cursor, windowed ? 'o' : 'e');

  const filters: string[] = [];
  const filterArgs: unknown[] = [];
  if (q.category) {
    filters.push('e.category = ?');
    filterArgs.push(q.category);
  }
  if (q.district) {
    filters.push('v.district = ?');
    filterArgs.push(q.district);
  }
  if (q.q) {
    filters.push('e.id IN (SELECT event_id FROM events_fts WHERE events_fts MATCH ?)');
    filterArgs.push(ftsQuery(q.q));
  }

  const select = `e.slug, e.title, e.lang, e.category, e.price_min, e.price_max, e.is_free, v.name AS venue_name,
                  v.district`;
  let stmt: D1PreparedStatement;
  if (!windowed) {
    const where = ["e.status = 'published'", 'e.next_start_utc >= ?', 'e.next_start_utc <= ?', ...filters];
    const args: unknown[] = [fromUtc, toUtc, ...filterArgs];
    if (cursor) {
      where.push('(e.next_start_utc > ? OR (e.next_start_utc = ? AND e.rowid > ?))');
      args.push(cursor.utc, cursor.utc, cursor.rowid);
    }
    stmt = db
      .prepare(
        `SELECT e.rowid AS cur_rowid, e.next_start_utc AS next_utc, e.next_start_local AS next_local,
                MAX(e.upcoming_count - 1, 0) AS more_dates, ${select}
           FROM events e INDEXED BY ${q.category ? 'events_category_next_idx' : 'events_next_idx'}
           LEFT JOIN venues v ON v.id = e.venue_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.next_start_utc, e.rowid
          LIMIT ?`,
      )
      .bind(...args, pageSize + 1);
  } else {
    const where = ['o.start_utc >= ?', 'o.start_utc <= ?', "o.status != 'cancelled'", "e.status = 'published'"];
    const args: unknown[] = [fromUtc, toUtc];
    if (cursor) {
      where.push('(o.start_utc > ? OR (o.start_utc = ? AND o.rowid > ?))');
      args.push(cursor.utc, cursor.utc, cursor.rowid);
    }
    where.push(...filters);
    args.push(...filterArgs);
    // Keyed on e.id so SQLite runs it after the cheaper event filters, not for every scanned date.
    where.push(`NOT EXISTS (SELECT 1 FROM occurrences o2 WHERE o2.event_id = e.id AND o2.start_utc >= ?
                  AND o2.start_utc < o.start_utc AND o2.status != 'cancelled')`);
    args.push(fromUtc);
    stmt = db
      .prepare(
        `SELECT o.rowid AS cur_rowid, o.start_utc AS next_utc, o.start_local AS next_local,
                MAX(e.upcoming_count - 1, 0) AS more_dates, ${select}
           -- Occurrences by start_utc as the outer loop, so LIMIT stops the scan early.
           FROM occurrences o INDEXED BY occurrences_start_idx
           CROSS JOIN events e ON e.id = o.event_id
           LEFT JOIN venues v ON v.id = e.venue_id
          WHERE ${where.join(' AND ')}
          ORDER BY o.start_utc, o.rowid
          LIMIT ?`,
      )
      .bind(...args, pageSize + 1);
  }

  const res = await stmt.all<Record<string, unknown>>();
  const rows = res.results.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(listItem),
    nextCursor:
      res.results.length > pageSize && last
        ? `${windowed ? 'o' : 'e'}|${String(last.next_utc)}|${String(last.cur_rowid)}`
        : null,
    rowsRead: res.meta.rows_read ?? 0,
  };
}

function parseCursor(raw: string | undefined, mode: 'e' | 'o'): { utc: string; rowid: number } | null {
  if (!raw) return null;
  const [m, utc, id] = raw.split('|');
  const rowid = Number(id);
  if (m !== mode || !utc || !Number.isInteger(rowid) || Number.isNaN(Date.parse(utc))) {
    throw new HTTPException(400, { message: 'Invalid cursor' });
  }
  return { utc, rowid };
}

/** List rows for given event ids, in the given order (for ranked results). */
export async function listItemsByIds(db: D1Database, ids: string[]): Promise<EventListItem[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(
      `SELECT e.id, e.slug, e.title, e.lang, e.category, e.price_min, e.price_max, e.is_free,
              e.next_start_utc AS next_utc, e.next_start_local AS next_local,
              MAX(e.upcoming_count - 1, 0) AS more_dates, v.name AS venue_name, v.district
         FROM events e LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.id IN (${ids.map(() => '?').join(',')}) AND e.status = 'published' AND e.next_start_utc IS NOT NULL`,
    )
    .bind(...ids)
    .all<Record<string, unknown>>();
  const byId = new Map(results.map((r) => [String(r.id), r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [listItem(r)] : [];
  });
}

/** Search by meaning: embeds the query and ranks upcoming events by cosine. Complements keyword search (FTS). */
export async function searchByMeaning(env: Env, text: string, limit = 20): Promise<EventListItem[]> {
  const index = await loadIndex(env.CACHE);
  // A query costs ~0.01 neurons; the check only matters if someone hammers the endpoint.
  if (!index?.ids.length || (await neuronsLeft(env.DB)) <= 50) return [];
  const [vec] = await embedTexts(env, [text]);
  const hits = nearest(index, vec!, limit, { min: MIN_SEARCH });
  return listItemsByIds(
    env.DB,
    hits.map((h) => h.id),
  );
}

/** Events close in meaning to this one ("More like this"). Reads one KV value and at most 6 event rows. */
export async function similarEvents(env: Env, slug: string): Promise<EventListItem[]> {
  const ev = await env.DB.prepare('SELECT id FROM events WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (!ev) throw new HTTPException(404, { message: 'Event not found' });
  const index = await loadIndex(env.CACHE);
  const vec = index && vectorOf(index, ev.id);
  const hits = index && vec ? nearest(index, vec, 6, { exclude: ev.id, min: MIN_SIMILAR }) : [];
  return listItemsByIds(
    env.DB,
    hits.map((h) => h.id),
  );
}

/** One published event with venue, every date and performers, or null. */
export async function eventDetail(db: D1Database, slug: string): Promise<EventDetail | null> {
  const ev = await db
    .prepare('SELECT * FROM events WHERE slug = ? AND status = ?')
    .bind(slug, 'published')
    .first<Record<string, unknown>>();
  if (!ev) return null;

  const [venue, occ, perf] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM venues WHERE id = ?').bind(ev.venue_id ?? ''),
    db.prepare('SELECT * FROM occurrences WHERE event_id = ? ORDER BY start_utc').bind(ev.id),
    db
      .prepare(
        `SELECT p.id, p.name, p.kind FROM event_performers ep JOIN performers p ON p.id = ep.performer_id
          WHERE ep.event_id = ? ORDER BY ep.position`,
      )
      .bind(ev.id),
  ]);

  const v = venue?.results[0];
  return EventDetail.parse({
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    titleEn: ev.title_en,
    description: ev.description,
    descriptionEn: ev.description_en,
    lang: ev.lang,
    category: ev.category,
    genres: JSON.parse(String(ev.genres ?? '[]')),
    venueId: ev.venue_id,
    priceMin: ev.price_min,
    priceMax: ev.price_max,
    isFree: Boolean(ev.is_free),
    priceNote: ev.price_note,
    urlOfficial: ev.url_official,
    urlTickets: ev.url_tickets,
    imageKey: ev.image_key,
    status: ev.status,
    mergedInto: ev.merged_into,
    firstStartAt: ev.first_start_at,
    lastStartAt: ev.last_start_at,
    dedupKey: ev.dedup_key,
    createdBy: ev.created_by,
    createdAt: ev.created_at,
    updatedAt: ev.updated_at,
    venue: v
      ? {
          id: v.id,
          name: v.name,
          aliases: JSON.parse(String(v.aliases ?? '[]')),
          address: v.address,
          district: v.district,
          lat: v.lat,
          lng: v.lng,
          url: v.url,
        }
      : null,
    occurrences: (occ?.results ?? []).map((o) => ({
      id: o.id,
      eventId: o.event_id,
      startLocal: o.start_local,
      startUtc: o.start_utc,
      endLocal: o.end_local,
      doorsLocal: o.doors_local,
      note: o.note,
      status: o.status,
    })),
    performers: perf?.results ?? [],
  });
}

/** Turn free text into a safe FTS5 prefix query: each word quoted, last one as prefix. */
export function ftsQuery(text: string): string {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
