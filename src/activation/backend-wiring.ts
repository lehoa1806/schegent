import * as os from 'node:os';
import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { resolveCliPath } from '../config/cli-path-accessor';
import {
  RuntimeLogSink,
  createRuntimeLogAccessor
} from '../lib/runtime-log';
import { WebviewLogSink } from '../lib/webview-log-sink';
import { buildSpawnEnv, type ProcessEnvironmentPolicy } from '../runner/spawn-env';
import {
  BackendCapabilityService,
  normalizeBackendProbeTimeoutSeconds
} from '../services/backend-capability-service';
import { BackendPingService } from '../services/backend-ping-service';
import { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';

const unrestrictedEnvironmentWarnedWorkspaces = new Set<string>();

export interface RuntimeEvidenceWiring {
  readonly runtimeLogAccessor: ReturnType<typeof createRuntimeLogAccessor>;
  readonly runtimeLogSink: RuntimeLogSink;
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly webviewLogSink: WebviewLogSink;
}

export interface BackendDiagnosticsWiring {
  readonly capabilities: BackendCapabilityService;
  readonly ping: BackendPingService;
  dispose(): void;
}

/** Workspace-scoped backend discovery and operator Ping composition. */
export function createBackendDiagnosticsWiring(input: {
  readonly workspaceRoot: string;
  readonly claudePath: string;
  readonly environmentPolicy: ProcessEnvironmentPolicy;
  readonly audit: AuditLogWriter;
  readonly logger: SanitizedLogger;
  readonly onDidChange: () => void;
}): BackendDiagnosticsWiring {
  const readTimeout = (): unknown => vscode.workspace
    .getConfiguration('schegent', vscode.Uri.file(input.workspaceRoot))
    .get<unknown>('backend.probeTimeoutSeconds', 5);
  const capabilities = new BackendCapabilityService({
    cwd: input.workspaceRoot,
    resolveCliPath: (kind) => resolveCliPath(
      kind, input.workspaceRoot, input.claudePath
    ),
    readTimeoutSeconds: readTimeout,
    buildEnv: () => buildSpawnEnv({
      env: { SCHEGENT_PHASE: 'runner-probe', SCHEGENT_ITERATION: '0' },
      inheritProcessEnv: input.environmentPolicy.inheritProcessEnv,
      processEnvAllowlist: input.environmentPolicy.processEnvAllowlist
    }),
    logger: input.logger,
    onDidChange: input.onDidChange
  });
  const ping = new BackendPingService({
    capabilities,
    readTimeoutSeconds: () => normalizeBackendProbeTimeoutSeconds(readTimeout()),
    audit: input.audit,
    logger: input.logger,
    onDidChange: input.onDidChange
  });
  return { capabilities, ping, dispose: () => capabilities.dispose() };
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
      // Feature 098 (SEC-03) — the operator's home directory is deliberately
      // NOT a root. `schegent.logging.runtimeLogFilePath` is workspace-
      // configurable, so a repository can pre-set it and the sink will append,
      // truncate, rotate-rename and unlink whatever it names under the
      // operator's own UID. With `$HOME` allowed that reaches `.zshrc`,
      // `.gitconfig`, `.ssh/config` and every other dotfile; the three roots
      // that remain are all Schegent- or OS-owned scratch space. Containment is
      // lexical (see `runtime-log-path.ts`), so a wide root is not narrowed by
      // any later check — the root list is the whole control.
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
