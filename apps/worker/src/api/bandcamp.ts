import { BandcampConnect, type BandcampStatus } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { dispatchScoring, refreshTaste } from '../ai/score';
import { requireUser, type AppEnv } from '../auth';
import { bandcampStatus, connect, disconnect, syncArtists } from '../bandcamp';

/** The JSON API under /api/me/bandcamp. No browser redirects: connecting is the fan name, not a sign-in. */
export const bandcampApi = new Hono<AppEnv>();

bandcampApi.get('/', async (c) => c.json((await bandcampStatus(c.env.DB, requireUser(c).id)) satisfies BandcampStatus));

bandcampApi.put('/', async (c) => {
  const user = requireUser(c);
  const body = BandcampConnect.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: 'Give your Bandcamp fan name.' });
  await connect(c.env, user.id, body.data.username);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await bandcampStatus(c.env.DB, user.id));
});

bandcampApi.post('/sync', async (c) => {
  const user = requireUser(c);
  await syncArtists(c.env, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await bandcampStatus(c.env.DB, user.id));
});

bandcampApi.delete('/', async (c) => {
  const user = requireUser(c);
  await disconnect(c.env.DB, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await bandcampStatus(c.env.DB, user.id));
});
