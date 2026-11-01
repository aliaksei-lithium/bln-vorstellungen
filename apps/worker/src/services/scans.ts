import { ExtractedEvent, type Scan } from '@bln/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { extractEvents, extractFromImage, type ExtractResult } from '../ai/extract';
import { VisionUnavailable } from '../ai/llm';
import { BudgetExhausted } from '../ai/models';
import { sha256 } from '../auth';
import { VenueIndex, resolveEvent } from '../pipeline/resolve';

/**
 * Scans (docs/09, 2026-11-01): a photo or pasted text becomes candidate events that the user reviews. Creating a
 * scan stores the input and starts PhotoIngestWorkflow; the workflow reads it with the model; confirming resolves
 * the reviewed candidates like any source, so duplicates merge into existing events.
 */

/** Per user and UTC day; a dense photo costs about half a cent of Claude, the shared daily cap still applies. */
export const SCANS_PER_DAY = 40;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type ScanRow = {
  id: string;
  user_id: string;
  kind: 'photo' | 'text';
  raw_item_id: string;
  status: Scan['status'];
  candidates: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
};

/** Native `Uint8Array.toBase64` where the runtime has it (fast, no copies); chunked btoa otherwise. */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export type ScanInput =
  | { kind: 'photo'; bytes: ArrayBuffer; contentType: string; takenAt?: string; note?: string }
  | { kind: 'text'; text: string };

/** `start: false` leaves reading to the caller (the MCP tool reads inline instead of through the workflow). */
export async function createScan(
  env: Env,
  userId: string,
  input: ScanInput,
  now = new Date(),
  opts: { start?: boolean } = {},
): Promise<string> {
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scans WHERE user_id = ? AND created_at >= ?`)
    .bind(userId, now.toISOString().slice(0, 10))
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= SCANS_PER_DAY) {
    throw new HTTPException(429, { message: `That's ${SCANS_PER_DAY} scans today. Try again tomorrow.` });
  }
  const id = crypto.randomUUID();
  const rawItemId = crypto.randomUUID();
  const fetchedAt = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  if (input.kind === 'photo') {
    const key = `scans/${userId}/${id}`;
    await env.MEDIA.put(key, input.bytes, { httpMetadata: { contentType: input.contentType } });
    const uploadId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO uploads (id, user_id, r2_key, content_type, size, status) VALUES (?, ?, ?, ?, ?, 'processing')`,
      ).bind(uploadId, userId, key, input.contentType, input.bytes.byteLength),
      // The photo date rides in published_at; the user's note in content.
      env.DB.prepare(
        `INSERT INTO raw_items (id, upload_id, external_id, content_hash, kind, content, r2_key, published_at, fetched_at)
         VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?)`,
      ).bind(
        rawItemId,
        uploadId,
        id,
        await sha256(`${input.bytes.byteLength}:${key}`),
        input.note ?? null,
        key,
        input.takenAt ?? null,
        fetchedAt,
      ),
    );
  } else {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO raw_items (id, external_id, content_hash, kind, content, fetched_at) VALUES (?, ?, ?, 'text', ?, ?)`,
      ).bind(rawItemId, id, await sha256(input.text), input.text, fetchedAt),
    );
  }
  stmts.push(
    env.DB.prepare(`INSERT INTO scans (id, user_id, kind, raw_item_id) VALUES (?, ?, ?, ?)`).bind(
      id,
      userId,
      input.kind,
      rawItemId,
    ),
  );
  await env.DB.batch(stmts);
  if (opts.start !== false) await env.PHOTO_INGEST.create({ id, params: { scanId: id } });
  return id;
}

const setStatus = (db: D1Database, id: string, fields: Record<string, string | null>) => {
  const keys = Object.keys(fields);
  return db
    .prepare(
      `UPDATE scans SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .bind(...keys.map((k) => fields[k]), id)
    .run();
};

/** Reads one scan with the model and stores the candidates. Expected failures end as status `failed`. */
export async function runScan(env: Env, scanId: string): Promise<{ status: Scan['status']; events: number }> {
  const row = await env.DB.prepare(
    `SELECT s.status, s.kind, r.id AS raw_id, r.content, r.r2_key, r.published_at
       FROM scans s JOIN raw_items r ON r.id = s.raw_item_id WHERE s.id = ?`,
  )
    .bind(scanId)
    .first<{
      status: Scan['status'];
      kind: 'photo' | 'text';
      raw_id: string;
      content: string | null;
      r2_key: string | null;
      published_at: string | null;
    }>();
  if (!row) return { status: 'failed', events: 0 };
  if (row.status !== 'queued' && row.status !== 'reading') return { status: row.status, events: 0 };
  await setStatus(env.DB, scanId, { status: 'reading' });
  let r: ExtractResult;
  try {
    if (row.kind === 'photo') {
      const obj = await env.MEDIA.get(row.r2_key!);
      if (!obj) throw new Error('The photo is missing from storage.');
      r = await extractFromImage(
        env,
        {
          mediaType: obj.httpMetadata?.contentType ?? 'image/jpeg',
          data: toBase64(new Uint8Array(await obj.arrayBuffer())),
        },
        { takenAt: row.published_at ?? undefined, note: row.content ?? undefined },
      );
    } else {
      r = await extractEvents(env, { content: row.content ?? '', sourceName: 'Text pasted by a user' });
    }
  } catch (err) {
    const message =
      err instanceof VisionUnavailable || err instanceof BudgetExhausted
        ? err.message
        : 'Could not read this one. Try a sharper photo, or paste the text instead.';
    console.error('scan failed', { scanId, err: String(err) });
    await setStatus(env.DB, scanId, { status: 'failed', error: message });
    await env.DB.prepare(`UPDATE raw_items SET extraction_status = 'failed' WHERE id = ?`).bind(row.raw_id).run();
    return { status: 'failed', events: 0 };
  }
  // Ready but empty still needs a reason: a poster for a past date is the common case.
  const empty = r.events.length
    ? null
    : r.raw.length
      ? `Found ${r.raw.length === 1 ? 'an event' : `${r.raw.length} events`}, but no upcoming dates.`
      : `No dated events found in this ${row.kind === 'photo' ? 'photo' : 'text'}.`;
  await setStatus(env.DB, scanId, {
    status: 'ready',
    error: empty,
    candidates: JSON.stringify(r.events),
    model: r.model,
    prompt_version: r.promptVersion,
  });
  await env.DB.prepare(`UPDATE raw_items SET extraction_status = 'done' WHERE id = ?`).bind(row.raw_id).run();
  return { status: 'ready', events: r.events.length };
}

const ScanResult = z.object({
  added: z.number(),
  merged: z.number(),
  events: z.array(z.object({ slug: z.string(), title: z.string(), created: z.boolean() })),
});

export async function getScan(db: D1Database, userId: string, id: string): Promise<Scan> {
  const row = await db.prepare(`SELECT * FROM scans WHERE id = ? AND user_id = ?`).bind(id, userId).first<ScanRow>();
  if (!row) throw new HTTPException(404, { message: 'Scan not found' });
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    candidates: z
      .array(ExtractedEvent)
      .catch([])
      .parse(JSON.parse(row.candidates ?? '[]')),
    result: row.result ? ScanResult.parse(JSON.parse(row.result)) : null,
    error: row.error,
  };
}

/** The user's photo, for the review page. */
export async function scanImage(env: Env, userId: string, id: string): Promise<R2ObjectBody> {
  const row = await env.DB.prepare(
    `SELECT r.r2_key FROM scans s JOIN raw_items r ON r.id = s.raw_item_id WHERE s.id = ? AND s.user_id = ?`,
  )
    .bind(id, userId)
    .first<{ r2_key: string | null }>();
  const obj = row?.r2_key ? await env.MEDIA.get(row.r2_key) : null;
  if (!obj) throw new HTTPException(404, { message: 'No photo for this scan' });
  return obj;
}

/** Adds the reviewed events. Each goes through the same resolve step as sources: a known event gains dates. */
export async function confirmScan(
  env: Env,
  userId: string,
  id: string,
  events: ExtractedEvent[],
): Promise<NonNullable<Scan['result']>> {
  const row = await env.DB.prepare(
    `SELECT status, raw_item_id, model, prompt_version FROM scans WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<{ status: Scan['status']; raw_item_id: string; model: string | null; prompt_version: string | null }>();
  if (!row) throw new HTTPException(404, { message: 'Scan not found' });
  if (row.status === 'done') throw new HTTPException(409, { message: 'These events were already added.' });
  if (row.status !== 'ready') throw new HTTPException(409, { message: 'This scan is not ready yet.' });
  const venues = await VenueIndex.load(env.DB);
  const touched: { id: string; created: boolean }[] = [];
  for (const ev of events) {
    const r = await resolveEvent(env.DB, venues, ev, {
      rawItemId: row.raw_item_id,
      model: row.model ?? 'unknown',
      promptVersion: row.prompt_version,
      createdBy: `user:${userId}`,
    });
    touched.push({ id: r.eventId, created: r.created });
  }
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title FROM events WHERE id IN (${touched.map(() => '?').join(',')})`,
  )
    .bind(...touched.map((t) => t.id))
    .all<{ id: string; slug: string; title: string }>();
  const byId = new Map(results.map((e) => [e.id, e]));
  const result = {
    added: touched.filter((t) => t.created).length,
    merged: touched.filter((t) => !t.created).length,
    events: touched.flatMap((t) => {
      const e = byId.get(t.id);
      return e ? [{ slug: e.slug, title: e.title, created: t.created }] : [];
    }),
  };
  await setStatus(env.DB, id, { status: 'done', result: JSON.stringify(result) });
  return result;
}
