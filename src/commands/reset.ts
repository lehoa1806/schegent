import * as vscode from 'vscode';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';

export async function runReset(ctx: {
  store: WorkspaceStateStore;
  notifier: Notifier;
  logger: SanitizedLogger;
}): Promise<void> {
  try {
    const choice = await vscode.window.showInformationMessage(
      'Schegent: Reset workspace state? Queue, run, lock, and watchdog will be cleared. Audit log file is preserved.',
      'Reset',
      'Cancel'
    );
    if (choice !== 'Reset') return;
    await ctx.store.reset();
    ctx.notifier.info('Schegent: workspace state reset.');
  } catch (err) {
    ctx.notifier.error(`Schegent: reset failed — ${(err as Error).message}`);
    ctx.logger.error((err as Error).message);
  }
}
