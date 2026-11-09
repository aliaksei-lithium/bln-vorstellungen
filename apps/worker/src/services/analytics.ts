import { berlinToday, type ActivityOverview, type ActivityUser, type TrackItem } from '@bln/shared';

/**
 * App usage by signed-in people (docs/09, 2026-11-09): one counter per user, Berlin day, kind and page kind in
 * `user_activity`. Counts only, so the table stays small (users x days x a dozen names) and holds nothing about
 * what someone asked, searched or opened. The web app sends batches (lib/track.ts); Ask is counted here.
 */
const DAY_MS = 86_400_000;
/** Counters older than this are dropped by the cron. */
export const ACTIVITY_KEEP_DAYS = 180;

const bump = (db: D1Database, userId: string, day: string, kind: string, name: string, by: number) =>
  db
    .prepare(
      `INSERT INTO user_activity (user_id, day, kind, name, count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day, kind, name) DO UPDATE SET count = count + excluded.count`,
    )
    .bind(userId, day, kind, name, by);

/** Adds a batch from the web app; items for the same counter are summed first, so each is one write. */
export async function recordActivity(db: D1Database, userId: string, items: TrackItem[], now = new Date()) {
  const day = berlinToday(now);
  const sums = new Map<string, number>();
  for (const i of items) sums.set(`${i.kind} ${i.page}`, (sums.get(`${i.kind} ${i.page}`) ?? 0) + i.count);
  await db.batch(
    [...sums].map(([key, n]) => {
      const [kind, page] = key.split(' ') as [string, string];
      return bump(db, userId, day, kind, page, n);
    }),
  );
}

/** One question sent to Ask. */
export const recordAsk = (db: D1Database, userId: string, now = new Date()) =>
  bump(db, userId, berlinToday(now), 'ask', 'question', 1).run();

/** Everyone's totals for the last `days` Berlin days (today included), most active first. */
export async function activityOverview(db: D1Database, days: number, now = new Date()): Promise<ActivityOverview> {
  const since = berlinToday(new Date(now.getTime() - (days - 1) * DAY_MS));
  const [users, counts, active] = await db.batch<Record<string, string | number | null>>([
    db.prepare('SELECT id, name, last_seen_at FROM users ORDER BY created_at'),
    db
      .prepare(
        `SELECT user_id, kind, name, SUM(count) AS n FROM user_activity WHERE day >= ? GROUP BY user_id, kind, name`,
      )
      .bind(since),
    db
      .prepare('SELECT user_id, COUNT(DISTINCT day) AS n FROM user_activity WHERE day >= ? GROUP BY user_id')
      .bind(since),
  ]);
  const byId = new Map<string, ActivityUser>(
    users!.results.map((u) => [
      String(u.id),
      {
        id: String(u.id),
        name: String(u.name),
        lastSeenAt: u.last_seen_at === null ? null : String(u.last_seen_at),
        activeDays: 0,
        opens: 0,
        views: 0,
        clicks: 0,
        asks: 0,
        pages: {},
      },
    ]),
  );
  for (const r of counts!.results) {
    const u = byId.get(String(r.user_id));
    if (!u) continue;
    const n = Number(r.n);
    if (r.kind === 'open') u.opens += n;
    else if (r.kind === 'click') u.clicks += n;
    else if (r.kind === 'ask') u.asks += n;
    else if (r.kind === 'view') {
      u.views += n;
      u.pages[String(r.name)] = n;
    }
  }
  for (const r of active!.results) {
    const u = byId.get(String(r.user_id));
    if (u) u.activeDays = Number(r.n);
  }
  const weight = (u: ActivityUser) => u.views + u.clicks + u.asks + u.opens;
  return { days, users: [...byId.values()].sort((a, b) => b.activeDays - a.activeDays || weight(b) - weight(a)) };
}

/** Drops counters past ACTIVITY_KEEP_DAYS. Returns how many rows went. */
export async function purgeActivity(db: D1Database, now = new Date()): Promise<number> {
  const before = berlinToday(new Date(now.getTime() - ACTIVITY_KEEP_DAYS * DAY_MS));
  const res = await db.prepare('DELETE FROM user_activity WHERE day < ?').bind(before).run();
  return res.meta.changes ?? 0;
}
