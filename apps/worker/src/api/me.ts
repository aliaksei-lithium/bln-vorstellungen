import {
  LoginRequest,
  PasswordLogin,
  PasswordSet,
  ProfileUpdate,
  StateUpdate,
  type MyStates,
  type PasswordStatus,
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
