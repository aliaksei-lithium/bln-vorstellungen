import { env, exports } from 'cloudflare:workers';
import { berlinLocalToUtc } from '@bln/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../src/ai/prompts/tagline';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { writeTaglines } from '../src/services/taglines';

/** Taglines: one line per event from its description, written once, with provenance, shown in lists. */

const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

/** Claude, scripted: a line for the first event of each batch, an empty one for the second. */
function claudeEnv(seen: string[]) {
  const AI = {
    run: async (_m: string, body: { messages: { content: string }[] }) => {
      seen.push(JSON.stringify(body.messages));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              lines: [
                { n: 1, text: 'Free-jazz saxophonist from Tennessee, solo.' },
                { n: 2, text: '' },
              ],
            }),
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 60 },
      };
    },
  };
  // A read-only view: assigning onto an object made from `env` would write through to `env` itself.
  return new Proxy(env, {
    get: (t, k) => (k === 'AI' ? AI : k === 'SCORE_MODEL' ? 'anthropic/claude-haiku-5.5' : Reflect.get(t, k)),
  }) as Env;
}

beforeAll(async () => {
  const at = `${day}T20:00`;
  const rows: [string, string | null][] = [
    ['tg_zoh', 'Zoh Amba is a saxophonist and flautist from Tennessee playing free jazz, here in a solo set.'],
    ['tg_note', 'Tickets at the door. Einlass 19 Uhr, Beginn 20 Uhr, bitte pünktlich.'],
    ['tg_bare', 'Link'],
  ];
  await env.DB.batch(
    rows.flatMap(([id, description]) => [
      env.DB.prepare(
        `INSERT INTO events (id, slug, title, description, lang, category, dedup_key, created_by)
         VALUES (?, ?, ?, ?, 'en', 'concert', ?, 't')`,
      ).bind(id, id, id, description, `${id}-k`),
      env.DB.prepare(
        `INSERT INTO occurrences (id, event_id, start_local, start_utc, status) VALUES (?, ?, ?, ?, 'scheduled')`,
      ).bind(`${id}_0`, id, at, berlinLocalToUtc(at)),
    ]),
  );
  await refreshAllNextDates(env.DB);
});

describe('taglines', () => {
  it('parses lines by number, drops empty ones and the full stop', () => {
    const m = parse(
      {
        lines: [
          { n: 1, text: 'Tuareg desert blues.' },
          { n: 2, text: ' ' },
          { n: 9, text: 'x' },
        ],
      },
      2,
    );
    expect([...m!]).toEqual([[1, 'Tuareg desert blues']]);
    expect(parse('nope', 2)).toBeNull();
  });

  it('writes a line once per event with a description, keeps provenance, and shows it in lists', async () => {
    const seen: string[] = [];
    expect(await writeTaglines(claudeEnv(seen), new Date())).toBeGreaterThanOrEqual(1);
    // Events without a real description are never sent.
    expect(seen.join()).not.toContain('tg_bare');
    const rows = await env.DB.prepare(
      `SELECT id, tagline, tagline_model, tagline_prompt, tagline_checked_at FROM events WHERE id LIKE 'tg_%' ORDER BY id`,
    ).all<Record<string, string | null>>();
    const by = Object.fromEntries(rows.results.map((r) => [r.id, r]));
    expect(by.tg_zoh).toMatchObject({
      tagline: 'Free-jazz saxophonist from Tennessee, solo',
      tagline_model: 'anthropic/claude-haiku-5.5',
      tagline_prompt: 'tagline@1',
    });
    expect(by.tg_note).toMatchObject({ tagline: null, tagline_model: null });
    expect(by.tg_note!.tagline_checked_at).not.toBeNull();
    expect(by.tg_bare!.tagline_checked_at).toBeNull();
    // Written once: nothing left to send.
    const again: string[] = [];
    await writeTaglines(claudeEnv(again), new Date());
    expect(again.join()).not.toContain('tg_zoh');

    const res = await exports.default.fetch(`https://x/api/events?from=${day}&to=${day}`);
    const { items } = (await res.json()) as { items: { slug: string; tagline?: string }[] };
    expect(items.find((i) => i.slug === 'tg_zoh')?.tagline).toBe('Free-jazz saxophonist from Tennessee, solo');
    expect(items.find((i) => i.slug === 'tg_note')?.tagline).toBeUndefined();
  });
});
