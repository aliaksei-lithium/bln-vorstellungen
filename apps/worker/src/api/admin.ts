import { SourceCreate, SourceRunView, SourceUpdate, SourceView } from '@bln/shared';
import { adapterTypes, getAdapter, hasAdapter, HtmlConfig, htmlAdapter, registerBuiltinAdapters } from '@bln/sources';
import { z } from 'zod';
import { configuredProvider, extractEvents } from '../ai/extract';
import { embedMissing } from '../ai/embed';
import { BudgetExhausted, CLAUDE, DAILY_NEURON_BUDGET } from '../ai/models';
import { rebuildIndex } from '../ai/vector-index';
import { sourceContext } from '../pipeline/source-run';
import { usageToday } from '../usage';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { startSourceRun } from '../pipeline/scheduler';

registerBuiltinAdapters();

/**
 * Owner-only admin API. Until sign-in lands (phase 2) it is gated by a shared secret: `Authorization: Bearer
 * <ADMIN_TOKEN>`, set with `wrangler secret put ADMIN_TOKEN`. Without the secret the admin API is off.
 */
export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) throw new HTTPException(503, { message: 'Admin API is disabled: ADMIN_TOKEN is not set.' });
  const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!(await sameSecret(given, expected))) throw new HTTPException(401, { message: 'Missing or wrong admin token.' });
  c.header('Cache-Control', 'no-store');
  await next();
});

/** Compares digests so the check takes the same time whatever the input. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

type SourceRow = {
  id: string;
  name: string;
  type: string;
  config: string;
  schedule_minutes: number;
  enabled: number;
  visibility: 'public' | 'private';
  cursor: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  stats: string;
};

const toView = (r: SourceRow): SourceView => ({
  id: r.id,
  name: r.name,
  type: r.type,
  config: JSON.parse(r.config) as Record<string, unknown>,
  scheduleMinutes: r.schedule_minutes,
  enabled: Boolean(r.enabled),
  visibility: r.visibility,
  cursor: r.cursor,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  stats: JSON.parse(r.stats || '{}') as Record<string, number>,
});

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON.' });
  }
}

function validConfig(type: string, config: unknown): Record<string, unknown> {
  if (!hasAdapter(type))
    throw new HTTPException(400, { message: `Unknown source type "${type}". Known: ${adapterTypes().join(', ')}` });
  const r = getAdapter(type).configSchema.safeParse(config);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HTTPException(400, { message: `config.${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}` });
  }
  return r.data as Record<string, unknown>;
}

async function getSource(db: D1Database, id: string): Promise<SourceRow> {
  const row = await db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>();
  if (!row) throw new HTTPException(404, { message: 'Source not found' });
  return row;
}

adminApi.get('/adapters', (c) =>
  c.json({
    adapters: adapterTypes().map((t) => ({ type: t, defaultScheduleMinutes: getAdapter(t).defaultScheduleMinutes })),
  }),
);

adminApi.get('/sources', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM sources ORDER BY name').all<SourceRow>();
  return c.json({ sources: results.map(toView) });
});

adminApi.post('/sources', async (c) => {
  const parsed = SourceCreate.safeParse(await readJson(c));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid source' });
  const s = parsed.data;
  const config = validConfig(s.type, s.config);
  const id = crypto.randomUUID();
  // next_run_at stays NULL: the next cron tick (≤ 15 min) runs it.
  await c.env.DB.prepare(
    `INSERT INTO sources (id, name, type, config, schedule_minutes, enabled, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      s.name,
      s.type,
      JSON.stringify(config),
      s.scheduleMinutes ?? getAdapter(s.type).defaultScheduleMinutes,
      s.enabled ? 1 : 0,
      s.visibility,
    )
    .run();
  return c.json(toView(await getSource(c.env.DB, id)), 201);
});

adminApi.patch('/sources/:id', async (c) => {
  const row = await getSource(c.env.DB, c.req.param('id'));
  const parsed = SourceUpdate.safeParse(await readJson(c));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid update' });
  const u = parsed.data;
  const config = u.config ? validConfig(row.type, u.config) : null;
  await c.env.DB.prepare(
    `UPDATE sources SET name = COALESCE(?, name), config = COALESCE(?, config),
       schedule_minutes = COALESCE(?, schedule_minutes), enabled = COALESCE(?, enabled),
       visibility = COALESCE(?, visibility), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  )
    .bind(
      u.name ?? null,
      config ? JSON.stringify(config) : null,
      u.scheduleMinutes ?? null,
      u.enabled === undefined ? null : u.enabled ? 1 : 0,
      u.visibility ?? null,
      row.id,
    )
    .run();
  return c.json(toView(await getSource(c.env.DB, row.id)));
});

/** Events stay: they may have other sources. Raw items and runs go with the source. */
adminApi.delete('/sources/:id', async (c) => {
  const row = await getSource(c.env.DB, c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM event_sources WHERE raw_item_id IN (SELECT id FROM raw_items WHERE source_id = ?)',
    ).bind(row.id),
    c.env.DB.prepare('DELETE FROM raw_items WHERE source_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM source_runs WHERE source_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(row.id),
  ]);
  return c.body(null, 204);
});

adminApi.post('/sources/:id/run', async (c) => {
  const row = await getSource(c.env.DB, c.req.param('id'));
  const now = new Date();
  await c.env.DB.prepare('UPDATE sources SET next_run_at = ? WHERE id = ?')
    .bind(new Date(now.getTime() + row.schedule_minutes * 60_000).toISOString(), row.id)
    .run();
  const instanceId = await startSourceRun(c.env, row.id, now);
  return c.json({ instanceId }, 202);
});

adminApi.get('/sources/:id/runs', async (c) => {
  const row = await getSource(c.env.DB, c.req.param('id'));
  const { results } = await c.env.DB.prepare(
    `SELECT id, workflow_id AS workflowId, started_at AS startedAt, finished_at AS finishedAt, status, fetched,
            new_items AS newItems, events_created AS eventsCreated, events_updated AS eventsUpdated, error
       FROM source_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(row.id)
    .all();
  return c.json({ runs: results.map((r) => SourceRunView.parse(r)) });
});

adminApi.get('/workflows/:instanceId', async (c) => {
  try {
    const instance = await c.env.SOURCE_RUN.get(c.req.param('instanceId'));
    return c.json({ id: instance.id, ...(await instance.status()) });
  } catch {
    throw new HTTPException(404, { message: 'Workflow instance not found' });
  }
});

/** `provider` compares models on the same input: "workers-ai" or a Claude id; default = the configured one. */
const Provider = z.enum(['workers-ai', ...(Object.keys(CLAUDE) as [keyof typeof CLAUDE])]).optional();

const ExtractPreview = z.union([
  z.object({
    text: z.string().min(1).max(60_000),
    sourceName: z.string().default('manual'),
    venue: z.string().optional(),
    provider: Provider,
  }),
  z.object({
    url: z.url(),
    cssSelector: z.string().optional(),
    venue: z.string().optional(),
    chunk: z.number().int().min(1).max(20).default(1),
    provider: Provider,
  }),
]);

/**
 * Dry run of the LLM path: page (or text) → Markdown → extracted events, nothing stored. For tuning a new `html`
 * source's selector and checking what the model makes of it before adding the source.
 */
adminApi.post('/extract', async (c) => {
  const parsed = ExtractPreview.safeParse(await readJson(c));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const p = parsed.data;
  let content: string;
  let chunks = 1;
  let url: string | undefined;
  if ('text' in p) content = p.text;
  else {
    url = p.url;
    const config = HtmlConfig.parse({ url: p.url, ...(p.cssSelector ? { cssSelector: p.cssSelector } : {}) });
    const r = await htmlAdapter
      .fetch(
        sourceContext(c.env, () => {}),
        config,
        null,
      )
      .catch((err: unknown) => {
        throw new HTTPException(502, {
          message: `Could not read the page: ${err instanceof Error ? err.message : err}`,
        });
      });
    chunks = r.stats.fetched;
    const item = r.items[p.chunk - 1];
    if (!item) throw new HTTPException(422, { message: `The page has ${r.items.length} chunk(s), not ${p.chunk}.` });
    content = item.content;
  }
  try {
    const r = await extractEvents(
      c.env,
      {
        content,
        sourceName: 'text' in p ? p.sourceName : new URL(p.url).hostname,
        ...(url ? { url } : {}),
        ...(p.venue ? { venue: p.venue } : {}),
      },
      { provider: p.provider ?? configuredProvider(c.env) },
    );
    return c.json({ chunks, markdownChars: content.length, markdownHead: content.slice(0, 600), ...r });
  } catch (err) {
    if (err instanceof BudgetExhausted) throw new HTTPException(429, { message: err.message });
    throw err;
  }
});

adminApi.get('/usage', async (c) => {
  const today = await usageToday(c.env.DB);
  return c.json({
    day: new Date().toISOString().slice(0, 10),
    neuronBudget: DAILY_NEURON_BUDGET,
    extractModel: configuredProvider(c.env),
    claudeDailyUsd: Number(c.env.CLAUDE_DAILY_USD ?? '0.5'),
    claudeUsd: (today.claude_microusd ?? 0) / 1e6,
    ...today,
  });
});

/** Embeds every upcoming event that has no vector yet (in rounds of 32), then rebuilds the vector index. */
adminApi.post('/ai/reindex', async (c) => {
  let embedded = 0;
  for (let round = 0; round < 20; round++) {
    const n = await embedMissing(c.env);
    embedded += n;
    if (n === 0) break;
  }
  const indexed = await rebuildIndex(c.env, new Date(), true);
  return c.json({ embedded, indexed });
});
