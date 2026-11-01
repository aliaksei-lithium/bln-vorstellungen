import type { Me } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';

/**
 * Optional passwords (docs/09, 2026-11-01). PBKDF2-SHA256 through WebCrypto at a cost that fits the free plan's
 * 10 ms CPU per request; the stored string carries its own cost so it can be raised on the next sign-in.
 */

export const ITERATIONS = 30_000;
export const MIN_LENGTH = 10;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const PROVIDER = 'credential';

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}

/** Whether the password matches, and whether the stored hash should be redone at the current cost. */
export async function checkPassword(password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const [scheme, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || !salt || !hash)
    return { ok: false, rehash: false };
  const got = await derive(password, unb64(salt), iterations);
  const want = unb64(hash);
  const ok = got.length === want.length && crypto.subtle.timingSafeEqual(got, want);
  return { ok, rehash: ok && iterations !== ITERATIONS };
}

/** A hash to check against when the email is unknown, so both answers take the same time. */
let dummy: Promise<string> | null = null;

type UserRow = { id: string; name: string; email: string; is_owner: number; password: string | null };

/**
 * Email + password → the user, or a 401 that does not say which part was wrong. After MAX_FAILS wrong passwords
 * in FAIL_WINDOW_MS the account answers 429 until the window passes; a login link still works.
 */
export async function signInWithPassword(
  db: D1Database,
  email: string,
  password: string,
  now = new Date(),
): Promise<Me> {
  const user = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.is_owner, a.password FROM users u
         LEFT JOIN accounts a ON a.user_id = u.id AND a.provider_id = ?
        WHERE lower(u.email) = lower(?)`,
    )
    .bind(PROVIDER, email.trim())
    .first<UserRow>();
  const wrong = new HTTPException(401, { message: 'Email or password is wrong.' });
  if (!user?.password) {
    await checkPassword(password, await (dummy ??= hashPassword('not a real password')));
    throw wrong;
  }
  const since = new Date(now.getTime() - FAIL_WINDOW_MS).toISOString();
  const fails = await db
    .prepare(`SELECT COUNT(*) AS n FROM verifications WHERE identifier = ? AND created_at >= ?`)
    .bind(`login-fail:${user.id}`, since)
    .first<{ n: number }>();
  if ((fails?.n ?? 0) >= MAX_FAILS) {
    throw new HTTPException(429, {
      message: 'Too many wrong passwords. Wait 15 minutes, or sign in with a login link.',
    });
  }
  const r = await checkPassword(password, user.password);
  if (!r.ok) {
    await db
      .prepare(`INSERT INTO verifications (id, identifier, value, expires_at, created_at) VALUES (?, ?, '', ?, ?)`)
      .bind(
        crypto.randomUUID(),
        `login-fail:${user.id}`,
        new Date(now.getTime() + FAIL_WINDOW_MS).toISOString(),
        now.toISOString(),
      )
      .run();
    throw wrong;
  }
  const stmts = [
    db.prepare(`DELETE FROM verifications WHERE identifier = ?`).bind(`login-fail:${user.id}`),
    // Old expired failure rows of anyone, so the table stays small.
    db
      .prepare(`DELETE FROM verifications WHERE identifier LIKE 'login-fail:%' AND expires_at < ?`)
      .bind(now.toISOString()),
  ];
  if (r.rehash) {
    stmts.push(
      db
        .prepare(`UPDATE accounts SET password = ? WHERE user_id = ? AND provider_id = ?`)
        .bind(await hashPassword(password), user.id, PROVIDER),
    );
  }
  await db.batch(stmts);
  return { id: user.id, name: user.name, email: user.email, isOwner: Boolean(user.is_owner) };
}

export async function hasPassword(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM accounts WHERE user_id = ? AND provider_id = ? AND password IS NOT NULL`)
    .bind(userId, PROVIDER)
    .first();
  return !!row;
}

/** Sets or changes the password. Changing one needs the current password; the first one only the session. */
export async function setPassword(db: D1Database, userId: string, next: string, current?: string): Promise<void> {
  if (next.length < MIN_LENGTH) {
    throw new HTTPException(400, { message: `Use at least ${MIN_LENGTH} characters.` });
  }
  const row = await db
    .prepare(`SELECT id, password FROM accounts WHERE user_id = ? AND provider_id = ?`)
    .bind(userId, PROVIDER)
    .first<{ id: string; password: string | null }>();
  if (row?.password) {
    if (!current || !(await checkPassword(current, row.password)).ok) {
      throw new HTTPException(403, { message: 'The current password is wrong.' });
    }
  }
  const hash = await hashPassword(next);
  if (row) {
    await db
      .prepare(`UPDATE accounts SET password = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .bind(hash, row.id)
      .run();
  } else {
    await db
      .prepare(`INSERT INTO accounts (id, user_id, account_id, provider_id, password) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, userId, PROVIDER, hash)
      .run();
  }
}
