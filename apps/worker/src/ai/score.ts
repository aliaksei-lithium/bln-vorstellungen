import { CATEGORY_LABELS, Prefs, formatPrice, hiddenCategories, type Category, type Reason } from '@bln/shared';
import { cosine, embedTexts, EMBED_MODEL_TAG } from './embed';
import { callJson, providerFrom } from './llm';
import * as prompt from './prompts/score';
import { loadIndex, vectorOf } from './vector-index';

/**
 * Per-user scoring (docs/05 "Scoring design"), two stages so most events never reach an LLM:
 *  1. rules + embeddings (free): hard filters from prefs, then cosine(taste, event) mapped to a base score;
 *  2. LLM: the best LLM_PER_RUN candidates, in batches of LLM_BATCH, get a 0-100 score and short reasons.
 * Every score row carries the profile version it was computed for; a profile change re-scores everything.
 */

export const LLM_BATCH = 20;
export const LLM_PER_RUN = 60;
const RULES_MODEL = `rules+${EMBED_MODEL_TAG}`;
/** Cosine between a taste text and an event text, mapped linearly onto 0..BASE_MAX (checked by hand). */
const COS_LOW = 0.3;
const COS_HIGH = 0.6;
const BASE_MAX = 60;
/** Below this base score an event is not worth an LLM call. */
const LLM_MIN_BASE = 15;

type ProfileRow = {
  taste_text: string;
  prefs: string;
  profile_embedding: ArrayBuffer | number[] | null;
  profile_version: number;
};

export async function loadProfile(db: D1Database, userId: string) {
  const row = await db
    .prepare('SELECT taste_text, prefs, profile_embedding, profile_version FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<ProfileRow>();
  return {
    tasteText: row?.taste_text ?? '',
    prefs: Prefs.parse(JSON.parse(row?.prefs || '{}')),
    vector: row?.profile_embedding ? new Int8Array(row.profile_embedding) : null,
    version: row?.profile_version ?? 1,
  };
}

/** Saves taste + prefs, embeds the taste text and bumps the version (which makes every score stale). */
export async function saveProfile(env: Env, userId: string, tasteText: string, prefs: Prefs): Promise<number> {
  const text = tasteText.trim();
  const [vector] = text ? await embedTexts(env, [text]) : [null];
  const row = await env.DB.prepare(
    `INSERT INTO user_profiles (user_id, taste_text, prefs, profile_embedding, profile_version) VALUES (?, ?, ?, ?, 2)
     ON CONFLICT (user_id) DO UPDATE SET taste_text = excluded.taste_text, prefs = excluded.prefs,
       profile_embedding = excluded.profile_embedding, profile_version = profile_version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING profile_version`,
  )
    .bind(userId, text, JSON.stringify(prefs), vector ? vector.buffer : null)
    .first<{ profile_version: number }>();
  return row!.profile_version;
}

export const baseFromCosine = (cos: number) =>
  Math.round(Math.max(0, Math.min(1, (cos - COS_LOW) / (COS_HIGH - COS_LOW))) * BASE_MAX);

type Candidate = {
  id: string;
  title: string;
  category: Category;
  price_min: number | null;
  price_max: number | null;
  is_free: number;
};

/**
 * Stage 1 for one user: scores every upcoming, embedded event that has no score for the current profile version.
 * Writes a row for each (so a failed LLM stage still leaves a ranked inbox) and returns the LLM candidates.
 */
export async function scoreByRules(
  env: Env,
  userId: string,
  now = new Date(),
): Promise<{ scored: number; candidates: string[] }> {
  const profile = await loadProfile(env.DB, userId);
  const index = await loadIndex(env.CACHE);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.category, e.price_min, e.price_max, e.is_free
       FROM events e INDEXED BY events_next_idx
      WHERE e.next_start_utc >= ? AND e.status = 'published'
        AND EXISTS (SELECT 1 FROM event_embeddings ee WHERE ee.event_id = e.id)
        -- Current means: this profile version, and either rules only or the current scoring prompt.
        AND NOT EXISTS (SELECT 1 FROM user_event_scores s
                         WHERE s.user_id = ? AND s.event_id = e.id AND s.profile_version = ?
                           AND (s.prompt_version IS NULL OR s.prompt_version = ?))
      LIMIT 600`,
  )
    .bind(now.toISOString(), userId, profile.version, prompt.version)
    .all<Candidate>();

  const rows: { id: string; score: number; reasons: Reason[] }[] = [];
  const llm: { id: string; base: number }[] = [];
  const optedOut = hiddenCategories(profile.prefs);
  for (const e of results) {
    if (optedOut.includes(e.category)) {
      rows.push({
        id: e.id,
        score: 0,
        reasons: [{ kind: 'rule', text: `${CATEGORY_LABELS[e.category]} is off until you turn it on` }],
      });
      continue;
    }
    if (profile.prefs.categoriesOff.includes(e.category)) {
      rows.push({
        id: e.id,
        score: 0,
        reasons: [{ kind: 'rule', text: `You turned off ${CATEGORY_LABELS[e.category]}` }],
      });
      continue;
    }
    if (profile.prefs.maxPrice != null && !e.is_free && e.price_min != null && e.price_min > profile.prefs.maxPrice) {
      rows.push({ id: e.id, score: 0, reasons: [{ kind: 'rule', text: `From ${e.price_min} €, above your limit` }] });
      continue;
    }
    const v = index && vectorOf(index, e.id);
    if (!profile.vector || !v) {
      // No taste text yet (or the index lags a tick): neutral, so the inbox still works.
      rows.push({ id: e.id, score: 30, reasons: [] });
      continue;
    }
    const base = baseFromCosine(cosine(profile.vector, v));
    rows.push({ id: e.id, score: base, reasons: [] });
    if (base >= LLM_MIN_BASE) llm.push({ id: e.id, base });
  }
  await writeScores(env.DB, userId, profile.version, RULES_MODEL, null, rows, now);
  const candidates = profile.tasteText
    ? llm
        .sort((a, b) => b.base - a.base)
        .slice(0, LLM_PER_RUN)
        .map((c) => c.id)
    : [];
  return { scored: rows.length, candidates };
}

/** Stage 2: one LLM call for up to LLM_BATCH events of one user. */
export async function scoreWithLlm(env: Env, userId: string, eventIds: string[], now = new Date()) {
  if (!eventIds.length) return { scored: 0, model: null as string | null };
  const profile = await loadProfile(env.DB, userId);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.category, e.description, e.price_min, e.price_max, e.is_free, e.next_start_local,
            v.name AS venue,
            (SELECT group_concat(p.name, ', ') FROM event_performers ep JOIN performers p ON p.id = ep.performer_id
              WHERE ep.event_id = e.id) AS performers
       FROM events e LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.id IN (${eventIds.map(() => '?').join(',')})`,
  )
    .bind(...eventIds)
    .all<
      Candidate & {
        description: string | null;
        next_start_local: string;
        venue: string | null;
        performers: string | null;
      }
    >();

  const prefs = [
    profile.prefs.categoriesOff.length
      ? `not interested in ${profile.prefs.categoriesOff.map((c) => CATEGORY_LABELS[c]).join(', ')}`
      : '',
    profile.prefs.maxPrice != null ? `pays at most ${profile.prefs.maxPrice} €` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const r = await callJson(env, {
    provider: providerFrom(env.SCORE_MODEL),
    system: prompt.system,
    user: prompt.user(
      profile.tasteText,
      prefs,
      results.map((e) => ({
        title: e.title,
        category: CATEGORY_LABELS[e.category],
        venue: e.venue,
        start: e.next_start_local,
        price: formatPrice({ isFree: Boolean(e.is_free), priceMin: e.price_min, priceMax: e.price_max }),
        performers: e.performers,
        description: e.description,
      })),
    ),
    schema: prompt.schema,
    parse: (out) => parseScores(out, results.length),
    maxTokens: 3000,
    metric: 'ai_score_calls',
  });
  const rows = r.value.map((s) => ({
    id: results[s.n - 1]!.id,
    score: Math.max(0, Math.min(100, Math.round(s.score))),
    reasons: s.reasons.slice(0, 2).map((x) => ({ kind: x.kind, text: x.text.slice(0, 120) })),
  }));
  await writeScores(env.DB, userId, profile.version, r.model, prompt.version, rows, now);
  return { scored: rows.length, model: r.model };
}

/** Valid scores for events 1..count; null (retry) when the reply is not JSON or covers less than half of them. */
export function parseScores(out: unknown, count: number): prompt.ModelScore[] | null {
  let v = out;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      return null;
    }
  }
  const raw = (v as { scores?: unknown } | null)?.scores;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const ok = raw.filter(
    (s): s is prompt.ModelScore =>
      !!s &&
      Number.isInteger(s.n) &&
      s.n >= 1 &&
      s.n <= count &&
      !seen.has(s.n) &&
      !!seen.add(s.n) &&
      typeof s.score === 'number' &&
      Array.isArray(s.reasons),
  );
  return ok.length * 2 >= count ? ok : null;
}

async function writeScores(
  db: D1Database,
  userId: string,
  profileVersion: number,
  model: string,
  promptVersion: string | null,
  rows: { id: string; score: number; reasons: Reason[] }[],
  now: Date,
) {
  if (!rows.length) return;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO user_event_scores (user_id, event_id, score, reasons, model, prompt_version, profile_version, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, event_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons,
           model = excluded.model, prompt_version = excluded.prompt_version,
           profile_version = excluded.profile_version, computed_at = excluded.computed_at`,
      )
      .bind(userId, r.id, r.score, JSON.stringify(r.reasons), model, promptVersion, profileVersion, now.toISOString()),
  );
  // D1 batches are transactions; keep each one modest.
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

/**
 * Once per scoring prompt version (KV flag): re-score everyone, since scores made with an older prompt count as
 * stale. Called by the cron, so a deploy that bumps the prompt re-ranks within 15 minutes.
 */
export async function rescoreAfterPromptChange(env: Env, now = new Date()): Promise<boolean> {
  const key = `rescored:${prompt.version}`;
  if (await env.CACHE.get(key)) return false;
  await dispatchScoring(env, undefined, now);
  await env.CACHE.put(key, now.toISOString());
  return true;
}

/** Starts a ScoreEvents run per user (all users, or one). Instance ids keep a re-dispatch within a minute idempotent. */
export async function dispatchScoring(env: Env, userId?: string, now = new Date()): Promise<number> {
  const { results } = userId
    ? { results: [{ id: userId }] }
    : await env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
  const minute = Math.floor(now.getTime() / 60_000);
  for (const u of results) {
    try {
      await env.SCORE_EVENTS.create({ id: `score-${u.id}-${minute}`, params: { userId: u.id } });
    } catch (err) {
      // An instance with this id already exists: a run for this user started this minute.
      console.warn('score dispatch', u.id, String(err));
    }
  }
  return results.length;
}
