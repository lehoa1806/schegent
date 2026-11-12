import * as vscode from 'vscode';

import type { BackendRunnerKind } from '../contracts/backend-kinds';

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
export function resolveCliPath(
  runnerKind: BackendRunnerKind,
  workspaceRoot: string,
  fallbackDefaultPath: string
): string {
  const config = vscode.workspace.getConfiguration(
    'schegent',
    vscode.Uri.file(workspaceRoot)
  );
  switch (runnerKind) {
    case 'agy':
      return readNonBlankPath(config.get<unknown>('agy.path'), 'agy');
    case 'codex':
      return readNonBlankPath(config.get<unknown>('codex.path'), 'codex');
    case 'claude':
      return readNonBlankPath(
        config.get<unknown>('cli.path'),
        readNonBlankPath(fallbackDefaultPath, 'claude')
      );
    default: {
      // Review gap GC-06 — unreachable while every kind has a case; a kind added to the union
      // without one fails to compile here, and a kind cast in from outside throws rather than
      // launching Claude's binary under another backend's name.
      const unhandled: never = runnerKind;
      throw new TypeError(`no CLI path setting for backend kind "${String(unhandled)}"`);
    }
  }
}

function readNonBlankPath(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}
