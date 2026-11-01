import { berlinLocalToUtc } from '@bln/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/ai/embed';
import { MODELS } from '../src/ai/models';
import { scoreByRules } from '../src/ai/score';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { listEvents } from '../src/services/events';
import { artistMatch, connectUrl, disconnect, finishConnect, musicLike, spotifyStatus } from '../src/spotify';

/** The Spotify connection against a stand-in for Spotify's token and Web API endpoints. */

const DAY = 86_400_000;
const local = (days: number) => `${new Date(Date.now() + days * DAY).toISOString().slice(0, 10)}T20:00`;
const spotifyEnv = { ...env, SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'secret' } as unknown as Env;

function fakeSpotify(seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/api/token')) {
      return Response.json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: 'user-top-read' });
    }
    if (url.includes('/me/top/artists')) {
      return Response.json({
        items: [
          { name: 'Slowdive', genres: ['shoegaze'] },
          { name: 'Hot Chip', genres: [] },
        ],
      });
    }
    if (url.includes('/me/following')) {
      return Response.json({ artists: { items: [{ name: 'slowdive' }, { name: 'Sofoquina' }], next: null } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function user(name: string) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).bind(id, name, `${id}@example.org`),
    env.DB.prepare(`INSERT INTO user_profiles (user_id, taste_text, prefs) VALUES (?, 'rock', '{}')`).bind(id),
  ]);
  return id;
}

describe('spotify', () => {
  it('connects once with a one-time state, stores top then followed artists, and disconnects', async () => {
    const uid = await user('Sam');
    const url = new URL(await connectUrl(spotifyEnv, uid));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/spotify/callback');
    expect(url.searchParams.get('scope')).toBe('user-top-read user-follow-read');
    const state = url.searchParams.get('state')!;

    const seen: string[] = [];
    expect(await finishConnect(spotifyEnv, uid, 'code', state, fakeSpotify(seen))).toBe(3);
    expect(seen[0]).toBe('POST https://accounts.spotify.com/api/token');
    expect(await spotifyStatus(env.DB, uid)).toMatchObject({
      connected: true,
      artists: ['Slowdive', 'Hot Chip', 'Sofoquina'], // "slowdive" again from followed is the same artist
    });
    // The state works once.
    await expect(finishConnect(spotifyEnv, uid, 'code', state, fakeSpotify())).rejects.toThrow('expired');

    await disconnect(env.DB, uid);
    expect(await spotifyStatus(env.DB, uid)).toEqual({ connected: false, syncedAt: null, artists: [], genres: [] });
  });

  it('still connects when followed artists are unavailable', async () => {
    const uid = await user('Ivo');
    const url = new URL(await connectUrl(spotifyEnv, uid));
    const base = fakeSpotify();
    const noFollow = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/me/following')
        ? new Response('gone', { status: 410 })
        : base(input, init)) as typeof fetch;
    expect(await finishConnect(spotifyEnv, uid, 'code', url.searchParams.get('state')!, noFollow)).toBe(2);
  });

  it('matches by performer anywhere, and by title only for concert-type events', () => {
    const artists = new Map([['hot chip', 'Hot Chip']]);
    expect(artistMatch({ title: 'Live!', category: 'theatre', acts: 'Hot Chip|Other' }, artists)).toBe('Hot Chip');
    expect(artistMatch({ title: 'Hot Chip: Tour 2027', category: 'concert', acts: null }, artists)).toBe('Hot Chip');
    expect(artistMatch({ title: 'Hot Chips and Dips', category: 'concert', acts: null }, artists)).toBeNull();
    expect(artistMatch({ title: 'Hot Chip', category: 'talk', acts: null }, artists)).toBeNull();
  });

  it('puts my artists at the top of the ranking and behind the "My Spotify artists" filter', async () => {
    const uid = await user('Kim');
    const url = new URL(await connectUrl(spotifyEnv, uid));
    await finishConnect(spotifyEnv, uid, 'code', url.searchParams.get('state')!, fakeSpotify());
    const vec = quantize(Array.from({ length: MODELS.embed.dims }, (_, i) => (i === 0 ? 1 : 0)));
    await env.DB.batch(
      [
        ['sp_hot', 'Hot Chip', 'concert'],
        ['sp_other', 'Somebody Else', 'concert'],
      ].flatMap(([id, title, cat], i) => [
        env.DB.prepare(
          `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by) VALUES (?, ?, ?, 'en', ?, ?, 't')`,
        ).bind(id, id, title, cat, `sp${i}`),
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `${id}_o`,
          id,
          local(5 + i),
          berlinLocalToUtc(local(5 + i)),
        ),
        env.DB.prepare(
          `INSERT INTO event_embeddings (event_id, model, dims, vector, text_hash) VALUES (?, ?, ?, ?, 'x')`,
        ).bind(id, `${MODELS.embed.id}#int8`, MODELS.embed.dims, vec.buffer),
      ]),
    );
    await refreshAllNextDates(env.DB);

    const r = await scoreByRules(env, uid);
    expect(r.candidates).not.toContain('sp_hot'); // no model call needed for a sure match
    const hot = await env.DB.prepare(
      `SELECT score, reasons FROM user_event_scores WHERE user_id = ? AND event_id = 'sp_hot'`,
    )
      .bind(uid)
      .first<{ score: number; reasons: string }>();
    expect(hot?.score).toBe(92);
    expect(JSON.parse(hot!.reasons)[0].text).toBe('You listen to Hot Chip on Spotify');

    const mine = await listEvents(env.DB, { via: ['spotify'] }, undefined, undefined, uid);
    expect(mine.items.map((e) => e.title)).toEqual(['Hot Chip']);
    expect((await listEvents(env.DB, { via: ['spotify'] })).items).toEqual([]); // nobody asking: nothing
  });

  it('finds events close to my taste by genre words, not just my artists', async () => {
    const uid = await user('Noa');
    const url = new URL(await connectUrl(spotifyEnv, uid));
    await finishConnect(spotifyEnv, uid, 'code', url.searchParams.get('state')!, fakeSpotify());
    const like = await musicLike(env, uid);
    expect(like.terms).toContain('shoegaze'); // from Slowdive's genres
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, slug, title, description, lang, category, dedup_key, created_by)
         VALUES ('lk_a', 'lk-a', 'Wall of Sound Night', 'Three loud shoegaze bands from Leipzig', 'en', 'concert', 'lk0', 't'),
                ('lk_b', 'lk-b', 'Shoegaze talk', 'A lecture about shoegaze history', 'en', 'talk', 'lk1', 't'),
                ('lk_c', 'lk-c', 'Jazz Trio', 'Standards and ballads', 'en', 'concert', 'lk2', 't')`,
      ),
      ...['lk_a', 'lk_b', 'lk_c'].map((id, i) =>
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `${id}_o`,
          id,
          local(8 + i),
          berlinLocalToUtc(local(8 + i)),
        ),
      ),
    ]);
    await refreshAllNextDates(env.DB);
    const r = await listEvents(env.DB, { via: ['spotifylike'] }, undefined, undefined, uid, like);
    // Concert-type events only: the talk about shoegaze is not a night out.
    expect(r.items.map((e) => e.title)).toEqual(['Wall of Sound Night']);
  });
});
