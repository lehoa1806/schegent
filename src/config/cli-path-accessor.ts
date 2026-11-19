import * as vscode from 'vscode';

import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { findBackendDescriptor } from '../contracts/backend-descriptors';

/**
 * Feature 074 / FR-R7-06 — Resolves the CLI binary path for a given runner kind.
 * Reads the setting dynamically from the descriptor table's `cliPathSettingKey`
 * so the operator can change `schegent.agy.path`, `schegent.codex.path`, or
 * `schegent.cli.path` without restarting the VS Code extension host.
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
  const descriptor = findBackendDescriptor(runnerKind);
  if (descriptor === undefined) {
    // Review gap GC-06 / FR-R7-06 FR-002 — unknown kind throws rather than launching
    // Claude's binary under another backend's name.
    throw new TypeError(`no CLI path setting for backend kind "${String(runnerKind)}"`);
  }
  const config = vscode.workspace.getConfiguration(
    'schegent',
    vscode.Uri.file(workspaceRoot)
  );
  const defaultPath = descriptor.usesLegacyFallbackPath
    ? readNonBlankPath(fallbackDefaultPath, descriptor.defaultCliBinary)
    : descriptor.defaultCliBinary;
  return readNonBlankPath(config.get<unknown>(descriptor.cliPathSettingKey), defaultPath);
}

function readNonBlankPath(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}
