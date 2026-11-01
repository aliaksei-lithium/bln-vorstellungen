import type { Me } from '@bln/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';

/**
 * Pre-defined users with one-time login links (docs/09, 2026-11-01). No passwords: hashing them properly costs more
 * CPU than the free plan's 10 ms, and there is nothing to reset. The owner creates a user and a link; opening it
 * starts a long session. Only SHA-256 hashes of links and session tokens are stored.
 */

export type AppEnv = { Bindings: Env; Variables: { user: Me | null } };

export const SESSION_COOKIE = 'bln_session';
const SESSION_DAYS = 180;
/** Sessions are extended when less than this is left, so an active user never gets signed out. */
const REFRESH_BELOW_DAYS = 150;
export const LOGIN_LINK_DAYS = 7;
const DAY_MS = 86_400_000;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type UserRow = { id: string; name: string; email: string; is_owner: number };
const toMe = (u: UserRow): Me => ({ id: u.id, name: u.name, email: u.email, isOwner: Boolean(u.is_owner) });

/** A one-time link, valid for LOGIN_LINK_DAYS. Older unused links of the same user stay valid until they expire. */
export async function createLoginLink(db: D1Database, userId: string, origin: string, now = new Date()) {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + LOGIN_LINK_DAYS * DAY_MS).toISOString();
  await db
    .prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), `login:${userId}`, await sha256(token), expiresAt)
    .run();
  return { url: `${origin}/login/${token}`, expiresAt };
}

/** Consumes a login link (deleting it) and returns its user, or null when unknown or expired. */
export async function consumeLoginLink(db: D1Database, token: string, now = new Date()): Promise<Me | null> {
  const row = await db
    .prepare(
      `DELETE FROM verifications WHERE value = ? AND identifier LIKE 'login:%'
       RETURNING identifier, expires_at`,
    )
    .bind(await sha256(token))
    .first<{ identifier: string; expires_at: string }>();
  if (!row || row.expires_at < now.toISOString()) return null;
  const user = await db
    .prepare('SELECT id, name, email, is_owner FROM users WHERE id = ?')
    .bind(row.identifier.slice('login:'.length))
    .first<UserRow>();
  return user ? toMe(user) : null;
}

export async function startSession(c: Context<AppEnv>, userId: string, now = new Date()): Promise<void> {
  const token = newToken();
  await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, token, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      userId,
      await sha256(token),
      new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString(),
      c.req.header('user-agent')?.slice(0, 200) ?? null,
    )
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token)
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?')
      .bind(await sha256(token))
      .run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

/** Sets `user` (or null) from the session cookie. Extends sessions that are past their refresh point. */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  c.set('user', null);
  if (token) {
    const now = new Date();
    const hash = await sha256(token);
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.is_owner, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
      .bind(hash, now.toISOString())
      .first<UserRow & { expires_at: string }>();
    if (row) {
      c.set('user', toMe(row));
      if (Date.parse(row.expires_at) - now.getTime() < REFRESH_BELOW_DAYS * DAY_MS) {
        const expires = new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString();
        await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(expires, hash).run();
      }
    }
  }
  await next();
};

export function requireUser(c: Context<AppEnv>): Me {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Sign in to see this.' });
  return user;
}

/**
 * CSRF guard for cookie-authenticated writes: a browser always sends Origin on cross-site POST/PUT/DELETE, so a
 * mismatch means another site is trying to act with the user's cookie. SameSite=Lax covers the rest.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      throw new HTTPException(403, { message: 'Cross-site request refused.' });
    }
  }
  await next();
};

/** Owner check for the admin API: the shared ADMIN_TOKEN (scripts, CI) or a signed-in owner (the web app). */
export async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.env.ADMIN_TOKEN;
  const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (expected && given && (await sameSecret(given, expected))) return true;
  return Boolean(c.get('user')?.isOwner);
}

/** Compares digests so the check takes the same time whatever the input. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
