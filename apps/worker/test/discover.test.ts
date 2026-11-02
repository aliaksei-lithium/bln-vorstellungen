import { berlinLocalToUtc, berlinToday } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parseCopy } from '../src/ai/prompts/discover';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { buildDiscover, buildStories, getDiscover, getPublicDiscover, type PoolItem } from '../src/services/discover';

/** Discover: computed stories, model copy with a template fallback, reading an edition back. */

const DAY = 86_400_000;
const today = berlinToday();
const dayAt = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const local = (days: number, time = '20:00') => `${dayAt(days)}T${time}`;

function item(id: string, over: Partial<PoolItem> = {}): PoolItem {
  return {
    id,
    title: `Event ${id}`,
    category: 'concert',
    genres: [],
    venueId: null,
    venue: null,
    district: null,
    nextLocal: local(10),
    days: 10,
    age: 30,
    isFree: false,
    weight: 60,
    score: 60,
    soldOut: 0,
    datesLeft: 1,
    lastLocal: null,
    sources: [],
    ...over,
  };
}

describe('discover stories', () => {
  it('builds each kind once, every event in one story only', () => {
    const pool: PoolItem[] = [
      item('far1', { days: 60, nextLocal: local(60), weight: 85, category: 'theatre' }),
      item('far2', { days: 90, nextLocal: local(90), weight: 40, soldOut: 2, category: 'opera' }),
      ...['n1', 'n2', 'n3'].map((id, i) =>
        item(id, { genres: ['Noise rock', 'Premiere'], days: 5 + i, nextLocal: local(5 + i), weight: 80 - i }),
      ),
      ...['v1', 'v2', 'v3'].map((id, i) =>
        item(id, { venueId: 'vn', venue: 'Schokoladen', days: 12 + i, nextLocal: local(12 + i), weight: 70 }),
      ),
      item('art1', { category: 'exhibition', weight: 65 }),
      item('art2', { category: 'exhibition', weight: 64 }),
      item('free1', { isFree: true, days: 3, nextLocal: local(3), weight: 50 }),
      item('free2', { isFree: true, days: 4, nextLocal: local(4), weight: 50 }),
    ];
    const stories = buildStories(pool, { personal: true, today });
    const kinds = stories.map((s) => s.kind);
    expect(kinds).toContain('ahead');
    expect(kinds).toContain('scene');
    expect(kinds).toContain('venue');
    expect(kinds).toContain('art');
    expect(kinds).toContain('free');
    const scene = stories.find((s) => s.kind === 'scene')!;
    expect(scene.title).toBe('Noise rock');
    expect(scene.picks.map((p) => p.id)).toEqual(['n1', 'n2', 'n3']);
    expect(stories.find((s) => s.kind === 'venue')!.title).toBe('Schokoladen');
    // Sold out far ahead counts even with a low score.
    expect(stories.find((s) => s.kind === 'ahead')!.picks.map((p) => p.id)).toEqual(['far1', 'far2']);
    const ids = stories.flatMap((s) => s.picks.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the model copy to known stories and in-range theme numbers', () => {
    const copy = parseCopy(
      {
        headline: 'Noise week',
        lede: 'Loud.',
        lead: 'scene-x',
        stories: [
          { key: 'scene-x', title: 'Loud', blurb: 'Very' },
          { key: 'nope', title: 'X', blurb: 'Y' },
        ],
        theme: { title: 'T', blurb: 'B', events: [1, 2, 2, 9] },
        focus: [{ text: 'Go', story: 'scene-x' }],
      },
      ['scene-x'],
      3,
    );
    expect(copy?.stories.map((s) => s.key)).toEqual(['scene-x']);
    expect(copy?.theme.events).toEqual([1, 2]);
    expect(parseCopy('not json', [], 0)).toBeNull();
  });
});

async function user(name: string) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).bind(id, name, `${id}@example.org`),
    env.DB.prepare(
      `INSERT INTO user_profiles (user_id, taste_text, prefs) VALUES (?, 'Noise rock and galleries', '{}')`,
    ).bind(id),
  ]);
  return id;
}

async function event(
  uid: string | null,
  id: string,
  over: {
    category?: string;
    score?: number;
    days?: number[];
    genres?: string[];
    venue?: string;
    /** Added today; otherwise long in the programme. */
    fresh?: boolean;
  } = {},
) {
  const days = over.days ?? [10];
  await env.DB.batch([
    ...(over.venue
      ? [
          env.DB.prepare(`INSERT OR IGNORE INTO venues (id, name, district) VALUES (?, ?, 'Mitte')`).bind(
            over.venue,
            over.venue,
          ),
        ]
      : []),
    env.DB.prepare(
      `INSERT INTO events (id, slug, title, lang, category, genres, venue_id, dedup_key, created_by, created_at)
       VALUES (?, ?, ?, 'en', ?, ?, ?, ?, 't', ?)`,
    ).bind(
      id,
      id,
      `Show ${id}`,
      over.category ?? 'concert',
      JSON.stringify(over.genres ?? []),
      over.venue ?? null,
      `${id}-k`,
      over.fresh ? new Date().toISOString() : '2026-01-01T00:00:00.000Z',
    ),
    ...days.map((d, i) =>
      env.DB.prepare(
        `INSERT INTO occurrences (id, event_id, start_local, start_utc, status) VALUES (?, ?, ?, ?, 'scheduled')`,
      ).bind(`${id}_${i}`, id, local(d), berlinLocalToUtc(local(d))),
    ),
    ...(uid
      ? [
          env.DB.prepare(
            `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
             VALUES (?, ?, ?, '[]', 1, '2026-01-01T00:00:00Z')`,
          ).bind(uid, id, over.score ?? 75),
        ]
      : []),
  ]);
}

/** Claude writes the copy and groups the first three loose events into a theme. */
function claudeEnv(onCall?: (user: string) => void) {
  return {
    ...env,
    SCORE_MODEL: 'anthropic/claude-haiku-5.5',
    AI: {
      run: async (_m: string, body: { messages: { content: string | { text?: string }[] }[] }) => {
        const userText = JSON.stringify(body.messages);
        onCall?.(userText);
        const keys = [...userText.matchAll(/\[([a-z0-9-]+)\] [a-z]+/g)].map((m) => m[1]!);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                headline: 'A loud fortnight',
                lede: 'Noise rock everywhere.',
                lead: keys[0] ?? '',
                stories: keys.map((k) => ({ key: k, title: `Title ${k}`, blurb: `Blurb ${k}` })),
                theme: { title: 'Small rooms', blurb: 'Three tiny gigs.', events: [1, 2, 3] },
                focus: [{ text: 'Keep Friday free', story: keys[0] ?? '' }],
              }),
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3000, output_tokens: 700 },
        };
      },
    },
  } as unknown as Env;
}

describe('discover editions', () => {
  it('writes copy with the model, adds a theme, and reads back without sorted-out events', async () => {
    const uid = await user('Mara');
    for (const [i, id] of ['d_n1', 'd_n2', 'd_n3'].entries()) {
      await event(uid, id, { genres: ['shoegaze'], days: [4 + i], score: 90 - i });
    }
    for (const [i, id] of ['d_l1', 'd_l2', 'd_l3', 'd_l4'].entries()) {
      await event(uid, id, { days: [20 + i], score: 66 });
    }
    await event(uid, 'd_far', { category: 'theatre', days: [70, 71], score: 88 });
    await event(uid, 'd_far2', { category: 'opera', days: [80], score: 81 });
    await refreshAllNextDates(env.DB);

    let prompt = '';
    const stories = await buildDiscover(
      claudeEnv((u) => (prompt = u)),
      uid,
    );
    expect(stories).toBeGreaterThanOrEqual(3);
    expect(prompt).toContain('Noise rock and galleries');

    await env.DB.prepare(
      `INSERT INTO user_event_state (user_id, event_id, state, updated_at) VALUES (?, 'd_n1', 'skipped', '2026-01-01T00:00:00Z')`,
    )
      .bind(uid)
      .run();
    const ed = await getDiscover(env, uid);
    expect(ed.status).toBe('ready');
    expect(ed.written).toBe(true);
    expect(ed.headline).toBe('A loud fortnight');
    expect(ed.stories[0]!.kind).toBe('theme');
    expect(ed.stories.find((s) => s.kind === 'scene')?.title).toMatch(/^Title scene-shoegaze/);
    expect(ed.stories.find((s) => s.kind === 'ahead')?.picks.map((p) => p.event.slug)).toEqual(['d_far', 'd_far2']);
    const slugs = ed.stories.flatMap((s) => s.picks.map((p) => p.event.slug));
    expect(slugs).not.toContain('d_n1');
    expect(ed.focus[0]).toEqual({ text: 'Keep Friday free', story: ed.lead });
    expect(ed.stories.flatMap((s) => s.picks).every((p) => typeof p.score === 'number')).toBe(true);
  });

  it('falls back to template copy when the model is unavailable', async () => {
    const uid = await user('Ole');
    for (const [i, id] of ['t_a', 't_b', 't_c'].entries()) {
      await event(uid, id, { venue: 'v_tmpl', days: [3 + i], score: 80 });
    }
    await refreshAllNextDates(env.DB);
    const broken = {
      ...env,
      SCORE_MODEL: 'anthropic/claude-haiku-5.5',
      AI: {
        run: async () => {
          throw new Error('gateway down');
        },
      },
    } as unknown as Env;
    await buildDiscover(broken, uid);
    const ed = await getDiscover(env, uid);
    expect(ed.written).toBe(false);
    expect(ed.stories.find((s) => s.kind === 'venue')?.title).toBe('v_tmpl');
  });

  it('serves a public edition without signing in, built on first read, without default-off venues', async () => {
    // A member loves both, so both would lead the public edition if p_off's venue were not off by default.
    const fan = await user('Fan');
    await event(fan, 'p_on', { days: [6], score: 99, fresh: true });
    await event(fan, 'p_off', { days: [6], score: 99, fresh: true });
    await event(null, 'p_on2', { days: [6], fresh: true });
    await event(null, 'p_on3', { days: [6], fresh: true });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes, default_off) VALUES
           ('s_quiet_d', 'Quiet', 'ical', '{}', 360, 1), ('s_loud_d', 'Loud', 'ical', '{}', 360, 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at)
         VALUES ('raw-q', 's_quiet_d', 'q', 'hq', 'text', '', '2026-01-01T00:00:00Z'),
                ('raw-l', 's_loud_d', 'l', 'hl', 'text', '', '2026-01-01T00:00:00Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO event_sources (event_id, raw_item_id, extracted, confidence)
         VALUES ('p_off', 'raw-q', '{}', 1), ('p_on', 'raw-l', '{}', 1)`,
      ),
    ]);
    await refreshAllNextDates(env.DB);
    const res = await exports.default.fetch('https://x/api/discover');
    expect(res.status).toBe(200);
    const ed = (await res.json()) as Awaited<ReturnType<typeof getPublicDiscover>>;
    expect(ed.status).toBe('ready');
    const slugs = ed.stories.flatMap((s) => s.picks.map((p) => p.event.slug));
    expect(slugs).toContain('p_on');
    expect(slugs).not.toContain('p_off');
    expect(ed.stories.flatMap((s) => s.picks).every((p) => p.score === null)).toBe(true);
  });

  it('needs a sign-in for the personal edition', async () => {
    const res = await exports.default.fetch('https://x/api/me/discover');
    expect(res.status).toBe(401);
  });
});
