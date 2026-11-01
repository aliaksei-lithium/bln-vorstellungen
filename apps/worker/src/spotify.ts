import type { SpotifyStatus } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { embedTexts } from './ai/embed';
import { callJson, providerFrom } from './ai/llm';
import { loadIndex, nearest } from './ai/vector-index';
import { newToken, sha256 } from './auth';

/**
 * Spotify (docs/09, 2026-11-01): the user connects once (authorization code flow, server side with the client
 * secret); we keep the refresh token and store their top and followed artists. Artists boost the ranking and back
 * the "My Spotify artists" filter. Scopes: top artists and followed artists only.
 */

const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-top-read user-follow-read';
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

async function api<T>(path: string, access: string, f: Fetch): Promise<T> {
  const res = await f(`${API}${path}`, { headers: { authorization: `Bearer ${access}` } });
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

/** Replaces the user's Spotify artists and makes their scores stale, so the next run ranks with them. */
async function saveArtists(db: D1Database, userId: string, artists: Artist[]): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM user_artists WHERE user_id = ? AND source = 'spotify'`).bind(userId),
    ...artists.map((a, rank) =>
      db
        .prepare(`INSERT OR IGNORE INTO user_artists (user_id, name_lc, name, genres, rank) VALUES (?, ?, ?, ?, ?)`)
        .bind(userId, a.name.toLowerCase(), a.name, JSON.stringify(a.genres), rank),
    ),
    db.prepare(`UPDATE user_profiles SET profile_version = profile_version + 1 WHERE user_id = ?`).bind(userId),
  ]);
}

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

/** Re-reads the artists with the stored refresh token (Spotify may rotate it). */
export async function syncArtists(env: Env, userId: string, f: Fetch = fetch): Promise<number> {
  const acc = await env.DB.prepare(`SELECT id, refresh_token FROM accounts WHERE user_id = ? AND provider_id = ?`)
    .bind(userId, PROVIDER)
    .first<{ id: string; refresh_token: string | null }>();
  if (!acc?.refresh_token) throw new HTTPException(409, { message: 'Spotify is not connected.' });
  const t = await token(env, { grant_type: 'refresh_token', refresh_token: acc.refresh_token }, f);
  const artists = await fillGenres(env, await fetchArtists(t.access_token, f));
  await env.DB.prepare(
    `UPDATE accounts SET refresh_token = COALESCE(?, refresh_token), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  )
    .bind(t.refresh_token ?? null, acc.id)
    .run();
  await saveArtists(env.DB, userId, artists);
  return artists.length;
}

export async function spotifyStatus(db: D1Database, userId: string): Promise<SpotifyStatus> {
  const [acc, artists] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT updated_at FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    db.prepare(`SELECT name FROM user_artists WHERE user_id = ? AND source = 'spotify' ORDER BY rank`).bind(userId),
  ]);
  const synced = acc?.results[0]?.updated_at;
  return {
    connected: !!synced,
    syncedAt: synced ? String(synced) : null,
    artists: (artists?.results ?? []).map((r) => String(r.name)),
    genres: synced ? (await musicTaste(db, userId)).genres : [],
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
 * The user's music taste as read from Spotify: genres weighted by artist rank (top artists count most), and the
 * leading artists. Added to the taste behind the scenes (embedding and scoring), never into the user's own text.
 */
export async function musicTaste(db: D1Database, userId: string): Promise<{ genres: string[]; artists: string[] }> {
  const { results } = await db
    .prepare(`SELECT name, genres FROM user_artists WHERE user_id = ? AND source = 'spotify' ORDER BY rank LIMIT 120`)
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
  return `Music they listen to (Spotify): ${m.genres.length ? `${m.genres.join(', ')}; ` : ''}artists such as ${m.artists.join(', ')}.`;
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
