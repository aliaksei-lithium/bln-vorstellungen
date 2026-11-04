import { berlinLocalToUtc, berlinToday } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { parseResearch } from '../src/ai/prompts/review';
import {
  REBUILDS_PER_DAY,
  TASTE_REBUILDS_PER_DAY,
  claimTasteRebuild,
  composeReview,
  dispatchDailyReviews,
  gatherCandidates,
  getReview,
  rebuildNow,
  research,
  researchPicks,
  sharedPicks,
  sharedResearch,
} from '../src/services/review';
import { dispatchScoring, loadProfile } from '../src/ai/score';

/** The daily Inbox review with a stubbed Claude: candidates and their facts, web notes, the review, reading it back. */

const DAY = 86_400_000;
/** Days from today in Berlin (the review counts days in Berlin, not UTC). */
const local = (days: number, time = '20:00') =>
  `${new Date(Date.parse(`${berlinToday()}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)}T${time}`;

async function user(name: string) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).bind(id, name, `${id}@example.org`),
    env.DB.prepare(
      `INSERT INTO user_profiles (user_id, taste_text, prefs) VALUES (?, 'Contemporary theatre and post-punk', ?)`,
    ).bind(id, JSON.stringify({ categoriesOff: ['talk'] })),
  ]);
  return id;
}

/** One event with dates (days from now), a score for the user, and optionally a sold-out date. */
async function event(
  uid: string,
  id: string,
  title: string,
  category: string,
  score: number,
  days: number[],
  soldOut = false,
) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by) VALUES (?, ?, ?, 'en', ?, ?, 't')`,
    ).bind(id, id, title, category, `${id}-k`),
    ...days.map((d, i) =>
      env.DB.prepare(
        `INSERT INTO occurrences (id, event_id, start_local, start_utc, status) VALUES (?, ?, ?, ?, ?)`,
      ).bind(`${id}_${i}`, id, local(d), berlinLocalToUtc(local(d)), soldOut && i === 0 ? 'sold_out' : 'scheduled'),
    ),
    env.DB.prepare(
      `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
       VALUES (?, ?, ?, ?, 1, '2026-01-01T00:00:00Z')`,
    ).bind(uid, id, score, JSON.stringify([{ kind: 'for', text: `${title} fits` }])),
  ]);
}

/** Claude answers research (has tools) with notes, and the review with the given picks. */
function claudeEnv(review: unknown, notes = '', seen: { tools: boolean }[] = []) {
  return {
    ...env,
    SCORE_MODEL: 'anthropic/claude-haiku-5.5',
    AI: {
      run: async (_m: string, body: { tools?: unknown[] }) => {
        seen.push({ tools: !!body.tools });
        return body.tools
          ? {
              content: [{ type: 'text', text: notes }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 20000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
            }
          : {
              content: [{ type: 'text', text: JSON.stringify(review) }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 4000, output_tokens: 600 },
            };
      },
    },
  } as unknown as Env;
}

describe('daily review', () => {
  it('gathers candidates with their facts, without switched-off categories or sorted-out events', async () => {
    const uid = await user('Ida');
    await event(uid, 'rv_far', 'Big Production', 'theatre', 88, [150, 151, 152]);
    await event(uid, 'rv_soon', 'Close Gig', 'concert', 91, [3]);
    await event(uid, 'rv_sold', 'Hot Ticket', 'concert', 72, [10, 11], true);
    await event(uid, 'rv_talk', 'A Talk', 'talk', 95, [5]);
    await event(uid, 'rv_low', 'Weak Match', 'concert', 40, [6]);
    await event(uid, 'rv_hidden', 'Hidden One', 'concert', 90, [7]);
    await event(uid, 'rv_planned', 'Planned Thing', 'theatre', 70, [3]);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user_event_state (user_id, event_id, state) VALUES (?, 'rv_hidden', 'hidden')`).bind(
        uid,
      ),
      env.DB.prepare(
        `INSERT INTO user_event_state (user_id, event_id, state) VALUES (?, 'rv_planned', 'interested')`,
      ).bind(uid),
    ]);
    await refreshAllNextDates(env.DB);

    const { prefs } = await loadProfile(env.DB, uid);
    const c = await gatherCandidates(env.DB, uid, prefs);
    expect(c.map((x) => x.id)).toEqual(['rv_soon', 'rv_far', 'rv_sold']);
    expect(c[0]).toMatchObject({ days: 3, datesLeft: 1, sameDayAs: 'Planned Thing' });
    expect(c[1]).toMatchObject({ days: 150, datesLeft: 3, soldOut: 0 });
    expect(c[2]).toMatchObject({ soldOut: 1, datesLeft: 1 });
    // Research covers the best overall and the best far ahead.
    expect(researchPicks(c)).toEqual([0, 1, 2]);
  });

  it('researches with web search, writes the review, and reads back only what is still open', async () => {
    const uid = await user('Jo');
    await event(uid, 'rj_far', 'Faust Marathon', 'theatre', 86, [140, 141]);
    await event(uid, 'rj_gig', 'Shame', 'concert', 93, [4]);
    await refreshAllNextDates(env.DB);
    const seen: { tools: boolean }[] = [];
    const e = claudeEnv(
      {
        summary: 'A rare long Faust and a gig you should not miss.',
        sections: [
          {
            category: 'theatre',
            picks: [{ n: 2, kind: 'book_early', why: 'Two dates only, in February; critics rave.' }],
          },
          { category: 'concert', picks: [{ n: 1, kind: 'perfect_match', why: 'Post-punk at its best, in 4 days.' }] },
          { category: 'opera', picks: [{ n: 9, kind: 'critics', why: 'Out of range: dropped.' }] },
        ],
      },
      '2 | Five-star reviews in Der Tagesspiegel | https://www.tagesspiegel.de/faust\nnot a note line',
      seen,
    );
    const { prefs } = await loadProfile(env.DB, uid);
    const candidates = await gatherCandidates(env.DB, uid, prefs);
    const found = await research(e, candidates);
    expect(found).toEqual({
      notes: [{ index: 1, note: 'Five-star reviews in Der Tagesspiegel', url: 'https://www.tagesspiegel.de/faust' }],
      searches: 2,
    });
    expect(await composeReview(e, uid, candidates, found)).toBe(2);
    expect(seen).toEqual([{ tools: true }, { tools: false }]);

    const r = await getReview(env, uid);
    expect(r).toMatchObject({
      status: 'ready',
      summary: 'A rare long Faust and a gig you should not miss.',
      searches: 2,
    });
    expect(r.canRefresh).toBe(false); // today's exists
    expect(
      r.sections.map((s) => [s.category, s.picks.map((p) => [p.event.slug, p.kind, p.sourceUrl, p.score])]),
    ).toEqual([
      ['theatre', [['rj_far', 'book_early', 'https://www.tagesspiegel.de/faust', 86]]],
      ['concert', [['rj_gig', 'perfect_match', null, 93]]],
    ]);
    const searches = await env.DB.prepare(
      `SELECT value FROM usage_counters WHERE metric = 'claude_web_searches'`,
    ).first<{
      value: number;
    }>();
    expect(searches?.value).toBeGreaterThanOrEqual(2);

    // Skipped since: it leaves the review, and an emptied section goes with it.
    await env.DB.prepare(`INSERT INTO user_event_state (user_id, event_id, state) VALUES (?, 'rj_gig', 'skipped')`)
      .bind(uid)
      .run();
    expect((await getReview(env, uid)).sections.map((s) => s.category)).toEqual(['theatre']);
  });

  it('writes a public edition from general interest, without plan checks, readable by anyone', async () => {
    const uid = await user('Pat');
    await event(uid, 'pub_far', 'Ring Cycle', 'opera', 80, [120, 122]);
    await event(uid, 'pub_gig', 'Neighbourhood Gig', 'concert', 60, [5]);
    await refreshAllNextDates(env.DB);
    const { gatherPublicCandidates } = await import('../src/services/review');
    const candidates = await gatherPublicCandidates(env.DB);
    const ring = candidates.find((c) => c.id === 'pub_far');
    expect(ring).toMatchObject({ members: 1, score: 80, sameDayAs: null });
    const i = candidates.indexOf(ring!);
    const e = claudeEnv({
      summary: 'A Ring cycle worth booking now.',
      sections: [
        {
          category: 'opera',
          picks: [
            { n: i + 1, kind: 'book_early', why: 'Two cycles only, in spring.' },
            { n: candidates.findIndex((c) => c.id === 'pub_gig') + 1, kind: 'plan_check', why: 'No agenda here.' },
          ],
        },
      ],
    });
    const { getPublicReview } = await import('../src/services/review');
    await composeReview(e, null, candidates, { notes: [], searches: 0 });
    const r = await getPublicReview(env);
    expect(r).toMatchObject({ status: 'ready', summary: 'A Ring cycle worth booking now.', canRefresh: false });
    expect(r.sections[0]!.picks.map((p) => [p.event.slug, p.kind, p.score])).toEqual([['pub_far', 'book_early', null]]);
    const res = await exports.default.fetch('https://x/api/highlights');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: string }).summary).toBe('A Ring cycle worth booking now.');
  });

  it('keeps "book early" for events weeks ahead, and leaves out venues visitors start without', async () => {
    const { kindFor, gatherPublicCandidates } = await import('../src/services/review');
    const c = { days: 10, datesLeft: 1 } as Parameters<typeof kindFor>[1];
    expect(kindFor('book_early', c)).toBe('last_chance');
    expect(kindFor('book_early', { ...c, datesLeft: 8 })).toBe('perfect_match');
    expect(kindFor('book_early', { ...c, days: 60 })).toBe('book_early');
    expect(kindFor('critics', c)).toBe('critics');

    const uid = await user('Vic');
    await event(uid, 'off_only', 'Only Off Venue', 'concert', 90, [9]);
    await event(uid, 'off_and_on', 'Listed Twice', 'concert', 90, [9]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes, default_off) VALUES
           ('src_off', 'Off Venue', 'ical', '{}', 60, 1), ('src_on', 'On Venue', 'ical', '{}', 60, 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, fetched_at) VALUES
           ('ri_off', 'src_off', 'a', 'ha', 'text', '', '2026-01-01T00:00:00Z'),
           ('ri_on', 'src_on', 'b', 'hb', 'text', '', '2026-01-01T00:00:00Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO event_sources (event_id, raw_item_id, extracted, confidence) VALUES
           ('off_only', 'ri_off', '{}', 1), ('off_and_on', 'ri_off', '{}', 1), ('off_and_on', 'ri_on', '{}', 1)`,
      ),
    ]);
    await refreshAllNextDates(env.DB);
    const ids = (await gatherPublicCandidates(env.DB)).map((x) => x.id);
    expect(ids).not.toContain('off_only');
    expect(ids).toContain('off_and_on');
  });

  it('parses research lines and ignores the rest', () => {
    expect(
      parseResearch('1 | Sold out in Hamburg | https://a.example/x\n1 | dup\n7 | out of range\n3 | no url', 3),
    ).toEqual([
      { n: 1, note: 'Sold out in Hamburg', url: 'https://a.example/x' },
      { n: 3, note: 'no url', url: null },
    ]);
  });

  it('dispatches reviews for users seen in the last week only', async () => {
    const recent = await user('Recent');
    const away = await user('Away');
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET last_seen_at = '2026-12-04T20:00:00Z' WHERE id = ?`).bind(recent),
      env.DB.prepare(`UPDATE users SET last_seen_at = '2026-11-01T20:00:00Z' WHERE id = ?`).bind(away),
    ]);
    const started: string[] = [];
    const e = {
      ...env,
      DAILY_REVIEW: { create: async ({ id }: { id: string }) => void started.push(id) },
    } as unknown as Env;
    await dispatchDailyReviews(e, new Date('2026-12-05T06:00:00Z'));
    expect(started).toContain('review-public-2026-12-05');
    expect(started).toContain(`review-${recent}-2026-12-05`);
    expect(started).not.toContain(`review-${away}-2026-12-05`);
  });

  it('shares one web research a day between every review, and waits for the one building it', async () => {
    await env.DB.prepare(`DELETE FROM daily_research`).run();
    const a = await user('Ana');
    const b = await user('Ben');
    await env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE id IN (?, ?)`)
      .bind(new Date().toISOString(), a, b)
      .run();
    await event(a, 'sr_a', 'Ana Gig', 'concert', 92, [5]);
    await event(b, 'sr_b', 'Ben Play', 'theatre', 90, [6]);
    await refreshAllNextDates(env.DB);
    const seen: { tools: boolean }[] = [];
    // A note for every line the research call lists.
    const notes = Array.from({ length: 10 }, (_, i) => `${i + 1} | note ${i + 1} | https://n.example/${i + 1}`);
    const e = claudeEnv({}, notes.join('\n'), seen);
    const listA = await gatherCandidates(env.DB, a, (await loadProfile(env.DB, a)).prefs);
    const listB = await gatherCandidates(env.DB, b, (await loadProfile(env.DB, b)).prefs);

    const forA = await sharedResearch(e, listA);
    const forB = await sharedResearch(e, listB);
    // One search call for both: each user's best is in it.
    expect(seen.filter((x) => x.tools)).toHaveLength(1);
    expect(forA.searches).toBe(2);
    expect(forA.notes.map((n) => listA[n.index]!.id)).toContain('sr_a');
    expect(forB.notes.map((n) => listB[n.index]!.id)).toContain('sr_b');

    // Tomorrow, another review is building it: this one waits, then reads it.
    const tomorrow = new Date(Date.now() + DAY);
    const day = berlinToday(tomorrow);
    await env.DB.prepare(`INSERT INTO daily_research (day, status) VALUES (?, 'building')`).bind(day).run();
    let waits = 0;
    const r = await sharedResearch(e, listA, tomorrow, async () => {
      waits++;
      await env.DB.prepare(`UPDATE daily_research SET status = 'ready', notes = ?, searches = 1 WHERE day = ?`)
        .bind(JSON.stringify([{ eventId: 'sr_a', note: 'sold out soon', url: null }]), day)
        .run();
    });
    expect(waits).toBe(1);
    expect(r).toEqual({
      notes: [{ index: listA.findIndex((c) => c.id === 'sr_a'), note: 'sold out soon', url: null }],
      searches: 1,
    });
    expect(seen.filter((x) => x.tools)).toHaveLength(1);
  });

  it("puts every reader's best first in the shared research", () => {
    const c = (id: string, score: number, members?: number) =>
      ({ id, score, days: 5, ...(members === undefined ? {} : { members }) }) as never;
    const pub = [c('p1', 0, 3), c('p2', 0, 2), c('p3', 0, 1)];
    const ida = [c('i1', 90), c('i2', 85), c('i3', 80)];
    const jo = [c('p1', 95), c('j2', 88)];
    expect(sharedPicks([pub, ida, jo]).map((x: { id: string }) => x.id)).toEqual(['p1', 'i1', 'p2', 'i2', 'j2', 'p3']);
  });

  it('dispatches once a Berlin day, from 05:00, for users with a taste', async () => {
    const started: string[] = [];
    const e = {
      ...env,
      DAILY_REVIEW: { create: async ({ id }: { id: string }) => void started.push(id) },
    } as unknown as Env;
    expect(await dispatchDailyReviews(e, new Date('2026-12-01T03:00:00Z'))).toBe(0); // 04:00 in Berlin
    const n = await dispatchDailyReviews(e, new Date('2026-12-01T05:00:00Z'));
    expect(n).toBeGreaterThan(0);
    expect(started.every((id) => id.endsWith('-2026-12-01'))).toBe(true);
    expect(await dispatchDailyReviews(e, new Date('2026-12-01T09:00:00Z'))).toBe(0); // already today
  });

  it("rebuilds on demand: the day's first, then a few a day, never while one is running", async () => {
    const uid = await user('Rae');
    const started: string[] = [];
    const e = {
      ...env,
      DAILY_REVIEW: { create: async ({ id }: { id: string }) => void started.push(id) },
    } as unknown as Env;
    const now = new Date('2026-12-02T10:00:00Z');
    const running = () => env.CACHE.delete(`review-running:${uid}`);
    // No edition today: the day's own run, which costs no rebuild.
    expect(await rebuildNow(e, uid, now)).toBe(true);
    expect(await rebuildNow(e, uid, now)).toBe(false); // still preparing
    await running();
    await env.DB.prepare(
      `INSERT INTO user_reviews (user_id, day, content, model, prompt_version) VALUES (?, '2026-12-02', ?, 'm', 'v')`,
    )
      .bind(uid, JSON.stringify({ summary: 's', sections: [] }))
      .run();
    expect(await getReview(e, uid, now)).toMatchObject({ rebuildsLeft: REBUILDS_PER_DAY, canRefresh: false });
    for (let i = 0; i < REBUILDS_PER_DAY; i++) {
      expect(await rebuildNow(e, uid, now)).toBe(true);
      await running();
    }
    expect(await rebuildNow(e, uid, now)).toBe(false);
    expect((await getReview(e, uid, now)).rebuildsLeft).toBe(0);
    expect(started).toEqual([
      `review-${uid}-2026-12-02-now`,
      ...Array.from({ length: REBUILDS_PER_DAY }, (_, i) => `review-${uid}-2026-12-02-again-${i + 1}`),
    ]);
    // A new Berlin day brings them back.
    expect((await getReview(e, uid, new Date('2026-12-03T10:00:00Z'))).rebuildsLeft).toBe(REBUILDS_PER_DAY);
  });

  it('rebuilds after a music service is connected, once scores are in, a few times a day', async () => {
    const uid = await user('Sam');
    const now = new Date('2026-12-04T10:00:00Z');
    for (let i = 0; i < TASTE_REBUILDS_PER_DAY; i++) expect(await claimTasteRebuild(env, uid, now)).toBe(true);
    expect(await claimTasteRebuild(env, uid, now)).toBe(false);
    // For you shows it is on its way right away.
    expect((await getReview(env, uid, now)).status).toBe('preparing');
    const runs: { id: string; params: unknown }[] = [];
    const e = {
      ...env,
      SCORE_EVENTS: { create: async (r: { id: string; params: unknown }) => void runs.push(r) },
    } as unknown as Env;
    await dispatchScoring(e, uid, now);
    await dispatchScoring(e, uid, now, { rebuild: true });
    const minute = Math.floor(now.getTime() / 60_000);
    expect(runs).toEqual([
      { id: `score-${uid}-${minute}`, params: { userId: uid } },
      { id: `score-${uid}-${minute}-rebuild`, params: { userId: uid, rebuild: true } },
    ]);
  });
});
