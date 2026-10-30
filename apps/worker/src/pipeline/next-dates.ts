/**
 * `events.next_start_*` and `upcoming_count` are denormalized from occurrences so the public list can page
 * through the events index alone (docs/08: < 500 rows read per list request). Resolve refreshes them for the
 * events it touches; the cron sweep moves events whose next date has passed on to their following date.
 */

const NEXT = `o.event_id = events.id AND o.start_utc >= ?1 AND o.status != 'cancelled'`;
const SET = `
  next_start_utc = (SELECT MIN(o.start_utc) FROM occurrences o WHERE ${NEXT}),
  next_start_local = (SELECT o.start_local FROM occurrences o WHERE ${NEXT} ORDER BY o.start_utc LIMIT 1),
  upcoming_count = (SELECT COUNT(*) FROM occurrences o WHERE ${NEXT})`;

export const refreshNextDate = (db: D1Database, eventId: string, now = new Date()): D1PreparedStatement =>
  db.prepare(`UPDATE events SET ${SET} WHERE id = ?2`).bind(now.toISOString(), eventId);

/** Touches only events whose stored next date is in the past (index on next_start_utc). */
export async function sweepPassedDates(db: D1Database, now = new Date()): Promise<number> {
  const r = await db
    .prepare(`UPDATE events SET ${SET} WHERE next_start_utc IS NOT NULL AND next_start_utc < ?1`)
    .bind(now.toISOString())
    .run();
  return r.meta.changes;
}

/** Full rebuild, for seeds and tests. Reads every event's occurrences; never on a request path. */
export async function refreshAllNextDates(db: D1Database, now = new Date()): Promise<void> {
  await db.prepare(`UPDATE events SET ${SET}`).bind(now.toISOString()).run();
}
