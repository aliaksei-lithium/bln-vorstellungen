import {
  SourceCreate,
  SourceRunView,
  SourceUpdate,
  SourceView,
  UserCreate,
  type InviteAccepted,
  type InviteRequests,
  type UsageOverview,
} from '@bln/shared';
import { adapterTypes, getAdapter, hasAdapter, HtmlConfig, htmlAdapter, registerBuiltinAdapters } from '@bln/sources';
import { z } from 'zod';
import { configuredProvider, extractEvents } from '../ai/extract';
import { embedMissing } from '../ai/embed';
import { BudgetExhausted, CLAUDE, DAILY_NEURON_BUDGET } from '../ai/models';
import { rebuildIndex } from '../ai/vector-index';
import { sourceContext } from '../pipeline/source-run';
import { usageDays, usageToday } from '../usage';
import { Hono } from 'hono';
import { createLoginLink, isAdmin, type AppEnv } from '../auth';
import { HTTPException } from 'hono/http-exception';
import { startSourceRun } from '../pipeline/scheduler';
import { acceptInvite, declineInvite, listInviteRequests } from '../services/invites';
import { buildDiscover } from '../services/discover';
import { dropPastImages, fetchImages } from '../services/images';
import { startReview } from '../services/review';

registerBuiltinAdapters();

/**
 * Owner-only admin API: a signed-in owner (web app) or `Authorization: Bearer <ADMIN_TOKEN>` (scripts), see
 * auth.ts. The bearer header also makes Workers Caching bypass, and every response here is no-store.
 */
export const adminApi = new Hono<AppEnv>();

adminApi.use('*', async (c, next) => {
  if (!(await isAdmin(c)))
    throw new HTTPException(401, { message: 'Owner only: sign in as the owner or send the admin token.' });
  c.header('Cache-Control', 'no-store');
  await next();
});

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

/** The owner's spend overview: one row per UTC day, today last (`?days=`, 1–90, default 30). */
adminApi.get('/usage/days', async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 30));
  const rows = await usageDays(c.env.DB, days);
  const cap = Number(c.env.CLAUDE_DAILY_USD);
  return c.json({
    days: rows.map(({ day, values: v }) => ({
      day,
      claudeUsd: (v.claude_microusd ?? 0) / 1e6,
      claudeCalls: v.claude_calls ?? 0,
      tokensIn: v.claude_tokens_in ?? 0,
      tokensOut: v.claude_tokens_out ?? 0,
      neurons: v.ai_neurons ?? 0,
      extractCalls: v.ai_extract_calls ?? 0,
      scoreCalls: v.ai_score_calls ?? 0,
    })),
    claudeDailyUsd: String(c.env.CLAUDE_DAILY_USD ?? '').trim() && Number.isFinite(cap) ? cap : null,
    neuronBudget: DAILY_NEURON_BUDGET,
    models: { extract: c.env.EXTRACT_MODEL ?? 'workers-ai', score: c.env.SCORE_MODEL ?? 'workers-ai' },
  } satisfies UsageOverview);
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

/* ---------- users (pre-defined, no sign-up) ---------- */

adminApi.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.is_owner AS isOwner, u.created_at AS createdAt,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS activeSessions
       FROM users u ORDER BY u.created_at`,
  )
    .bind(new Date().toISOString())
    .all();
  return c.json({ users: results.map((u) => ({ ...u, isOwner: Boolean(u.isOwner) })) });
});

/** Creates a user (or returns the existing one with that email) and a fresh one-time login link for them. */
adminApi.post('/users', async (c) => {
  const parsed = UserCreate.safeParse(await readJson(c));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid user' });
  const u = parsed.data;
  const email = u.email.toLowerCase();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, is_owner) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (email) DO UPDATE SET name = excluded.name, is_owner = MAX(is_owner, excluded.is_owner)`,
    ).bind(crypto.randomUUID(), u.name, email, u.owner ? 1 : 0),
  ]);
  const user = await c.env.DB.prepare('SELECT id, name, email, is_owner FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; name: string; email: string; is_owner: number }>();
  await c.env.DB.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)').bind(user!.id).run();
  const link = await createLoginLink(c.env.DB, user!.id, new URL(c.req.url).origin);
  return c.json(
    { user: { id: user!.id, name: user!.name, email: user!.email, isOwner: Boolean(user!.is_owner) }, loginLink: link },
    201,
  );
});

adminApi.post('/users/:id/login-link', async (c) => {
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR email = ?')
    .bind(c.req.param('id'), c.req.param('id').toLowerCase())
    .first<{ id: string }>();
  if (!user) throw new HTTPException(404, { message: 'User not found' });
  return c.json(await createLoginLink(c.env.DB, user.id, new URL(c.req.url).origin), 201);
});

/** Signs the user out everywhere and removes their data (profile, scores, states cascade). */
adminApi.delete('/users/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.req.param('id')).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: 'User not found' });
  return c.body(null, 204);
});

/* ---------- invite requests (docs/09, 2026-11-02) ---------- */

adminApi.get('/invites', async (c) => {
  const status = c.req.query('status');
  return c.json({
    requests: await listInviteRequests(
      c.env.DB,
      status === 'all' || status === 'invited' || status === 'declined' ? status : 'pending',
    ),
  } satisfies InviteRequests);
});

adminApi.post('/invites/:id/accept', async (c) =>
  c.json((await acceptInvite(c.env.DB, c.req.param('id'), new URL(c.req.url).origin)) satisfies InviteAccepted, 201),
);

adminApi.post('/invites/:id/decline', async (c) => c.json(await declineInvite(c.env.DB, c.req.param('id'))));

/** Starts the daily highlights now: the public edition, or one user's with `?user=<id>` (testing, a missed day). */
adminApi.post('/reviews/run', async (c) => {
  const who = c.req.query('user') ?? null;
  const ok = await startReview(c.env, who, `review-${who ?? 'public'}-manual-${Date.now()}`);
  return c.json({ started: ok }, ok ? 202 : 409);
});

/** Runs the image job now (backfill after a new source, or checking a change): `?limit=` events, at most 40. */
adminApi.post('/images/run', async (c) => {
  const limit = Math.min(40, Math.max(1, Number(c.req.query('limit') ?? 10) || 10));
  const dropped = await dropPastImages(c.env);
  const t0 = Date.now();
  const stored = await fetchImages(c.env, new Date(), limit);
  return c.json({ stored, dropped, ms: Date.now() - t0 });
});

/** Rebuilds today's Discover now (one model call, no web searches): public, or one user's with `?user=<id>`. */
adminApi.post('/discover/run', async (c) => {
  const who = c.req.query('user') ?? null;
  if (who && !(await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(who).first())) {
    throw new HTTPException(404, { message: 'No such user' });
  }
  return c.json({ stories: await buildDiscover(c.env, who) });
});
