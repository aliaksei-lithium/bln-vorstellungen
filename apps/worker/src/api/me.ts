import {
  AgendaItem,
  InboxResponse,
  LoginRequest,
  MyEvent,
  ProfileUpdate,
  Reason,
  StateUpdate,
  type EventListItem,
  type Profile,
} from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { dispatchScoring, loadProfile, saveProfile } from '../ai/score';
import {
  consumeLoginLink,
  createLoginLink,
  endSession,
  newToken,
  requireUser,
  sha256,
  startSession,
  type AppEnv,
} from '../auth';
import { agendaIcs } from './ics';

/** Sign-in, the signed-in user's profile, inbox, triage and agenda. Never cached: every response is per user. */
export const meApi = new Hono<AppEnv>();
export const authApi = new Hono<AppEnv>();
export const calendarApi = new Hono<AppEnv>();

const DAY_MS = 86_400_000;

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON.' });
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HTTPException(400, { message: r.error.issues[0]?.message ?? 'Invalid input' });
  return r.data;
}

/* ---------- sign-in ---------- */

authApi.post('/login', async (c) => {
  const { token } = await body(c, LoginRequest);
  const user = await consumeLoginLink(c.env.DB, token);
  if (!user) throw new HTTPException(401, { message: 'This login link is used up or expired. Ask for a new one.' });
  await startSession(c, user.id);
  return c.json({ user });
});

authApi.post('/logout', async (c) => {
  await endSession(c);
  return c.json({ user: null });
});

meApi.get('/', (c) => c.json({ user: c.get('user') }));

/** A one-time link for the signed-in user's other device (phone, laptop). */
meApi.post('/login-link', async (c) => {
  const user = requireUser(c);
  return c.json(await createLoginLink(c.env.DB, user.id, new URL(c.req.url).origin), 201);
});

/* ---------- profile ---------- */

meApi.get('/profile', async (c) => {
  const p = await loadProfile(c.env.DB, requireUser(c).id);
  return c.json({ tasteText: p.tasteText, prefs: p.prefs, version: p.version } satisfies Profile);
});

/** Saves the taste, embeds it and starts re-scoring in the background. */
meApi.put('/profile', async (c) => {
  const user = requireUser(c);
  const p = await body(c, ProfileUpdate);
  const version = await saveProfile(c.env, user.id, p.tasteText, p.prefs);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json({ tasteText: p.tasteText.trim(), prefs: p.prefs, version } satisfies Profile);
});

/* ---------- inbox ---------- */

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

const reasonsOf = (raw: unknown) =>
  z
    .array(Reason)
    .catch([])
    .parse(JSON.parse(String(raw ?? '[]')));

/**
 * Untriaged, scored, upcoming events best first. Rows read ≈ the user's scored upcoming events (a few hundred),
 * through the (user_id, score) index.
 */
meApi.get('/inbox', async (c) => {
  const user = requireUser(c);
  const range = c.req.query('range') === 'week' ? 'week' : 'all';
  const now = new Date();
  const from = now.toISOString();
  const to = range === 'week' ? new Date(now.getTime() + 7 * DAY_MS).toISOString() : '9999';
  const { version, tasteText } = await loadProfile(c.env.DB, user.id);
  const db = c.env.DB;
  const [items, counts] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT e.slug, e.title, e.lang, e.category, e.price_min, e.price_max, e.is_free, e.next_start_utc,
                e.next_start_local, e.upcoming_count, v.name AS venue_name, v.district, s.score, s.reasons
           FROM user_event_scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN venues v ON v.id = e.venue_id
          WHERE s.user_id = ?1 AND s.score > 0 AND e.status = 'published'
            AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3
            AND NOT EXISTS (SELECT 1 FROM user_event_state st WHERE st.user_id = ?1 AND st.event_id = s.event_id)
          ORDER BY s.score DESC, e.next_start_utc
          LIMIT 100`,
      )
      .bind(user.id, from, to),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM user_event_scores s JOIN events e ON e.id = s.event_id
             WHERE s.user_id = ?1 AND s.score > 0 AND e.status = 'published'
               AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3) AS total,
           (SELECT COUNT(*) FROM user_event_scores s JOIN events e ON e.id = s.event_id
             JOIN user_event_state st ON st.user_id = s.user_id AND st.event_id = s.event_id
             WHERE s.user_id = ?1 AND s.score > 0 AND e.status = 'published'
               AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3) AS done,
           (SELECT COUNT(*) FROM events e INDEXED BY events_next_idx
             WHERE e.next_start_utc >= ?2 AND e.status = 'published'
               AND NOT EXISTS (SELECT 1 FROM user_event_scores s
                                WHERE s.user_id = ?1 AND s.event_id = e.id AND s.profile_version = ?4)) AS pending`,
      )
      .bind(user.id, from, to, version),
  ]);
  const n = counts?.results[0] ?? {};
  const res: InboxResponse = {
    items: (items?.results ?? []).map((r) => ({
      ...listItem(r),
      score: Number(r.score),
      reasons: reasonsOf(r.reasons),
    })),
    total: Number(n.total ?? 0),
    done: Number(n.done ?? 0),
    pending: Number(n.pending ?? 0),
    hasTaste: tasteText.length > 0,
  };
  return c.json(res);
});

/* ---------- one event ---------- */

async function eventId(db: D1Database, slug: string): Promise<string> {
  const ev = await db.prepare('SELECT id FROM events WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (!ev) throw new HTTPException(404, { message: 'Event not found' });
  return ev.id;
}

meApi.get('/events/:slug', async (c) => {
  const user = requireUser(c);
  const id = await eventId(c.env.DB, c.req.param('slug'));
  const row = await c.env.DB.prepare(
    `SELECT s.score, s.reasons, st.state, st.occurrence_id
       FROM (SELECT ?1 AS user_id, ?2 AS event_id) k
       LEFT JOIN user_event_scores s ON s.user_id = k.user_id AND s.event_id = k.event_id
       LEFT JOIN user_event_state st ON st.user_id = k.user_id AND st.event_id = k.event_id`,
  )
    .bind(user.id, id)
    .first<Record<string, unknown>>();
  return c.json(
    MyEvent.parse({
      score: row?.score ?? null,
      reasons: reasonsOf(row?.reasons),
      state: row?.state ?? null,
      occurrenceId: row?.occurrence_id ?? null,
    }),
  );
});

/** Triage: interested / maybe / skipped / hidden / went, or null to undo. Hidden events never come back. */
meApi.put('/events/:slug/state', async (c) => {
  const user = requireUser(c);
  const id = await eventId(c.env.DB, c.req.param('slug'));
  const u = await body(c, StateUpdate);
  if (u.state === null) {
    await c.env.DB.prepare('DELETE FROM user_event_state WHERE user_id = ? AND event_id = ?').bind(user.id, id).run();
  } else {
    if (u.occurrenceId) {
      const occ = await c.env.DB.prepare('SELECT 1 FROM occurrences WHERE id = ? AND event_id = ?')
        .bind(u.occurrenceId, id)
        .first();
      if (!occ) throw new HTTPException(400, { message: 'That date does not belong to this event.' });
    }
    await c.env.DB.prepare(
      `INSERT INTO user_event_state (user_id, event_id, state, occurrence_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, event_id) DO UPDATE SET state = excluded.state,
         occurrence_id = COALESCE(excluded.occurrence_id, occurrence_id),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
      .bind(user.id, id, u.state, u.occurrenceId ?? null)
      .run();
  }
  return c.json({ state: u.state });
});

/* ---------- agenda ---------- */

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

meApi.get('/agenda', async (c) => c.json({ items: await agendaItems(c.env.DB, requireUser(c).id) }));

/** A private calendar URL for the agenda; making a new one revokes the old one. */
meApi.post('/calendar-link', async (c) => {
  const user = requireUser(c);
  const token = newToken();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM api_keys WHERE user_id = ? AND name = 'calendar'`).bind(user.id),
    c.env.DB.prepare(`INSERT INTO api_keys (id, user_id, name, prefix, key_hash) VALUES (?, ?, 'calendar', ?, ?)`).bind(
      crypto.randomUUID(),
      user.id,
      token.slice(0, 6),
      await sha256(token),
    ),
  ]);
  return c.json({ url: `${new URL(c.req.url).origin}/api/cal/${token}.ics` }, 201);
});

/* ---------- calendar feed (token in the URL, for calendar apps) ---------- */

calendarApi.get('/:file', async (c) => {
  const token = c.req.param('file').replace(/\.ics$/, '');
  const key = await c.env.DB.prepare(
    `SELECT k.user_id, u.name FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.name = 'calendar'`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string; name: string }>();
  if (!key) throw new HTTPException(404, { message: 'Calendar not found' });
  const items = await agendaItems(c.env.DB, key.user_id);
  const origin = new URL(c.req.url).origin;
  return c.body(agendaIcs(items, origin, `BLN Vorstellungen · ${key.name}`), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'private, max-age=300',
  });
});
