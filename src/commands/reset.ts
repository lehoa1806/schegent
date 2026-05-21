import * as vscode from 'vscode';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SanitizedLogger } from '../lib/logger';

export async function runReset(ctx: {
  store: WorkspaceStateStore;
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
    void vscode.window.showInformationMessage('Schegent: workspace state reset.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Schegent: reset failed — ${(err as Error).message}`);
    ctx.logger.error((err as Error).message);
  }
}
