import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { loadProfile } from './ai/score';
import { buildDiscover } from './services/discover';
import { composeReview, gatherCandidates, gatherPublicCandidates, sharedResearch } from './services/review';
import { runScan } from './services/scans';

/**
 * Workflow classes bound in wrangler.jsonc that are still placeholders until their phase lands: ExtractItem
 * (phase 3), EnrichEvent (phase 4). SourceRun and ScoreEvents live in pipeline/.
 */

abstract class Placeholder<P> extends WorkflowEntrypoint<Env, P> {
  protected abstract readonly phase: number;
  override async run(_event: WorkflowEvent<P>, step: WorkflowStep) {
    return step.do('not implemented', async () => ({ skipped: true, phase: this.phase }));
  }
}

export class ExtractItemWorkflow extends Placeholder<{ rawItemId: string }> {
  protected readonly phase = 3;
}

export class EnrichEventWorkflow extends Placeholder<{ eventId: string }> {
  protected readonly phase = 4;
}

/**
 * Reads one scan (photo or pasted text) into candidate events. One step: the model call is the whole job, and a
 * dense listing can take a minute. runScan records expected failures on the scan itself.
 */
export class PhotoIngestWorkflow extends WorkflowEntrypoint<Env, { scanId: string }> {
  override async run(event: WorkflowEvent<{ scanId: string }>, step: WorkflowStep) {
    return step.do('read', { retries: { limit: 1, delay: '5 seconds' }, timeout: '5 minutes' }, () =>
      runScan(this.env, event.payload.scanId),
    );
  }
}

/**
 * The daily review for one user (docs/09, 2026-11-02), and their Discover edition. Research and compose are separate
 * steps, so a failed compose retries without paying for the web searches again.
 */
export class DailyReviewWorkflow extends WorkflowEntrypoint<Env, { userId?: string }> {
  override async run(event: WorkflowEvent<{ userId?: string }>, step: WorkflowStep) {
    // No user: the public edition.
    const userId = event.payload.userId ?? null;
    // Discover first and on its own: it falls back to template copy, so it never holds up the review.
    await step.do('discover', { retries: { limit: 1, delay: '30 seconds' }, timeout: '3 minutes' }, async () => ({
      stories: await buildDiscover(this.env, userId),
    }));
    const found = await step.do(
      'research',
      { retries: { limit: 1, delay: '30 seconds' }, timeout: '5 minutes' },
      async () => {
        const candidates = userId
          ? await gatherCandidates(this.env.DB, userId, (await loadProfile(this.env.DB, userId)).prefs)
          : await gatherPublicCandidates(this.env.DB);
        return { candidates, ...(await sharedResearch(this.env, candidates)) };
      },
    );
    return step.do('compose', { retries: { limit: 2, delay: '30 seconds' }, timeout: '5 minutes' }, async () => ({
      picks: await composeReview(this.env, userId, found.candidates, found),
    }));
  }
}
