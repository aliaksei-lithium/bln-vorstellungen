import {
  AgendaItem,
  FREQUENCY_MIN_SCORE,
  mixCategories,
  MyEvent,
  Reason,
  type Category,
  type EventListItem,
  type InboxResponse,
  type MyStates,
  type UserState,
  type StateUpdate,
} from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProfile } from '../ai/score';

/** The signed-in user's inbox, triage and agenda, shared by the REST API and the MCP tools. */

const DAY_MS = 86_400_000;

const listItem = (r: Record<string, unknown>): EventListItem => ({
  slug: String(r.slug),
  title: String(r.title),
  category: r.category as EventListItem['category'],
  venueName: (r.venue_name as string | null) ?? null,
  district: (r.district as string | null) ?? null,
  priceMin: (r.price_min as number | null) ?? null,
  priceMax: (r.price_max as number | null) ?? null,
  isFree: Boolean(r.is_free),
  next: { startLocal: String(r.next_start_local), startUtc: String(r.next_start_utc) },
  moreDates: Math.max(0, Number(r.upcoming_count) - 1),
  ...(r.lang === 'de' || r.lang === 'en' ? { lang: r.lang } : {}),
});

export const reasonsOf = (raw: unknown) =>
  z
    .array(Reason)
    .catch([])
    .parse(JSON.parse(String(raw ?? '[]')));

/**
 * Untriaged, scored, upcoming events best first, with the next date between `from` and `to` (ISO instants; default:
 * now to no limit). Rows read ≈ the user's scored upcoming events (a few hundred), through the (user_id, score) index.
 * The counts cover the whole range; `category` and `minScore` only narrow the items.
 */
export async function inbox(
  db: D1Database,
  userId: string,
  opts: { from?: string; to?: string; limit?: number; category?: Category; minScore?: number } = {},
  now = new Date(),
): Promise<InboxResponse> {
  const from = opts.from && opts.from > now.toISOString() ? opts.from : now.toISOString();
  const to = opts.to ?? '9999';
  const { version, tasteText, prefs } = await loadProfile(db, userId);
  // "Less" and "rarely" categories need a higher score; numbered after each query's own parameters.
  const levels = Object.entries(prefs.frequency) as [Category, 'less' | 'rarely'][];
  const often = (first: number) =>
    levels.map((_, i) => ` AND NOT (e.category = ?${first + 2 * i} AND s.score < ?${first + 2 * i + 1})`).join('');
  const levelArgs = levels.flatMap(([c, f]) => [c, FREQUENCY_MIN_SCORE[f]]);
  // A window that starts later (a weekend, say) matches any performance in it, shown as the event's date; the plain
  // inbox goes by the denormalized next date and reads no occurrences.
  const inWindow = `(SELECT o.start_utc || '|' || o.start_local FROM occurrences o
                      WHERE o.event_id = e.id AND o.start_utc >= ?2 AND o.start_utc <= ?3 AND o.status != 'cancelled'
                      ORDER BY o.start_utc LIMIT 1)`;
  const windowed = from !== now.toISOString();
  const [items, counts] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT * FROM (
           SELECT e.slug, e.title, e.lang, e.category, e.price_min, e.price_max, e.is_free, e.next_start_utc,
                  e.next_start_local, e.upcoming_count, v.name AS venue_name, v.district, s.score, s.reasons,
                  ${windowed ? inWindow : 'NULL'} AS window_start
             FROM user_event_scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN venues v ON v.id = e.venue_id
            WHERE s.user_id = ?1 AND s.score >= MAX(?5, 1) AND e.status = 'published'
              AND ${windowed ? 'e.next_start_utc IS NOT NULL' : 'e.next_start_utc >= ?2'}
              AND e.next_start_utc <= ?3 AND (?6 IS NULL OR e.category = ?6)${often(7)}
              AND NOT EXISTS (SELECT 1 FROM user_event_state st WHERE st.user_id = ?1 AND st.event_id = s.event_id)
         ) WHERE ${windowed ? 'window_start IS NOT NULL' : '1'}
          ORDER BY score DESC, COALESCE(window_start, next_start_utc)
          LIMIT ?4`,
      )
      .bind(userId, from, to, opts.limit ?? 100, opts.minScore ?? 1, opts.category ?? null, ...levelArgs),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM user_event_scores s JOIN events e ON e.id = s.event_id
             WHERE s.user_id = ?1 AND s.score > 0 AND e.status = 'published'
               AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3${often(5)}) AS total,
           (SELECT COUNT(*) FROM user_event_scores s JOIN events e ON e.id = s.event_id
             JOIN user_event_state st ON st.user_id = s.user_id AND st.event_id = s.event_id
             WHERE s.user_id = ?1 AND s.score > 0 AND e.status = 'published'
               AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3${often(5)}) AS done,
           (SELECT COUNT(*) FROM events e INDEXED BY events_next_idx
             WHERE e.next_start_utc >= ?2 AND e.status = 'published'
               AND NOT EXISTS (SELECT 1 FROM user_event_scores s
                                WHERE s.user_id = ?1 AND s.event_id = e.id AND s.profile_version = ?4)) AS pending`,
      )
      .bind(userId, from, to, version, ...levelArgs),
  ]);
  const n = counts?.results[0] ?? {};
  return {
    // Best first, but no category takes more than a third of the places (docs/09, 2026-11-01).
    items: mixCategories(
      (items?.results ?? []).map((r) => ({
        ...listItem(
          r.window_start
            ? {
                ...r,
                next_start_utc: String(r.window_start).split('|')[0],
                next_start_local: String(r.window_start).split('|')[1],
              }
            : r,
        ),
        score: Number(r.score),
        reasons: reasonsOf(r.reasons),
      })),
    ),
    total: Number(n.total ?? 0),
    done: Number(n.done ?? 0),
    pending: Number(n.pending ?? 0),
    hasTaste: tasteText.length > 0,
  };
}

export const inboxUntil = (range: 'week' | 'all', now = new Date()) =>
  range === 'week' ? new Date(now.getTime() + 7 * DAY_MS).toISOString() : undefined;

export async function eventIdBySlug(db: D1Database, slug: string): Promise<string> {
  const ev = await db.prepare('SELECT id FROM events WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (!ev) throw new HTTPException(404, { message: 'Event not found' });
  return ev.id;
}

/** The user's score, reasons and triage state for one event. */
export async function myEvent(db: D1Database, userId: string, eventId: string): Promise<MyEvent> {
  const row = await db
    .prepare(
      `SELECT s.score, s.reasons, st.state, st.occurrence_id
         FROM (SELECT ?1 AS user_id, ?2 AS event_id) k
         LEFT JOIN user_event_scores s ON s.user_id = k.user_id AND s.event_id = k.event_id
         LEFT JOIN user_event_state st ON st.user_id = k.user_id AND st.event_id = k.event_id`,
    )
    .bind(userId, eventId)
    .first<Record<string, unknown>>();
  return MyEvent.parse({
    score: row?.score ?? null,
    reasons: reasonsOf(row?.reasons),
    state: row?.state ?? null,
    occurrenceId: row?.occurrence_id ?? null,
  });
}

/** Scores of several events for one user, by slug (events without a score are left out). */
export async function scoresBySlug(db: D1Database, userId: string, slugs: string[]): Promise<Map<string, number>> {
  if (!slugs.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT e.slug, s.score FROM events e JOIN user_event_scores s ON s.event_id = e.id AND s.user_id = ?
        WHERE e.slug IN (${slugs.map(() => '?').join(',')})`,
    )
    .bind(userId, ...slugs)
    .all<{ slug: string; score: number }>();
  return new Map(results.map((r) => [r.slug, r.score]));
}

/** Triage: interested / maybe / skipped / hidden / went, or null to undo. Hidden events never come back. */
export async function setEventState(db: D1Database, userId: string, eventId: string, u: StateUpdate): Promise<void> {
  if (u.state === null) {
    await db.prepare('DELETE FROM user_event_state WHERE user_id = ? AND event_id = ?').bind(userId, eventId).run();
    return;
  }
  if (u.occurrenceId) {
    const occ = await db
      .prepare('SELECT 1 FROM occurrences WHERE id = ? AND event_id = ?')
      .bind(u.occurrenceId, eventId)
      .first();
    if (!occ) throw new HTTPException(400, { message: 'That date does not belong to this event.' });
  }
  await db
    .prepare(
      `INSERT INTO user_event_state (user_id, event_id, state, occurrence_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, event_id) DO UPDATE SET state = excluded.state,
         occurrence_id = COALESCE(excluded.occurrence_id, occurrence_id),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(userId, eventId, u.state, u.occurrenceId ?? null)
    .run();
}

export async function agendaItems(db: D1Database, userId: string, now = new Date()): Promise<AgendaItem[]> {
  // The picked date when it is still ahead, else the event's next date.
  const { results } = await db
    .prepare(
      `SELECT e.slug, e.title, e.category, e.price_min, e.price_max, e.is_free, v.name AS venue_name, st.state,
              COALESCE(o.id, (SELECT o2.id FROM occurrences o2 WHERE o2.event_id = e.id
                               AND o2.start_utc = e.next_start_utc LIMIT 1)) AS occ_id,
              COALESCE(o.start_local, e.next_start_local) AS start_local,
              CASE WHEN o.id IS NOT NULL THEN o.end_local END AS end_local
         FROM user_event_state st
         JOIN events e ON e.id = st.event_id
         LEFT JOIN venues v ON v.id = e.venue_id
         LEFT JOIN occurrences o ON o.id = st.occurrence_id AND o.start_utc >= ?2
        WHERE st.user_id = ?1 AND st.state IN ('interested', 'maybe')
          AND (o.id IS NOT NULL OR e.next_start_utc >= ?2)
        ORDER BY start_local`,
    )
    .bind(userId, now.toISOString())
    .all<Record<string, unknown>>();
  return results
    .filter((r) => r.occ_id && r.start_local)
    .map((r) =>
      AgendaItem.parse({
        slug: r.slug,
        title: r.title,
        category: r.category,
        venueName: r.venue_name ?? null,
        priceMin: r.price_min ?? null,
        priceMax: r.price_max ?? null,
        isFree: Boolean(r.is_free),
        state: r.state,
        occurrenceId: r.occ_id,
        startLocal: r.start_local,
        endLocal: r.end_local ?? null,
      }),
    );
}

/** Every mark of the user, by event slug (a few hundred rows at most), for list rows. */
export async function statesBySlug(db: D1Database, userId: string): Promise<MyStates['states']> {
  const { results } = await db
    .prepare(
      `SELECT e.slug, st.state FROM user_event_state st JOIN events e ON e.id = st.event_id WHERE st.user_id = ?`,
    )
    .bind(userId)
    .all<{ slug: string; state: UserState }>();
  return Object.fromEntries(results.map((r) => [r.slug, r.state]));
}
