import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';

export interface ShowActiveRunCtx {
  notifier: Notifier;
  logger: SanitizedLogger;
}

interface ShowActiveRunArg {
  id?: string;
  runId?: string;
  source?: 'queue' | 'history' | 'sidebar';
}

function parseArg(arg: unknown): ShowActiveRunArg {
  if (!arg || typeof arg !== 'object') return {};
  const obj = arg as Record<string, unknown>;
  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    runId: typeof obj.runId === 'string' ? obj.runId : undefined,
    source: obj.source === 'queue' || obj.source === 'history' || obj.source === 'sidebar'
      ? obj.source
      : undefined
  };
}

export async function runShowActiveRun(arg: unknown, ctx: ShowActiveRunCtx): Promise<void> {
  const parsed = parseArg(arg);
  const id = parsed.id ?? parsed.runId ?? '(unknown)';
  const source = parsed.source ?? 'sidebar';
  try {
    await vscode.commands.executeCommand('workbench.view.extension.schegent');
    ctx.notifier.info(`Schegent: showing details for ${source} item ${id}.`);
  } catch (err) {
    ctx.logger.warn(`runShowActiveRun: ${(err as Error).message}`);
  }
}
