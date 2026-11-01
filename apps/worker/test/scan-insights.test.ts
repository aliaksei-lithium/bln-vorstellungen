import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { scanMore, scanPlaylist } from '../src/services/scan-insights';
import { createScan, getScan, runScan } from '../src/services/scans';
import { connectUrl, finishConnect, listenUrl } from '../src/spotify';

/** Scan insights with a stubbed model and a stand-in for Spotify: ranking, "More", "Listen" and playlists. */

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

async function user(name: string, taste = 'shoegaze and noise rock, no musicals') {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).bind(id, name, `${id}@example.org`),
    env.DB.prepare(`INSERT INTO user_profiles (user_id, taste_text, prefs) VALUES (?, ?, '{}')`).bind(id, taste),
  ]);
  return id;
}

const listing = (title: string, performers: string[] = []) => ({
  title,
  lang: 'en',
  category: 'concert',
  dates: [{ start: `${day(10)}T20:00` }],
  venue: 'Cassiopeia',
  performers,
  genres: ['rock'],
  confidence: 0.8,
  quote: title,
});

/** Claude answers by prompt: extraction, ranking, or a "More" note. Records each system prompt it saw. */
function claudeEnv(answers: { events: unknown[]; ranks?: unknown[]; more?: unknown }, seen: string[] = []) {
  return {
    ...env,
    EXTRACT_MODEL: 'anthropic/claude-haiku-5.5',
    SCORE_MODEL: 'anthropic/claude-haiku-5.5',
    SPOTIFY_CLIENT_ID: 'cid',
    SPOTIFY_CLIENT_SECRET: 'secret',
    PHOTO_INGEST: { create: async () => ({ id: 'x' }) },
    AI: {
      run: async (_model: string, body: { system: { text: string }[] }) => {
        const sys = body.system[0]!.text;
        seen.push(sys.slice(0, 30));
        const out = sys.startsWith('You rank events someone found')
          ? { items: answers.ranks ?? [] }
          : sys.startsWith('You explain one event')
            ? answers.more
            : { events: answers.events };
        return {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 200 },
        };
      },
    },
  } as unknown as Env;
}

type Track = { uri: string; artists: { name: string }[] };

function fakeSpotify(seen: string[], o: { artists?: Record<string, string>; tracks?: Record<string, Track[]> }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search ? `?${url.searchParams.get('q')}` : ''}`);
    if (url.pathname === '/api/token') {
      return Response.json({
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600,
        scope: 'user-top-read playlist-modify-private',
      });
    }
    if (url.pathname.startsWith('/v1/me/top/artists')) return Response.json({ items: [] });
    if (url.pathname.startsWith('/v1/me/following')) return Response.json({ artists: { items: [], next: null } });
    if (url.pathname === '/v1/search' && url.searchParams.get('type') === 'artist') {
      const q = url.searchParams.get('q')!;
      const id = o.artists?.[q];
      return Response.json({
        artists: {
          items: [
            { name: `${q} Tribute`, external_urls: { spotify: 'https://open.spotify.com/artist/wrong' } },
            ...(id
              ? [
                  {
                    name: q,
                    genres: [],
                    external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
                    images: [],
                  },
                ]
              : []),
          ],
        },
      });
    }
    if (url.pathname === '/v1/search') {
      const act = /artist:"(.+)"/.exec(url.searchParams.get('q')!)![1]!;
      return Response.json({ tracks: { items: o.tracks?.[act] ?? [] } });
    }
    if (url.pathname === '/v1/me/playlists') {
      return Response.json({ id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } });
    }
    if (url.pathname === '/v1/playlists/pl1/items') return Response.json({ snapshot_id: 's' });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('scan insights', () => {
  it('ranks candidates for the user with reasons and genres while reading', async () => {
    const uid = await user('Lou');
    const seen: string[] = [];
    const e = claudeEnv(
      {
        events: [listing('Musical Gala'), listing('Wall of Noise', ['Ringo Deathstarr'])],
        ranks: [
          { n: 1, score: 12, reason: 'A musical; you said no musicals', genres: [] },
          { n: 2, score: 88, reason: 'Shoegaze, which you like', genres: ['Shoegaze', 'noise pop'] },
        ],
      },
      seen,
    );
    const id = await createScan(e, uid, { kind: 'text', text: 'Musical Gala and Wall of Noise next week' });
    expect(await runScan(e, id)).toEqual({ status: 'ready', events: 2 });
    expect(seen).toHaveLength(2); // one extraction, one ranking call for both events

    const scan = await getScan(env.DB, uid, id);
    expect(scan.insights).toEqual([
      { score: 12, reason: 'A musical; you said no musicals', genres: ['rock'] }, // the extractor's genres
      { score: 88, reason: 'Shoegaze, which you like', genres: ['shoegaze', 'noise pop'] },
    ]);
    const stored = await env.DB.prepare(`SELECT insights FROM scans WHERE id = ?`)
      .bind(id)
      .first<{ insights: string }>();
    expect(JSON.parse(stored!.insights)[1]).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      prompt: 'scanRank@1',
    });
  });

  it('still reads the scan when ranking fails', async () => {
    const uid = await user('Mo');
    const e = claudeEnv({ events: [listing('Quiet Night')], ranks: [] }); // an unusable ranking reply
    const id = await createScan(e, uid, { kind: 'text', text: 'Quiet Night at Cassiopeia next week' });
    expect(await runScan(e, id)).toEqual({ status: 'ready', events: 1 });
    expect((await getScan(env.DB, uid, id)).insights).toEqual([{ score: null, reason: null, genres: ['rock'] }]);
  });

  it('explains one event with its acts from Spotify, once', async () => {
    const uid = await user('Ana');
    const seen: string[] = [];
    const e = claudeEnv(
      {
        events: [listing('Wall of Noise', ['Ringo Deathstarr', 'Nobody Known'])],
        more: { about: 'Texan shoegaze band Ringo Deathstarr.', why: 'Close to the shoegaze you listen to.' },
      },
      seen,
    );
    const id = await createScan(e, uid, { kind: 'text', text: 'Wall of Noise with Ringo Deathstarr' });
    await runScan(e, id);
    const calls: string[] = [];
    const f = fakeSpotify(calls, { artists: { 'Ringo Deathstarr': 'rd1' } });

    const more = await scanMore(e, uid, id, 0, f);
    expect(more.more).toEqual({
      about: 'Texan shoegaze band Ringo Deathstarr.',
      why: 'Close to the shoegaze you listen to.',
      artists: [{ name: 'Ringo Deathstarr', url: 'https://open.spotify.com/artist/rd1', genres: [], image: null }],
    });
    expect((await getScan(env.DB, uid, id)).insights[0]?.more?.about).toBe('Texan shoegaze band Ringo Deathstarr.');

    // Asked again: kept, no new model call or lookup.
    const before = [seen.length, calls.length];
    await scanMore(e, uid, id, 0, f);
    expect([seen.length, calls.length]).toEqual(before);
    await expect(scanMore(e, uid, id, 5, f)).rejects.toThrow('No such event');
  });

  it('sends "Listen" to the artist page on an exact name, else to Spotify search', async () => {
    const e = claudeEnv({ events: [] });
    const f = fakeSpotify([], { artists: { Slowdive: 'sd1' } });
    expect(await listenUrl(e, 'Slowdive', f)).toBe('https://open.spotify.com/artist/sd1');
    expect(await listenUrl(e, 'Somebody Unknown', f)).toBe('https://open.spotify.com/search/Somebody%20Unknown');
  });

  it('makes a private playlist from the picked events and reports acts without tracks', async () => {
    const uid = await user('Rae');
    const e = claudeEnv({
      events: [listing('Wall of Noise', ['Ringo Deathstarr']), listing('Ghost Act'), listing('Not picked', ['X'])],
    });
    const id = await createScan(e, uid, { kind: 'text', text: 'Three gigs at Cassiopeia next week' });
    await runScan(e, id);
    const calls: string[] = [];
    const f = fakeSpotify(calls, {
      tracks: {
        'Ringo Deathstarr': [
          { uri: 'spotify:track:1', artists: [{ name: 'Ringo Deathstarr' }] },
          { uri: 'spotify:track:x', artists: [{ name: 'Someone Else' }] },
          { uri: 'spotify:track:2', artists: [{ name: 'Ringo Deathstarr' }] },
          { uri: 'spotify:track:3', artists: [{ name: 'Ringo Deathstarr' }] },
        ],
      },
    });

    // Not connected yet, then connected with the playlist scope.
    await expect(scanPlaylist(e, uid, id, [0, 1], f)).rejects.toThrow('not connected');
    const url = new URL(await connectUrl(e, uid));
    expect(url.searchParams.get('scope')).toContain('playlist-modify-private');
    await finishConnect(e, uid, 'code', url.searchParams.get('state')!, f);

    calls.length = 0;
    expect(await scanPlaylist(e, uid, id, [0, 1], f)).toEqual({
      url: 'https://open.spotify.com/playlist/pl1',
      tracks: 2,
      missing: ['Ghost Act'], // the headliner read from a title without performers
    });
    expect(calls).toEqual([
      'POST /api/token',
      'GET /v1/search?artist:"Ringo Deathstarr"',
      'GET /v1/search?artist:"Ghost Act"',
      'POST /v1/me/playlists',
      'POST /v1/playlists/pl1/items',
    ]);

    // A connection made before playlists existed must reconnect.
    await env.DB.prepare(`UPDATE accounts SET scope = 'user-top-read' WHERE user_id = ?`).bind(uid).run();
    await expect(scanPlaylist(e, uid, id, [0], f)).rejects.toThrow('Reconnect Spotify');
  });
});
