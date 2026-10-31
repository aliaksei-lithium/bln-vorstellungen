import { Category, ExtractedEvent, berlinToday, cleanTitle, truncate } from '@bln/shared';
import { isUpcoming, looksFree } from '@bln/sources';
import {
  BudgetExhausted,
  ClaudeBudgetExhausted,
  MODELS,
  claudeUsd,
  claudeUsdLeft,
  isClaudeModel,
  neuronsFor,
  neuronsLeft,
  outputOf,
  recordNeurons,
  runModel,
  type ClaudeModel,
} from './models';
import * as prompt from './prompts/extract';
import { bumpUsage } from '../usage';

/**
 * LLM extraction (docs/03 step 2): Markdown/text → ExtractedEvent[]. The model's JSON is mapped and validated
 * here; anything that does not fit the shared schema is dropped, never stored half-valid.
 */

export type ExtractInput = {
  content: string;
  sourceName: string;
  url?: string;
  venue?: string;
  publishedAt?: string;
};

export type ExtractResult = {
  events: ExtractedEvent[];
  dropped: number;
  model: string;
  promptVersion: string;
  neurons: number;
  /** Claude spend in USD (0 on Workers AI). */
  usd: number;
  /** The model's own JSON before mapping, for the admin dry run. */
  raw: prompt.ModelEvent[];
};

/** Rough token estimate for the budget pre-check: ~3.5 characters per token for German/English prose. */
const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const local = (v: string | undefined) => {
  const s = v?.trim().replace(' ', 'T').slice(0, 16);
  return s && LOCAL.test(s) ? s : undefined;
};
const url = (v: string | undefined) => {
  try {
    return v && /^https?:\/\//.test(v) ? new URL(v).toString() : undefined;
  } catch {
    return undefined;
  }
};

/** "Literaturhaus Berlin, Fasanenstraße 23" → name + address, when the model folds the address into the name. */
function venueOf(name: string | undefined, address: string | undefined): ExtractedEvent['venue'] {
  const n = name?.trim();
  if (!n) return null;
  const a = address?.trim();
  if (a) return { name: n, address: a };
  const [first, ...rest] = n.split(',').map((x) => x.trim());
  return rest.length && /\d/.test(rest.join(' ')) ? { name: first!, address: rest.join(', ') } : { name: n };
}

export function toExtracted(m: prompt.ModelEvent, today = berlinToday()): ExtractedEvent | null {
  const occurrences = (m.dates ?? [])
    .map((d) => {
      const start = local(d.start);
      if (!start || !isUpcoming(start, today)) return null;
      const end = local(d.end);
      const doors = local(d.doors);
      return {
        start,
        ...(end && end > start ? { end } : {}),
        ...(doors && doors <= start ? { doorsAt: doors } : {}),
        ...(d.note?.trim() ? { note: truncate(d.note.trim(), 120) } : {}),
      };
    })
    .filter((o): o is NonNullable<typeof o> => !!o);
  const seen = new Set<string>();
  const unique = occurrences.filter((o) => !seen.has(o.start) && seen.add(o.start));
  // Backfill what the model tends to skip, from the text it quoted: "Doors 19:00" / "Einlass 19 Uhr".
  const evidence = `${m.quote ?? ''}\n${m.description ?? ''}`;
  const door = evidence.match(
    /\b(?:doors|einlass)\s*(?:open\s*)?(?:um\s*|at\s*|:\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr|h)?/i,
  );
  if (door && unique.length === 1 && !unique[0]!.doorsAt) {
    const doorsAt = `${unique[0]!.start.slice(0, 11)}${door[1]!.padStart(2, '0')}:${door[2] ?? '00'}`;
    if (doorsAt < unique[0]!.start) unique[0]!.doorsAt = doorsAt;
  }
  const given = (v: number | undefined) => (v !== undefined && v >= 0 ? v : undefined);
  // One stated price arrives as min or max only; treat it as both.
  const min = given(m.priceMin) ?? given(m.priceMax);
  const max = given(m.priceMax) ?? given(m.priceMin);
  const free = m.free === true || max === 0 || looksFree(evidence);
  const official = url(m.url);
  const tickets = url(m.ticketsUrl);
  const r = ExtractedEvent.safeParse({
    title: cleanTitle(m.title ?? ''),
    ...(m.description?.trim() ? { description: truncate(m.description.trim(), 2000) } : {}),
    lang: ['de', 'en'].includes(m.lang) ? m.lang : 'other',
    category: Category.safeParse(m.category).data ?? 'other',
    genres: (m.genres ?? []).filter((g) => typeof g === 'string' && g.trim()).slice(0, 5),
    occurrences: unique,
    venue: venueOf(m.venue, m.address),
    performers: (m.performers ?? [])
      .filter((p) => typeof p === 'string' && p.trim())
      .slice(0, 20)
      .map((name) => ({ name: name.trim() })),
    price: free
      ? { currency: 'EUR', free: true }
      : min !== undefined
        ? { currency: 'EUR', min, ...(max !== undefined && max >= min ? { max } : {}) }
        : null,
    urls: { ...(official ? { official } : {}), ...(tickets ? { tickets } : {}) },
    confidence: Math.min(1, Math.max(0, Number(m.confidence) || 0)),
    needsReview: (Number(m.confidence) || 0) < 0.6,
    sourceQuote: truncate(m.quote ?? '', 300),
  });
  return r.success ? r.data : null;
}

export type ExtractProvider = 'workers-ai' | ClaudeModel;

/** The configured extractor: `EXTRACT_MODEL` in wrangler.jsonc vars, Workers AI unless it names a Claude model. */
export const configuredProvider = (env: Env): ExtractProvider => {
  const m = env.EXTRACT_MODEL ?? '';
  return isClaudeModel(m) ? m : 'workers-ai';
};

type Attempt = { out: unknown; neurons: number; usd: number; model: string };

async function callWorkersAi(env: Env, system: string, user: string): Promise<Attempt> {
  const res = await runModel<{ response?: unknown; choices?: { message?: { content?: string | null } }[] }>(
    env,
    MODELS.extract.id,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 6000,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    },
  );
  const neurons = neuronsFor(MODELS.extract, res.usage, estimateTokens(system + user));
  await env.DB.batch([recordNeurons(env.DB, neurons), bumpUsage(env.DB, 'ai_extract_calls', 1)]);
  return { out: outputOf(res), neurons, usd: 0, model: MODELS.extract.id };
}

type ClaudeMessage = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Claude via AI Gateway in Anthropic Messages format. Structured outputs enforce the schema; effort `low` with
 * thinking off suits extraction (reading, not reasoning). The system prompt is marked cacheable: it is identical
 * across calls of a day.
 */
async function callClaude(env: Env, model: ClaudeModel, today: string, user: string): Promise<Attempt> {
  const res = await runModel<ClaudeMessage>(env, model, {
    max_tokens: 8000,
    system: [
      { type: 'text', text: prompt.system({ today, schemaInPrompt: false }), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: prompt.strictSchema } },
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this item');
  const usd = claudeUsd(model, res.usage);
  await env.DB.batch([
    bumpUsage(env.DB, 'claude_microusd', usd * 1e6),
    bumpUsage(env.DB, 'claude_calls', 1),
    bumpUsage(env.DB, 'ai_extract_calls', 1),
  ]);
  const text = (res.content ?? []).find((b) => b.type === 'text')?.text;
  return { out: text, neurons: 0, usd, model };
}

export async function extractEvents(
  env: Env,
  input: ExtractInput,
  opts: { today?: string; provider?: ExtractProvider } = {},
): Promise<ExtractResult> {
  const today = opts.today ?? berlinToday();
  const user = prompt.user(input, input.content);
  let provider = opts.provider ?? configuredProvider(env);
  if (provider !== 'workers-ai' && (await claudeUsdLeft(env)) <= 0) {
    console.warn(new ClaudeBudgetExhausted().message);
    provider = 'workers-ai';
  }

  const workersAi = async () => {
    const system = prompt.system({ today });
    const estimate = neuronsFor(MODELS.extract, {
      prompt_tokens: estimateTokens(system + user),
      completion_tokens: 2000,
    });
    if ((await neuronsLeft(env.DB)) < estimate) throw new BudgetExhausted();
    return callWorkersAi(env, system, user);
  };
  const call = async (): Promise<Attempt> => {
    if (provider === 'workers-ai') return workersAi();
    try {
      return await callClaude(env, provider, today, user);
    } catch (err) {
      // No key stored on the gateway, a refusal, or an outage: the free model still gets the item done.
      console.warn('extract: Claude failed, using Workers AI', String(err));
      provider = 'workers-ai';
      return workersAi();
    }
  };

  // Unusable JSON (not even complete events to salvage): one retry; a second failure is an error, so the item is
  // marked failed instead of silently yielding nothing.
  let attempt = await call();
  let neurons = attempt.neurons;
  let usd = attempt.usd;
  let parsed = parseResponse(attempt.out);
  if (parsed === null) {
    console.warn('extract: unparseable output, retrying', String(attempt.out).slice(-200));
    attempt = await call();
    neurons += attempt.neurons;
    usd += attempt.usd;
    parsed = parseResponse(attempt.out);
    if (parsed === null) throw new Error('Model output was not valid JSON twice');
  }
  const events = parsed.map((m) => toExtracted(m, today));
  const ok = events.filter((e): e is ExtractedEvent => !!e);
  return {
    events: ok,
    dropped: events.length - ok.length,
    model: attempt.model,
    promptVersion: prompt.version,
    neurons,
    usd,
    raw: parsed,
  };
}

/**
 * Models return either the object or a JSON string (sometimes fenced). A reply cut off at max_tokens keeps its
 * complete events (see `salvageEvents`). Null when nothing usable is there.
 */
export function parseResponse(r: unknown): prompt.ModelEvent[] | null {
  let v = r;
  if (typeof v === 'string') {
    const s = v.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      v = JSON.parse(s);
    } catch {
      return salvageEvents(s);
    }
  }
  const events = (v as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? (events.filter((e) => e && typeof e === 'object') as prompt.ModelEvent[]) : [];
}

/**
 * `{"events":[{…},{…},{…` → the complete events. Tracks depth outside strings and cuts after the last event
 * object that closed. A long programme page can produce more JSON than max_tokens allows.
 */
export function salvageEvents(s: string): prompt.ModelEvent[] | null {
  let depth = 0;
  let inString = false;
  let lastEventEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      // root object = 1, events array = 2, an event = 3 → closing an event brings depth back to 2
      if (ch === '}' && depth === 2) lastEventEnd = i;
    }
  }
  if (lastEventEnd < 0) return null;
  try {
    const events = (JSON.parse(`${s.slice(0, lastEventEnd + 1)}]}`) as { events?: unknown }).events;
    return Array.isArray(events) ? (events as prompt.ModelEvent[]) : null;
  } catch {
    return null;
  }
}
