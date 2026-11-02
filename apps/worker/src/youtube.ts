import type { YoutubeStatus } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { newToken, sha256 } from './auth';
import { fillGenres, musicTaste, saveArtistsFrom, type Artist } from './spotify';

/**
 * YouTube Music (docs/09, 2026-11-03), like Spotify: the user connects once (Google OAuth, server side, read-only
 * YouTube scope); we keep the refresh token and store their artists. YouTube Music has no API of its own, so the
 * artists come from the YouTube Data API: songs they liked (YouTube Music likes show up in YouTube's liked videos,
 * category Music) and the music channels they subscribe to. Liked songs count most; genres come from the same
 * model call Spotify artists get. About 10 quota units per sync, of 10,000 a day.
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const PROVIDER = 'youtube';
const STATE_MINUTES = 10;
const PAGES = 4;
const MAX_ARTISTS = 150;
/** YouTube's category id for music videos. */
const MUSIC = '10';

type Fetch = typeof fetch;
type Creds = { id: string; secret: string };

function credentials(env: Env): Creds | null {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = env as Env & Record<string, string | undefined>;
  return id && secret ? { id, secret } : null;
}

function need(env: Env): Creds {
  const c = credentials(env);
  if (!c) throw new HTTPException(503, { message: 'YouTube Music is not set up on this site yet.' });
  return c;
}

export const redirectUri = (env: Env) => `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/youtube/callback`;

/** Google's consent URL; the state is kept hashed for ten minutes and works once. Offline access for a refresh token. */
export async function connectUrl(env: Env, userId: string, now = new Date()): Promise<string> {
  const { id } = need(env);
  const state = newToken();
  await env.DB.prepare(`INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      `youtube-state:${userId}`,
      await sha256(state),
      new Date(now.getTime() + STATE_MINUTES * 60_000).toISOString(),
    )
    .run();
  return `${AUTHORIZE}?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })}`;
}

async function token(env: Env, body: Record<string, string>, f: Fetch) {
  const { id, secret } = need(env);
  const res = await f(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: id, client_secret: secret }),
  });
  if (!res.ok) {
    const detail = await res.text();
    // An expired or revoked refresh token (apps in Google's "Testing" status lose them after 7 days).
    if (res.status === 400 && /invalid_grant/.test(detail)) {
      throw new HTTPException(409, { message: 'Reconnect YouTube Music on the Me page.' });
    }
    throw new Error(`Google token ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as { access_token: string; refresh_token?: string; scope?: string };
}

async function api<T>(path: string, access: string, f: Fetch): Promise<T> {
  const res = await f(`${API}${path}`, { headers: { authorization: `Bearer ${access}` } });
  if (!res.ok) throw new Error(`YouTube ${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** "Moving As A Giant - Topic", "SlowdiveVEVO", "Slowdive (Official)" → the artist's name. */
export function artistName(channelTitle: string): string {
  return channelTitle
    .replace(/\s+-\s+Topic$/i, '')
    .replace(/VEVO$/, '')
    .replace(/\s*[([]?\bofficial( channel| music)?\b[)\]]?\s*$/i, '')
    .trim();
}

/** Topic links YouTube attaches to music channels ("…/wiki/Rock_music", "…/wiki/Punk_rock"). */
const MUSIC_TOPIC = /music|rock|punk|jazz|hip_hop|metal|reggae|blues|soul|techno|electronic|classical|pop/i;

type Page<T> = { items?: T[]; nextPageToken?: string };
type Video = { snippet?: { channelTitle?: string; categoryId?: string } };
type Sub = { snippet?: { title?: string; resourceId?: { channelId?: string } } };
type Channel = { id: string; topicDetails?: { topicCategories?: string[] } };

/** Liked songs first (the more liked, the higher), then subscribed music channels; first mention wins. */
export async function fetchArtists(access: string, f: Fetch): Promise<Artist[]> {
  const likes = new Map<string, { name: string; n: number }>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < PAGES; page++) {
      const r: Page<Video> = await api<Page<Video>>(
        `/videos?part=snippet&myRating=like&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`,
        access,
        f,
      );
      for (const v of r.items ?? []) {
        if (v.snippet?.categoryId !== MUSIC || !v.snippet.channelTitle) continue;
        const name = artistName(v.snippet.channelTitle);
        const key = name.toLowerCase();
        if (name) likes.set(key, { name, n: (likes.get(key)?.n ?? 0) + 1 });
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    console.warn('youtube likes unavailable', String(err));
  }

  const subs: { id: string; title: string }[] = [];
  pageToken = undefined;
  try {
    for (let page = 0; page < PAGES; page++) {
      const r: Page<Sub> = await api<Page<Sub>>(
        `/subscriptions?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`,
        access,
        f,
      );
      for (const s of r.items ?? []) {
        const id = s.snippet?.resourceId?.channelId;
        if (id && s.snippet?.title) subs.push({ id, title: s.snippet.title });
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    // An account without a YouTube channel has no subscriptions to read.
    console.warn('youtube subscriptions unavailable', String(err));
  }
  const music = new Set<string>();
  for (let i = 0; i < subs.length; i += 50) {
    const ids = subs.slice(i, i + 50).map((s) => s.id);
    try {
      const r = await api<Page<Channel>>(`/channels?part=topicDetails&id=${ids.join(',')}`, access, f);
      for (const c of r.items ?? []) {
        if ((c.topicDetails?.topicCategories ?? []).some((t) => MUSIC_TOPIC.test(t))) music.add(c.id);
      }
    } catch (err) {
      console.warn('youtube channels unavailable', String(err));
    }
  }
  const subscribed = subs
    .filter((s) => music.has(s.id) || / - Topic$/i.test(s.title))
    .map((s) => artistName(s.title))
    .filter(Boolean);

  const seen = new Set<string>();
  return [...[...likes.values()].sort((a, b) => b.n - a.n).map((l) => l.name), ...subscribed]
    .filter((name) => !seen.has(name.toLowerCase()) && !!seen.add(name.toLowerCase()))
    .slice(0, MAX_ARTISTS)
    .map((name) => ({ name, genres: [] }));
}

/** Callback: checks the state, trades the code for tokens, keeps the refresh token and stores the artists. */
export async function finishConnect(env: Env, userId: string, code: string, state: string, f: Fetch = fetch) {
  const row = await env.DB.prepare(`DELETE FROM verifications WHERE identifier = ? AND value = ? RETURNING expires_at`)
    .bind(`youtube-state:${userId}`, await sha256(state))
    .first<{ expires_at: string }>();
  if (!row || row.expires_at < new Date().toISOString()) {
    throw new HTTPException(400, { message: 'That Google sign-in expired. Try connecting again.' });
  }
  const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env) }, f);
  if (!t.refresh_token) throw new Error('Google sent no refresh token');
  const artists = await fillGenres(env, await fetchArtists(t.access_token, f));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    env.DB.prepare(
      `INSERT INTO accounts (id, user_id, account_id, provider_id, refresh_token, scope) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, userId, PROVIDER, t.refresh_token, t.scope ?? SCOPE),
  ]);
  await saveArtistsFrom(env.DB, userId, 'youtube', artists);
  return artists.length;
}

async function userAccess(env: Env, userId: string, f: Fetch): Promise<string> {
  const acc = await env.DB.prepare(`SELECT id, refresh_token FROM accounts WHERE user_id = ? AND provider_id = ?`)
    .bind(userId, PROVIDER)
    .first<{ id: string; refresh_token: string | null }>();
  if (!acc?.refresh_token) throw new HTTPException(409, { message: 'YouTube Music is not connected.' });
  const t = await token(env, { grant_type: 'refresh_token', refresh_token: acc.refresh_token }, f);
  await env.DB.prepare(`UPDATE accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(acc.id)
    .run();
  return t.access_token;
}

/** Re-reads the artists. */
export async function syncArtists(env: Env, userId: string, f: Fetch = fetch): Promise<number> {
  const artists = await fillGenres(env, await fetchArtists(await userAccess(env, userId, f), f));
  await saveArtistsFrom(env.DB, userId, 'youtube', artists);
  return artists.length;
}

export async function youtubeStatus(env: Env, userId: string): Promise<YoutubeStatus> {
  const [acc, artists] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT updated_at FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    env.DB.prepare(`SELECT name FROM user_artists WHERE user_id = ? AND source = 'youtube' ORDER BY rank`).bind(userId),
  ]);
  const synced = acc?.results[0]?.updated_at;
  return {
    available: !!credentials(env),
    connected: !!synced,
    syncedAt: synced ? String(synced) : null,
    artists: (artists?.results ?? []).map((r) => String(r.name)),
    genres: synced ? (await musicTaste(env.DB, userId)).genres : [],
  };
}

export async function disconnect(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    db.prepare(`DELETE FROM user_artists WHERE user_id = ? AND source = 'youtube'`).bind(userId),
    db.prepare(`UPDATE user_profiles SET profile_version = profile_version + 1 WHERE user_id = ?`).bind(userId),
  ]);
}

/** "Listen" on YouTube Music: its search for the act (no lookup, so no quota). */
export const listenUrl = (name: string) => `https://music.youtube.com/search?q=${encodeURIComponent(name)}`;
