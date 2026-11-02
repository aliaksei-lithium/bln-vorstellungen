import { artistKey, type SpotifyArtist, type SpotifyStatus } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { embedTexts } from './ai/embed';
import { callJson, providerFrom } from './ai/llm';
import { loadIndex, nearest } from './ai/vector-index';
import { newToken, sha256 } from './auth';

/**
 * Spotify (docs/09, 2026-11-01): the user connects once (authorization code flow, server side with the client
 * secret); we keep the refresh token and store their top and followed artists. Artists boost the ranking and back
 * the "My Spotify artists" filter. Scopes: top and followed artists, and private playlists (scan playlists). Public
 * lookups (artist search for "Listen" and "More") use an app token instead of the user's.
 */

const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const PLAYLIST_SCOPE = 'playlist-modify-private';
const SCOPES = `user-top-read user-follow-read ${PLAYLIST_SCOPE}`;
const PROVIDER = 'spotify';
const STATE_MINUTES = 10;

type Fetch = typeof fetch;
export type Artist = { name: string; genres: string[] };

export const redirectUri = (env: Env) => `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/spotify/callback`;

function credentials(env: Env): string {
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = env as Env & Record<string, string | undefined>;
  if (!id || !secret) throw new HTTPException(503, { message: 'Spotify is not set up on this site yet.' });
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

/** The Spotify consent URL for this user; the state is kept hashed for ten minutes and works once. */
export async function connectUrl(env: Env, userId: string, now = new Date()): Promise<string> {
  credentials(env);
  const state = newToken();
  await env.DB.prepare(`INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      `spotify-state:${userId}`,
      await sha256(state),
      new Date(now.getTime() + STATE_MINUTES * 60_000).toISOString(),
    )
    .run();
  const id = (env as Env & { SPOTIFY_CLIENT_ID?: string }).SPOTIFY_CLIENT_ID!;
  return `${AUTHORIZE}?${new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirectUri(env),
    scope: SCOPES,
    state,
  })}`;
}

async function token(env: Env, body: Record<string, string>, f: Fetch) {
  const res = await f(TOKEN, {
    method: 'POST',
    headers: { authorization: credentials(env), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new HTTPException(502, { message: `Spotify refused the sign-in (${res.status}).` });
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

async function api<T>(path: string, access: string, f: Fetch, post?: unknown): Promise<T> {
  const res = await f(
    `${API}${path}`,
    post === undefined
      ? { headers: { authorization: `Bearer ${access}` } }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify(post),
        },
  );
  if (res.status === 403) {
    throw new HTTPException(403, {
      message: 'Spotify only lets accounts the site owner added in its dashboard connect. Ask the owner to add you.',
    });
  }
  if (!res.ok) throw new HTTPException(502, { message: `Spotify answered ${res.status}.` });
  return (await res.json()) as T;
}

type ArtistObj = { name: string; genres?: string[] };

/** Top artists (about the last six months), then followed ones; first mention wins. */
export async function fetchArtists(access: string, f: Fetch): Promise<Artist[]> {
  const top = await api<{ items: ArtistObj[] }>('/me/top/artists?limit=50&time_range=medium_term', access, f);
  // Best effort: Spotify keeps reshaping follow endpoints for development-mode apps (2026); top artists suffice.
  const followed: ArtistObj[] = [];
  let next: string | null = '/me/following?type=artist&limit=50';
  try {
    for (let page = 0; next && page < 4; page++) {
      const r: { artists: { items: ArtistObj[]; next: string | null } } = await api(next, access, f);
      followed.push(...r.artists.items);
      next = r.artists.next ? r.artists.next.replace(API, '') : null;
    }
  } catch (err) {
    console.warn('spotify followed artists unavailable', String(err));
  }
  const seen = new Set<string>();
  return [...top.items, ...followed]
    .filter((a) => a.name?.trim() && !seen.has(a.name.toLowerCase()) && !!seen.add(a.name.toLowerCase()))
    .map((a) => ({ name: a.name.trim(), genres: (a.genres ?? []).slice(0, 5) }));
}

/**
 * Spotify marks artist `genres` deprecated and may return them empty. When most are missing, one cheap model call
 * names them (2-4 per artist, only for artists it knows; empty when unsure).
 */
export async function fillGenres(env: Env, artists: Artist[]): Promise<Artist[]> {
  const missing = artists.filter((a) => !a.genres.length);
  if (!artists.length || missing.length < artists.length / 2) return artists;
  const names = missing.slice(0, 60).map((a) => a.name);
  try {
    const r = await callJson(env, {
      provider: providerFrom(env.SCORE_MODEL),
      system:
        'You name music genres for artists. For each artist give 2-4 common genre names in lower case ' +
        '(e.g. "shoegaze", "post-punk", "crust punk"). If you do not know an artist, give an empty list. Never guess.',
      user: `<artists>\n${names.join('\n')}\n</artists>`,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artists: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string' }, genres: { type: 'array', items: { type: 'string' } } },
              required: ['name', 'genres'],
            },
          },
        },
        required: ['artists'],
      },
      parse: (out) => {
        try {
          const v = (typeof out === 'string' ? JSON.parse(out) : out) as { artists?: Artist[] };
          return Array.isArray(v?.artists) ? v.artists : null;
        } catch {
          return null;
        }
      },
      maxTokens: 3000,
      metric: 'ai_score_calls',
    });
    const byName = new Map(r.value.map((a) => [a.name.toLowerCase(), (a.genres ?? []).slice(0, 4)]));
    return artists.map((a) => (a.genres.length ? a : { ...a, genres: byName.get(a.name.toLowerCase()) ?? [] }));
  } catch (err) {
    console.warn('genre fill failed', String(err));
    return artists;
  }
}

/** Replaces the user's artists from one service and makes their scores stale, so the next run ranks with them. */
export async function saveArtistsFrom(
  db: D1Database,
  userId: string,
  source: 'spotify' | 'youtube' | 'bandcamp',
  artists: Artist[],
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM user_artists WHERE user_id = ? AND source = ?`).bind(userId, source),
    ...artists.map((a, rank) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO user_artists (user_id, name_lc, name, genres, rank, source) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, a.name.toLowerCase(), a.name, JSON.stringify(a.genres), rank, source),
    ),
    db.prepare(`UPDATE user_profiles SET profile_version = profile_version + 1 WHERE user_id = ?`).bind(userId),
  ]);
}

const saveArtists = (db: D1Database, userId: string, artists: Artist[]) =>
  saveArtistsFrom(db, userId, 'spotify', artists);

/** Callback: checks the state, trades the code for tokens, keeps the refresh token and stores the artists. */
export async function finishConnect(env: Env, userId: string, code: string, state: string, f: Fetch = fetch) {
  const row = await env.DB.prepare(`DELETE FROM verifications WHERE identifier = ? AND value = ? RETURNING expires_at`)
    .bind(`spotify-state:${userId}`, await sha256(state))
    .first<{ expires_at: string }>();
  if (!row || row.expires_at < new Date().toISOString()) {
    throw new HTTPException(400, { message: 'That Spotify sign-in expired. Try connecting again.' });
  }
  const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env) }, f);
  const artists = await fillGenres(env, await fetchArtists(t.access_token, f));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    env.DB.prepare(
      `INSERT INTO accounts (id, user_id, account_id, provider_id, refresh_token, scope) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, userId, PROVIDER, t.refresh_token ?? null, t.scope ?? SCOPES),
  ]);
  await saveArtists(env.DB, userId, artists);
  return artists.length;
}

/** A fresh access token from the stored refresh token (Spotify may rotate it). */
async function userAccess(env: Env, userId: string, f: Fetch, needScope?: string): Promise<string> {
  const acc = await env.DB.prepare(
    `SELECT id, refresh_token, scope FROM accounts WHERE user_id = ? AND provider_id = ?`,
  )
    .bind(userId, PROVIDER)
    .first<{ id: string; refresh_token: string | null; scope: string | null }>();
  if (!acc?.refresh_token) throw new HTTPException(409, { message: 'Spotify is not connected.' });
  if (needScope && !acc.scope?.split(' ').includes(needScope)) {
    throw new HTTPException(409, { message: 'Reconnect Spotify on the Me page to allow playlists.' });
  }
  const t = await token(env, { grant_type: 'refresh_token', refresh_token: acc.refresh_token }, f);
  await env.DB.prepare(
    `UPDATE accounts SET refresh_token = COALESCE(?, refresh_token), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  )
    .bind(t.refresh_token ?? null, acc.id)
    .run();
  return t.access_token;
}

/** Re-reads the artists. */
export async function syncArtists(env: Env, userId: string, f: Fetch = fetch): Promise<number> {
  const artists = await fillGenres(env, await fetchArtists(await userAccess(env, userId, f), f));
  await saveArtists(env.DB, userId, artists);
  return artists.length;
}

export async function spotifyStatus(db: D1Database, userId: string): Promise<SpotifyStatus> {
  const [acc, artists] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT updated_at, scope FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    db.prepare(`SELECT name FROM user_artists WHERE user_id = ? AND source = 'spotify' ORDER BY rank`).bind(userId),
  ]);
  const synced = acc?.results[0]?.updated_at;
  return {
    connected: !!synced,
    syncedAt: synced ? String(synced) : null,
    artists: (artists?.results ?? []).map((r) => String(r.name)),
    genres: synced ? (await musicTaste(db, userId)).genres : [],
    canPlaylist: String(acc?.results[0]?.scope ?? '')
      .split(' ')
      .includes(PLAYLIST_SCOPE),
  };
}

export async function disconnect(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    db.prepare(`DELETE FROM user_artists WHERE user_id = ? AND source = 'spotify'`).bind(userId),
    db.prepare(`UPDATE user_profiles SET profile_version = profile_version + 1 WHERE user_id = ?`).bind(userId),
  ]);
}

/**
 * Whether an event is by one of the user's artists: a performer with the same name (any category), or a concert-
 * type event titled with the name ("Hot Chip", "Hot Chip: Tour 2027"). Returns the artist's display name.
 */
export function artistMatch(
  e: { title: string; category: string; acts: string | null },
  artists: Map<string, string>,
): string | null {
  for (const act of e.acts?.split('|') ?? []) {
    const hit = artists.get(act.toLowerCase().trim());
    if (hit) return hit;
  }
  if (!['concert', 'club', 'festival'].includes(e.category)) return null;
  const t = e.title.toLowerCase().trim();
  for (const [lc, name] of artists) {
    if (t === lc || t.startsWith(`${lc} `) || t.startsWith(`${lc}:`)) return name;
  }
  return null;
}

/**
 * The user's music taste as read from Spotify, YouTube Music and Bandcamp: genres weighted by artist rank (top
 * artists count most), and the leading artists. Added to the taste behind the scenes (embedding and scoring), never
 * into the user's own text.
 */
export async function musicTaste(db: D1Database, userId: string): Promise<{ genres: string[]; artists: string[] }> {
  const { results } = await db
    .prepare(`SELECT name, genres FROM user_artists WHERE user_id = ? ORDER BY rank, source LIMIT 120`)
    .bind(userId)
    .all<{ name: string; genres: string }>();
  const weight = new Map<string, number>();
  results.forEach((a, rank) => {
    for (const g of JSON.parse(a.genres || '[]') as string[]) weight.set(g, (weight.get(g) ?? 0) + 1 / (1 + rank / 10));
  });
  return {
    genres: [...weight.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([g]) => g),
    artists: results.slice(0, 12).map((a) => a.name),
  };
}

/** One line for prompts and the taste embedding, or '' when nothing is connected. */
export async function musicTasteLine(db: D1Database, userId: string): Promise<string> {
  const m = await musicTaste(db, userId);
  if (!m.artists.length) return '';
  return `Music they listen to: ${m.genres.length ? `${m.genres.join(', ')}; ` : ''}artists such as ${m.artists.join(', ')}.`;
}

/** Only strong meaning matches count: below this, any concert looks a little like any music taste. */
const LIKE_MIN = 0.5;
const LIKE_MAX = 150;
/** Words too broad to say anything about a taste on their own ("dream pop" still matches as a whole). */
const BROAD = new Set([
  'pop',
  'music',
  'new',
  'wave',
  'alternative',
  'indie',
  'modern',
  'classic',
  'dance',
  'contemporary',
  'german',
  'berlin',
  'deep',
  'art',
]);

/**
 * What "close to my Spotify taste" matches on: genre words from the user's artists (whole genres, plus their
 * distinctive words: "crust punk" → "crust punk", "crust", "punk") for event texts, and the ids of events whose
 * meaning is strongly close to the taste line (cached vector in KV until the artists change).
 */
export async function musicLike(env: Env, userId: string): Promise<{ ids: string[]; terms: string[] }> {
  const m = await musicTaste(env.DB, userId);
  if (!m.artists.length) return { ids: [], terms: [] };
  const terms = [
    ...new Set(
      m.genres.flatMap((g) => [
        g.toLowerCase(),
        ...g
          .toLowerCase()
          .split(/[\s-]+/)
          .filter((w) => w.length >= 4 && !BROAD.has(w)),
      ]),
    ),
  ].slice(0, 20);
  const line = await musicTasteLine(env.DB, userId);
  const index = await loadIndex(env.CACHE);
  if (!index?.ids.length) return { ids: [], terms };
  const key = `music:${userId}`;
  const hash = await sha256(line);
  const cached = await env.CACHE.getWithMetadata<{ h: string }>(key, 'arrayBuffer');
  let vec: Int8Array | undefined =
    cached.value && cached.metadata?.h === hash ? new Int8Array(cached.value) : undefined;
  if (!vec) {
    [vec] = await embedTexts(env, [line]);
    if (!vec) return { ids: [], terms };
    await env.CACHE.put(key, vec.slice().buffer as ArrayBuffer, { metadata: { h: hash } });
  }
  return { ids: nearest(index, vec, LIKE_MAX, { min: LIKE_MIN }).map((h) => h.id), terms };
}

/** An app token (client credentials) for public lookups; kept in KV for most of its hour. */
async function appToken(env: Env, f: Fetch): Promise<string> {
  const cached = await env.CACHE.get('spotify:app-token');
  if (cached) return cached;
  const t = await token(env, { grant_type: 'client_credentials' }, f);
  await env.CACHE.put('spotify:app-token', t.access_token, { expirationTtl: Math.max(60, t.expires_in - 300) });
  return t.access_token;
}

type ArtistHit = {
  name: string;
  genres?: string[];
  external_urls?: { spotify?: string };
  images?: { url: string; width?: number | null }[];
};
const ARTIST_TTL = 7 * 86_400;

/**
 * The act on Spotify, by exact name only (a near match is usually another band), or null. Cached per name for a
 * week, misses included, so a scan's "More" and "Listen" cost one search per act.
 */
export async function findArtist(env: Env, name: string, f: Fetch = fetch): Promise<SpotifyArtist | null> {
  const want = artistKey(name);
  if (!want) return null;
  const key = `spotify:artist:${want}`;
  const cached = await env.CACHE.get(key);
  if (cached) return JSON.parse(cached) as SpotifyArtist | null;
  const r = await api<{ artists: { items: ArtistHit[] } }>(
    `/search?${new URLSearchParams({ q: name, type: 'artist', limit: '10' })}`,
    await appToken(env, f),
    f,
  );
  const hit = r.artists.items.find((a) => artistKey(a.name) === want && a.external_urls?.spotify);
  const image = hit?.images?.length
    ? ([...hit.images].reverse().find((i) => (i.width ?? 0) >= 160) ?? hit.images[0]!).url
    : null;
  const artist: SpotifyArtist | null = hit
    ? { name: hit.name, url: hit.external_urls!.spotify!, genres: (hit.genres ?? []).slice(0, 4), image }
    : null;
  await env.CACHE.put(key, JSON.stringify(artist), { expirationTtl: ARTIST_TTL });
  return artist;
}

/** Where "Listen" goes: the artist page when the name is found, Spotify's own search otherwise. */
export async function listenUrl(env: Env, name: string, f: Fetch = fetch): Promise<string> {
  try {
    const a = await findArtist(env, name, f);
    if (a) return a.url;
  } catch (err) {
    console.warn('spotify listen lookup', String(err));
  }
  return `https://open.spotify.com/search/${encodeURIComponent(name)}`;
}

const TRACKS_PER_ACT = 2;
/** The Workers Free plan allows 50 subrequests per call: token, searches, create, add. */
export const PLAYLIST_ACTS = 40;

/**
 * A private playlist in the user's account with a couple of tracks per act (exact artist name only). Acts without
 * a match are reported, not guessed. Needs the playlist scope, so older connections must reconnect first.
 */
export async function createPlaylist(
  env: Env,
  userId: string,
  p: { name: string; description: string; acts: string[] },
  f: Fetch = fetch,
): Promise<{ url: string; tracks: number; missing: string[] }> {
  const access = await userAccess(env, userId, f, PLAYLIST_SCOPE);
  const acts = p.acts.slice(0, PLAYLIST_ACTS);
  const found: string[][] = [];
  for (let i = 0; i < acts.length; i += 5) {
    found.push(
      ...(await Promise.all(
        acts.slice(i, i + 5).map(async (act) => {
          const r = await api<{ tracks: { items: { uri: string; artists: { name: string }[] }[] } }>(
            `/search?${new URLSearchParams({ q: `artist:"${act}"`, type: 'track', limit: '10' })}`,
            access,
            f,
          );
          return r.tracks.items
            .filter((t) => t.artists.some((a) => artistKey(a.name) === artistKey(act)))
            .slice(0, TRACKS_PER_ACT)
            .map((t) => t.uri);
        }),
      )),
    );
  }
  const uris = [...new Set(found.flat())].slice(0, 100);
  if (!uris.length) throw new HTTPException(404, { message: 'None of these acts have tracks on Spotify.' });
  const list = await api<{ id: string; external_urls: { spotify: string } }>('/me/playlists', access, f, {
    name: p.name.slice(0, 100),
    public: false,
    description: p.description.slice(0, 300),
  });
  await api(`/playlists/${list.id}/items`, access, f, { uris });
  return { url: list.external_urls.spotify, tracks: uris.length, missing: acts.filter((_, i) => !found[i]!.length) };
}
