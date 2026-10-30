import type { HealthResponse } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eventsApi } from './api/events';

export { McpAgent } from './mcp';
export {
  EnrichEventWorkflow,
  ExtractItemWorkflow,
  PhotoIngestWorkflow,
  ScoreEventsWorkflow,
  SourceRunWorkflow,
} from './workflows';

const app = new Hono<{ Bindings: Env }>();

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
  /** Every 15 min. Phase 1: select due sources and start a SourceRun workflow per source. */
  async scheduled(controller, env) {
    const due = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)',
    )
      .bind(new Date(controller.scheduledTime).toISOString())
      .first<{ n: number }>();
    console.log('cron', { cron: controller.cron, dueSources: due?.n ?? 0 });
  },
} satisfies ExportedHandler<Env>;
