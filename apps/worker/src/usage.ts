/**
 * Daily counters (docs/04 `usage_counters`) so free-tier budgets are enforced in code, not discovered on a bill.
 * Days are UTC, matching when Cloudflare resets its daily free allowances.
 */

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export type Metric =
  | 'ai_neurons'
  | 'ai_extract_calls'
  | 'ai_score_calls'
  | 'ai_embed_texts'
  | 'claude_microusd'
  | 'claude_calls'
  | 'claude_tokens_in'
  | 'claude_tokens_out'
  | 'claude_web_searches'
  | 'ai_review_calls'
  | 'ai_discover_calls'
  | 'ai_ask_calls';

export const bumpUsage = (db: D1Database, metric: Metric, by: number, now = new Date()): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO usage_counters (day, metric, value) VALUES (?, ?, ?)
       ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
    )
    .bind(utcDay(now), metric, Math.round(by));

export async function usageToday(db: D1Database, now = new Date()): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT metric, value FROM usage_counters WHERE day = ?')
    .bind(utcDay(now))
    .all<{ metric: string; value: number }>();
  return Object.fromEntries(results.map((r) => [r.metric, r.value]));
}

/** Counters per UTC day for the last `days` days (today included), oldest first; days without usage are zeros. */
export async function usageDays(
  db: D1Database,
  days: number,
  now = new Date(),
): Promise<{ day: string; values: Record<string, number> }[]> {
  const list = Array.from({ length: days }, (_, i) => utcDay(new Date(now.getTime() - (days - 1 - i) * 86_400_000)));
  const { results } = await db
    .prepare('SELECT day, metric, value FROM usage_counters WHERE day >= ? ORDER BY day')
    .bind(list[0])
    .all<{ day: string; metric: string; value: number }>();
  const byDay = new Map(list.map((d) => [d, {} as Record<string, number>]));
  for (const r of results) {
    const v = byDay.get(r.day);
    if (v) v[r.metric] = r.value;
  }
  return list.map((day) => ({ day, values: byDay.get(day)! }));
}
