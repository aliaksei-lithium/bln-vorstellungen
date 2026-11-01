import { Category, ExtractedEvent, berlinToday, cleanTitle, truncate } from '@bln/shared';
import { isUpcoming, looksFree } from '@bln/sources';
import { callJson, providerFrom, type LlmProvider } from './llm';
import * as prompt from './prompts/extract';
import * as photo from './prompts/photo';

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
  // A title that is only the venue's name says nothing; the first act names the night better.
  const venue = venueOf(m.venue, m.address);
  const acts = (m.performers ?? []).filter((p) => typeof p === 'string' && p.trim());
  const rawTitle = cleanTitle(m.title ?? '');
  const title =
    venue && acts.length && rawTitle.toLowerCase() === venue.name.toLowerCase() ? cleanTitle(acts[0]!) : rawTitle;
  const r = ExtractedEvent.safeParse({
    title,
    ...(m.description?.trim() ? { description: truncate(m.description.trim(), 2000) } : {}),
    lang: ['de', 'en'].includes(m.lang) ? m.lang : 'other',
    category: Category.safeParse(m.category).data ?? 'other',
    genres: (m.genres ?? []).filter((g) => typeof g === 'string' && g.trim()).slice(0, 5),
    occurrences: unique,
    venue,
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

export type ExtractProvider = LlmProvider;

/** The configured extractor: `EXTRACT_MODEL` in wrangler.jsonc vars, Workers AI unless it names a Claude model. */
export const configuredProvider = (env: Env): ExtractProvider => providerFrom(env.EXTRACT_MODEL);

export async function extractEvents(
  env: Env,
  input: ExtractInput,
  opts: { today?: string; provider?: ExtractProvider } = {},
): Promise<ExtractResult> {
  const today = opts.today ?? berlinToday();
  const r = await callJson(env, {
    provider: opts.provider ?? configuredProvider(env),
    system: prompt.system({ today }),
    user: prompt.user(input, input.content),
    schema: prompt.strictSchema,
    parse: parseResponse,
    maxTokens: 6000,
    metric: 'ai_extract_calls',
  });
  const events = r.value.map((m) => toExtracted(m, today));
  const ok = events.filter((e): e is ExtractedEvent => !!e);
  return {
    events: ok,
    dropped: events.length - ok.length,
    model: r.model,
    promptVersion: prompt.version,
    neurons: r.neurons,
    usd: r.usd,
    raw: r.value,
  };
}

/**
 * A photo (poster, flyer, magazine page, listing) → ExtractedEvent[], through Claude vision only. Dense listings can
 * hold 60 events, hence the large output budget; the reply is mapped exactly like the text path.
 */
export async function extractFromImage(
  env: Env,
  image: { mediaType: string; data: string },
  opts: { today?: string; takenAt?: string; note?: string } = {},
): Promise<ExtractResult> {
  const today = opts.today ?? berlinToday();
  // The photo date anchors day-only dates ("Wed 4"); a photo from last month still means last month's listing.
  const anchor = opts.takenAt && opts.takenAt < today ? opts.takenAt : today;
  const r = await callJson(env, {
    provider: configuredProvider(env),
    system: photo.system({ today: anchor }),
    user: photo.user({ takenAt: opts.takenAt, note: opts.note }),
    images: [image],
    schema: prompt.strictSchema,
    parse: parseResponse,
    maxTokens: 20000,
    metric: 'ai_extract_calls',
  });
  const events = r.value.map((m) => toExtracted(m, today));
  const ok = events.filter((e): e is ExtractedEvent => !!e);
  return {
    events: ok,
    dropped: events.length - ok.length,
    model: r.model,
    promptVersion: photo.version,
    neurons: r.neurons,
    usd: r.usd,
    raw: r.value,
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
