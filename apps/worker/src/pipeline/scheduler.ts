/**
 * Cron dispatcher (docs/03 "Scheduling"). Picks due sources, claims each with a conditional UPDATE so two
 * overlapping cron invocations never start the same source twice, then starts a SourceRun workflow.
 */

const MAX_PER_TICK = 10;

export async function startSourceRun(env: Env, sourceId: string, now = new Date()): Promise<string> {
  const id = `src-${sourceId}-${now.getTime()}`;
  await env.SOURCE_RUN.create({ id, params: { sourceId } });
  return id;
}

export async function dispatchDueSources(env: Env, now = new Date(), start = startSourceRun): Promise<string[]> {
  const nowIso = now.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, schedule_minutes FROM sources
      WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at LIMIT ?`,
  )
    .bind(nowIso, MAX_PER_TICK)
    .all<{ id: string; schedule_minutes: number }>();

  const started: string[] = [];
  for (const s of results) {
    const next = new Date(now.getTime() + s.schedule_minutes * 60_000).toISOString();
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
