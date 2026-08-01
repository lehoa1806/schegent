import * as vscode from 'vscode';

/**
 * Feature 074 — Resolves the CLI binary path for a given runner kind.
 * Reads the setting dynamically so the operator can change
 * `schegent.agy.path`, `schegent.codex.path`, or `schegent.cli.path`
 * without restarting the VS Code extension host.
 *
 * This accessor is intentionally isolated from the main `PipelineConfig`
 * because runner paths are strictly local machine configuration, whereas
 * pipelines can be workspace-shared.
 */
export function resolveCliPath(runnerKind: string, workspaceRoot: string, fallbackDefaultPath: string): string {
  const config = vscode.workspace.getConfiguration(
    'schegent',
    vscode.Uri.file(workspaceRoot)
  );
  if (runnerKind === 'agy') {
    return readNonBlankPath(config.get<unknown>('agy.path'), 'agy');
  }
  if (runnerKind === 'codex') {
    return readNonBlankPath(config.get<unknown>('codex.path'), 'codex');
  }
  return readNonBlankPath(
    config.get<unknown>('cli.path'),
    readNonBlankPath(fallbackDefaultPath, 'claude')
  );
}

function readNonBlankPath(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}
