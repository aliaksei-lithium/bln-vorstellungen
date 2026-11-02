import { env } from 'cloudflare:workers';
import { berlinLocalToUtc } from '@bln/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { ask, linkTitles, QUESTIONS_PER_DAY } from '../src/services/ask';

/** Ask (docs/11): the tool loop against a scripted model, references, web suggestions and the daily limits. */

const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
type Call = { messages: { role: string; content: unknown }[]; tools: { name: string; type?: string }[] };

/** A stand-in for Claude: each call returns the next scripted reply and records what it was sent. */
function scripted(replies: unknown[]) {
  const calls: Call[] = [];
  const AI = {
    run: async (_model: string, input: Call) => {
      calls.push(JSON.parse(JSON.stringify(input)) as Call);
      return replies.shift() ?? { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
    },
  };
  // A read-only view: assigning onto an object made from `env` would write through to `env` itself.
  return { env: new Proxy(env, { get: (t, k) => (k === 'AI' ? AI : Reflect.get(t, k)) }) as Env, calls };
}

beforeAll(async () => {
  const at = `${day}T21:00`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email) VALUES ('u_ask', 'Asker', 'ask@example.org')`),
    env.DB.prepare(
      `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by)
       VALUES ('ask_ev', 'noise-night', 'Noise Night', 'en', 'concert', 'ask-k', 't')`,
    ),
    env.DB.prepare(
      `INSERT INTO occurrences (id, event_id, start_local, start_utc, status) VALUES ('ask_ev_0', 'ask_ev', ?, ?, 'scheduled')`,
    ).bind(at, berlinLocalToUtc(at)),
    env.DB.prepare(
      `INSERT INTO events_fts (event_id, title, description, performers, venue) VALUES ('ask_ev', 'Noise Night', 'loud guitars', '', '')`,
    ),
    env.DB.prepare(
      `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
       VALUES ('u_ask', 'ask_ev', 88, '[]', 1, '2026-01-01T00:00:00Z')`,
    ),
  ]);
  await refreshAllNextDates(env.DB);
});

describe('ask', () => {
  it('searches the programme, cites real events only and collects web suggestions', async () => {
    const { env: e, calls } = scripted([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'search_events', input: { query: 'noise' } },
          {
            type: 'tool_use',
            id: 't2',
            name: 'suggest_event',
            input: { title: 'Basement Feedback', when: 'Sa 14.11. 22:00', venue: 'Somewhere', url: 'https://x.test/e' },
          },
        ],
        usage: { input_tokens: 2000, output_tokens: 100 },
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Go to [[noise-night]]; skip [[made-up-show]]. Also Basement Feedback.' }],
        usage: { input_tokens: 3000, output_tokens: 80 },
      },
    ]);
    const r = await ask(e, 'u_ask', [{ role: 'user', text: 'Something noisy this week?' }]);
    expect(r.answer).toBe('Go to [[noise-night]]; skip made-up-show. Also Basement Feedback.');
    expect(r.events.map((x) => x.slug)).toEqual(['noise-night']);
    expect(r.found).toEqual([
      { title: 'Basement Feedback', when: 'Sa 14.11. 22:00', venue: 'Somewhere', url: 'https://x.test/e', note: null },
    ]);
    // The tool result went back to the model, as a line it can cite, with this person's score.
    const results = JSON.stringify(calls[1]!.messages.at(-1));
    expect(results).toContain('[[noise-night]]');
    expect(results).toContain('their score 88');
    // Web search is offered within the day's allowance.
    expect(calls[0]!.tools.some((t) => t.type === 'web_search_20250305')).toBe(true);
    expect(r.left.questions).toBe(QUESTIONS_PER_DAY - 1);
  });

  it('links events the model named by title instead of by reference', () => {
    const seen = new Map([
      ['sports', 'SPORTS'],
      ['swapmeet', 'SWAPMEET'],
      ['die-letzten', 'Die Letzten werden die Ersten sein'],
      ['die', 'Die'],
      ['noise-night', 'Noise Night'],
    ]);
    const answer =
      'Try [[noise-night]]. Louder: SWAPMEET at Badehaus, or SPORTS at SO36 (SPORTS again). Also Die Letzten werden die Ersten sein. Noise Night rules.';
    expect(linkTitles(answer, seen)).toBe(
      'Try [[noise-night]]. Louder: [[swapmeet]] at Badehaus, or [[sports]] at SO36 (SPORTS again). Also [[die-letzten]]. Noise Night rules.',
    );
  });

  it('stops at the daily limit', async () => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    await env.CACHE.put(`ask:u_ask:${today}`, JSON.stringify({ q: QUESTIONS_PER_DAY, s: 0 }));
    const { env: e } = scripted([]);
    await expect(ask(e, 'u_ask', [{ role: 'user', text: 'More?' }])).rejects.toMatchObject({ status: 429 });
    await env.CACHE.delete(`ask:u_ask:${today}`);
  });

  it("refuses when the day's Claude budget is spent", async () => {
    const utc = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO usage_counters (day, metric, value) VALUES (?, 'claude_microusd', 1000000000)
       ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
    )
      .bind(utc)
      .run();
    const { env: e } = scripted([]);
    await expect(ask(e, 'u_ask', [{ role: 'user', text: 'Anything?' }])).rejects.toMatchObject({ status: 429 });
    await env.DB.prepare(
      `UPDATE usage_counters SET value = value - 1000000000 WHERE day = ? AND metric = 'claude_microusd'`,
    )
      .bind(utc)
      .run();
  });
});
