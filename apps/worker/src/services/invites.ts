import type { InviteAccepted, InviteRequest, InviteRequestCreate } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { createLoginLink } from '../auth';

/**
 * Invite requests (docs/09, 2026-11-02). Visitors ask; the owner sees them on the Me page and through MCP, and invites
 * (creates the user, keeps their note as a first taste, makes a one-time login link to send them) or declines.
 * No email goes out from here: the site has no domain for Cloudflare Email Sending yet.
 */

/** Site-wide per UTC day, so a script cannot fill the table. */
export const REQUESTS_PER_DAY = 30;

type Row = {
  id: string;
  name: string;
  email: string;
  note: string | null;
  status: InviteRequest['status'];
  created_at: string;
};
const toRequest = (r: Row): InviteRequest => ({
  id: r.id,
  name: r.name,
  email: r.email,
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
});

/** Stores a request. A second one from the same email updates the pending one instead of adding another. */
export async function requestInvite(db: D1Database, input: InviteRequestCreate, now = new Date()): Promise<void> {
  // Bots fill every field; people never see this one. Pretend it worked.
  if (input.website) return;
  const email = input.email.toLowerCase();
  const today = await db
    .prepare(`SELECT COUNT(*) AS n FROM invite_requests WHERE created_at >= ?`)
    .bind(now.toISOString().slice(0, 10))
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= REQUESTS_PER_DAY) {
    throw new HTTPException(429, { message: 'Too many requests today. Please try again tomorrow.' });
  }
  const pending = await db
    .prepare(`SELECT id FROM invite_requests WHERE email = ? AND status = 'pending'`)
    .bind(email)
    .first<{ id: string }>();
  if (pending) {
    await db
      .prepare(
        `UPDATE invite_requests SET name = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .bind(input.name, input.note || null, pending.id)
      .run();
    return;
  }
  await db
    .prepare(`INSERT INTO invite_requests (id, name, email, note) VALUES (?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.name, email, input.note || null)
    .run();
}

export async function listInviteRequests(db: D1Database, status: InviteRequest['status'] | 'all' = 'pending') {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, note, status, created_at FROM invite_requests
        ${status === 'all' ? '' : 'WHERE status = ?1'} ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(...(status === 'all' ? [] : [status]))
    .all<Row>();
  return results.map(toRequest);
}

async function getRequest(db: D1Database, id: string): Promise<Row> {
  const r = await db
    .prepare(`SELECT id, name, email, note, status, created_at FROM invite_requests WHERE id = ?`)
    .bind(id)
    .first<Row>();
  if (!r) throw new HTTPException(404, { message: 'Invite request not found' });
  return r;
}

/**
 * Invites: creates the user (or finds the one with that email), keeps their note as a first taste when they have
 * none, and makes a one-time login link for the owner to send.
 */
export async function acceptInvite(db: D1Database, id: string, origin: string): Promise<InviteAccepted> {
  const r = await getRequest(db, id);
  if (r.status === 'declined') throw new HTTPException(409, { message: 'This request was declined.' });
  await db
    .prepare(`INSERT INTO users (id, name, email, email_verified) VALUES (?, ?, ?, 1) ON CONFLICT (email) DO NOTHING`)
    .bind(crypto.randomUUID(), r.name, r.email)
    .run();
  const user = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(r.email).first<{ id: string }>();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO user_profiles (user_id, taste_text) VALUES (?, ?)`).bind(user!.id, r.note ?? ''),
    db
      .prepare(
        `UPDATE invite_requests SET status = 'invited', user_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
      )
      .bind(user!.id, id),
  ]);
  const link = await createLoginLink(db, user!.id, origin);
  return { request: toRequest({ ...r, status: 'invited' }), loginLink: link };
}

export async function declineInvite(db: D1Database, id: string): Promise<InviteRequest> {
  const r = await getRequest(db, id);
  if (r.status === 'invited') throw new HTTPException(409, { message: 'This person was already invited.' });
  await db
    .prepare(
      `UPDATE invite_requests SET status = 'declined', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(id)
    .run();
  return toRequest({ ...r, status: 'declined' });
}
