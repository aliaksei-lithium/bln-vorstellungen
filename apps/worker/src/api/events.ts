import { EventDetail, EventsQuery, type EventListItem, berlinLocalToUtc, berlinToday } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Public, read-only event API. One row per event at its next occurrence in range (an event is never repeated
 * per date). Plain SQL keeps rows read per request predictable for the D1 budget.
 */
export const eventsApi = new Hono<{ Bindings: Env }>();

const DAY_MS = 86_400_000;

eventsApi.get('/', async (c) => {
  const q = EventsQuery.safeParse(c.req.query());
  if (!q.success) throw new HTTPException(400, { message: q.error.issues[0]?.message ?? 'Invalid query' });
  const from = q.data.from ?? berlinToday();
  const to = q.data.to ?? new Date(Date.parse(from) + 60 * DAY_MS).toISOString().slice(0, 10);
  const fromUtc = q.data.from ? berlinLocalToUtc(`${from}T00:00`) : new Date().toISOString();
  const toUtc = berlinLocalToUtc(`${to}T23:59`);

  const where = ['e.status = ?', 'o.start_utc >= ?', 'o.start_utc <= ?', "o.status != 'cancelled'"];
  const args: unknown[] = ['published', fromUtc, toUtc];
  if (q.data.category) {
    where.push('e.category = ?');
    args.push(q.data.category);
  }
  if (q.data.district) {
    where.push('v.district = ?');
    args.push(q.data.district);
  }
  if (q.data.q) {
    where.push('e.id IN (SELECT event_id FROM events_fts WHERE events_fts MATCH ?)');
    args.push(ftsQuery(q.data.q));
  }

  const { results } = await c.env.DB.prepare(
    `SELECT e.slug, e.title, e.category, e.price_min, e.price_max, e.is_free, v.name AS venue_name, v.district,
            -- SQLite takes bare columns from the row that holds the MIN()
            MIN(o.start_utc) AS next_utc, o.start_local AS next_local,
            (SELECT COUNT(*) FROM occurrences WHERE event_id = e.id AND start_utc >= ?) - 1 AS more_dates
       FROM events e
       JOIN occurrences o ON o.event_id = e.id
       LEFT JOIN venues v ON v.id = e.venue_id
      WHERE ${where.join(' AND ')}
      GROUP BY e.id
      ORDER BY next_utc
      LIMIT 300`,
  )
    .bind(fromUtc, ...args)
    .all<Record<string, unknown>>();

  const items: EventListItem[] = results.map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    category: r.category as EventListItem['category'],
    venueName: (r.venue_name as string | null) ?? null,
    district: (r.district as string | null) ?? null,
    priceMin: (r.price_min as number | null) ?? null,
    priceMax: (r.price_max as number | null) ?? null,
    isFree: Boolean(r.is_free),
    next: { startLocal: String(r.next_local), startUtc: String(r.next_utc) },
    moreDates: Math.max(0, Number(r.more_dates)),
  }));
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ items });
});

eventsApi.get('/:slug', async (c) => {
  const db = c.env.DB;
  const ev = await db
    .prepare('SELECT * FROM events WHERE slug = ? AND status = ?')
    .bind(c.req.param('slug'), 'published')
    .first<Record<string, unknown>>();
  if (!ev) throw new HTTPException(404, { message: 'Event not found' });

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
  const detail = EventDetail.parse({
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
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(detail);
});

/** Turn free text into a safe FTS5 prefix query: each word quoted, last one as prefix. */
export function ftsQuery(text: string): string {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
