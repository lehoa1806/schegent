import * as os from 'node:os';
import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import {
  RuntimeLogSink,
  createRuntimeLogAccessor
} from '../lib/runtime-log';
import { WebviewLogSink } from '../lib/webview-log-sink';
import type { ProcessEnvironmentPolicy } from '../runner/spawn-env';
import { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';

const unrestrictedEnvironmentWarnedWorkspaces = new Set<string>();

export interface RuntimeEvidenceWiring {
  readonly runtimeLogAccessor: ReturnType<typeof createRuntimeLogAccessor>;
  readonly runtimeLogSink: RuntimeLogSink;
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly webviewLogSink: WebviewLogSink;
}

/** Stage-1 logging/evidence composition shared by workspace and no-workspace hosts. */
export function createRuntimeEvidenceWiring(
  context: vscode.ExtensionContext,
  logger: SanitizedLogger
): RuntimeEvidenceWiring {
  const runtimeLogAccessor = createRuntimeLogAccessor(
    () => vscode.workspace.getConfiguration('schegent'),
    () => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
    logger,
    () => {
      const roots: string[] = [];
      const workspaceRoot = getCanonicalWorkspaceRoot()?.uri.fsPath;
      if (workspaceRoot) roots.push(workspaceRoot);
      roots.push(context.globalStorageUri.fsPath);
      try { roots.push(os.tmpdir()); } catch { /* unavailable on some embedded hosts */ }
      try { roots.push(os.homedir()); } catch { /* OS user may have no home */ }
      return roots;
    }
  );
  const evidenceHealth = new EvidenceHealthMonitor();
  const runtimeLogSink = new RuntimeLogSink({
    accessor: runtimeLogAccessor,
    fallbackLogger: logger,
    evidenceHealth
  });
  const webviewLogSink = new WebviewLogSink();
  logger.addSink(runtimeLogSink);
  logger.addSink(webviewLogSink);
  return { runtimeLogAccessor, runtimeLogSink, evidenceHealth, webviewLogSink };
}

/** Warn once per workspace without ever logging environment values. */
export function warnIfEnvironmentIsUnrestricted(
  policy: ProcessEnvironmentPolicy,
  workspaceRoot: string,
  logger: SanitizedLogger
): void {
  if (
    policy.mode !== 'inherit' ||
    unrestrictedEnvironmentWarnedWorkspaces.has(workspaceRoot)
  ) return;
  unrestrictedEnvironmentWarnedWorkspaces.add(workspaceRoot);
  logger.warn(
    'backend environment policy is unrestricted (inherit); use schegent.cli.environmentMode=allowlist or minimal to reduce ambient secret exposure; see docs/reference/settings.md#schegentclienvironmentmode'
  );
}
