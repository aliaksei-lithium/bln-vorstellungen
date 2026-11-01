import {
  McpAddFromText,
  McpConfirmEvents,
  McpGetEvent,
  McpListEvents,
  McpMarkEvent,
  McpMyPicks,
  McpSearch,
  McpSetTaste,
  berlinLocalToUtc,
  berlinToday,
  hiddenCategories,
  CATEGORY_LABELS,
  type Category,
  type EventListItem,
} from '@bln/shared';
import { McpServer } from '@modelcontextprotocol/server';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { dispatchScoring, loadProfile, saveProfile } from '../ai/score';
import { eventDetail, listEvents, searchByMeaning } from '../services/events';
import { agendaItems, eventIdBySlug, inbox, myEvent, scoresBySlug, setEventState } from '../services/me';
import { agendaMarkdown, candidateLines, eventLines, eventMarkdown } from './format';
import { confirmScan, createScan, getScan, runScan } from '../services/scans';

/**
 * The MCP server (docs/06): one per request (stateless), for one signed-in user. Every tool calls the same
 * services as the REST API; this file only maps inputs and renders compact markdown.
 */

export type McpProps = { userId: string };

const DAY_MS = 86_400_000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/** Expected failures (unknown slug, a date that is not the event's) become tool errors the model can act on. */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HTTPException && err.status < 500) return fail(err.message);
    throw err;
  }
}

const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

export function buildServer(
  env: Env,
  ctx: ExecutionContext,
  opts: { userId: string; scopes: string[]; origin: string },
): McpServer {
  const { userId, origin } = opts;
  const canWrite = opts.scopes.includes('mcp:write');
  const server = new McpServer(
    { name: 'bln-vorstellungen', title: 'BLN Vorstellungen', version: '1.0.0' },
    {
      instructions:
        "Berlin events (theatre, opera, concerts, clubs, talks…) read from the venues' own programmes, scored " +
        "0-100 for this user's taste. Start with my_picks for recommendations, list_events for what's on, " +
        'search_events for a topic. Dates are Berlin local time; an event without a time shows just the day. ' +
        'Always give the user the event links.',
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  // Opt-in categories (sex-positive and kink) stay out of every result unless this user switched them on.
  const hiddenFor = async () => hiddenCategories((await loadProfile(env.DB, userId)).prefs);
  const switchedOff = (c: Category) =>
    text(`${CATEGORY_LABELS[c]} events are off for this user. They can turn them on at ${origin}/me.`);

  server.registerTool(
    'my_picks',
    {
      title: 'My picks',
      description:
        "Upcoming events ranked for the user's taste, best first, with the main reason for each score. Leaves out " +
        'events the user already marked. Use for "what should I go to", "my top picks this weekend".',
      inputSchema: McpMyPicks,
      annotations: readOnly,
    },
    (a) =>
      run(async () => {
        const res = await inbox(env.DB, userId, {
          from: a.from ? berlinLocalToUtc(`${a.from}T00:00`) : undefined,
          to: a.to ? berlinLocalToUtc(`${a.to}T23:59`) : undefined,
          category: a.category,
          minScore: a.minScore,
          limit: a.limit,
        });
        if (!res.hasTaste) {
          return text(
            'No taste description yet, so nothing is ranked. Ask the user what they like and save it with set_taste.',
          );
        }
        const note = res.pending ? `\n\n(${res.pending} new events are still being scored.)` : '';
        return text(
          res.items.length
            ? `${eventLines(origin, res.items)}${note}`
            : `Nothing scored ${a.minScore} or more in that range. Try a lower minScore or a wider range.${note}`,
        );
      }),
  );

  server.registerTool(
    'list_events',
    {
      title: "What's on",
      description:
        "Events in Berlin by date, each once at its first date in the range, with the user's score when there is " +
        'one. Filter by category or keywords. Defaults to the next 14 days.',
      inputSchema: McpListEvents,
      annotations: readOnly,
    },
    (a) =>
      run(async () => {
        const hidden = await hiddenFor();
        if (a.category && hidden.includes(a.category)) return switchedOff(a.category);
        const from = a.from ?? berlinToday();
        const to = a.to ?? plusDays(from, 14);
        const res = await listEvents(
          env.DB,
          { from, to, category: a.category ? [a.category] : undefined, q: a.query },
          a.limit,
          hidden,
        );
        const scores = await scoresBySlug(
          env.DB,
          userId,
          res.items.map((e) => e.slug),
        );
        const rows = res.items.map((e) => ({ ...e, score: scores.get(e.slug) ?? null }));
        const more = res.nextCursor ? `\n\n(More events in this range: narrow it by date or category.)` : '';
        return text(rows.length ? `${eventLines(origin, rows)}${more}` : `No events from ${from} to ${to}.`);
      }),
  );

  server.registerTool(
    'search_events',
    {
      title: 'Search events',
      description:
        'Finds upcoming events by meaning and by keywords: a topic, mood, artist, play or venue, in English or ' +
        "German. Results carry the user's score.",
      inputSchema: McpSearch,
      annotations: readOnly,
    },
    (a) =>
      run(async () => {
        const hidden = await hiddenFor();
        const [byMeaning, byWords] = await Promise.all([
          searchByMeaning(env, a.query, a.limit, hidden),
          listEvents(env.DB, { q: a.query }, a.limit, hidden),
        ]);
        // Keyword hits first (exact title or name), then the closest by meaning.
        const seen = new Set<string>();
        const items: EventListItem[] = [...byWords.items, ...byMeaning]
          .filter((e) => !seen.has(e.slug) && !!seen.add(e.slug))
          .slice(0, a.limit);
        const scores = await scoresBySlug(
          env.DB,
          userId,
          items.map((e) => e.slug),
        );
        return text(
          items.length
            ? eventLines(
                origin,
                items.map((e) => ({ ...e, score: scores.get(e.slug) ?? null })),
              )
            : `Nothing upcoming matches "${a.query}".`,
        );
      }),
  );

  server.registerTool(
    'get_event',
    {
      title: 'Event details',
      description:
        "One event in full: venue, price, every upcoming date with notes, performers, description, the user's " +
        'score with its reasons, and their mark.',
      inputSchema: McpGetEvent,
      annotations: readOnly,
    },
    (a) =>
      run(async () => {
        const detail = await eventDetail(env.DB, a.slug);
        if (!detail) return fail(`No event with slug "${a.slug}". Use search_events to find it.`);
        return text(eventMarkdown(origin, detail, await myEvent(env.DB, userId, detail.id)));
      }),
  );

  server.registerTool(
    'my_agenda',
    {
      title: 'My agenda',
      description: 'Events the user marked interested or maybe, by date, with clashes on the same evening flagged.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => run(async () => text(agendaMarkdown(origin, await agendaItems(env.DB, userId)))),
  );

  server.registerTool(
    'get_taste',
    {
      title: 'My taste',
      description: "The user's taste description that every score is based on, and their filters.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const p = await loadProfile(env.DB, userId);
        const filters = [
          p.prefs.categoriesOff.length ? `Never shows: ${p.prefs.categoriesOff.join(', ')}` : '',
          p.prefs.categoriesOn.length ? `Opted in to: ${p.prefs.categoriesOn.join(', ')}` : '',
          Object.keys(p.prefs.frequency).length
            ? `Comes up less often (only strong matches): ${Object.entries(p.prefs.frequency)
                .map(([c, f]) => `${c} ${f}`)
                .join(', ')}`
            : '',
          p.prefs.maxPrice != null ? `Max price: ${p.prefs.maxPrice} €` : '',
        ].filter(Boolean);
        return text([p.tasteText ? `Taste:\n${p.tasteText}` : 'No taste description yet.', ...filters].join('\n\n'));
      }),
  );

  const needsWrite = () =>
    fail('This connection is read-only. Reconnect BLN Vorstellungen and allow changes to use this tool.');

  server.registerTool(
    'mark_event',
    {
      title: 'Mark an event',
      description:
        'Triage an event for the user: put it on the agenda (interested, maybe), skip or hide it, record that they ' +
        'went, or clear the mark. Only when the user asks.',
      inputSchema: McpMarkEvent,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        if (!canWrite) return needsWrite();
        const id = await eventIdBySlug(env.DB, a.slug);
        let occurrenceId: string | null = null;
        if (a.date) {
          const occ = await env.DB.prepare(
            `SELECT id, start_local FROM occurrences WHERE event_id = ? AND start_local LIKE ? AND status != 'cancelled'
              ORDER BY start_utc LIMIT 1`,
          )
            .bind(id, `${a.date}%`)
            .first<{ id: string; start_local: string }>();
          if (!occ) return fail(`This event has no performance on ${a.date}. get_event lists its dates.`);
          occurrenceId = occ.id;
        }
        await setEventState(env.DB, userId, id, {
          state: a.state === 'clear' ? null : a.state,
          occurrenceId,
        });
        return text(
          a.state === 'clear'
            ? `Cleared the mark on ${a.slug}.`
            : `Marked ${a.slug} as ${a.state}${a.date ? ` for ${a.date}` : ''}.`,
        );
      }),
  );

  server.registerTool(
    'set_taste',
    {
      title: 'Update my taste',
      description:
        "Replaces the user's taste description and re-scores every upcoming event in the background. Only when the " +
        'user asks to change what they like; show them the new text first.',
      inputSchema: McpSetTaste,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        if (!canWrite) return needsWrite();
        const { prefs } = await loadProfile(env.DB, userId);
        await saveProfile(env, userId, a.tasteText, prefs);
        ctx.waitUntil(dispatchScoring(env, userId));
        return text('Saved. Scores update within a few minutes; my_picks shows the new ranking after that.');
      }),
  );

  server.registerTool(
    'add_events_from_text',
    {
      title: 'Read events from text',
      description:
        'Reads events out of text the user gives you (a newsletter, message, website text or programme) and lists ' +
        'them numbered, with a review link. Nothing is added yet: show the list to the user, then call ' +
        'confirm_events with the numbers they want.',
      inputSchema: McpAddFromText,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        if (!canWrite) return needsWrite();
        const scanId = await createScan(env, userId, { kind: 'text', text: a.text }, new Date(), { start: false });
        await runScan(env, scanId);
        const scan = await getScan(env.DB, userId, scanId);
        if (scan.status === 'failed') return fail(scan.error ?? 'Could not read that text.');
        if (!scan.candidates.length) return text(scan.error ?? 'No dated events in that text.');
        return text(
          `Found ${scan.candidates.length} ${scan.candidates.length === 1 ? 'event' : 'events'} (scan \`${scanId}\`). ` +
            `Nothing is added yet. To review or edit in the app: ${origin}/scan/${scanId}\n\n` +
            candidateLines(scan.candidates),
        );
      }),
  );

  server.registerTool(
    'confirm_events',
    {
      title: 'Add read events',
      description:
        'Adds events read by add_events_from_text, all or the numbers picked. Events already listed get the new ' +
        'dates merged in instead of a duplicate. Only after the user agreed to the list.',
      inputSchema: McpConfirmEvents,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        if (!canWrite) return needsWrite();
        const scan = await getScan(env.DB, userId, a.scanId);
        const picked = a.pick?.length
          ? a.pick.map((n) => scan.candidates[n - 1]).filter((e): e is NonNullable<typeof e> => !!e)
          : scan.candidates;
        if (!picked.length) return fail(`Pick numbers between 1 and ${scan.candidates.length}.`);
        const r = await confirmScan(env, userId, a.scanId, picked);
        return text(
          `Added ${r.added} new, merged ${r.merged} into events already listed:\n` +
            r.events.map((e) => `- [${e.title}](${origin}/e/${e.slug}) · ${e.created ? 'new' : 'merged'}`).join('\n'),
        );
      }),
  );

  server.registerPrompt(
    'weekend_picks',
    {
      title: 'Weekend picks',
      description: 'My top events for the coming weekend, grouped by day.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Use my_picks for the coming Friday to Sunday in Berlin. List my top 10, grouped by day, each with ' +
              'time, venue, price, the link and one line on why it fits me. Flag anything that clashes.',
          },
        },
      ],
    }),
  );

  return server;
}
