import {
  berlinToday,
  formatDateTime,
  formatPrice,
  hiddenCategories,
  type AskFound,
  type AskResponse,
  type AskTurn,
  type Category,
  type EventListItem,
} from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { providerFrom, WEB_SEARCH_USD } from '../ai/llm';
import { claudeUsd, claudeUsdLeft, runModel, type ClaudeModel } from '../ai/models';
import * as prompt from '../ai/prompts/ask';
import { loadProfile } from '../ai/score';
import { bumpUsage } from '../usage';
import { eventDetail, listEvents, listItemsByIds, searchByMeaning } from './events';
import { agendaItems } from './me';

/**
 * Ask (docs/11, docs/09 2026-11-02): one question from a signed-in user, answered by Claude with read-only tools over
 * the programme and, when that has nothing, web search. A short loop run here; nothing is stored but the counters.
 */

export const QUESTIONS_PER_DAY = 20;
export const SEARCHES_PER_DAY = 4;
const SEARCHES_PER_QUESTION = 2;
const ROUNDS = 4;
const MAX_TOKENS = 1500;
/** No question starts with less than this left of the day's Claude budget (a question with searches costs ~$0.03). */
const MIN_BUDGET_USD = 0.05;
const MAX_FOUND = 3;
const DAY_MS = 86_400_000;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };
type Message = {
  content?: Block[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
};
type Turn = { role: 'user' | 'assistant'; content: string | Block[] };

type Counters = { q: number; s: number };
const counterKey = (userId: string, day: string) => `ask:${userId}:${day}`;

async function counters(env: Env, userId: string, day: string): Promise<Counters> {
  const v = await env.CACHE.get<Counters>(counterKey(userId, day), 'json');
  return { q: v?.q ?? 0, s: v?.s ?? 0 };
}

/** What a user has left today, for the box before the first question. */
export async function askLeft(env: Env, userId: string, now = new Date()) {
  const c = await counters(env, userId, berlinToday(now));
  return { questions: Math.max(0, QUESTIONS_PER_DAY - c.q), searches: Math.max(0, SEARCHES_PER_DAY - c.s) };
}

/** One programme event as a line the model can cite: `[[slug]] · Fr 06.11. 20:00 · Title · Venue (District) · …`. */
function line(e: EventListItem, scores: Map<string, number>): string {
  const score = scores.get(e.slug);
  return [
    `[[${e.slug}]]`,
    formatDateTime(e.next.startLocal, e.category) + (e.moreDates ? ` (+${e.moreDates} dates)` : ''),
    e.title,
    e.venueName ? `${e.venueName}${e.district ? ` (${e.district})` : ''}` : null,
    e.category,
    formatPrice(e),
    score != null ? `their score ${score}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

async function scoresFor(db: D1Database, userId: string, slugs: string[]): Promise<Map<string, number>> {
  if (!slugs.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT e.slug, s.score FROM events e JOIN user_event_scores s ON s.event_id = e.id AND s.user_id = ?
        WHERE e.slug IN (${slugs.map(() => '?').join(',')})`,
    )
    .bind(userId, ...slugs)
    .all<{ slug: string; score: number }>();
  return new Map(results.map((r) => [r.slug, r.score]));
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const plusDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

type Ctx = {
  env: Env;
  userId: string;
  hidden: Category[];
  today: string;
  found: AskFound[];
  /** Every programme event the tools showed the model this question, by slug: its title, for linkTitles. */
  seen: Map<string, string>;
};

/** Runs one of our tools; the result is text for the model. Errors become text too, so the model can recover. */
export async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<string> {
  const { env, userId, hidden, today } = ctx;
  const lines = async (items: EventListItem[]) => {
    if (!items.length) return 'Nothing found.';
    for (const i of items) ctx.seen.set(i.slug, i.title);
    const scores = await scoresFor(
      env.DB,
      userId,
      items.map((i) => i.slug),
    );
    return items.map((i) => line(i, scores)).join('\n');
  };
  if (name === 'search_events') {
    const query = str(input.query, 100);
    if (!query) return 'Give a query.';
    const from = day(input.from) ?? today;
    const to = day(input.to) ?? plusDays(from, 90);
    const [byWord, byMeaning] = await Promise.all([
      listEvents(env.DB, { q: query, from, to }, 15, hidden, userId),
      searchByMeaning(env, query, 15, hidden).catch(() => [] as EventListItem[]),
    ]);
    const seen = new Set<string>();
    const merged = [...byWord.items, ...byMeaning.filter((i) => i.next.startLocal.slice(0, 10) <= to)].filter(
      (i) => !seen.has(i.slug) && !!seen.add(i.slug),
    );
    return lines(merged.slice(0, 15));
  }
  if (name === 'list_events') {
    const from = day(input.from) ?? today;
    const to = day(input.to) ?? plusDays(from, 7);
    let venue: string | undefined;
    const venueName = str(input.venue, 100);
    if (venueName) {
      const v = await env.DB.prepare(
        `SELECT id FROM venues WHERE lower(name) = lower(?) OR name LIKE ? ORDER BY length(name) LIMIT 1`,
      )
        .bind(venueName, `%${venueName.replace(/[%_]/g, '')}%`)
        .first<{ id: string }>();
      if (!v) return `No venue called "${venueName}" in the programme.`;
      venue = v.id;
    }
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : undefined;
    const res = await listEvents(
      env.DB,
      {
        from,
        to,
        category: list(input.category) as Category[] | undefined,
        district: list(input.district),
        ...(venue ? { venue } : {}),
      },
      25,
      hidden,
      userId,
    );
    return lines(res.items);
  }
  if (name === 'get_event') {
    const e = await eventDetail(env.DB, str(input.slug, 120).replace(/^\[\[|\]\]$/g, ''));
    if (!e || hidden.includes(e.category)) return 'No such event.';
    const now = new Date().toISOString();
    const dates = e.occurrences
      .filter((o) => o.startUtc >= now && o.status !== 'cancelled')
      .slice(0, 12)
      .map((o) => `${formatDateTime(o.startLocal, e.category)}${o.status === 'sold_out' ? ' (sold out)' : ''}`);
    return [
      `[[${e.slug}]] ${e.title} · ${e.category}`,
      e.venue ? `Venue: ${e.venue.name}${e.venue.address ? `, ${e.venue.address}` : ''}` : null,
      `Dates: ${dates.join('; ') || 'none left'}`,
      formatPrice(e) ? `Price: ${formatPrice(e)}` : null,
      e.performers.length ? `With: ${e.performers.map((p) => p.name).join(', ')}` : null,
      e.urlTickets || e.urlOfficial ? `Link: ${e.urlTickets ?? e.urlOfficial}` : null,
      e.description ? `About: ${e.description.slice(0, 1200)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'suggest_event') {
    if (ctx.found.length >= MAX_FOUND) return `Only ${MAX_FOUND} suggestions per answer.`;
    const title = str(input.title);
    const when = str(input.when, 80);
    if (!title || !when) return 'A suggestion needs a title and when.';
    let url: string | null = null;
    try {
      const u = new URL(str(input.url, 500));
      if (u.protocol === 'https:' || u.protocol === 'http:') url = u.toString();
    } catch {
      // No usable link: the suggestion stands without one.
    }
    ctx.found.push({ title, when, venue: str(input.venue) || null, url, note: str(input.note, 240) || null });
    return 'Noted; the person can add it.';
  }
  return `Unknown tool ${name}.`;
}

/**
 * The model sometimes names a programme event by its title instead of its reference ("SPORTS at SO36 is another
 * option"). Titles of events the tools showed it this question become references: exact, case-sensitive matches of
 * at least four characters, the first mention only, never inside an existing reference.
 */
export function linkTitles(answer: string, seen: Map<string, string>): string {
  const cited = new Set([...answer.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1]!));
  let out = answer;
  // Longest titles first, so "Die Letzten werden die Ersten sein" wins over "Die Letzten".
  for (const [slug, title] of [...seen].sort((a, b) => b[1].length - a[1].length)) {
    if (cited.has(slug) || title.trim().length < 4) continue;
    const parts = out.split(/(\[\[[a-z0-9-]+\]\])/);
    const i = parts.findIndex((p, n) => n % 2 === 0 && p.includes(title));
    if (i < 0) continue;
    parts[i] = parts[i]!.replace(title, `[[${slug}]]`);
    out = parts.join('');
    cited.add(slug);
  }
  return out;
}

/** `[[slug]]` references that exist (in first-mention order); unknown ones lose their brackets. */
export async function resolveRefs(
  db: D1Database,
  answer: string,
  hidden: Category[],
): Promise<{ answer: string; events: EventListItem[] }> {
  const slugs = [...new Set([...answer.matchAll(/\[\[([a-z0-9-]{1,120})\]\]/g)].map((m) => m[1]!))].slice(0, 20);
  if (!slugs.length) return { answer, events: [] };
  const { results } = await db
    .prepare(`SELECT id, slug FROM events WHERE slug IN (${slugs.map(() => '?').join(',')})`)
    .bind(...slugs)
    .all<{ id: string; slug: string }>();
  const ids = new Map(results.map((r) => [r.slug, r.id]));
  const items = await listItemsByIds(
    db,
    slugs.flatMap((s) => (ids.has(s) ? [ids.get(s)!] : [])),
    hidden,
  );
  const known = new Set(items.map((i) => i.slug));
  return {
    answer: answer.replace(/\[\[([a-z0-9-]{1,120})\]\]/g, (m, s: string) => (known.has(s) ? m : s)),
    events: items,
  };
}

/** Answers the last user turn. Throws 429 past the day's limits or budget, 503 without Claude. */
export async function ask(env: Env, userId: string, turns: AskTurn[], now = new Date()): Promise<AskResponse> {
  const provider = providerFrom(env.SCORE_MODEL);
  if (provider === 'workers-ai') throw new HTTPException(503, { message: 'Ask needs Claude, which is not set up.' });
  const model: ClaudeModel = provider;
  const today = berlinToday(now);
  const used = await counters(env, userId, today);
  if (used.q >= QUESTIONS_PER_DAY) {
    throw new HTTPException(429, { message: `That's ${QUESTIONS_PER_DAY} questions today. Ask again tomorrow.` });
  }
  if ((await claudeUsdLeft(env)) < MIN_BUDGET_USD) {
    throw new HTTPException(429, { message: "Today's AI budget is used up. Browse and For you still work." });
  }
  const searchesLeft = Math.max(0, SEARCHES_PER_DAY - used.s);

  const { tasteText, prefs } = await loadProfile(env.DB, userId);
  const hidden = hiddenCategories(prefs);
  const until = plusDays(today, 30);
  const agenda = (await agendaItems(env.DB, userId, now))
    .filter((a) => a.startLocal.slice(0, 10) <= until)
    .slice(0, 15)
    .map((a) => `${formatDateTime(a.startLocal, a.category)} · ${a.title}${a.venueName ? ` · ${a.venueName}` : ''}`)
    .join('\n');
  const settings = [
    prefs.categoriesOff.length ? `never shows ${prefs.categoriesOff.join(', ')}` : '',
    prefs.maxPrice != null ? `price up to ${prefs.maxPrice} €` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const system = prompt.system(tasteText, settings, today, agenda);
  const ctx: Ctx = { env, userId, hidden, today, found: [], seen: new Map() };
  const messages: Turn[] = turns.map((t) => ({ role: t.role, content: t.text }));

  let usd = 0;
  let searches = 0;
  let text = '';
  for (let round = 0; round < ROUNDS; round++) {
    const last = round === ROUNDS - 1;
    const tools = [
      ...prompt.tools,
      ...(searchesLeft - searches > 0
        ? [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: Math.min(SEARCHES_PER_QUESTION, searchesLeft - searches),
            },
          ]
        : []),
    ];
    const res = await runModel<Message>(env, model, {
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
      ...(last ? { tool_choice: { type: 'none' } } : {}),
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
    if (res.stop_reason === 'refusal') throw new HTTPException(422, { message: 'Claude declined to answer that.' });
    const s = res.usage?.server_tool_use?.web_search_requests ?? 0;
    const cost = claudeUsd(model, res.usage) + s * WEB_SEARCH_USD;
    searches += s;
    usd += cost;
    await env.DB.batch([
      bumpUsage(env.DB, 'claude_microusd', cost * 1e6),
      bumpUsage(env.DB, 'claude_calls', 1),
      bumpUsage(env.DB, 'claude_tokens_in', res.usage?.input_tokens ?? 0),
      bumpUsage(env.DB, 'claude_tokens_out', res.usage?.output_tokens ?? 0),
      bumpUsage(env.DB, 'claude_web_searches', s),
    ]);
    const content = res.content ?? [];
    text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    messages.push({ role: 'assistant', content });
    const calls = content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use',
    );
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use' || !calls.length) break;
    const results = await Promise.all(
      calls.map(async (c) => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: await runTool(ctx, c.name, c.input ?? {}).catch((err: unknown) => `Tool failed: ${String(err)}`),
      })),
    );
    messages.push({ role: 'user', content: results });
  }

  const next: Counters = { q: used.q + 1, s: used.s + searches };
  await Promise.all([
    env.CACHE.put(counterKey(userId, today), JSON.stringify(next), { expirationTtl: 2 * 86_400 }),
    bumpUsage(env.DB, 'ai_ask_calls', 1).run(),
  ]);
  console.log('ask', { userId, rounds: messages.length, searches, usd: Math.round(usd * 1e4) / 1e4 });
  const { answer, events } = await resolveRefs(
    env.DB,
    linkTitles(text.trim() || 'I could not find an answer this time.', ctx.seen),
    hidden,
  );
  return {
    answer,
    events,
    found: ctx.found,
    searches,
    left: { questions: Math.max(0, QUESTIONS_PER_DAY - next.q), searches: Math.max(0, SEARCHES_PER_DAY - next.s) },
  };
}
