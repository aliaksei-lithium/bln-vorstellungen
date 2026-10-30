import type { HealthResponse } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { adminApi } from './api/admin';
import { eventsApi } from './api/events';
import { sweepPassedDates } from './pipeline/next-dates';
import { dispatchDueSources } from './pipeline/scheduler';

export { McpAgent } from './mcp';
export { SourceRunWorkflow } from './pipeline/source-run';
export { EnrichEventWorkflow, ExtractItemWorkflow, PhotoIngestWorkflow, ScoreEventsWorkflow } from './workflows';

const app = new Hono<{ Bindings: Env }>();

// Workers Caching stores any GET without an explicit policy (heuristically, for hours). Only routes that opt in
// with their own Cache-Control are cacheable; everything else under /api is no-store.
app.use('/api/*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

app.get('/api/health', async (c) => {
  const t0 = Date.now();
  let db: HealthResponse['db'] = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    db = 'error';
  }
  const body: HealthResponse = { ok: db === 'ok', db, dbLatencyMs: Date.now() - t0, time: new Date().toISOString() };
  return c.json(body, db === 'ok' ? 200 : 503);
});

app.route('/api/events', eventsApi);
app.route('/api/admin', adminApi);

app.all('/mcp/*', (c) => c.env.MCP_AGENT.get(c.env.MCP_AGENT.idFromName('default')).fetch(c.req.raw));
app.all('/mcp', (c) => c.env.MCP_AGENT.get(c.env.MCP_AGENT.idFromName('default')).fetch(c.req.raw));

app.all('/api/*', () => {
  throw new HTTPException(404, { message: 'Not found' });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error('unhandled', err);
  return c.json({ error: 'Something went wrong on our side. Try again in a minute.' }, 500);
});

export default {
  fetch: app.fetch,
  /** Every 15 min: move events past their next date on, then start a SourceRun workflow per due source. */
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    const swept = await sweepPassedDates(env.DB, now);
    const started = await dispatchDueSources(env, now);
    console.log('cron', { cron: controller.cron, swept, started: started.length });
  },
} satisfies ExportedHandler<Env>;
