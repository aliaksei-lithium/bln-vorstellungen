import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatchScoring } from '../src/ai/score';
import { seen, seenById } from '../src/services/activity';
import { getReview } from '../src/services/review';

/** Who counts as around: visits recorded at most hourly, daily AI work for recent users, a catch-up on return. */

const DAY = 86_400_000;

async function user(name: string, lastSeenAt: string | null, taste = 'Noise rock') {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email, last_seen_at) VALUES (?, ?, ?, ?)`).bind(
      id,
      name,
      `${id}@example.org`,
      lastSeenAt,
    ),
    env.DB.prepare(`INSERT INTO user_profiles (user_id, taste_text, prefs) VALUES (?, ?, '{}')`).bind(id, taste),
  ]);
  return id;
}

const lastSeen = async (id: string) =>
  (await env.DB.prepare(`SELECT last_seen_at FROM users WHERE id = ?`).bind(id).first<{ last_seen_at: string }>())!
    .last_seen_at;

function scoringEnv(runs: { id: string; params: unknown }[]) {
  return {
    ...env,
    SCORE_EVENTS: { create: async (r: { id: string; params: unknown }) => void runs.push(r) },
  } as unknown as Env;
}

describe('activity', () => {
  it('records a visit at most hourly', async () => {
    const now = new Date('2026-12-10T12:00:00Z');
    const id = await user('Hourly', '2026-12-10T11:30:00Z');
    expect(seen(env, id, '2026-12-10T11:30:00Z', now)).toBeNull();
    await seen(env, id, '2026-12-10T10:30:00Z', now);
    expect(await lastSeen(id)).toBe(now.toISOString());
  });

  it('catches up a user back after a week: re-scored, then a fresh For you, shown as on its way', async () => {
    const now = new Date('2026-12-11T09:00:00Z');
    const id = await user('Back', new Date(now.getTime() - 9 * DAY).toISOString());
    const runs: { id: string; params: unknown }[] = [];
    await seenById(scoringEnv(runs), id, now);
    expect(runs).toEqual([
      { id: `score-${id}-${Math.floor(now.getTime() / 60_000)}-rebuild`, params: { userId: id, rebuild: true } },
    ]);
    expect((await getReview(env, id, now)).status).toBe('preparing');
  });

  it('only records the first visit of a new account, and skips users without a taste', async () => {
    const now = new Date('2026-12-12T09:00:00Z');
    const fresh = await user('New', null);
    const blank = await user('Blank', new Date(now.getTime() - 30 * DAY).toISOString(), '');
    const runs: { id: string; params: unknown }[] = [];
    await seenById(scoringEnv(runs), fresh, now);
    await seenById(scoringEnv(runs), blank, now);
    expect(runs).toEqual([]);
    expect(await lastSeen(fresh)).toBe(now.toISOString());
  });

  it('scores new events for recent users only', async () => {
    const now = new Date('2026-12-13T09:00:00Z');
    const recent = await user('Recent', new Date(now.getTime() - 2 * DAY).toISOString());
    const idle = await user('Idle', new Date(now.getTime() - 20 * DAY).toISOString());
    const runs: { id: string; params: unknown }[] = [];
    await dispatchScoring(scoringEnv(runs), undefined, now);
    const users = runs.map((r) => (r.params as { userId: string }).userId);
    expect(users).toContain(recent);
    expect(users).not.toContain(idle);
  });
});
