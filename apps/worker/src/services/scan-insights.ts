import {
  CATEGORY_LABELS,
  actsOf,
  artistKey,
  formatPrice,
  type ExtractedEvent,
  type ScanInsight,
  type ScanPlaylistResult,
  type SpotifyArtist,
} from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { callJson, providerFrom } from '../ai/llm';
import * as prompt from '../ai/prompts/scan';
import { user as scoreUser, type ScoreEventInput } from '../ai/prompts/score';
import { loadProfile, prefsLine } from '../ai/score';
import { createPlaylist, findArtist, musicTasteLine } from '../spotify';
import { getScan } from './scans';

/**
 * Scan insights (docs/09, 2026-11-01 "Scan insights"). Reading a scan also ranks its candidates for the user, with
 * a reason and genres (one call per 20 events, in parallel). "More" is per event and on demand: the acts looked up on
 * Spotify plus a short note. A playlist takes a couple of tracks per act of the ticked events.
 *
 * Stored in `scans.insights`, one entry per candidate in the same order, each with its model and prompt version.
 */

const RANK_BATCH = 20;
const MORE_ACTS = 3;

type Fetch = typeof fetch;
type Stored = ScanInsight & { model?: string; prompt?: string };

const toScoreInput = (e: ExtractedEvent): ScoreEventInput => ({
  title: e.title,
  category: CATEGORY_LABELS[e.category],
  venue: e.venue?.name ?? null,
  start: e.occurrences[0]!.start,
  price: e.price
    ? formatPrice({ isFree: !!e.price.free, priceMin: e.price.min ?? null, priceMax: e.price.max ?? null })
    : null,
  performers: e.performers.map((p) => p.name).join(', ') || null,
  description: e.description ?? null,
});

const cleanGenres = (g: string[]) => [...new Set(g.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 3);

/** Valid ranks for events 1..count; null (retry) when the reply is not JSON or covers less than half of them. */
export function parseRanks(out: unknown, count: number): prompt.ModelRank[] | null {
  let v = out;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      return null;
    }
  }
  const raw = (v as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const ok = raw.filter(
    (r): r is prompt.ModelRank =>
      !!r &&
      Number.isInteger(r.n) &&
      r.n >= 1 &&
      r.n <= count &&
      !seen.has(r.n) &&
      !!seen.add(r.n) &&
      typeof r.score === 'number' &&
      typeof r.reason === 'string' &&
      Array.isArray(r.genres),
  );
  return ok.length * 2 >= count ? ok : null;
}

/**
 * Ranks candidates for the user. Best effort: a failed batch keeps the extractor's genres without a score, and a
 * scan never fails because of ranking.
 */
export async function rankCandidates(env: Env, userId: string, events: ExtractedEvent[]): Promise<Stored[]> {
  if (!events.length) return [];
  const profile = await loadProfile(env.DB, userId);
  const prefs = await prefsLine(env.DB, userId, profile.prefs);
  const batches: ExtractedEvent[][] = [];
  for (let i = 0; i < events.length; i += RANK_BATCH) batches.push(events.slice(i, i + RANK_BATCH));
  const ranked = await Promise.all(
    batches.map(async (batch) => {
      try {
        const r = await callJson(env, {
          provider: providerFrom(env.SCORE_MODEL),
          system: prompt.rankSystem,
          user: scoreUser(profile.tasteText, prefs, batch.map(toScoreInput)),
          schema: prompt.rankSchema,
          parse: (out) => parseRanks(out, batch.length),
          maxTokens: 3000,
          metric: 'ai_score_calls',
        });
        return batch.map((e, i): Stored => {
          const m = r.value.find((x) => x.n === i + 1);
          if (!m) return { score: null, reason: null, genres: cleanGenres(e.genres) };
          return {
            score: Math.max(0, Math.min(100, Math.round(m.score))),
            reason: m.reason.slice(0, 120),
            genres: cleanGenres(m.genres.length ? m.genres : e.genres),
            model: r.model,
            prompt: prompt.rankVersion,
          };
        });
      } catch (err) {
        console.warn('scan ranking failed', String(err));
        return batch.map((e): Stored => ({ score: null, reason: null, genres: cleanGenres(e.genres) }));
      }
    }),
  );
  return ranked.flat();
}

const eventText = (e: ExtractedEvent) =>
  [
    e.title,
    CATEGORY_LABELS[e.category],
    e.venue?.name,
    e.occurrences[0]!.start.replace('T', ' '),
    e.performers.length
      ? `with ${e.performers.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ')}`
      : '',
    e.genres.length ? `genres: ${e.genres.join(', ')}` : '',
    e.description?.replace(/\s+/g, ' ').slice(0, 800),
  ]
    .filter(Boolean)
    .join('\n');

const spotifyReady = (env: Env) => !!(env as Env & { SPOTIFY_CLIENT_ID?: string }).SPOTIFY_CLIENT_ID;

function parseMore(out: unknown): prompt.ModelMore | null {
  try {
    const v = (typeof out === 'string' ? JSON.parse(out) : out) as Partial<prompt.ModelMore> | null;
    return typeof v?.about === 'string' && typeof v.why === 'string' ? { about: v.about, why: v.why } : null;
  } catch {
    return null;
  }
}

/** The "More" note for candidate `index`, made once and kept on the scan. */
export async function scanMore(
  env: Env,
  userId: string,
  scanId: string,
  index: number,
  f: Fetch = fetch,
): Promise<ScanInsight> {
  const scan = await getScan(env.DB, userId, scanId);
  const e = scan.candidates[index];
  if (!e) throw new HTTPException(404, { message: 'No such event in this scan.' });
  const known = scan.insights[index];
  if (known?.more) return known;

  const artists: SpotifyArtist[] = [];
  if (spotifyReady(env)) {
    for (const act of actsOf(e).slice(0, MORE_ACTS)) {
      const a = await findArtist(env, act, f).catch((err: unknown) => {
        console.warn('spotify lookup failed', String(err));
        return null;
      });
      if (a) artists.push(a);
    }
  }
  const profile = await loadProfile(env.DB, userId);
  const r = await callJson(env, {
    provider: providerFrom(env.SCORE_MODEL),
    system: prompt.moreSystem,
    user: prompt.moreUser(
      profile.tasteText,
      await musicTasteLine(env.DB, userId),
      eventText(e),
      artists.map((a) => `${a.name}: ${a.genres.length ? a.genres.join(', ') : 'no genres listed'}`).join('\n'),
    ),
    schema: prompt.moreSchema,
    parse: parseMore,
    maxTokens: 600,
    metric: 'ai_score_calls',
  });
  const more = {
    about: r.value.about.slice(0, 600),
    why: r.value.why.slice(0, 300),
    artists,
    model: r.model,
    prompt: prompt.moreVersion,
  };
  // json_set on one entry, so two notes asked for at once do not overwrite each other.
  const blank = scan.candidates.map((c): Stored => ({ score: null, reason: null, genres: cleanGenres(c.genres) }));
  await env.DB.prepare(
    `UPDATE scans SET insights = json_set(COALESCE(insights, ?), ?, json(?)) WHERE id = ? AND user_id = ?`,
  )
    .bind(JSON.stringify(blank), `$[${index}].more`, JSON.stringify(more), scanId, userId)
    .run();
  const base = known ?? blank[index]!;
  return {
    score: base.score,
    reason: base.reason,
    genres: base.genres,
    more: { about: more.about, why: more.why, artists },
  };
}

/** A private Spotify playlist from the picked candidates: first acts of every event first, then the rest. */
export async function scanPlaylist(
  env: Env,
  userId: string,
  scanId: string,
  indexes: number[],
  f: Fetch = fetch,
): Promise<ScanPlaylistResult> {
  const scan = await getScan(env.DB, userId, scanId);
  const picked = [...new Set(indexes)].flatMap((i) => (scan.candidates[i] ? [scan.candidates[i]] : []));
  if (!picked.length) throw new HTTPException(400, { message: 'Pick at least one event.' });
  const lists = picked.map(actsOf);
  const acts = new Map<string, string>();
  for (let round = 0; round < MORE_ACTS; round++) {
    for (const l of lists) {
      const act = l[round];
      if (act && !acts.has(artistKey(act))) acts.set(artistKey(act), act);
    }
  }
  if (!acts.size) throw new HTTPException(400, { message: 'These events name no acts to look for.' });
  const day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Berlin' });
  return createPlaylist(
    env,
    userId,
    {
      name: `BLN gigs · ${day}`,
      description: `From a BLN Vorstellungen scan: ${picked.map((e) => e.title).join(', ')}`,
      acts: [...acts.values()],
    },
    f,
  );
}
