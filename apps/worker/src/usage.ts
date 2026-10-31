/**
 * Daily counters (docs/04 `usage_counters`) so free-tier budgets are enforced in code, not discovered on a bill.
 * Days are UTC, matching when Cloudflare resets its daily free allowances.
 */

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export type Metric = 'ai_neurons' | 'ai_extract_calls' | 'ai_embed_texts' | 'claude_microusd' | 'claude_calls';

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
