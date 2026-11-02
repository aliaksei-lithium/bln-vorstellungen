import { InviteRequestCreate, type InboxReview } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../auth';
import { requestInvite } from '../services/invites';
import { getPublicReview } from '../services/review';

/** Public, no sign-in: the day's highlights, and "Ask for an invite" (docs/09, 2026-11-02). */
export const highlightsApi = new Hono<AppEnv>();
export const inviteRequestsApi = new Hono<AppEnv>();

highlightsApi.get('/', async (c) => {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
  return c.json((await getPublicReview(c.env)) satisfies InboxReview);
});

inviteRequestsApi.post('/', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON.' });
  }
  const p = InviteRequestCreate.safeParse(raw);
  if (!p.success) throw new HTTPException(400, { message: p.error.issues[0]?.message ?? 'Invalid request' });
  await requestInvite(c.env.DB, p.data);
  return c.json({ ok: true }, 201);
});
