import { type SpotifyStatus } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { dispatchScoring, refreshTaste } from '../ai/score';
import { requireUser, type AppEnv } from '../auth';
import { connectUrl, disconnect, finishConnect, spotifyStatus, syncArtists } from '../spotify';

/** Browser redirects (/spotify/connect, /spotify/callback) and the JSON API under /api/me/spotify. */
export const spotifyPages = new Hono<AppEnv>();
export const spotifyApi = new Hono<AppEnv>();

const back = (reason: string) => `/me?spotify=${encodeURIComponent(reason)}#spotify`;

spotifyPages.get('/connect', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/me');
  return c.redirect(await connectUrl(c.env, user.id));
});

spotifyPages.get('/callback', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/me');
  const { code, state, error } = c.req.query();
  if (error || !code || !state) return c.redirect(back('denied'));
  try {
    await finishConnect(c.env, user.id, code, state);
    await refreshTaste(c.env, user.id);
    c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
    return c.redirect(back('connected'));
  } catch (err) {
    console.warn('spotify callback', String(err));
    return c.redirect(back(err instanceof HTTPException && err.status === 403 ? 'not-allowed' : 'failed'));
  }
});

spotifyApi.get('/', async (c) => c.json((await spotifyStatus(c.env.DB, requireUser(c).id)) satisfies SpotifyStatus));

spotifyApi.post('/sync', async (c) => {
  const user = requireUser(c);
  await syncArtists(c.env, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await spotifyStatus(c.env.DB, user.id));
});

spotifyApi.delete('/', async (c) => {
  const user = requireUser(c);
  await disconnect(c.env.DB, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await spotifyStatus(c.env.DB, user.id));
});
