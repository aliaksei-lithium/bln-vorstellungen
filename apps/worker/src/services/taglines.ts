import { htmlToText } from '@bln/shared';
import { callJson, providerFrom } from '../ai/llm';
import * as prompt from '../ai/prompts/tagline';

/**
 * Taglines (docs/09, 2026-11-03): one line per upcoming event on what it is, written once from its description and
 * kept with its model and prompt version. The cron writes a few batches each run, soonest events first; an event
 * without a real description gets none (it would be guessed). About $0.02 per 1,000 events with Claude Haiku.
 */

export const PER_CALL = 20;
export const PER_RUN = 40;
/** A description shorter than this is a ticket note or a link, not something to describe. */
const MIN_TEXT = 40;
const TEXT_CHARS = 400;

type Row = {
  id: string;
  title: string;
  category: string;
  venue: string | null;
  genres: string;
  description: string;
};

/** Writes taglines for upcoming events that have a description and none yet. Returns how many got one. */
export async function writeTaglines(env: Env, now = new Date(), limit = PER_RUN): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.category, v.name AS venue, e.genres,
            COALESCE(e.description_en, e.description) AS description
       FROM events e LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.status = 'published' AND e.next_start_utc IS NOT NULL AND e.tagline_checked_at IS NULL
        AND length(COALESCE(e.description_en, e.description)) >= ?
      ORDER BY e.next_start_utc LIMIT ?`,
  )
    .bind(MIN_TEXT, limit)
    .all<Row>();
  let written = 0;
  for (let i = 0; i < results.length; i += PER_CALL) {
    const batch = results.slice(i, i + PER_CALL);
    const r = await callJson(env, {
      provider: providerFrom(env.SCORE_MODEL),
      system: prompt.system,
      user: prompt.user(
        batch.map((e) => ({
          title: e.title,
          category: e.category,
          venue: e.venue,
          genres: (JSON.parse(e.genres || '[]') as string[]).slice(0, 4),
          text: htmlToText(e.description).replace(/\s+/g, ' ').slice(0, TEXT_CHARS),
        })),
      ),
      schema: prompt.schema,
      parse: (out) => prompt.parse(out, batch.length),
      maxTokens: 1500,
      metric: 'ai_tagline_calls',
    });
    const at = now.toISOString();
    await env.DB.batch(
      batch.map((e, k) => {
        const line = r.value.get(k + 1) ?? null;
        if (line) written++;
        return env.DB.prepare(
          `UPDATE events SET tagline = ?, tagline_model = ?, tagline_prompt = ?, tagline_checked_at = ? WHERE id = ?`,
        ).bind(line, line ? r.model : null, line ? prompt.version : null, at, e.id);
      }),
    );
  }
  return written;
}
