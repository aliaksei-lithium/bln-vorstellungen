import { getAdapter, hasAdapter } from '@bln/sources';

/**
 * Cron dispatcher (docs/03 "Scheduling"). Picks due sources, claims each with a conditional UPDATE so two
 * overlapping cron invocations never start the same source twice, then starts a SourceRun workflow.
 */

const MAX_PER_TICK = 10;
/**
 * Sources off by default for visitors whose pages the model has to read (no `mapItem`) are read at most weekly
 * (docs/09, 2026-11-04): they cost model calls, their programmes are published months ahead, and dates already
 * listed stay listed.
 */
export const QUIET_SOURCE_MINUTES = 7 * 24 * 60;

/** Minutes until the next run. */
export function intervalFor(s: { type: string; schedule_minutes: number; default_off: number }): number {
  const readByModel = hasAdapter(s.type) && !getAdapter(s.type).mapItem;
  return s.default_off && readByModel ? Math.max(s.schedule_minutes, QUIET_SOURCE_MINUTES) : s.schedule_minutes;
}

export async function startSourceRun(env: Env, sourceId: string, now = new Date()): Promise<string> {
  const id = `src-${sourceId}-${now.getTime()}`;
  await env.SOURCE_RUN.create({ id, params: { sourceId } });
  return id;
}

export async function dispatchDueSources(env: Env, now = new Date(), start = startSourceRun): Promise<string[]> {
  const nowIso = now.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, type, schedule_minutes, default_off FROM sources
      WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at LIMIT ?`,
  )
    .bind(nowIso, MAX_PER_TICK)
    .all<{ id: string; type: string; schedule_minutes: number; default_off: number }>();

  const started: string[] = [];
  for (const s of results) {
    const next = new Date(now.getTime() + intervalFor(s) * 60_000).toISOString();
    const claim = await env.DB.prepare(
      'UPDATE sources SET next_run_at = ? WHERE id = ? AND enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)',
    )
      .bind(next, s.id, nowIso)
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      started.push(await start(env, s.id, now));
    } catch (err) {
      // Give the source back to the next tick instead of waiting a full interval.
      await env.DB.prepare('UPDATE sources SET next_run_at = NULL WHERE id = ?').bind(s.id).run();
      console.error('dispatch failed', { sourceId: s.id, err: String(err) });
    }
  }
  return started;
}
