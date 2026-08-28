// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT, WITH ONE NAMED
// EXCEPTION THAT PHASE D CLOSES.
// Composes the capability service, the operator Ping and the Stage-1 log sinks;
// every probe those services can perform is called from somewhere else, and the
// wiring-time one is deferred (see `stage2-producers.ts`).
//
// The exception is `createRuntimeEvidenceWiring`, which adds a sink that appends
// to `schegent.logging.runtimeLogFilePath` — `scope: resource`, so a workspace
// can name it, which is the criterion's first clause. It is NOT gated here and
// must not be: the runtime log is the one surface that explains why everything
// else in an untrusted window was refused, and a sink that goes quiet takes the
// explanation with it. The closure is Phase D's `restrictedConfigurations`
// (T1526a) plus the containment `FR-R3-005` already applies at the syscall — a
// setting the folder cannot set is a path the folder cannot name.

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
import { buildSpawnEnv, policyRequestFields, type ProcessEnvironmentPolicy } from '../runner/spawn-env';
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
    // FR-R3-049 — through the shared helper like every other policy consumer.
    // This site mapped the two fields by hand, which meant the helper was not
    // actually "the one place" the policy reaches a request; and because this is
    // a probe rather than an `.invoke` call, the lint gate could not see it
    // either. Passing `inheritProcessEnv` unconditionally also differed subtly
    // from the helper, which omits it unless it is `false`.
    buildEnv: () => buildSpawnEnv({
      env: { SCHEGENT_PHASE: 'runner-probe', SCHEGENT_ITERATION: '0' },
      ...policyRequestFields(input.environmentPolicy)
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
  // Feature FR-R3-005 (T329) — one root list, read by both the accessor that
  // decides whether a configured path is admissible and the sink that performs
  // the syscalls. Deriving it twice would let the two drift into enforcing
  // different policies, which is the failure mode where a path passes
  // admission and is then refused at the point of effect, or worse, the other
  // way around.
  const allowedRuntimeLogRoots = (): readonly string[] => {
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
    // that remain are all Schegent- or OS-owned scratch space.
    //
    // Feature FR-R3-005 (T329) added symlink-resistant containment at the
    // sink's own syscalls, which is why `runtime-log-path.ts` being lexical is
    // no longer the whole story. It is emphatically NOT a licence to widen
    // this list back: containment at the point of effect is additional to the
    // narrowed roots, and a re-added `$HOME` would be a root the oracle
    // faithfully proves paths into.
    return roots;
  };
  const runtimeLogAccessor = createRuntimeLogAccessor(
    () => vscode.workspace.getConfiguration('schegent'),
    () => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
    logger,
    allowedRuntimeLogRoots
  );
  const evidenceHealth = new EvidenceHealthMonitor();
  const runtimeLogSink = new RuntimeLogSink({
    accessor: runtimeLogAccessor,
    fallbackLogger: logger,
    evidenceHealth,
    containmentRoots: allowedRuntimeLogRoots
  });
  const webviewLogSink = new WebviewLogSink();
  logger.addSink(runtimeLogSink);
  logger.addSink(webviewLogSink);
  return { runtimeLogAccessor, runtimeLogSink, evidenceHealth, webviewLogSink };
}

/**
 * Warn once per workspace without ever logging environment values.
 *
 * FR-R3-125 (FR-007) — this stays exactly as it is, and the reason is worth
 * stating so it is not "consolidated" with the newer one. This warning is about
 * the environment policy ON ITS OWN: `inherit` widens the ambient credential
 * surface for every spawn, contained or not, and that is true and worth saying
 * once per workspace at activation. It cannot say more, because at activation
 * nothing knows which backend will spawn.
 *
 * `createBackendRunner` carries a SECOND warning about the CONJUNCTION — no
 * OS-enforced bound *and* the full ambient environment — which is a different
 * fact, fires on one of four combinations, and is only knowable where the backend
 * kind and the policy meet. Two warnings, two facts. Merging them would either
 * lose the general one or make the compound one fire when it does not apply.
 */
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
