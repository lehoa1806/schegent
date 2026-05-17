import * as vscode from 'vscode';
import * as path from 'path';
import type { Notifier } from '../ui/notifications';

export async function runShowAuditLog(ctx: {
  workspaceRoot: string;
  notifier: Notifier;
}): Promise<void> {
  const logPath = path.join(ctx.workspaceRoot, '.schegent', 'audit.log');
  try {
    const uri = vscode.Uri.file(logPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  } catch {
    ctx.notifier.info('Schegent: no audit log yet.');
  }
}
