import { EventsList } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { cosine, quantize } from '../src/ai/embed';
import { parseResponse, toExtracted } from '../src/ai/extract';
import { MODELS } from '../src/ai/models';
import { nearest, rebuildIndex, type VectorIndex } from '../src/ai/vector-index';
import { refreshAllNextDates } from '../src/pipeline/next-dates';
import { extractItem } from '../src/pipeline/source-run';

const DAY = 86_400_000;
const plus = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('toExtracted', () => {
  it('maps model output to the shared schema and drops what does not fit', () => {
    const e = toExtracted({
      title: 'Lesung &amp; Gespräch',
      lang: 'de',
      category: 'poetry',
      dates: [
        { start: `${plus(3)}T19:30`, doors: `${plus(3)}T19:00`, note: 'Saal' },
        { start: `${plus(3)}T19:30` },
        { start: '2020-01-01T19:30' },
        { start: 'next friday' },
      ],
      venue: 'Literaturhaus Berlin, Fasanenstraße 23',
      priceMin: 5,
      priceMax: -1,
      url: 'not a url',
      confidence: 0.4,
      quote: 'Am Freitag …',
    });
    expect(e).toMatchObject({
      title: 'Lesung & Gespräch',
      category: 'other',
      occurrences: [{ start: `${plus(3)}T19:30`, doorsAt: `${plus(3)}T19:00`, note: 'Saal' }],
      venue: { name: 'Literaturhaus Berlin', address: 'Fasanenstraße 23' },
      price: { currency: 'EUR', min: 5, max: 5 },
      urls: {},
      needsReview: true,
    });
  });

  it('rejects an event left without upcoming dates', () => {
    expect(
      toExtracted({
        title: 'Old',
        lang: 'en',
        category: 'talk',
        dates: [{ start: '2020-01-01T10:00' }],
        venue: '',
        confidence: 1,
        quote: '',
      }),
    ).toBeNull();
  });

  it('parses objects, JSON strings and fenced JSON', () => {
    expect(parseResponse({ events: [{ title: 'a' }] })).toHaveLength(1);
    expect(parseResponse('```json\n{"events":[{"title":"a"},{"title":"b"}]}\n```')).toHaveLength(2);
    expect(parseResponse('sorry, no')).toBeNull();
    expect(parseResponse({ nope: 1 })).toEqual([]);
    // Cut off at max_tokens: the complete events survive.
    const cut = '{"events":[{"title":"A","quote":"x \\" }"},{"title":"B"},{"title":"C","dates":[{"start":"2026-';
    expect(parseResponse(cut)?.map((e) => e.title)).toEqual(['A', 'B']);
  });
});

describe('vectors', () => {
  it('quantizes to unit int8 vectors whose dot product is the cosine', () => {
    const a = quantize([3, 4, 0]);
    expect(cosine(a, quantize([6, 8, 0]))).toBeCloseTo(1, 2);
    expect(cosine(a, quantize([0, 0, 5]))).toBeCloseTo(0, 2);
  });

  it('ranks nearest ids above a floor, excluding the query item', () => {
    const vecs = [quantize([1, 0, 0]), quantize([0.9, 0.1, 0]), quantize([0, 1, 0])];
    const index: VectorIndex = {
      model: 'test',
      dims: 3,
      ids: ['a', 'b', 'c'],
      builtAt: '',
      data: Int8Array.from(vecs.flatMap((v) => [...v])),
    };
    expect(nearest(index, vecs[0]!, 5, { exclude: 'a', min: 0.5 }).map((h) => h.id)).toEqual(['b']);
  });
});

const fakeAi = (events: unknown[]) =>
  ({
    ...env,
    AI: {
      run: async () => ({
        choices: [{ message: { content: JSON.stringify({ events }) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, neurons: 12.5 },
      }),
    },
  }) as unknown as Env;

describe('extractItem (LLM path)', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, name, type, config, schedule_minutes) VALUES
           ('s_be', 'Berliner Ensemble', 'html', '{"url":"https://be.example/spielplan","venue":{"name":"Berliner Ensemble","address":"Bertolt-Brecht-Platz 1, 10117 Berlin"}}', 1440)`,
      ),
      env.DB.prepare(
        `INSERT INTO raw_items (id, source_id, external_id, content_hash, kind, content, url, fetched_at) VALUES
           ('raw-be-1', 's_be', 'https://be.example/spielplan#1', 'h1', 'markdown', 'Fr Hamlet 19:30 Großes Haus', 'https://be.example/spielplan', '2026-10-31T00:00:00Z'),
           ('raw-be-2', 's_be', 'https://be.example/spielplan#2', 'h2', 'markdown', 'Sa Faust', 'https://be.example/spielplan', '2026-10-31T00:00:00Z')`,
      ),
    ]);
  });

  it('extracts, resolves with provenance and keeps the room as the date note', async () => {
    const ai = fakeAi([
      {
        title: 'Hamlet',
        lang: 'de',
        category: 'theatre',
        dates: [{ start: `${plus(2)}T19:30` }, { start: `${plus(5)}T19:30` }],
        venue: 'Berliner Ensemble, Großes Haus',
        confidence: 0.95,
        quote: 'Fr Hamlet 19:30',
      },
    ]);
    expect(await extractItem(ai, 's_be', 'raw-be-1')).toMatchObject({ created: 1, updated: 0, failed: 0, neurons: 13 });
    const row = await env.DB.prepare(
      `SELECT e.title, v.name AS venue, MIN(o.note) AS note, COUNT(o.id) AS dates, es.model, es.prompt_version
         FROM events e JOIN venues v ON v.id = e.venue_id JOIN occurrences o ON o.event_id = e.id
         JOIN event_sources es ON es.event_id = e.id WHERE e.title = 'Hamlet'`,
    ).first();
    expect(row).toEqual({
      title: 'Hamlet',
      venue: 'Berliner Ensemble',
      note: 'Berliner Ensemble, Großes Haus',
      dates: 2,
      model: MODELS.extract.id,
      prompt_version: 'extract@4',
    });
    const item = await env.DB.prepare(`SELECT extraction_status FROM raw_items WHERE id = 'raw-be-1'`).first();
    expect(item).toEqual({ extraction_status: 'done' });
  });

  it('leaves the item pending when the daily neuron budget is spent', async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO usage_counters (day, metric, value) VALUES (?, 'ai_neurons', 8000)`)
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    const r = await extractItem(fakeAi([]), 's_be', 'raw-be-2');
    expect(r.budgetExhausted).toBe(true);
    const item = await env.DB.prepare(`SELECT extraction_status FROM raw_items WHERE id = 'raw-be-2'`).first();
    expect(item).toEqual({ extraction_status: 'pending' });
  });
});

describe('similar events', () => {
  it('ranks upcoming events from the KV vector index', async () => {
    const vec = (xs: number[]) => {
      const v = new Array<number>(MODELS.embed.dims).fill(0);
      xs.forEach((x, i) => (v[i] = x));
      return quantize(v).buffer;
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by) VALUES
           ('s1', 'jazz-a', 'Jazz A', 'en', 'concert', 'ja', 't'), ('s2', 'jazz-b', 'Jazz B', 'en', 'concert', 'jb', 't'),
           ('s3', 'opera-c', 'Opera C', 'de', 'opera', 'oc', 't')`,
      ),
      ...['s1', 's2', 's3'].map((id, i) =>
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `occ-${id}`,
          id,
          `${plus(i + 1)}T20:00`,
          `${plus(i + 1)}T19:00:00.000Z`,
        ),
      ),
      ...[
        ['s1', [1, 0.1]],
        ['s2', [1, 0.2]],
        ['s3', [0, 1]],
      ].map(([id, xs]) =>
        env.DB.prepare(
          `INSERT INTO event_embeddings (event_id, model, dims, vector, text_hash) VALUES (?, ?, ?, ?, 'x')`,
        ).bind(id, `${MODELS.embed.id}#int8`, MODELS.embed.dims, vec(xs as number[])),
      ),
    ]);
    await refreshAllNextDates(env.DB);
    expect(await rebuildIndex(env, new Date(), true)).toBe(3);
    const res = await exports.default.fetch('https://x/api/events/jazz-a/similar');
    expect(EventsList.parse(await res.json()).items.map((i) => i.slug)).toEqual(['jazz-b']);
  });
});

describe('Claude provider', () => {
  it('sends a closed schema for structured outputs', async () => {
    const { strictSchema } = await import('../src/ai/prompts/extract');
    const s = strictSchema as {
      additionalProperties: boolean;
      properties: { events: { items: Record<string, unknown> } };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.events.items.additionalProperties).toBe(false);
  });

  it('meters Claude in dollars and falls back to Workers AI when the gateway refuses', async () => {
    const { extractEvents } = await import('../src/ai/extract');
    const calls: string[] = [];
    const ai = {
      ...env,
      AI: {
        run: async (model: string) => {
          calls.push(model);
          if (model.startsWith('anthropic/')) throw new Error('2021: Insufficient AI Gateway credits');
          return {
            choices: [{ message: { content: JSON.stringify({ events: [] }) } }],
            usage: { neurons: 1 },
          };
        },
      },
    } as unknown as Env;
    await env.DB.prepare(`DELETE FROM usage_counters`).run();
    const r = await extractEvents(ai, { content: 'x', sourceName: 't' }, { provider: 'anthropic/claude-haiku-5.5' });
    expect(calls).toEqual(['anthropic/claude-haiku-5.5', MODELS.extract.id]);
    expect(r.model).toBe(MODELS.extract.id);

    const claude = {
      ...env,
      AI: {
        run: async () => ({
          content: [{ type: 'text', text: '{"events":[]}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        }),
      },
    } as unknown as Env;
    const c = await extractEvents(
      claude,
      { content: 'x', sourceName: 't' },
      { provider: 'anthropic/claude-haiku-5.5' },
    );
    expect(c).toMatchObject({ model: 'anthropic/claude-haiku-5.5', usd: 0.1, neurons: 0 });
  });
});
