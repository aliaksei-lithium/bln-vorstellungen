import {
  CATEGORY_LABELS,
  FREQUENCY_MIN_SCORE,
  berlinToday,
  formatDateTime,
  formatPrice,
  hiddenCategories,
  utcToBerlinLocal,
  type Category,
  type InboxReview,
  type Prefs,
} from '@bln/shared';
import { callJson, claudeSearch, providerFrom } from '../ai/llm';
import { isClaudeModel } from '../ai/models';
import * as prompt from '../ai/prompts/review';
import { loadProfile, prefsLine } from '../ai/score';
import { SOURCE_IDS, listItemsByIds } from './events';

/**
 * The daily review on the Inbox (docs/09, 2026-11-02 "Daily review"). Once a Berlin day per user with a taste:
 *  1. candidates, free: the user's scored upcoming events (6 months) with facts the scores don't show: how soon, dates
 *     left, sold-out dates, how many sources list it, and whether it falls on a day already in their agenda;
 *  2. research, Claude with web search (at most MAX_SEARCHES): reviews and demand for the most promising few;
 *  3. compose: one structured call picks what stands out, grouped by category, each pick with a kind and why.
 * Runs as DailyReviewWorkflow from the cron after REVIEW_HOUR, or on demand from the Inbox.
 */

const HORIZON_DAYS = 180;
const MIN_SCORE = 55;
const PER_CATEGORY = 6;
const MAX_CANDIDATES = 36;
const RESEARCH_EVENTS = 6;
export const MAX_SEARCHES = 4;
/** From this far ahead, an event counts as "book early" material. */
const FAR_DAYS = 42;
export const REVIEW_HOUR = 5;
const RUNNING_TTL = 900;
/** Manual rebuilds of today's edition, per user and Berlin day: each one can spend web searches. */
export const REBUILDS_PER_DAY = 3;
const rebuildKey = (userId: string, day: string) => `rebuilds:${userId}:${day}`;
const DAY_MS = 86_400_000;

export type Candidate = {
  id: string;
  title: string;
  category: Category;
  venue: string | null;
  nextLocal: string;
  days: number;
  score: number;
  reason: string | null;
  datesLeft: number;
  soldOut: number;
  lastLocal: string | null;
  sources: number;
  performers: string | null;
  price: string | null;
  sameDayAs: string | null;
  /** Public edition: how many members' scores the score averages (0: none, the score means nothing). */
  members?: number;
};

type Row = Record<string, unknown>;

/** The score's strongest reason, from its JSON column. */
function firstReason(raw: unknown): string | null {
  try {
    return (JSON.parse(String(raw ?? '[]')) as { text: string }[])[0]?.text ?? null;
  } catch {
    return null;
  }
}

/** Step 1: candidates with their facts, a few per category, without anything the user switched off or sorted out. */
export async function gatherCandidates(
  db: D1Database,
  userId: string,
  prefs: Prefs,
  now = new Date(),
): Promise<Candidate[]> {
  const nowIso = now.toISOString();
  const [scored, planned] = await db.batch<Row>([
    db
      .prepare(
        `SELECT e.id, e.title, e.category, e.price_min, e.price_max, e.is_free, e.next_start_local AS next_local,
                e.next_start_utc AS next_utc, v.name AS venue, s.score, s.reasons,
                (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?2
                   AND o.status = 'scheduled') AS dates_left,
                (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?2
                   AND o.status = 'sold_out') AS sold_out,
                (SELECT MAX(o.start_local) FROM occurrences o WHERE o.event_id = e.id
                   AND o.status != 'cancelled') AS last_local,
                (SELECT group_concat(p.name, ', ') FROM event_performers ep JOIN performers p ON p.id = ep.performer_id
                  WHERE ep.event_id = e.id) AS performers,
                ${SOURCE_IDS}
           FROM user_event_scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN venues v ON v.id = e.venue_id
           LEFT JOIN user_event_state st ON st.user_id = s.user_id AND st.event_id = e.id
          WHERE s.user_id = ?1 AND e.status = 'published' AND e.next_start_utc >= ?2 AND e.next_start_utc <= ?3
            AND s.score >= ?4 AND (st.state IS NULL OR st.state = 'inbox')
          ORDER BY s.score DESC
          LIMIT 150`,
      )
      .bind(userId, nowIso, new Date(now.getTime() + HORIZON_DAYS * DAY_MS).toISOString(), MIN_SCORE),
    db
      .prepare(
        `SELECT e.title, COALESCE(o.start_local, e.next_start_local) AS start_local
           FROM user_event_state st JOIN events e ON e.id = st.event_id
           LEFT JOIN occurrences o ON o.id = st.occurrence_id
          WHERE st.user_id = ? AND st.state IN ('interested', 'maybe')
            AND COALESCE(o.start_utc, e.next_start_utc) >= ?`,
      )
      .bind(userId, nowIso),
  ]);

  const plannedByDay = new Map<string, string>();
  for (const p of planned?.results ?? []) {
    if (p.start_local) plannedByDay.set(String(p.start_local).slice(0, 10), String(p.title));
  }
  const off = new Set<string>([...prefs.categoriesOff, ...hiddenCategories(prefs)]);
  const srcOff = new Set(prefs.sourcesOff);
  const today = Date.parse(`${berlinToday(now)}T00:00:00Z`);

  const all = (scored?.results ?? []).flatMap((r): Candidate[] => {
    const category = r.category as Category;
    const score = Number(r.score);
    const level = prefs.frequency[category];
    const sources = r.source_ids ? String(r.source_ids).split(',') : [];
    if (off.has(category)) return [];
    if (level && score < FREQUENCY_MIN_SCORE[level]) return [];
    if (sources.length && sources.every((s) => srcOff.has(s))) return [];
    const nextLocal = String(r.next_local);
    const reason = firstReason(r.reasons);
    return [
      {
        id: String(r.id),
        title: String(r.title),
        category,
        venue: (r.venue as string | null) ?? null,
        nextLocal,
        days: Math.round((Date.parse(`${nextLocal.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS),
        score,
        reason,
        datesLeft: Number(r.dates_left ?? 0),
        soldOut: Number(r.sold_out ?? 0),
        lastLocal: (r.last_local as string | null) ?? null,
        sources: sources.length,
        performers: (r.performers as string | null) ?? null,
        price: formatPrice({
          isFree: Boolean(r.is_free),
          priceMin: r.price_min as number | null,
          priceMax: r.price_max as number | null,
        }),
        sameDayAs: plannedByDay.get(nextLocal.slice(0, 10)) ?? null,
      },
    ];
  });

  // A few per category, so one busy category cannot crowd out the rest; plus what is far ahead or selling out.
  const perCategory = new Map<string, number>();
  const picked = all.filter((c) => {
    const n = perCategory.get(c.category) ?? 0;
    const special = (c.days >= FAR_DAYS && c.score >= 70) || c.soldOut > 0;
    if (n >= PER_CATEGORY && !special) return false;
    perCategory.set(c.category, n + 1);
    return true;
  });
  return picked.slice(0, MAX_CANDIDATES);
}

/** The few worth a web search: the best overall, and the best far ahead (where booking early matters). */
export function researchPicks(candidates: Candidate[]): number[] {
  // The public edition comes sorted by general interest; a user's by their score, of which only strong ones count.
  const strong = candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.members !== undefined || c.score >= 70);
  const best = strong.slice(0, RESEARCH_EVENTS / 2).map(({ i }) => i);
  const far = strong
    .filter(({ c, i }) => c.days >= FAR_DAYS && !best.includes(i))
    .slice(0, RESEARCH_EVENTS - best.length)
    .map(({ i }) => i);
  const rest = strong.filter(({ i }) => !best.includes(i) && !far.includes(i)).map(({ i }) => i);
  return [...best, ...far, ...rest].slice(0, RESEARCH_EVENTS);
}

export type Note = { index: number; note: string; url: string | null };

/** Step 2: web notes for a few candidates. Skipped (empty) without Claude or when the day's budget is short. */
export async function research(env: Env, candidates: Candidate[]): Promise<{ notes: Note[]; searches: number }> {
  const model = env.SCORE_MODEL;
  const picks = researchPicks(candidates);
  if (!model || !isClaudeModel(model) || !picks.length) return { notes: [], searches: 0 };
  const lines = picks.map((i, k) => {
    const c = candidates[i]!;
    return [
      `${k + 1}. ${c.title}`,
      CATEGORY_LABELS[c.category],
      c.venue,
      formatDateTime(c.nextLocal, c.category),
      c.performers ? `with ${c.performers}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  });
  try {
    const r = await claudeSearch(env, {
      model,
      system: prompt.researchSystem,
      user: prompt.researchUser(lines),
      maxUses: MAX_SEARCHES,
      maxTokens: 1500,
      metric: 'ai_review_calls',
    });
    const notes = prompt
      .parseResearch(r.text, picks.length)
      .map((n) => ({ index: picks[n.n - 1]!, note: n.note, url: n.url }));
    return { notes, searches: r.searches };
  } catch (err) {
    console.warn('review research skipped', String(err));
    return { notes: [], searches: 0 };
  }
}

function candidateLine(c: Candidate, i: number, note: Note | undefined): string {
  return [
    `${i + 1}. ${c.title}`,
    CATEGORY_LABELS[c.category],
    c.venue,
    `next ${formatDateTime(c.nextLocal, c.category)} (in ${c.days} days)`,
    c.datesLeft > 1
      ? `${c.datesLeft} dates left, last ${c.lastLocal?.slice(0, 10)}`
      : c.datesLeft === 1
        ? 'only this date'
        : null,
    c.soldOut ? `${c.soldOut} dates sold out` : null,
    c.price,
    c.members === undefined
      ? `score ${c.score}${c.reason ? `: ${c.reason}` : ''}`
      : c.members
        ? `average match for ${c.members} members: ${c.score}`
        : null,
    c.sources > 1 ? `listed by ${c.sources} sources` : null,
    c.sameDayAs ? `same day as "${c.sameDayAs}" in their agenda` : null,
    note ? `web: ${note.note}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

type StoredPick = { eventId: string; kind: prompt.Kind; why: string; sourceUrl: string | null };
type Stored = { summary: string; sections: { category: Category; picks: StoredPick[] }[] };

/**
 * "Book early" means months ahead; the model sometimes uses it for next week. Closer than BOOK_EARLY_MIN_DAYS it
 * becomes a last chance (few dates left) or simply made for you.
 */
const BOOK_EARLY_MIN_DAYS = 21;
export function kindFor(kind: prompt.Kind, c: Candidate): prompt.Kind {
  if (kind !== 'book_early' || c.days >= BOOK_EARLY_MIN_DAYS) return kind;
  return c.datesLeft <= 3 ? 'last_chance' : 'perfect_match';
}

/** Who a review is for: a user id, or null for the public edition. */
type Audience = string | null;
const runningKey = (who: Audience) => `review-running:${who ?? 'public'}`;

const PUBLIC_TASTE =
  'Anyone curious about Berlin culture: wants the highlights of the coming months across theatre, music, clubs, ' +
  'art and talks: the hard-to-get tickets, the acclaimed productions, the last chances. No agenda of their own.';

/** Step 3: the review itself, saved for the day. Returns how many picks it holds. */
export async function composeReview(
  env: Env,
  who: Audience,
  candidates: Candidate[],
  found: { notes: Note[]; searches: number },
  now = new Date(),
): Promise<number> {
  const day = berlinToday(now);
  const byIndex = new Map(found.notes.map((n) => [n.index, n]));
  let content: Stored = {
    summary: 'Nothing stands out right now: no strong matches in the next months.',
    sections: [],
  };
  let model = 'none';
  if (candidates.length) {
    const profile = who ? await loadProfile(env.DB, who) : null;
    const r = await callJson(env, {
      provider: providerFrom(env.SCORE_MODEL),
      system: prompt.system,
      user: prompt.user(
        profile ? profile.tasteText : PUBLIC_TASTE,
        profile && who ? await prefsLine(env.DB, who, profile.prefs) : '',
        day,
        candidates.map((c, i) => candidateLine(c, i, byIndex.get(i))),
      ),
      schema: prompt.schema,
      parse: (out) => prompt.parseReview(out, candidates.length),
      maxTokens: 2500,
      metric: 'ai_review_calls',
    });
    model = r.model;
    content = {
      summary: r.value.summary,
      sections: r.value.sections.map((s) => ({
        category: s.category,
        picks: s.picks
          // No agenda in the public edition, so nothing to check against.
          .filter((p) => who || p.kind !== 'plan_check')
          .map((p) => ({
            eventId: candidates[p.n - 1]!.id,
            kind: kindFor(p.kind, candidates[p.n - 1]!),
            why: p.why.slice(0, 200),
            sourceUrl: byIndex.get(p.n - 1)?.url ?? null,
          })),
      })),
    };
  }
  const version = found.searches ? `${prompt.researchVersion}+${prompt.version}` : prompt.version;
  const upsert = `ON CONFLICT DO UPDATE SET content = excluded.content, model = excluded.model,
       prompt_version = excluded.prompt_version, searches = excluded.searches,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  await (
    who
      ? env.DB.prepare(
          `INSERT INTO user_reviews (user_id, day, content, model, prompt_version, searches) VALUES (?, ?, ?, ?, ?, ?) ${upsert}`,
        ).bind(who, day, JSON.stringify(content), model, version, found.searches)
      : env.DB.prepare(
          `INSERT INTO public_reviews (day, content, model, prompt_version, searches) VALUES (?, ?, ?, ?, ?) ${upsert}`,
        ).bind(day, JSON.stringify(content), model, version, found.searches)
  ).run();
  await env.CACHE.delete(runningKey(who));
  return content.sections.reduce((n, s) => n + s.picks.length, 0);
}

type ReviewRow = { day: string; content: string; searches: number; created_at: string };

/** Picks still upcoming and, for a user, not hidden or skipped since; emptied sections go. */
async function readBack(
  env: Env,
  row: ReviewRow,
  opts: { userId?: string; hidden: readonly Category[]; sourcesOff?: Set<string> },
  now: Date,
): Promise<InboxReview['sections']> {
  const content = JSON.parse(row.content) as Stored;
  const ids = content.sections.flatMap((s) => s.picks.map((p) => p.eventId));
  if (!ids.length) return [];
  type Meta = { id: string; slug: string; score: number | null; state: string | null };
  const [items, extra] = await Promise.all([
    listItemsByIds(env.DB, ids, opts.hidden),
    env.DB.prepare(
      `SELECT e.id, e.slug, s.score, st.state FROM events e
         LEFT JOIN user_event_scores s ON s.event_id = e.id AND s.user_id = ?1
         LEFT JOIN user_event_state st ON st.event_id = e.id AND st.user_id = ?1
        WHERE e.id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
    )
      .bind(opts.userId ?? '', ...ids)
      .all<Meta>(),
  ]);
  // List rows carry slugs, not ids: match through the slug.
  const bySlug = new Map(items.map((it) => [it.slug, it]));
  const meta = new Map(extra.results.map((r) => [r.id, r]));
  const today = utcToBerlinLocal(now).slice(0, 10);
  return content.sections.flatMap((s) => {
    const picks = s.picks.flatMap((p) => {
      const m = meta.get(p.eventId);
      const event = m ? bySlug.get(m.slug) : undefined;
      if (!event || event.next.startLocal < today) return [];
      if (m?.state === 'hidden' || m?.state === 'skipped') return [];
      const off = opts.sourcesOff;
      if (off?.size && event.sources?.length && event.sources.every((id) => off.has(id))) return [];
      return [{ kind: p.kind, why: p.why, sourceUrl: p.sourceUrl, score: m?.score ?? null, event }];
    });
    return picks.length ? [{ category: s.category, picks }] : [];
  });
}

function shape(
  row: ReviewRow | null,
  preparing: boolean,
  sections: InboxReview['sections'],
  today: string,
  rebuildsLeft = 0,
): InboxReview {
  if (!row) {
    return {
      status: preparing ? 'preparing' : 'none',
      day: null,
      createdAt: null,
      summary: null,
      sections: [],
      searches: 0,
      canRefresh: !preparing,
      rebuildsLeft,
    };
  }
  return {
    status: preparing ? 'preparing' : 'ready',
    day: row.day,
    createdAt: row.created_at,
    summary: (JSON.parse(row.content) as Stored).summary,
    sections,
    searches: row.searches,
    canRefresh: row.day !== today && !preparing,
    rebuildsLeft,
  };
}

/** A user's latest review. */
export async function getReview(env: Env, userId: string, now = new Date()): Promise<InboxReview> {
  const today = berlinToday(now);
  const [row, running, used, profile] = await Promise.all([
    env.DB.prepare(
      `SELECT day, content, searches, created_at FROM user_reviews WHERE user_id = ? ORDER BY day DESC LIMIT 1`,
    )
      .bind(userId)
      .first<ReviewRow>(),
    env.CACHE.get(runningKey(userId)),
    env.CACHE.get(rebuildKey(userId, today)),
    loadProfile(env.DB, userId),
  ]);
  const sections = row ? await readBack(env, row, { userId, hidden: hiddenCategories(profile.prefs) }, now) : [];
  return shape(row, !!running, sections, today, Math.max(0, REBUILDS_PER_DAY - Number(used ?? 0)));
}

/**
 * The user asks for a fresh Discover and For you now. Without today's edition yet it is the day's own run; once it
 * exists, a rebuild, at most REBUILDS_PER_DAY a day. Nothing starts while one is being prepared.
 */
export async function rebuildNow(env: Env, userId: string, now = new Date()): Promise<boolean> {
  const current = await getReview(env, userId, now);
  if (current.status === 'preparing') return false;
  const day = berlinToday(now);
  if (current.day !== day) return startReview(env, userId, `review-${userId}-${day}-now`);
  if (!current.rebuildsLeft) return false;
  const n = REBUILDS_PER_DAY - current.rebuildsLeft + 1;
  await env.CACHE.put(rebuildKey(userId, day), String(n), { expirationTtl: 2 * 86_400 });
  return startReview(env, userId, `review-${userId}-${day}-again-${n}`);
}

/** The latest public edition. Visitors cannot ask for a fresh one. */
export async function getPublicReview(env: Env, now = new Date()): Promise<InboxReview> {
  const row = await env.DB.prepare(
    `SELECT day, content, searches, created_at FROM public_reviews ORDER BY day DESC LIMIT 1`,
  ).first<ReviewRow>();
  const { results: defaultOff } = await env.DB.prepare(`SELECT id FROM sources WHERE default_off = 1`).all<{
    id: string;
  }>();
  const sections = row
    ? await readBack(env, row, { hidden: hiddenCategories(), sourcesOff: new Set(defaultOff.map((d) => d.id)) }, now)
    : [];
  return { ...shape(row, false, sections, berlinToday(now)), canRefresh: false };
}

/**
 * Candidates for the public edition: no taste to score against, so the members' average score (where any exist)
 * stands in for general interest, nudged by the facts: sold-out dates, several sources, far ahead.
 */
export async function gatherPublicCandidates(db: D1Database, now = new Date()): Promise<Candidate[]> {
  const nowIso = now.toISOString();
  const hidden = hiddenCategories();
  const { results } = await db
    .prepare(
      `SELECT e.id, e.title, e.category, e.price_min, e.price_max, e.is_free, e.next_start_local AS next_local,
              v.name AS venue,
              (SELECT AVG(s.score) FROM user_event_scores s WHERE s.event_id = e.id) AS avg_score,
              (SELECT COUNT(*) FROM user_event_scores s WHERE s.event_id = e.id) AS members,
              (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?1
                 AND o.status = 'scheduled') AS dates_left,
              (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?1
                 AND o.status = 'sold_out') AS sold_out,
              (SELECT MAX(o.start_local) FROM occurrences o WHERE o.event_id = e.id
                 AND o.status != 'cancelled') AS last_local,
              (SELECT group_concat(p.name, ', ') FROM event_performers ep JOIN performers p ON p.id = ep.performer_id
                WHERE ep.event_id = e.id) AS performers,
              ${SOURCE_IDS}
         FROM events e LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.status = 'published' AND e.next_start_utc >= ?1 AND e.next_start_utc <= ?2
          AND e.category NOT IN (${['', ...hidden].map((_, i) => `?${i + 3}`).join(',')})
          -- Visitors start without some venues (sources.default_off): events only they list stay out.
          AND NOT (EXISTS (SELECT 1 FROM event_sources es JOIN raw_items r ON r.id = es.raw_item_id
                            JOIN sources so ON so.id = r.source_id WHERE es.event_id = e.id AND so.default_off = 1)
                   AND NOT EXISTS (SELECT 1 FROM event_sources es JOIN raw_items r ON r.id = es.raw_item_id
                            LEFT JOIN sources so ON so.id = r.source_id
                            WHERE es.event_id = e.id AND (so.id IS NULL OR so.default_off = 0)))
        LIMIT 3000`,
    )
    .bind(nowIso, new Date(now.getTime() + HORIZON_DAYS * DAY_MS).toISOString(), '', ...hidden)
    .all<Row>();
  const today = Date.parse(`${berlinToday(now)}T00:00:00Z`);
  const all = results.map((r): Candidate & { priority: number } => {
    const nextLocal = String(r.next_local);
    const days = Math.round((Date.parse(`${nextLocal.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS);
    const members = Number(r.members ?? 0);
    const score = members ? Math.round(Number(r.avg_score)) : 0;
    const sources = r.source_ids ? String(r.source_ids).split(',').length : 0;
    const soldOut = Number(r.sold_out ?? 0);
    return {
      id: String(r.id),
      title: String(r.title),
      category: r.category as Category,
      venue: (r.venue as string | null) ?? null,
      nextLocal,
      days,
      score,
      reason: null,
      datesLeft: Number(r.dates_left ?? 0),
      soldOut,
      lastLocal: (r.last_local as string | null) ?? null,
      sources,
      performers: (r.performers as string | null) ?? null,
      price: formatPrice({
        isFree: Boolean(r.is_free),
        priceMin: r.price_min as number | null,
        priceMax: r.price_max as number | null,
      }),
      sameDayAs: null,
      members,
      priority: (members ? score : 45) + (soldOut ? 15 : 0) + (sources > 1 ? 10 : 0) + (days >= FAR_DAYS ? 5 : 0),
    };
  });
  all.sort((a, b) => b.priority - a.priority);
  const perCategory = new Map<string, number>();
  return all
    .filter((c) => {
      const n = perCategory.get(c.category) ?? 0;
      if (n >= PER_CATEGORY) return false;
      perCategory.set(c.category, n + 1);
      return true;
    })
    .slice(0, MAX_CANDIDATES)
    .map(({ priority: _p, ...c }) => c);
}

/** Starts a review run (null: the public edition); false when one with this id already exists. */
export async function startReview(env: Env, who: Audience, id: string): Promise<boolean> {
  try {
    await env.DAILY_REVIEW.create({ id, params: who ? { userId: who } : {} });
  } catch (err) {
    console.warn('review dispatch', who ?? 'public', String(err));
    return false;
  }
  await env.CACHE.put(runningKey(who), '1', { expirationTtl: RUNNING_TTL });
  return true;
}

/** Rebuilds after a music service is connected, per user and Berlin day: each one can spend web searches. */
export const TASTE_REBUILDS_PER_DAY = 3;

/**
 * After a music service is connected: whether Discover and For you may be rebuilt for this user once the new scores
 * are in (at most TASTE_REBUILDS_PER_DAY a day). When yes, For you shows "preparing" right away; the score run
 * starts the rebuild when it is done (pipeline/score-run.ts).
 */
export async function claimTasteRebuild(env: Env, userId: string, now = new Date()): Promise<boolean> {
  const key = `taste-rebuilds:${userId}:${berlinToday(now)}`;
  const used = Number((await env.CACHE.get(key)) ?? 0);
  if (used >= TASTE_REBUILDS_PER_DAY) return false;
  await Promise.all([
    env.CACHE.put(key, String(used + 1), { expirationTtl: 2 * 86_400 }),
    env.CACHE.put(runningKey(userId), '1', { expirationTtl: RUNNING_TTL }),
  ]);
  return true;
}

/**
 * From the cron: once per Berlin day after REVIEW_HOUR, the public edition and a review for everyone with a taste
 * or Spotify artists.
 */
export async function dispatchDailyReviews(env: Env, now = new Date()): Promise<number> {
  const local = utcToBerlinLocal(now);
  if (Number(local.slice(11, 13)) < REVIEW_HOUR) return 0;
  const day = local.slice(0, 10);
  const key = `reviews:${day}`;
  if (await env.CACHE.get(key)) return 0;
  await env.CACHE.put(key, now.toISOString(), { expirationTtl: 2 * 86_400 });
  const { results } = await env.DB.prepare(
    `SELECT p.user_id FROM user_profiles p
      WHERE trim(p.taste_text) != '' OR EXISTS (SELECT 1 FROM user_artists a WHERE a.user_id = p.user_id)`,
  ).all<{ user_id: string }>();
  let started = (await startReview(env, null, `review-public-${day}`)) ? 1 : 0;
  for (const u of results) if (await startReview(env, u.user_id, `review-${u.user_id}-${day}`)) started++;
  return started;
}
