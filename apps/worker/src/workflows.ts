import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

/**
 * Workflow classes bound in wrangler.jsonc that are still placeholders until their phase lands:
 * ScoreEvents (phase 2), ExtractItem and PhotoIngest (phase 3), EnrichEvent (phase 4). SourceRun lives in
 * pipeline/source-run.ts.
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

export class ScoreEventsWorkflow extends Placeholder<{ userId: string; eventIds: string[] }> {
  protected readonly phase = 2;
}

export class PhotoIngestWorkflow extends Placeholder<{ uploadId: string }> {
  protected readonly phase = 3;
}
