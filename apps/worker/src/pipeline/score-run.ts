import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { LLM_BATCH, scoreByRules, scoreWithLlm } from '../ai/score';

export type ScoreParams = { userId: string };

/**
 * ScoreEvents (docs/08 phase 2): rules + embeddings for every unscored upcoming event of one user, then the LLM
 * for the best candidates in small batches. Started by the cron when new events were embedded and by a profile
 * save. An LLM batch that fails leaves the rule-based scores in place.
 */
export class ScoreEventsWorkflow extends WorkflowEntrypoint<Env, ScoreParams> {
  override async run(event: WorkflowEvent<ScoreParams>, step: WorkflowStep) {
    const { userId } = event.payload;
    const rules = await step.do('rules', () => scoreByRules(this.env, userId));
    let llm = 0;
    for (let i = 0; i < rules.candidates.length; i += LLM_BATCH) {
      const batch = rules.candidates.slice(i, i + LLM_BATCH);
      try {
        const r = await step.do(
          `llm ${i / LLM_BATCH + 1}`,
          { retries: { limit: 1, delay: '20 seconds' }, timeout: '3 minutes' },
          () => scoreWithLlm(this.env, userId, batch),
        );
        llm += r.scored;
      } catch (err) {
        console.error('score llm batch failed', { userId, err: String(err) });
      }
    }
    return { scored: rules.scored, llm };
  }
}
