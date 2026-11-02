import {
  CATEGORY_LABELS,
  FREQUENCY_MIN_SCORE,
  berlinToday,
  formatDateTime,
  formatDay,
  hiddenCategories,
  utcToBerlinLocal,
  type Category,
  type DiscoverEdition,
  type DiscoverKind,
  type Prefs,
} from '@bln/shared';
import { callJson, providerFrom } from '../ai/llm';
import * as prompt from '../ai/prompts/discover';
import { loadProfile } from '../ai/score';
import { SOURCE_IDS, listItemsByIds } from './events';

/**
 * Discover (docs/09, 2026-11-02 "Discover"): an editorial page, once a Berlin day per user with scores and once for
 * the public. The stories are computed from SQL (cheap and exact): the weekend, what to book ahead, a scene (genre),
 * a venue spotlight, exhibitions, what is new, something outside the usual, free events, a district. One model call
 * then writes the copy, may group loose events into a theme, and suggests what to focus on. Without a model (or when
 * it fails) a plain template writes the copy, so a page always exists.
 */

const HORIZON_DAYS = 120;
const POOL_LIMIT = 600;
const PER_STORY = 6;
const MAX_STORIES = 9;
const FAR_DAYS = 42;
const FRESH_DAYS = 7;
const LOOSE = 18;
const KEEP_DAYS = 14;
const DAY_MS = 86_400_000;
const PUBLIC = 'public';

export type PoolItem = {
  id: string;
  title: string;
  category: Category;
  genres: string[];
  venueId: string | null;
  venue: string | null;
  district: string | null;
  nextLocal: string;
  /** Days from today (Berlin) to the next date. */
  days: number;
  /** Days since the event entered the programme. */
  age: number;
  isFree: boolean;
  /** How much the reader should care: their score, or for the public the members' average plus demand. */
  weight: number;
  /** The reader's own score (null in the public edition). */
  score: number | null;
  soldOut: number;
  datesLeft: number;
  lastLocal: string | null;
  sources: string[];
};

type Row = Record<string, unknown>;

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

function toItem(r: Row, today: string, weight: number, score: number | null): PoolItem {
  const nextLocal = String(r.next_local);
  let genres: string[] = [];
  try {
    const g: unknown = JSON.parse(String(r.genres ?? '[]'));
    if (Array.isArray(g)) genres = g.filter((x): x is string => typeof x === 'string');
  } catch {
    // Unreadable genres: none.
  }
  return {
    id: String(r.id),
    title: String(r.title),
    category: r.category as Category,
    genres,
    venueId: (r.venue_id as string | null) ?? null,
    venue: (r.venue as string | null) ?? null,
    district: (r.district as string | null) ?? null,
    nextLocal,
    days: dayDiff(nextLocal, today),
    age: -dayDiff(utcToBerlinLocal(String(r.created_at)), today),
    isFree: Boolean(r.is_free),
    weight,
    score,
    soldOut: Number(r.sold_out ?? 0),
    datesLeft: Number(r.dates_left ?? 0),
    lastLocal: (r.last_local as string | null) ?? null,
    sources: r.source_ids ? String(r.source_ids).split(',') : [],
  };
}

const FACTS = `e.id, e.title, e.category, e.genres, e.is_free, e.created_at, e.next_start_local AS next_local,
       v.id AS venue_id, v.name AS venue, v.district,
       (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?1 AND o.status = 'scheduled') AS dates_left,
       (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = e.id AND o.start_utc >= ?1 AND o.status = 'sold_out') AS sold_out,
       (SELECT MAX(o.start_local) FROM occurrences o WHERE o.event_id = e.id AND o.status != 'cancelled') AS last_local,
       ${SOURCE_IDS}`;

/** A user's scored upcoming events, without what they switched off or already sorted out. */
export async function gatherPool(db: D1Database, userId: string, prefs: Prefs, now = new Date()): Promise<PoolItem[]> {
  const today = berlinToday(now);
  const { results } = await db
    .prepare(
      `SELECT ${FACTS}, s.score
         FROM user_event_scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN venues v ON v.id = e.venue_id
         LEFT JOIN user_event_state st ON st.user_id = s.user_id AND st.event_id = e.id
        WHERE s.user_id = ?3 AND e.status = 'published' AND e.next_start_utc >= ?1 AND e.next_start_utc <= ?2
          AND s.score >= 45 AND (st.state IS NULL OR st.state = 'inbox')
        ORDER BY s.score DESC
        LIMIT ${POOL_LIMIT}`,
    )
    .bind(now.toISOString(), new Date(now.getTime() + HORIZON_DAYS * DAY_MS).toISOString(), userId)
    .all<Row>();
  const off = new Set<string>([...prefs.categoriesOff, ...hiddenCategories(prefs)]);
  const srcOff = new Set(prefs.sourcesOff);
  return results.flatMap((r) => {
    const score = Number(r.score);
    const item = toItem(r, today, score + (Number(r.sold_out) ? 5 : 0), score);
    const level = prefs.frequency[item.category];
    if (off.has(item.category) || (level && score < FREQUENCY_MIN_SCORE[level])) return [];
    if (item.sources.length && item.sources.every((s) => srcOff.has(s))) return [];
    return [item];
  });
}

/**
 * The public pool: no taste, so the members' average score stands in for interest, nudged by demand. Events only
 * default-off sources list stay out, as on the public highlights.
 */
export async function gatherPublicPool(db: D1Database, now = new Date()): Promise<PoolItem[]> {
  const today = berlinToday(now);
  const hidden = hiddenCategories();
  const { results } = await db
    .prepare(
      `SELECT ${FACTS},
              (SELECT AVG(s.score) FROM user_event_scores s WHERE s.event_id = e.id) AS avg_score
         FROM events e LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.status = 'published' AND e.next_start_utc >= ?1 AND e.next_start_utc <= ?2
          AND e.category NOT IN (${['', ...hidden].map((_, i) => `?${i + 3}`).join(',')})
          AND NOT (EXISTS (SELECT 1 FROM event_sources es JOIN raw_items r ON r.id = es.raw_item_id
                            JOIN sources so ON so.id = r.source_id WHERE es.event_id = e.id AND so.default_off = 1)
                   AND NOT EXISTS (SELECT 1 FROM event_sources es JOIN raw_items r ON r.id = es.raw_item_id
                            LEFT JOIN sources so ON so.id = r.source_id
                            WHERE es.event_id = e.id AND (so.id IS NULL OR so.default_off = 0)))
        ORDER BY avg_score IS NULL, avg_score DESC, e.next_start_utc
        LIMIT ${POOL_LIMIT}`,
    )
    .bind(now.toISOString(), new Date(now.getTime() + HORIZON_DAYS * DAY_MS).toISOString(), '', ...hidden)
    .all<Row>();
  return results.map((r) => {
    const avg = r.avg_score == null ? null : Math.round(Number(r.avg_score));
    const sources = r.source_ids ? String(r.source_ids).split(',').length : 0;
    const weight = (avg ?? 45) + (Number(r.sold_out) ? 15 : 0) + (sources > 1 ? 10 : 0);
    return toItem(r, today, weight, null);
  });
}

export type Draft = {
  key: string;
  kind: DiscoverKind;
  subject: string | null;
  picks: PoolItem[];
  title: string;
  blurb: string;
};

/** Words that say what kind of event it is, not what it sounds or looks like: no use as a scene. */
const NOT_A_SCENE = new Set([
  ...Object.keys(CATEGORY_LABELS),
  ...Object.values(CATEGORY_LABELS).map((l) => l.toLowerCase()),
  'premiere',
  'uraufführung',
  'wiederaufnahme',
  'übernahme',
  'derniere',
  'gastspiel',
  'theater',
  'theatre show',
  'konzert',
  'live',
  'music',
  'musik',
  'party',
  'drama',
  'award',
  'event',
  'ausstellung',
  'vortrag',
  'lecture',
  'oper',
  'tanz',
  'film',
  'performance',
  'show',
  'workshop',
]);

/** The group with the strongest top three, among groups of at least `min` unused items. */
function bestGroup(
  items: PoolItem[],
  keysOf: (i: PoolItem) => string[],
  min: number,
): { key: string; items: PoolItem[] } | null {
  const groups = new Map<string, PoolItem[]>();
  for (const i of items) for (const k of keysOf(i)) groups.set(k, [...(groups.get(k) ?? []), i]);
  let best: { key: string; items: PoolItem[]; strength: number } | null = null;
  for (const [key, list] of groups) {
    if (list.length < min) continue;
    const strength = list.slice(0, 3).reduce((n, i) => n + i.weight, 0);
    if (!best || strength > best.strength) best = { key, items: list, strength };
  }
  return best;
}

const sceneKeys = (i: PoolItem) =>
  [...new Set(i.genres.map((g) => g.trim().toLowerCase()))].filter((g) => g.length > 2 && !NOT_A_SCENE.has(g));

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "A at V, B at W and 3 more" */
function names(picks: PoolItem[], n = 2): string {
  const shown = picks.slice(0, n).map((p) => (p.venue ? `${p.title} at ${p.venue}` : p.title));
  const more = picks.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ');
}

/** The coming weekend, Friday to Sunday; from Friday on, the rest of this one. */
function weekend(today: string): [string, string] {
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (wd === 0) return [today, today];
  if (wd >= 5) return [today, addDays(today, 7 - wd)];
  return [addDays(today, 5 - wd), addDays(today, 7 - wd)];
}

/** The order stories appear in after the lead. */
const ORDER: DiscoverKind[] = [
  'theme',
  'weekend',
  'scene',
  'venue',
  'ahead',
  'art',
  'stretch',
  'fresh',
  'free',
  'district',
];

/** Step 1, pure: the stories with template copy, strongest claims first so each event appears once. */
export function buildStories(pool: PoolItem[], opts: { personal: boolean; today: string }): Draft[] {
  const { today, personal } = opts;
  const sorted = [...pool].sort((a, b) => b.weight - a.weight || a.days - b.days);
  const used = new Set<string>();
  const out: Draft[] = [];
  const free = (list: PoolItem[]) => list.filter((i) => !used.has(i.id));
  const add = (
    kind: DiscoverKind,
    key: string,
    subject: string | null,
    list: PoolItem[],
    min: number,
    copy: (p: PoolItem[]) => [string, string],
    /** Places read as a programme: the strongest few, then in date order. */
    chrono = false,
  ) => {
    const picks = free(list).slice(0, PER_STORY);
    if (chrono) picks.sort((a, b) => a.nextLocal.localeCompare(b.nextLocal));
    if (picks.length < min) return;
    for (const p of picks) used.add(p.id);
    const [title, blurb] = copy(picks);
    out.push({ key, kind, subject, picks, title, blurb });
  };

  const strong = personal ? 70 : 60;
  add(
    'ahead',
    'ahead',
    null,
    sorted.filter((i) => i.days >= FAR_DAYS && (i.soldOut > 0 || i.weight >= strong)),
    2,
    (p) => ['Worth booking now', `Weeks ahead and the kind that sells out: ${names(p)}.`],
  );

  for (let n = 0; n < 2; n++) {
    const g = bestGroup(free(sorted.filter((i) => i.days <= 30)), sceneKeys, 3);
    if (!g) break;
    const label = capitalise(g.key);
    add('scene', `scene-${g.key.replace(/[^a-z0-9]+/g, '-')}`, label, g.items, 3, (p) => [
      label,
      `${p.length} ${label.toLowerCase()} nights in the coming weeks, from ${p[0]!.title} to ${p[p.length - 1]!.title}.`,
    ]);
  }

  // A venue that already carries a scene story would only repeat it.
  const sceneVenues = new Set(
    out
      .filter((st) => st.kind === 'scene')
      .flatMap((st) => {
        const counts = new Map<string, number>();
        for (const p of st.picks) if (p.venueId) counts.set(p.venueId, (counts.get(p.venueId) ?? 0) + 1);
        return [...counts].filter(([, n]) => n * 2 > st.picks.length).map(([id]) => id);
      }),
  );
  const v = bestGroup(
    free(sorted.filter((i) => i.days <= 21)),
    (i) => (i.venueId && !sceneVenues.has(i.venueId) ? [i.venueId] : []),
    3,
  );
  if (v) {
    const venue = v.items[0]!.venue ?? 'One venue';
    add(
      'venue',
      `venue-${v.key}`,
      venue,
      v.items,
      3,
      (p) => [
        venue,
        `${p.length} dates in the next three weeks, starting ${formatDay(p[0]!.nextLocal)} with ${p[0]!.title}.`,
      ],
      true,
    );
  }

  const [from, to] = weekend(today);
  add(
    'weekend',
    'weekend',
    null,
    sorted.filter((i) => i.nextLocal.slice(0, 10) >= from && i.nextLocal.slice(0, 10) <= to),
    3,
    (p) => ['This weekend', `${formatDay(from)} to ${formatDay(to)}: ${names(p)}.`],
  );

  add(
    'art',
    'art',
    null,
    sorted.filter((i) => i.category === 'exhibition' && i.days <= 45),
    2,
    (p) => ['On the walls', `Exhibitions on now and soon: ${names(p)}.`],
  );

  // What the reader usually goes for: the two categories with the most strong matches (most events, publicly).
  const counts = new Map<Category, number>();
  for (const i of sorted)
    if (!personal || i.weight >= strong) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  const usual = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => c);
  const usualLabel = usual.map((c) => CATEGORY_LABELS[c].toLowerCase()).join(' and ');
  add(
    'stretch',
    'stretch',
    null,
    sorted.filter((i) => !usual.includes(i.category) && i.days <= 45 && (personal ? i.weight >= 60 : i.weight >= 55)),
    2,
    (p) =>
      personal
        ? ['Outside your usual', `Not ${usualLabel}, but close enough to your taste to try: ${names(p)}.`]
        : ['Something different', `Beyond the ${usualLabel}: ${names(p)}.`],
  );

  add(
    'fresh',
    'fresh',
    null,
    sorted.filter((i) => i.age <= FRESH_DAYS),
    3,
    (p) => ['New in the programme', `Added this week: ${names(p)}.`],
  );

  add(
    'free',
    'free',
    null,
    sorted.filter((i) => i.isFree && i.days <= 14),
    2,
    (p) => ['No ticket needed', `Free in the next two weeks: ${names(p)}.`],
  );

  const d = bestGroup(free(sorted.filter((i) => i.days <= 7)), (i) => (i.district ? [i.district] : []), 3);
  if (d) {
    add(
      'district',
      `district-${d.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      d.key,
      d.items,
      3,
      (p) => [`Around ${d.key}`, `${p.length} things this week within a few streets: ${names(p)}.`],
      true,
    );
  }

  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)).slice(0, MAX_STORIES);
}

/** The one fact a pick shows under its title. */
export function noteFor(i: PoolItem, kind: DiscoverKind): string | null {
  if (i.soldOut) return `${i.soldOut} ${i.soldOut === 1 ? 'date' : 'dates'} sold out`;
  if (i.datesLeft > 1 && i.lastLocal) {
    return i.datesLeft <= 3
      ? `${i.datesLeft} dates left, last ${formatDay(i.lastLocal)}`
      : `${i.datesLeft} dates until ${formatDay(i.lastLocal)}`;
  }
  if (i.isFree && kind !== 'free') return 'free';
  if (i.age <= FRESH_DAYS && kind !== 'fresh') return 'new in the programme';
  return null;
}

type Focus = { text: string; story: string | null };

function templateFocus(stories: Draft[]): Focus[] {
  const by = (k: DiscoverKind) => stories.find((s) => s.kind === k);
  const out: Focus[] = [];
  const ahead = by('ahead');
  if (ahead) out.push({ text: `Book ${ahead.picks[0]!.title} early`, story: ahead.key });
  const wk = by('weekend');
  if (wk) out.push({ text: `Keep ${formatDay(wk.picks[0]!.nextLocal)} for ${wk.picks[0]!.title}`, story: wk.key });
  const venue = by('venue');
  if (venue) out.push({ text: `Get to know ${venue.subject}`, story: venue.key });
  const stretch = by('stretch');
  if (stretch) out.push({ text: `Try something new: ${stretch.picks[0]!.title}`, story: stretch.key });
  return out.slice(0, 3);
}

const LEAD_ORDER: DiscoverKind[] = [
  'theme',
  'scene',
  'venue',
  'weekend',
  'ahead',
  'art',
  'stretch',
  'fresh',
  'free',
  'district',
];

function pickLine(p: PoolItem, n: string, kind: DiscoverKind, personal: boolean): string {
  return [
    `${n}. ${p.title}`,
    CATEGORY_LABELS[p.category],
    p.venue,
    formatDateTime(p.nextLocal, p.category),
    noteFor(p, kind),
    p.genres.length ? p.genres.slice(0, 3).join(', ') : null,
    personal && p.score != null ? `fit ${p.score}/100` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

type Stored = {
  headline: string;
  lede: string;
  lead: string | null;
  stories: {
    key: string;
    kind: DiscoverKind;
    title: string;
    blurb: string;
    subject: string | null;
    picks: { eventId: string; note: string | null }[];
  }[];
  focus: Focus[];
};

const PUBLIC_TASTE =
  'Anyone curious about Berlin culture: theatre, music, clubs, art. Wants the strongest of the coming weeks.';

/**
 * Builds and saves the day's edition (who null: the public one). `write: false` skips the model, for an instant first
 * edition; the daily run replaces it. Returns how many stories it holds.
 */
export async function buildDiscover(
  env: Env,
  who: string | null,
  opts: { write?: boolean } = {},
  now = new Date(),
): Promise<number> {
  const today = berlinToday(now);
  const profile = who ? await loadProfile(env.DB, who) : null;
  const pool = who ? await gatherPool(env.DB, who, profile!.prefs, now) : await gatherPublicPool(env.DB, now);
  const personal = !!who;
  const drafts = buildStories(pool, { personal, today });
  const lead = LEAD_ORDER.map((k) => drafts.find((d) => d.kind === k)).find(Boolean);
  let content: Stored = {
    headline: lead ? lead.title : 'A quiet stretch',
    lede: lead ? lead.blurb : 'Nothing much stands out in the coming weeks yet. New programmes arrive every day.',
    lead: lead?.key ?? null,
    stories: drafts.map((d) => ({
      key: d.key,
      kind: d.kind,
      title: d.title,
      blurb: d.blurb,
      subject: d.subject,
      picks: d.picks.map((p) => ({ eventId: p.id, note: noteFor(p, d.kind) })),
    })),
    focus: templateFocus(drafts),
  };
  let model = 'template';
  let version = 'template';

  if (opts.write !== false && drafts.length) {
    const used = new Set(drafts.flatMap((d) => d.picks.map((p) => p.id)));
    const loose = [...pool]
      .filter((p) => !used.has(p.id) && p.days <= 30)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, LOOSE);
    try {
      const r = await callJson(env, {
        provider: providerFrom(env.SCORE_MODEL),
        system: prompt.system,
        user: prompt.user(
          profile ? profile.tasteText : PUBLIC_TASTE,
          today,
          drafts.map(
            (d) =>
              `[${d.key}] ${d.kind}${d.subject ? `: ${d.subject}` : ''}\n${d.picks
                .map((p, i) => pickLine(p, String(i + 1), d.kind, personal))
                .join('\n')}`,
          ),
          loose.map((p, i) => pickLine(p, `L${i + 1}`, 'theme', personal)),
        ),
        schema: prompt.schema,
        parse: (out) =>
          prompt.parseCopy(
            out,
            drafts.map((d) => d.key),
            loose.length,
          ),
        maxTokens: 2000,
        metric: 'ai_discover_calls',
      });
      const copy = new Map(r.value.stories.map((s) => [s.key, s]));
      const stories = content.stories.map((s) => {
        const c = copy.get(s.key);
        return c ? { ...s, title: c.title || s.title, blurb: c.blurb || s.blurb } : s;
      });
      const themed = r.value.theme.events.map((n) => loose[n - 1]!);
      if (themed.length >= 3 && r.value.theme.title) {
        stories.unshift({
          key: 'theme',
          kind: 'theme',
          title: r.value.theme.title,
          blurb: r.value.theme.blurb,
          subject: null,
          picks: themed.map((p) => ({ eventId: p.id, note: noteFor(p, 'theme') })),
        });
      }
      const keys = new Set(stories.map((s) => s.key));
      content = {
        headline: r.value.headline || content.headline,
        lede: r.value.lede || content.lede,
        lead: keys.has(r.value.lead) ? r.value.lead : content.lead,
        stories,
        focus: r.value.focus.length
          ? r.value.focus.map((f) => ({ text: f.text, story: keys.has(f.story) ? f.story : null }))
          : content.focus,
      };
      model = r.model;
      version = prompt.version;
    } catch (err) {
      // No model today (budget, outage): the template copy still makes a page.
      console.warn('discover copy skipped', who ?? PUBLIC, String(err));
    }
  }

  const audience = who ?? PUBLIC;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO discover_editions (audience, day, content, model, prompt_version) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET content = excluded.content, model = excluded.model,
         prompt_version = excluded.prompt_version, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(audience, today, JSON.stringify(content), model, version),
    env.DB.prepare(`DELETE FROM discover_editions WHERE audience = ? AND day < ?`).bind(
      audience,
      addDays(today, -KEEP_DAYS),
    ),
  ]);
  return content.stories.length;
}

type EditionRow = { day: string; content: string; model: string; created_at: string };

const latest = (db: D1Database, audience: string) =>
  db
    .prepare(
      `SELECT day, content, model, created_at FROM discover_editions WHERE audience = ? ORDER BY day DESC LIMIT 1`,
    )
    .bind(audience)
    .first<EditionRow>();

/** The stored edition with live event rows: past, hidden or sorted-out events and switched-off sources drop out. */
async function readBack(
  env: Env,
  row: EditionRow,
  opts: { userId?: string; hidden: readonly Category[]; sourcesOff: Set<string> },
  now: Date,
): Promise<DiscoverEdition> {
  const content = JSON.parse(row.content) as Stored;
  const ids = [...new Set(content.stories.flatMap((s) => s.picks.map((p) => p.eventId)))];
  type Meta = { id: string; slug: string; score: number | null; state: string | null };
  const [items, extra] = ids.length
    ? await Promise.all([
        listItemsByIds(env.DB, ids, opts.hidden),
        env.DB.prepare(
          `SELECT e.id, e.slug, s.score, st.state FROM events e
             LEFT JOIN user_event_scores s ON s.event_id = e.id AND s.user_id = ?1
             LEFT JOIN user_event_state st ON st.event_id = e.id AND st.user_id = ?1
            WHERE e.id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
        )
          .bind(opts.userId ?? '', ...ids)
          .all<Meta>(),
      ])
    : [[], { results: [] as Meta[] }];
  const bySlug = new Map(items.map((it) => [it.slug, it]));
  const meta = new Map(extra.results.map((r) => [r.id, r]));
  const today = utcToBerlinLocal(now).slice(0, 10);
  const stories = content.stories.flatMap((s) => {
    const picks = s.picks.flatMap((p) => {
      const m = meta.get(p.eventId);
      const event = m ? bySlug.get(m.slug) : undefined;
      if (!event || event.next.startLocal < today) return [];
      if (m?.state === 'hidden' || m?.state === 'skipped') return [];
      if (opts.sourcesOff.size && event.sources?.length && event.sources.every((id) => opts.sourcesOff.has(id)))
        return [];
      return [{ event, score: opts.userId ? (m?.score ?? null) : null, note: p.note }];
    });
    return picks.length
      ? [{ key: s.key, kind: s.kind, title: s.title, blurb: s.blurb, subject: s.subject, picks }]
      : [];
  });
  const keys = new Set(stories.map((s) => s.key));
  return {
    status: 'ready',
    day: row.day,
    createdAt: row.created_at,
    headline: content.headline,
    lede: content.lede,
    lead: content.lead && keys.has(content.lead) ? content.lead : null,
    stories,
    focus: content.focus.map((f) => ({ text: f.text, story: f.story && keys.has(f.story) ? f.story : null })),
    written: row.model !== 'template',
  };
}

const NONE: DiscoverEdition = {
  status: 'none',
  day: null,
  createdAt: null,
  headline: null,
  lede: null,
  lead: null,
  stories: [],
  focus: [],
  written: false,
};

/** A user's latest edition; the first one is built on the spot from the template (no model, no wait). */
export async function getDiscover(env: Env, userId: string, now = new Date()): Promise<DiscoverEdition> {
  let row = await latest(env.DB, userId);
  if (!row) {
    await buildDiscover(env, userId, { write: false }, now);
    row = await latest(env.DB, userId);
  }
  if (!row) return NONE;
  const { prefs } = await loadProfile(env.DB, userId);
  return readBack(env, row, { userId, hidden: hiddenCategories(prefs), sourcesOff: new Set(prefs.sourcesOff) }, now);
}

/** The latest public edition, built from the template when none exists yet. */
export async function getPublicDiscover(env: Env, now = new Date()): Promise<DiscoverEdition> {
  let row = await latest(env.DB, PUBLIC);
  if (!row) {
    await buildDiscover(env, null, { write: false }, now);
    row = await latest(env.DB, PUBLIC);
  }
  if (!row) return NONE;
  const { results } = await env.DB.prepare(`SELECT id FROM sources WHERE default_off = 1`).all<{ id: string }>();
  return readBack(env, row, { hidden: hiddenCategories(), sourcesOff: new Set(results.map((r) => r.id)) }, now);
}
