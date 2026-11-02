import { type YoutubeStatus } from '@bln/shared';
import { Hono } from 'hono';
import { dispatchScoring, refreshTaste } from '../ai/score';
import { requireUser, type AppEnv } from '../auth';
import { claimTasteRebuild } from '../services/review';
import { connectUrl, disconnect, finishConnect, syncArtists, youtubeStatus } from '../youtube';

/** Browser redirects (/youtube/connect, /youtube/callback) and the JSON API under /api/me/youtube. */
export const youtubePages = new Hono<AppEnv>();
export const youtubeApi = new Hono<AppEnv>();

const back = (reason: string) => `/me?youtube=${encodeURIComponent(reason)}#youtube`;

youtubePages.get('/connect', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/me');
  return c.redirect(await connectUrl(c.env, user.id));
});

youtubePages.get('/callback', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/me');
  const { code, state, error } = c.req.query();
  if (error || !code || !state) return c.redirect(back(error === 'access_denied' ? 'denied' : 'failed'));
  try {
    await finishConnect(c.env, user.id, code, state);
    await refreshTaste(c.env, user.id);
    // New artists: re-score, then rebuild Discover and For you with the new scores.
    const rebuild = await claimTasteRebuild(c.env, user.id);
    c.executionCtx.waitUntil(dispatchScoring(c.env, user.id, undefined, { rebuild }));
    return c.redirect(back('connected'));
  } catch (err) {
    console.warn('youtube callback', String(err));
    return c.redirect(back('failed'));
  }
});

youtubeApi.get('/', async (c) => c.json((await youtubeStatus(c.env, requireUser(c).id)) satisfies YoutubeStatus));

youtubeApi.post('/sync', async (c) => {
  const user = requireUser(c);
  await syncArtists(c.env, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await youtubeStatus(c.env, user.id));
});

youtubeApi.delete('/', async (c) => {
  const user = requireUser(c);
  await disconnect(c.env.DB, user.id);
  await refreshTaste(c.env, user.id);
  c.executionCtx.waitUntil(dispatchScoring(c.env, user.id));
  return c.json(await youtubeStatus(c.env, user.id));
});
