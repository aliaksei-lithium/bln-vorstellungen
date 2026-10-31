import { bumpUsage, usageToday } from '../usage';

/**
 * Workers AI models (docs/05). Free tier = 10,000 neurons a day; the rates below come from the Workers AI pricing
 * page (2026-10-31) and are used to meter our own spend before Cloudflare would refuse it.
 */
export const MODELS = {
  /**
   * Event extraction from Markdown. JSON-schema output, 256k context, multilingual. Thinking off: with it on, a
   * two-event test took 16 s and 18 neurons instead of 2 s and 3 neurons, for the same answer.
   */
  extract: { id: '@cf/google/gemma-4-26b-a4b-it', neuronsPerMIn: 9091, neuronsPerMOut: 27273 },
  /** Event and query embeddings. Multilingual (German + English), 1024 dims. */
  embed: { id: '@cf/baai/bge-m3', neuronsPerMIn: 1075, dims: 1024 },
} as const;

/** What our own code may spend per UTC day; the rest of the 10k stays as headroom. */
export const DAILY_NEURON_BUDGET = 8000;

export class BudgetExhausted extends Error {
  constructor() {
    super('Daily Workers AI budget used up; pending items wait for tomorrow.');
  }
}

export async function neuronsLeft(db: D1Database): Promise<number> {
  return DAILY_NEURON_BUDGET - ((await usageToday(db)).ai_neurons ?? 0);
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; neurons?: number };
type Chat = { choices?: { message?: { content?: string | null } }[] };

/** env.AI.run through the auto-created `default` AI Gateway (logs, analytics), typed loosely for newer model ids. */
export async function runModel<T>(
  env: Env,
  model: string,
  input: Record<string, unknown>,
): Promise<T & { usage?: Usage }> {
  const run = env.AI.run.bind(env.AI) as unknown as (
    m: string,
    i: unknown,
    o: unknown,
  ) => Promise<T & { usage?: Usage }>;
  return run(model, input, { gateway: { id: 'default' } });
}

/** Neurons as reported by Workers AI when present, else computed from token counts and the model's rates. */
export const neuronsFor = (
  rates: { neuronsPerMIn: number; neuronsPerMOut?: number },
  u: Usage | undefined,
  fallbackIn = 0,
) =>
  u?.neurons ??
  ((u?.prompt_tokens ?? fallbackIn) * rates.neuronsPerMIn + (u?.completion_tokens ?? 0) * (rates.neuronsPerMOut ?? 0)) /
    1e6;

/** Text output of a chat model: `response` on older models, OpenAI-style `choices` on newer ones. */
export const outputOf = (r: { response?: unknown } & Chat): unknown => r.response ?? r.choices?.[0]?.message?.content;

export const recordNeurons = (db: D1Database, neurons: number) => bumpUsage(db, 'ai_neurons', Math.ceil(neurons));
