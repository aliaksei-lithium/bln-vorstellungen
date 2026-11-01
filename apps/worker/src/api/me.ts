import {
  LoginRequest,
  PasswordLogin,
  PasswordSet,
  ProfileUpdate,
  SourceSwitch,
  BrowseDefault,
  StateUpdate,
  type MyStates,
  type PasswordStatus,
  type SourcesOverview,
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
import { agendaItems, eventIdBySlug, inbox, inboxUntil, myEvent, setEventState, statesBySlug } from '../services/me';
import { hasPassword, setPassword, signInWithPassword } from '../passwords';
import { agendaIcs } from './ics';

/** Sign-in, the signed-in user's profile, inbox, triage and agenda. Never cached: every response is per user. */
export const meApi = new Hono<AppEnv>();
export const authApi = new Hono<AppEnv>();
export const calendarApi = new Hono<AppEnv>();

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

authApi.post('/password', async (c) => {
  const { email, password } = await body(c, PasswordLogin);
  const user = await signInWithPassword(c.env.DB, email, password);
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

meApi.get('/password', async (c) =>
  c.json({ set: await hasPassword(c.env.DB, requireUser(c).id) } satisfies PasswordStatus),
);

meApi.put('/password', async (c) => {
  const user = requireUser(c);
  const p = await body(c, PasswordSet);
  await setPassword(c.env.DB, user.id, p.password, p.current);
  return c.json({ set: true } satisfies PasswordStatus);
});

/**
 * The page behind a source for people (not the feed): an explicit `link`, the Telegram channel, or the configured
 * URL without feed parameters (?ical=1). Only http(s) links come out.
 */
export function sourceLink(type: string, config: string): string | null {
  let c: { link?: string; url?: string; channel?: string };
  try {
    c = JSON.parse(config);
  } catch {
    return null;
  }
  if (c.link) return /^https?:\/\//.test(c.link) ? c.link : null;
  if (type === 'telegram' && c.channel) return `https://t.me/${c.channel}`;
  if (!c.url || !/^https?:\/\//.test(c.url)) return null;
  if (type !== 'ical' && type !== 'rss') return c.url;
  const u = new URL(c.url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Where events come from and when each source is checked next; enabled ones first, busiest first. */
meApi.get('/sources', async (c) => {
  requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.type, s.config, s.enabled, s.schedule_minutes, s.last_run_at, s.last_status, s.next_run_at,
            (SELECT COUNT(DISTINCT es.event_id) FROM raw_items r
               JOIN event_sources es ON es.raw_item_id = r.id
               JOIN events e ON e.id = es.event_id
              WHERE r.source_id = s.id AND e.next_start_utc >= ?) AS upcoming
       FROM sources s
      ORDER BY s.enabled DESC, upcoming DESC, s.name`,
  )
    .bind(new Date().toISOString())
    .all<Record<string, unknown>>();
  return c.json({
    sources: results.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      link: sourceLink(String(r.type), String(r.config)),
      type: String(r.type),
      enabled: Boolean(r.enabled),
      everyMinutes: Number(r.schedule_minutes),
      lastRunAt: (r.last_run_at as string | null) ?? null,
      lastStatus: (r.last_status as string | null) ?? null,
      nextRunAt: (r.next_run_at as string | null) ?? null,
      upcoming: Number(r.upcoming ?? 0),
    })),
  } satisfies SourcesOverview);
});

/** Switches one source off or on for this user. No re-scoring: lists and the inbox filter at read time. */
meApi.put('/sources/:id', async (c) => {
  const user = requireUser(c);
  const { on } = await body(c, SourceSwitch);
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT 1 FROM sources WHERE id = ?').bind(id).first();
  if (!exists) throw new HTTPException(404, { message: 'Source not found' });
  const { prefs } = await loadProfile(c.env.DB, user.id);
  const sourcesOff = on ? prefs.sourcesOff.filter((s) => s !== id) : [...new Set([...prefs.sourcesOff, id])];
  await c.env.DB.prepare(
    `UPDATE user_profiles SET prefs = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?`,
  )
    .bind(JSON.stringify({ ...prefs, sourcesOff }), user.id)
    .run();
  return c.json({ sourcesOff });
});

/** Saves (or clears, with '') the Browse filters to start from. Only known filter keys are kept. No re-scoring. */
meApi.put('/browse-default', async (c) => {
  const user = requireUser(c);
  const { search } = await body(c, BrowseDefault);
  const keep = new URLSearchParams(
    [...new URLSearchParams(search)].filter(([k, v]) => ['when', 'category', 'district', 'via'].includes(k) && v),
  ).toString();
  const { prefs } = await loadProfile(c.env.DB, user.id);
  await c.env.DB.prepare(
    `UPDATE user_profiles SET prefs = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?`,
  )
    .bind(JSON.stringify({ ...prefs, browseDefault: keep }), user.id)
    .run();
  return c.json({ search: keep });
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
  // Source switches and the Browse default have their own endpoints; a taste form opened earlier must not undo them.
  const stored = (await loadProfile(c.env.DB, user.id)).prefs;
  p.prefs.sourcesOff = stored.sourcesOff;
  p.prefs.browseDefault = stored.browseDefault;
  const version = await saveProfile(c.env, user.id, p.tasteText, p.prefs);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json({ tasteText: p.tasteText.trim(), prefs: p.prefs, version } satisfies Profile);
});

/* ---------- inbox, one event, triage, agenda (services/me) ---------- */

meApi.get('/inbox', async (c) => {
  const user = requireUser(c);
  const range = c.req.query('range') === 'week' ? 'week' : 'all';
  return c.json(await inbox(c.env.DB, user.id, { to: inboxUntil(range) }));
});

meApi.get('/states', async (c) =>
  c.json({ states: await statesBySlug(c.env.DB, requireUser(c).id) } satisfies MyStates),
);

meApi.get('/events/:slug', async (c) => {
  const user = requireUser(c);
  return c.json(await myEvent(c.env.DB, user.id, await eventIdBySlug(c.env.DB, c.req.param('slug'))));
});

meApi.put('/events/:slug/state', async (c) => {
  const user = requireUser(c);
  const id = await eventIdBySlug(c.env.DB, c.req.param('slug'));
  const u = await body(c, StateUpdate);
  await setEventState(c.env.DB, user.id, id, u);
  return c.json({ state: u.state });
});

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
