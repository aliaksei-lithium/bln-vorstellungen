import { berlinToday } from '@bln/shared';
import { getAdapter, registerBuiltinAdapters, type RawItem, type SourceContext } from '@bln/sources';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { resolveEvent, VenueIndex } from './resolve';

registerBuiltinAdapters();

/**
 * SourceRun (docs/03): fetch → store raw items (dedup by content hash) → resolve in small batches → finalize.
 * Each step is its own invocation with its own 10 ms CPU budget, so batches stay small.
 */

export const RESOLVE_BATCH = 8;
const STRUCTURED_VERSION = 1;

type SourceRow = {
  id: string;
  name: string;
  type: string;
  config: string;
  cursor: string | null;
  schedule_minutes: number;
};

export type SourceRunParams = { sourceId: string };

export function sourceContext(env: Env, log: (m: string, d?: Record<string, unknown>) => void): SourceContext {
  return {
    fetch: (input, init) => fetch(input, init),
    toMarkdown: async (html, opts) => {
      const res = await env.AI.toMarkdown(
        { name: 'page.html', blob: new Blob([html], { type: 'text/html' }) },
        opts?.cssSelector ? { conversionOptions: { html: { cssSelector: opts.cssSelector } } } : undefined,
      );
      const r = Array.isArray(res) ? res[0] : res;
      if (!r || r.format === 'error') throw new Error('toMarkdown failed');
      return r.data;
    },
    today: berlinToday(),
    log,
  };
}

async function loadSource(env: Env, sourceId: string): Promise<SourceRow> {
  const s = await env.DB.prepare('SELECT id, name, type, config, cursor, schedule_minutes FROM sources WHERE id = ?')
    .bind(sourceId)
    .first<SourceRow>();
  if (!s) throw new Error(`Source ${sourceId} not found`);
  return s;
}

export async function startRun(env: Env, sourceId: string, workflowId: string): Promise<string> {
  await loadSource(env, sourceId);
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_runs (id, source_id, workflow_id, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
  )
    .bind(runId, sourceId, workflowId, new Date().toISOString())
    .run();
  return runId;
}

export type FetchStepResult = { itemIds: string[]; fetched: number; newItems: number; cursor: string | null };

/**
 * Runs the adapter and stores new raw items. Returns ids of new items that the adapter can map without an LLM;
 * the rest stay `pending` for LLM extraction (phase 3).
 */
export async function fetchAndStore(env: Env, sourceId: string): Promise<FetchStepResult> {
  const source = await loadSource(env, sourceId);
  const adapter = getAdapter(source.type);
  const config = adapter.configSchema.parse(JSON.parse(source.config));
  const ctx = sourceContext(env, (m, d) => console.log(`[${source.name}] ${m}`, d ?? ''));
  const result = await adapter.fetch(ctx, config, source.cursor);
  const ids = await storeRawItems(env.DB, sourceId, result.items);
  // Also picks up items a crashed earlier run stored but never resolved.
  const pending = adapter.mapItem
    ? (
        await env.DB.prepare(
          `SELECT id FROM raw_items WHERE source_id = ? AND extraction_status = 'pending' ORDER BY fetched_at LIMIT 400`,
        )
          .bind(sourceId)
          .all<{ id: string }>()
      ).results.map((r) => r.id)
    : [];
  return {
    itemIds: pending,
    fetched: result.stats.fetched,
    newItems: ids.length,
    cursor: result.cursor,
  };
}

/** INSERT … ON CONFLICT DO NOTHING on (source_id, content_hash): unchanged items are skipped by the database. */
export async function storeRawItems(db: D1Database, sourceId: string, items: RawItem[]): Promise<string[]> {
  if (!items.length) return [];
  const now = new Date().toISOString();
  const stmts = items.map((it) =>
    db
      .prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, url, published_at, fetched_at,
           extraction_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, content_hash) DO NOTHING
         RETURNING id`,
      )
      .bind(
        crypto.randomUUID(),
        sourceId,
        it.externalId,
        it.contentHash,
        it.kind,
        it.content,
        it.url ?? null,
        it.publishedAt ?? null,
        now,
        'pending',
      ),
  );
  const results = await db.batch<{ id: string }>(stmts);
  return results.flatMap((r) => r.results.map((row) => row.id));
}

export type ResolveStepResult = { created: number; updated: number; failed: number };

/** Maps raw items with the adapter's `mapItem` and resolves every candidate. */
export async function resolveItems(env: Env, sourceId: string, itemIds: string[]): Promise<ResolveStepResult> {
  const source = await loadSource(env, sourceId);
  const adapter = getAdapter(source.type);
  const config = adapter.configSchema.parse(JSON.parse(source.config));
  const { results: rows } = await env.DB.prepare(
    `SELECT id, external_id, content_hash, kind, content, url FROM raw_items
      WHERE id IN (${itemIds.map(() => '?').join(',')})`,
  )
    .bind(...itemIds)
    .all<{
      id: string;
      external_id: string;
      content_hash: string;
      kind: RawItem['kind'];
      content: string;
      url: string | null;
    }>();

  const venues = await VenueIndex.load(env.DB);
  const out: ResolveStepResult = { created: 0, updated: 0, failed: 0 };
  const done: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const candidates =
        adapter.mapItem?.(
          {
            externalId: row.external_id,
            contentHash: row.content_hash,
            kind: row.kind,
            content: row.content,
            ...(row.url ? { url: row.url } : {}),
          },
          config,
        ) ?? [];
      for (const ev of candidates) {
        const r = await resolveEvent(env.DB, venues, ev, {
          rawItemId: row.id,
          model: `adapter:${source.type}@${STRUCTURED_VERSION}`,
          promptVersion: null,
          createdBy: 'source',
        });
        if (r.created) out.created++;
        else out.updated++;
      }
      done.push(row.id);
    } catch (err) {
      console.error('resolve failed', { rawItemId: row.id, err: String(err) });
      out.failed++;
      failed.push(row.id);
    }
  }
  const mark = (ids: string[], status: string) =>
    ids.length
      ? env.DB.prepare(`UPDATE raw_items SET extraction_status = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(
          status,
          ...ids,
        )
      : null;
  const updates = [mark(done, 'done'), mark(failed, 'failed')].filter((s): s is D1PreparedStatement => !!s);
  if (updates.length) await env.DB.batch(updates);
  return out;
}

export type FinishInput = {
  status: 'ok' | 'error';
  cursor?: string | null;
  fetched?: number;
  newItems?: number;
  created?: number;
  updated?: number;
  error?: string;
};

export async function finishRun(env: Env, runId: string, sourceId: string, r: FinishInput): Promise<void> {
  const now = new Date().toISOString();
  const db = env.DB;
  const stmts = [
    db
      .prepare(
        `UPDATE source_runs SET finished_at = ?, status = ?, fetched = ?, new_items = ?, events_created = ?,
           events_updated = ?, error = ? WHERE id = ?`,
      )
      .bind(now, r.status, r.fetched ?? 0, r.newItems ?? 0, r.created ?? 0, r.updated ?? 0, r.error ?? null, runId),
    db
      .prepare(
        `UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ?,
           stats = json_set(COALESCE(stats, '{}'), '$.runs', COALESCE(json_extract(stats, '$.runs'), 0) + 1,
             '$.eventsCreated', COALESCE(json_extract(stats, '$.eventsCreated'), 0) + ?,
             '$.lastFetched', ?),
           updated_at = ? WHERE id = ?`,
      )
      .bind(now, r.status, r.error ?? null, r.created ?? 0, r.fetched ?? 0, now, sourceId),
  ];
  // Only a successful run moves the cursor; a failed one retries from the same place next time.
  if (r.status === 'ok' && r.cursor !== undefined) {
    stmts.push(db.prepare('UPDATE sources SET cursor = ? WHERE id = ?').bind(r.cursor, sourceId));
  }
  await db.batch(stmts);
}

export class SourceRunWorkflow extends WorkflowEntrypoint<Env, SourceRunParams> {
  override async run(event: WorkflowEvent<SourceRunParams>, step: WorkflowStep) {
    const { sourceId } = event.payload;
    const runId = await step.do('start', () => startRun(this.env, sourceId, event.instanceId));
    try {
      const fetched = await step.do(
        'fetch',
        { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '2 minutes' },
        () => fetchAndStore(this.env, sourceId),
      );
      let created = 0;
      let updated = 0;
      for (let i = 0; i < fetched.itemIds.length; i += RESOLVE_BATCH) {
        const batch = fetched.itemIds.slice(i, i + RESOLVE_BATCH);
        const r = await step.do(
          `resolve ${i / RESOLVE_BATCH + 1}`,
          { retries: { limit: 2, delay: '10 seconds' } },
          () => resolveItems(this.env, sourceId, batch),
        );
        created += r.created;
        updated += r.updated;
      }
      await step.do('finish', () =>
        finishRun(this.env, runId, sourceId, {
          status: 'ok',
          cursor: fetched.cursor,
          fetched: fetched.fetched,
          newItems: fetched.newItems,
          created,
          updated,
        }),
      );
      return { fetched: fetched.fetched, newItems: fetched.newItems, created, updated };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await step.do('fail', () =>
        finishRun(this.env, runId, sourceId, { status: 'error', error: error.slice(0, 500) }),
      );
      throw err;
    }
  }
}
