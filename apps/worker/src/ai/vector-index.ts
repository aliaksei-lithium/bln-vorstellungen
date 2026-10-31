import { cosine, EMBED_MODEL_TAG } from './embed';
import { MODELS } from './models';

/**
 * All upcoming events' vectors packed into one KV value (no Vectorize on the free plan, docs/09). "Similar" and
 * semantic search read it once per isolate and scan it in memory: 1,000 events × 1 KB, a few ms of CPU, and zero
 * D1 rows. The cron rebuilds it when embeddings changed or it is older than MAX_AGE.
 */

const META_KEY = 'vec:v1:meta';
const DATA_KEY = 'vec:v1:data';
const MAX_AGE_MS = 6 * 3_600_000;
const DIMS = MODELS.embed.dims;

type Meta = { model: string; dims: number; ids: string[]; builtAt: string };
export type VectorIndex = Meta & { data: Int8Array };

let cached: { index: VectorIndex; loadedAt: number } | null = null;

export async function loadIndex(kv: KVNamespace): Promise<VectorIndex | null> {
  if (cached && Date.now() - cached.loadedAt < 10 * 60_000) return cached.index;
  const [meta, buf] = await Promise.all([kv.get<Meta>(META_KEY, 'json'), kv.get(DATA_KEY, 'arrayBuffer')]);
  if (!meta || !buf || buf.byteLength !== meta.ids.length * meta.dims) return null;
  cached = { index: { ...meta, data: new Int8Array(buf) }, loadedAt: Date.now() };
  return cached.index;
}

export async function rebuildIndex(env: Env, now = new Date(), force = false): Promise<number | null> {
  const meta = await env.CACHE.get<Meta>(META_KEY, 'json');
  const stale = await env.CACHE.get('vec:v1:stale');
  if (!force && meta && !stale && now.getTime() - Date.parse(meta.builtAt) < MAX_AGE_MS) return null;

  const { results } = await env.DB.prepare(
    `SELECT ee.event_id, ee.vector FROM events e INDEXED BY events_next_idx
       JOIN event_embeddings ee ON ee.event_id = e.id AND ee.model = ?
      WHERE e.next_start_utc >= ? AND e.status = 'published'
      ORDER BY e.next_start_utc LIMIT 3000`,
  )
    .bind(EMBED_MODEL_TAG, now.toISOString())
    .all<{ event_id: string; vector: ArrayBuffer | number[] }>();
  const data = new Int8Array(results.length * DIMS);
  // D1 hands blobs back as ArrayBuffer or as a byte array, depending on the runtime; Int8Array takes both.
  results.forEach((r, i) => data.set(new Int8Array(r.vector), i * DIMS));
  const next: Meta = {
    model: EMBED_MODEL_TAG,
    dims: DIMS,
    ids: results.map((r) => r.event_id),
    builtAt: now.toISOString(),
  };
  // Data first: a reader that sees the new meta must find matching data (length is checked on load).
  await env.CACHE.put(DATA_KEY, data.buffer);
  await env.CACHE.put(META_KEY, JSON.stringify(next));
  await env.CACHE.delete('vec:v1:stale');
  cached = null;
  return results.length;
}

export const markIndexStale = (kv: KVNamespace) => kv.put('vec:v1:stale', '1');

/** Top matches for a query vector, best first, above a floor so unrelated events are not padded in. */
export function nearest(index: VectorIndex, q: Int8Array, k: number, opts: { exclude?: string; min?: number } = {}) {
  const scored: { id: string; score: number }[] = [];
  for (let i = 0; i < index.ids.length; i++) {
    const id = index.ids[i]!;
    if (id === opts.exclude) continue;
    const score = cosine(q, index.data, i * index.dims);
    if (score >= (opts.min ?? 0)) scored.push({ id, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

export function vectorOf(index: VectorIndex, id: string): Int8Array | null {
  const i = index.ids.indexOf(id);
  return i < 0 ? null : index.data.subarray(i * index.dims, (i + 1) * index.dims);
}
