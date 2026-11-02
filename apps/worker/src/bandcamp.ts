import { USER_AGENT } from '@bln/sources';
import type { BandcampStatus } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { fillGenres, musicTaste, saveArtistsFrom, type Artist } from './spotify';

/**
 * Bandcamp (docs/09, 2026-11-04), like Spotify and YouTube Music, but without a sign-in: Bandcamp has no API for
 * fans, and a fan's collection is public by default. The user gives their fan name; we read the fan id from the fan
 * page, then the collection, wishlist and followed artists from the endpoints the fan page itself uses. Artists
 * bought most count most, then the wishlist, then followed ones; genres come from the same model call Spotify
 * artists get. About 7 requests per sync. Nothing secret is kept: the fan name is all we store besides the artists.
 */

const SITE = 'https://bandcamp.com';
const API = `${SITE}/api/fancollection/1`;
const PROVIDER = 'bandcamp';
const PER_PAGE = 100;
const COLLECTION_PAGES = 3;
const FOLLOWING_PAGES = 2;
const MAX_ARTISTS = 150;
/** Fan names: letters, digits, "_", "-" and "." (what Bandcamp allows in https://bandcamp.com/<name>). */
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
/** Compilations name no one in particular. */
const NOBODY = /^(various( artists)?|v\.?\s?a\.?|unknown artist)$/i;

type Fetch = typeof fetch;

/**
 * The fan name from what the user typed: "name", "@name", "bandcamp.com/name" or "https://bandcamp.com/name/…".
 * Null for anything else, an artist's own site ("name.bandcamp.com") included.
 */
export function bandcampUsername(input: string): string | null {
  let s = input.trim().replace(/^@/, '');
  if (/\.bandcamp\.com\b/i.test(s)) return null;
  const link = /^(?:https?:\/\/)?(?:www\.)?bandcamp\.com\/([^/?#\s]+)/i.exec(s);
  if (link) s = link[1]!;
  else if (/[/:]/.test(s)) return null;
  return NAME.test(s) ? s : null;
}

async function bandcamp(f: Fetch, url: string, body?: unknown): Promise<Response> {
  const res = await f(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: body === undefined ? 'text/html' : 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null);
  if (!res) throw new HTTPException(502, { message: 'Bandcamp did not answer. Try again in a minute.' });
  return res;
}

/** The fan id from the fan page's page data (`data-blob`, HTML-escaped JSON with `fan_data.fan_id`). */
export async function fanId(username: string, f: Fetch): Promise<number> {
  const res = await bandcamp(f, `${SITE}/${encodeURIComponent(username)}`);
  if (res.status === 404) {
    throw new HTTPException(404, { message: `Bandcamp has no fan page called “${username}”.` });
  }
  if (!res.ok) throw new HTTPException(502, { message: `Bandcamp answered ${res.status}.` });
  const html = await res.text();
  const q = '(?:&quot;|")';
  const m =
    new RegExp(`fan_data${q}:\\{[^{}]*?${q}fan_id${q}:(\\d+)`).exec(html) ??
    new RegExp(`${q}fan_id${q}:(\\d+)`).exec(html);
  if (!m) {
    throw new HTTPException(404, {
      message: `“${username}” is not a Bandcamp fan page. Use the name from your profile link, bandcamp.com/<name>.`,
    });
  }
  return Number(m[1]);
}

type Page = { more_available?: boolean; last_token?: string; error?: boolean; error_message?: string };
type Items = Page & { items?: { band_name?: string }[] };
type Followed = Page & { followeditems?: { name?: string }[] };

/** Up to `pages` pages of one fan list, newest first; an error on a later page keeps what came before. */
async function pages<T extends Page>(
  f: Fetch,
  list: string,
  fan: number,
  first: string,
  pageCount: number,
  pick: (p: T) => (string | undefined)[],
): Promise<string[]> {
  const names: string[] = [];
  let token = first;
  for (let page = 0; page < pageCount; page++) {
    const res = await bandcamp(f, `${API}/${list}`, { fan_id: fan, older_than_token: token, count: PER_PAGE });
    if (!res.ok) throw new Error(`Bandcamp ${list} ${res.status}`);
    const p = (await res.json()) as T;
    if (p.error) throw new Error(`Bandcamp ${list}: ${p.error_message ?? 'error'}`);
    names.push(...pick(p).filter((n): n is string => !!n?.trim()));
    if (!p.more_available || !p.last_token) break;
    token = p.last_token;
  }
  return names;
}

/**
 * Collection first (bands with more purchases higher, then the most recent), then the wishlist, then followed
 * artists; first mention wins. Each list is best effort: a private one is skipped, not an error.
 */
export async function fetchArtists(fan: number, f: Fetch, now = new Date()): Promise<Artist[]> {
  const secs = Math.floor(now.getTime() / 1000);
  const items = (p: Items) => (p.items ?? []).map((i) => i.band_name);
  const lists = await Promise.all(
    [
      pages<Items>(f, 'collection_items', fan, `${secs}::a::`, COLLECTION_PAGES, items),
      pages<Items>(f, 'wishlist_items', fan, `${secs}::a::`, 1, items),
      pages<Followed>(f, 'following_bands', fan, `${secs}:9999999999`, FOLLOWING_PAGES, (p) =>
        (p.followeditems ?? []).map((b) => b.name),
      ),
    ].map((p, i) => p.catch((err) => (console.warn(`bandcamp list ${i} unavailable`, String(err)), [] as string[]))),
  );
  const [collection, wishlist, following] = lists as [string[], string[], string[]];

  const bought = new Map<string, { name: string; n: number; first: number }>();
  collection.forEach((raw, i) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    const hit = bought.get(key);
    if (hit) hit.n++;
    else bought.set(key, { name, n: 1, first: i });
  });
  const seen = new Set<string>();
  return [
    ...[...bought.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((b) => b.name),
    ...wishlist.map((n) => n.trim()),
    ...following.map((n) => n.trim()),
  ]
    .filter((name) => !NOBODY.test(name) && !seen.has(name.toLowerCase()) && !!seen.add(name.toLowerCase()))
    .slice(0, MAX_ARTISTS)
    .map((name) => ({ name, genres: [] }));
}

async function readArtists(env: Env, username: string, f: Fetch): Promise<Artist[]> {
  return fillGenres(env, await fetchArtists(await fanId(username, f), f));
}

/** Connect: checks the fan page, keeps the fan name and stores the artists. Returns how many were found. */
export async function connect(env: Env, userId: string, input: string, f: Fetch = fetch): Promise<number> {
  const username = bandcampUsername(input);
  if (!username) {
    throw new HTTPException(400, {
      message: 'Give your Bandcamp fan name or the link to your fan page, like bandcamp.com/yourname.',
    });
  }
  const artists = await readArtists(env, username, f);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    env.DB.prepare(`INSERT INTO accounts (id, user_id, account_id, provider_id) VALUES (?, ?, ?, ?)`).bind(
      crypto.randomUUID(),
      userId,
      username,
      PROVIDER,
    ),
  ]);
  await saveArtistsFrom(env.DB, userId, PROVIDER, artists);
  return artists.length;
}

/** Re-reads the artists of the connected fan page. */
export async function syncArtists(env: Env, userId: string, f: Fetch = fetch): Promise<number> {
  const acc = await env.DB.prepare(`SELECT id, account_id FROM accounts WHERE user_id = ? AND provider_id = ?`)
    .bind(userId, PROVIDER)
    .first<{ id: string; account_id: string }>();
  if (!acc) throw new HTTPException(409, { message: 'Bandcamp is not connected.' });
  const artists = await readArtists(env, acc.account_id, f);
  await env.DB.prepare(`UPDATE accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(acc.id)
    .run();
  await saveArtistsFrom(env.DB, userId, PROVIDER, artists);
  return artists.length;
}

export async function bandcampStatus(db: D1Database, userId: string): Promise<BandcampStatus> {
  const [acc, artists] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT account_id, updated_at FROM accounts WHERE user_id = ? AND provider_id = ?`)
      .bind(userId, PROVIDER),
    db.prepare(`SELECT name FROM user_artists WHERE user_id = ? AND source = 'bandcamp' ORDER BY rank`).bind(userId),
  ]);
  const row = acc?.results[0];
  return {
    connected: !!row,
    username: row ? String(row.account_id) : null,
    syncedAt: row?.updated_at ? String(row.updated_at) : null,
    artists: (artists?.results ?? []).map((r) => String(r.name)),
    genres: row ? (await musicTaste(db, userId)).genres : [],
  };
}

export async function disconnect(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM accounts WHERE user_id = ? AND provider_id = ?`).bind(userId, PROVIDER),
    db.prepare(`DELETE FROM user_artists WHERE user_id = ? AND source = 'bandcamp'`).bind(userId),
    db.prepare(`UPDATE user_profiles SET profile_version = profile_version + 1 WHERE user_id = ?`).bind(userId),
  ]);
}

/** "Listen" on Bandcamp: its artist search for the act (no lookup). */
export const listenUrl = (name: string) => `${SITE}/search?item_type=b&q=${encodeURIComponent(name)}`;
