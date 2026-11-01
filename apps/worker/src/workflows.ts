import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
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
