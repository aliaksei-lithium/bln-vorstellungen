import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/auth';
import { artistName, connectUrl, disconnect, fetchArtists, finishConnect, youtubeStatus } from '../src/youtube';

/** YouTube Music: artists from liked songs and music subscriptions, through a faked Google API. */

/** `env` with overrides, read-only: assigning onto an object made from `env` would write through to `env` itself. */
const overrides: Record<string, string> = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  // Genres would cost a model call; Workers AI is not reachable in tests, so they stay empty.
  SCORE_MODEL: 'workers-ai',
};
const google = new Proxy(env, {
  get: (target, key) => (typeof key === 'string' && key in overrides ? overrides[key] : Reflect.get(target, key)),
}) as Env;

/** Google's endpoints, answered from fixtures. */
const fake: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return json({ access_token: 'at', refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/youtube.readonly' });
  }
  if (url.includes('/videos?')) {
    return json({
      items: [
        { snippet: { channelTitle: 'Slowdive - Topic', categoryId: '10' } },
        { snippet: { channelTitle: 'Slowdive - Topic', categoryId: '10' } },
        { snippet: { channelTitle: 'Moving As A Giant - Topic', categoryId: '10' } },
        { snippet: { channelTitle: 'Some Vlogger', categoryId: '22' } },
      ],
    });
  }
  if (url.includes('/subscriptions?')) {
    return json({
      items: [
        { snippet: { title: 'METZVEVO', resourceId: { channelId: 'c_metz' } } },
        { snippet: { title: 'Cooking Daily', resourceId: { channelId: 'c_cook' } } },
        { snippet: { title: 'Slowdive', resourceId: { channelId: 'c_slow' } } },
      ],
    });
  }
  if (url.includes('/channels?')) {
    return json({
      items: [
        { id: 'c_metz', topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Punk_rock'] } },
        { id: 'c_cook', topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Food'] } },
        { id: 'c_slow', topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Rock_music'] } },
      ],
    });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

describe('youtube music', () => {
  it('cleans channel names into artists', () => {
    expect(artistName('Moving As A Giant - Topic')).toBe('Moving As A Giant');
    expect(artistName('METZVEVO')).toBe('METZ');
    expect(artistName('Slowdive (Official)')).toBe('Slowdive');
  });

  it('ranks liked songs first, then music subscriptions, skipping everything else', async () => {
    const artists = await fetchArtists('at', fake);
    expect(artists.map((a) => a.name)).toEqual(['Slowdive', 'Moving As A Giant', 'METZ']);
  });

  it('connects, stores artists apart from Spotify, and disconnects', async () => {
    await env.DB.prepare(`INSERT INTO users (id, name, email) VALUES ('u_yt', 'YT', 'yt@example.org')`).run();
    const url = new URL(await connectUrl(google, 'u_yt'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
    const state = url.searchParams.get('state')!;
    expect(
      await env.DB.prepare(`SELECT 1 AS ok FROM verifications WHERE identifier = 'youtube-state:u_yt' AND value = ?`)
        .bind(await sha256(state))
        .first(),
    ).toEqual({ ok: 1 });
    expect(await finishConnect(google, 'u_yt', 'code', state, fake)).toBe(3);
    const s = await youtubeStatus(google, 'u_yt');
    expect(s).toMatchObject({ available: true, connected: true, artists: ['Slowdive', 'Moving As A Giant', 'METZ'] });
    // The state works once.
    await expect(finishConnect(google, 'u_yt', 'code', state, fake)).rejects.toMatchObject({ status: 400 });
    await disconnect(env.DB, 'u_yt');
    expect(await youtubeStatus(google, 'u_yt')).toMatchObject({ connected: false, artists: [] });
  });

  it('says when the site has no Google credentials', async () => {
    expect((await youtubeStatus(env, 'nobody')).available).toBe(false);
  });
});
