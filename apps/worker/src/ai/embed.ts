import { MODELS, neuronsFor, recordNeurons, runModel } from './models';
import { bumpUsage } from '../usage';

/**
 * Event embeddings (docs/05) with Workers AI bge-m3, stored L2-normalized and quantized to int8 (1 KB per event
 * instead of 4 KB). Cosine on int8 is a plain integer dot product; ranking quality is unaffected at this scale.
 */

export const EMBED_MODEL_TAG = `${MODELS.embed.id}#int8`;
const DIMS = MODELS.embed.dims;

export function quantize(v: ArrayLike<number>): Int8Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((v[i]! / norm) * 127)));
  return out;
}

/** Cosine similarity of two quantized unit vectors, in [-1, 1]. */
export function cosine(a: Int8Array, b: Int8Array, bOffset = 0): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[bOffset + i]!;
  return dot / (127 * 127);
}

export async function embedTexts(env: Env, texts: string[]): Promise<Int8Array[]> {
  if (!texts.length) return [];
  const res = await runModel<{ data?: number[][] }>(env, MODELS.embed.id, { text: texts });
  const data = res.data ?? [];
  if (data.length !== texts.length || data.some((d) => d.length !== DIMS))
    throw new Error('Unexpected embedding shape');
  const tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 3.5), 0);
  await env.DB.batch([
    recordNeurons(env.DB, neuronsFor(MODELS.embed, res.usage, tokens)),
    bumpUsage(env.DB, 'ai_embed_texts', texts.length),
  ]);
  return data.map(quantize);
}

type EventText = {
  id: string;
  title: string;
  category: string;
  description: string | null;
  venue: string | null;
  performers: string | null;
};

/** What an event "is about": title first, then kind, place, people and the start of the description. */
export const eventText = (e: EventText): string =>
  [e.title, e.category, e.venue, e.performers, e.description?.slice(0, 600)].filter(Boolean).join('\n');

/**
 * Embeds upcoming published events that have no embedding yet. Called from the cron; bounded per tick so one
 * invocation stays small. Returns how many were embedded.
 */
export async function embedMissing(env: Env, now = new Date(), limit = 32): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.category, e.description, v.name AS venue,
            (SELECT group_concat(p.name, ', ') FROM event_performers ep JOIN performers p ON p.id = ep.performer_id
              WHERE ep.event_id = e.id) AS performers
       FROM events e INDEXED BY events_next_idx
       LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.next_start_utc >= ? AND e.status = 'published'
        AND NOT EXISTS (SELECT 1 FROM event_embeddings ee WHERE ee.event_id = e.id)
      ORDER BY e.next_start_utc
      LIMIT ?`,
  )
    .bind(now.toISOString(), limit)
    .all<EventText>();
  if (!results.length) return 0;
  const texts = results.map(eventText);
  const vectors = await embedTexts(env, texts);
  const hashes = await Promise.all(texts.map(sha256));
  await env.DB.batch(
    results.map((e, i) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO event_embeddings (event_id, model, dims, vector, text_hash) VALUES (?, ?, ?, ?, ?)`,
      ).bind(e.id, EMBED_MODEL_TAG, DIMS, vectors[i]!.buffer, hashes[i]),
    ),
  );
  return results.length;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
