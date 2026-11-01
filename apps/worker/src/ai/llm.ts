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
import { bumpUsage, type Metric } from '../usage';

/**
 * One JSON-producing LLM call with the project's rules: Claude through AI Gateway when configured (structured
 * outputs), Workers AI otherwise or as the fallback (json_object mode, schema in the prompt), budgets checked
 * before and metered after, one retry when the output is unusable.
 */

export type LlmProvider = 'workers-ai' | ClaudeModel;

export const providerFrom = (value: string | undefined): LlmProvider =>
  value && isClaudeModel(value) ? value : 'workers-ai';

export type JsonCall<T> = {
  provider: LlmProvider;
  /** Instructions without the schema; the Workers AI path appends the schema, Claude enforces it while decoding. */
  system: string;
  user: string;
  /** Closed JSON Schema (additionalProperties: false on every object) of the reply. */
  schema: Record<string, unknown>;
  /** Turns the model's output into a result, or null when it is unusable (triggers the one retry). */
  parse: (output: unknown) => T | null;
  maxTokens?: number;
  /** Usage counter bumped once per model call, e.g. ai_extract_calls. */
  metric: Metric;
  /** Images sent before the text (photos of posters). Claude only: there is no free fallback for them. */
  images?: { mediaType: string; data: string }[];
  /** Overrides the default `low` effort, for harder inputs such as dense photos. */
  effort?: 'low' | 'medium' | 'high';
};

/** A call with images when Claude is unavailable (no key, refusal, outage) or its daily budget is spent. */
export class VisionUnavailable extends Error {
  constructor(reason: string) {
    super(`Reading photos needs Claude, which is unavailable right now (${reason}). Try again later.`);
  }
}

export type JsonResult<T> = { value: T; model: string; neurons: number; usd: number };

type Attempt = { out: unknown; neurons: number; usd: number; model: string };

const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/** The schema as an instruction, for models without constrained decoding. */
export const schemaInstruction = (schema: Record<string, unknown>) =>
  `\n\nReply with one JSON object only, following this JSON Schema:\n${JSON.stringify(schema)}`;

async function workersAi(env: Env, system: string, user: string, maxTokens: number, metric: Metric): Promise<Attempt> {
  const estimate = neuronsFor(MODELS.extract, {
    prompt_tokens: estimateTokens(system + user),
    completion_tokens: Math.min(maxTokens, 2000),
  });
  if ((await neuronsLeft(env.DB)) < estimate) throw new BudgetExhausted();
  const res = await runModel<{ response?: unknown; choices?: { message?: { content?: string | null } }[] }>(
    env,
    MODELS.extract.id,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    },
  );
  const neurons = neuronsFor(MODELS.extract, res.usage, estimateTokens(system + user));
  await env.DB.batch([recordNeurons(env.DB, neurons), bumpUsage(env.DB, metric, 1)]);
  return { out: outputOf(res), neurons, usd: 0, model: MODELS.extract.id };
}

type ClaudeMessage = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

async function claude(env: Env, model: ClaudeModel, req: JsonCall<unknown>, maxTokens: number): Promise<Attempt> {
  const { system, user, schema, metric } = req;
  const content = req.images?.length
    ? [
        ...req.images.map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mediaType, data: i.data },
        })),
        { type: 'text', text: user },
      ]
    : user;
  const res = await runModel<ClaudeMessage>(env, model, {
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    thinking: { type: 'disabled' },
    output_config: { effort: req.effort ?? 'low', format: { type: 'json_schema', schema } },
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
  const usd = claudeUsd(model, res.usage);
  await env.DB.batch([
    bumpUsage(env.DB, 'claude_microusd', usd * 1e6),
    bumpUsage(env.DB, 'claude_calls', 1),
    bumpUsage(env.DB, metric, 1),
  ]);
  return { out: (res.content ?? []).find((b) => b.type === 'text')?.text, neurons: 0, usd, model };
}

export async function callJson<T>(env: Env, req: JsonCall<T>): Promise<JsonResult<T>> {
  const maxTokens = req.maxTokens ?? 6000;
  let provider = req.provider;
  const vision = !!req.images?.length;
  if (vision && provider === 'workers-ai') throw new VisionUnavailable('no Claude model configured');
  if (provider !== 'workers-ai' && (await claudeUsdLeft(env)) <= 0) {
    if (vision) throw new VisionUnavailable('the daily AI budget is used up');
    console.warn(new ClaudeBudgetExhausted().message);
    provider = 'workers-ai';
  }
  const once = async (): Promise<Attempt> => {
    if (provider === 'workers-ai') {
      return workersAi(env, req.system + schemaInstruction(req.schema), req.user, maxTokens, req.metric);
    }
    try {
      return await claude(env, provider, req as JsonCall<unknown>, maxTokens);
    } catch (err) {
      if (vision) throw new VisionUnavailable(String(err).slice(0, 120));
      // No key stored on the gateway, a refusal, or an outage: the free model still gets the job done.
      console.warn(`${req.metric}: Claude failed, using Workers AI`, String(err));
      provider = 'workers-ai';
      return once();
    }
  };

  let attempt = await once();
  let neurons = attempt.neurons;
  let usd = attempt.usd;
  let value = req.parse(attempt.out);
  if (value === null) {
    console.warn(`${req.metric}: unusable output, retrying`, String(attempt.out).slice(-200));
    attempt = await once();
    neurons += attempt.neurons;
    usd += attempt.usd;
    value = req.parse(attempt.out);
    if (value === null) throw new Error('Model output was not usable twice');
  }
  return { value, model: attempt.model, neurons, usd };
}
