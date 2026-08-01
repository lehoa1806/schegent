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
  if (runnerKind === 'agy') {
    return vscode.workspace
      .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
      .get<string>('agy.path', 'agy');
  }
  if (runnerKind === 'codex') {
    return vscode.workspace
      .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
      .get<string>('codex.path', 'codex');
  }
  return fallbackDefaultPath; // 'claude' or unrecognized falls back to the default setting
}
