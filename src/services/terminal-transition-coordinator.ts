import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { HistoryRecorder } from './history-recorder';

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

/**
 * Durable, idempotent terminal transition journal. The intent is persisted
 * before the terminal run record. Activation replay completes queue/history
 * projection before clearing it, repairing crashes at any intermediate step.
 */
export class TerminalTransitionCoordinator {
  constructor(
    private readonly store: WorkspaceStateStore,
    private readonly queue: Pick<QueueManager, 'finish'>,
    private readonly history: Pick<HistoryRecorder, 'record'>,
    private readonly logger: SanitizedLogger
  ) {}

  public async begin(run: WorkflowRun): Promise<void> {
    if (!TERMINAL.has(run.status)) return;
    const existing = this.store.getTerminalTransitionIntent();
    if (existing?.run.id === run.id && existing.run.status === run.status) return;
    await this.store.setTerminalTransitionIntent({ schemaVersion: 1, run, createdAt: Date.now() });
  }

  public async complete(run: WorkflowRun, description: string): Promise<void> {
    if (!TERMINAL.has(run.status)) return;
    await this.begin(run);
    await this.store.setRun(run);
    try {
      await this.queue.finish(run.featureId, run.status as 'completed' | 'failed' | 'canceled');
      await this.history.record(
        run,
        description,
        run.status as 'completed' | 'failed' | 'canceled'
      );
      await this.store.setTerminalTransitionIntent(null);
    } catch (error) {
      this.logger.warn(`terminal-transition: replay remains pending: ${(error as Error).message}`);
    }
  }

  public async replay(): Promise<void> {
    const intent = this.store.getTerminalTransitionIntent();
    if (!intent) return;
    await this.complete(intent.run, intent.run.featureId);
  }
}
