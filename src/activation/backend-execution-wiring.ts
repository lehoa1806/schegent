import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import { ProcessTreeDegradationRecorder } from '../controller/process-tree-degradation-recorder';
import type { SanitizedLogger } from '../lib/logger';
import { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { RunActivityObservation } from '../monitor/activity-coalescer';
import { resolveBackendKind } from '../runner/backend-runner-factory';
import { BackendRunnerRegistry } from '../runner/backend-runner-registry';
import { PromptBuilder } from '../runner/prompt-builder';
import type { ProcessEnvironmentPolicy } from '../runner/spawn-env';
import { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { TelemetrySamplerImpl } from '../telemetry/telemetry-sampler';
import type { TelemetrySnapshot } from '../telemetry/telemetry-snapshot';
import type { StateProjector } from '../ui/sidebar/state-projector';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import { RATE_LIMIT_MATCHERS } from '../parser/credit-error-detector';
import { withDropReporting } from '../monitor/drop-reporting-transport';
import { createCliTransportSink } from '../monitor/cli-transport-sink';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';
import { windowsShellOut } from '../telemetry/platform/platform-windows';
import { psShellOut } from '../telemetry/platform/platform-ps';
import { createSpawnIdentityRecorder } from '../state/spawn-identity-recorder';
import { createBackendDiagnosticsWiring, type BackendDiagnosticsWiring } from './backend-wiring';

/**
 * FR-R3-119 — the backend execution collaborators, wired.
 *
 * The second extraction out of `wireStage2()`, after
 * `sidebar-router-wiring.ts`. `wireStage2` was 1,221 lines when `FR-R3-119`
 * measured it and 1,010 after the first cut; this region is 148 lines of it.
 *
 * WHY THIS REGION. Of the candidate spans it had by far the narrowest input
 * boundary — **nine** bindings in, against 22 and 30 for the two alternatives —
 * while producing a coherent bundle: the things needed to observe a CLI, sample
 * its telemetry, and construct a runner for it.
 *
 * THE PART THAT WOULD HAVE BROKEN SILENTLY, and the reason this module returns
 * setters rather than plain values.
 *
 * Three of these bindings are declared `null` here, **captured by closures
 * inside this module**, and assigned ~280 lines later in `wireStage2` once the
 * controller and projector exist:
 *
 *   * `livenessRecorder` — captured by the monitor's activity callback,
 *     assigned `controller`
 *   * `telemetryProjector` — captured by the sampler's snapshot callback,
 *     assigned `projector`
 *   * `capabilityProjector` — captured by the backend-diagnostics `onDidChange`,
 *     assigned `projector`
 *
 * Returning them as values and letting the caller reassign its own destructured
 * copy would leave every closure in here still holding `null`. Nothing would
 * fail to compile and no test asserts the wiring directly — the monitor would
 * simply stop recording activity, the sampler would stop reaching the UI, and
 * the capability panel would stop refreshing. A silent behavioural regression,
 * which `FR-059` forbids and which typechecking cannot see.
 *
 * So the late binding is explicit: `bindLivenessRecorder`, `bindTelemetryProjector`
 * and `bindCapabilityProjector`. That is strictly clearer than the `let x = null`
 * reassigned 280 lines away that it replaces — the dependency is now named at
 * both ends.
 */
/**
 * `output` is deliberately absent: the region closed over it in `wireStage2`
 * only because everything was in scope there, and measured against what this
 * code actually reads it needs none of it.
 */
export interface BackendExecutionWiringDeps {
  readonly workspaceRoot: string;
  readonly cliPath: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly disposables: vscode.Disposable[];
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly processEnvironmentPolicy: ProcessEnvironmentPolicy;
}

export interface BackendExecutionWiring {
  readonly monitor: ClaudeCliMonitor;
  readonly sampler: TelemetrySamplerImpl;
  readonly runnerRegistry: BackendRunnerRegistry;
  readonly historyStore: HistoryStore;
  readonly promptBuilder: PromptBuilder;
  readonly rawTranscript: RawTranscriptWriter;
  readonly backendKind: ReturnType<typeof resolveBackendKind>;
  readonly backendCapabilities: BackendDiagnosticsWiring['capabilities'];
  readonly backendPing: BackendDiagnosticsWiring['ping'];
  readonly readUncontainedAllowed: () => boolean;
  readonly verboseAccessor: { isVerboseDiagnosticsEnabled: () => boolean };
  /** Late binding — see the docblock. Without these the closures keep `null`. */
  readonly bindLivenessRecorder: (r: {
    recordRunActivity: (o: RunActivityObservation) => void;
  }) => void;
  readonly bindTelemetryProjector: (p: {
    updateTelemetry: (snap: TelemetrySnapshot | null) => void;
  }) => void;
  readonly bindCapabilityProjector: (p: Pick<StateProjector, 'kick'>) => void;
}

export function wireBackendExecution(
  deps: BackendExecutionWiringDeps
): BackendExecutionWiring {
  const {
    workspaceRoot,
    cliPath,
    logger,
    store,
    auditWriter,
    disposables,
    evidenceHealth,
    processEnvironmentPolicy
  } = deps;

// FR-R3-008 (T377) — the monitor observes activity long before the controller
// that persists it exists, so the recorder is late-bound in the same shape as
// `telemetryProjector` below. Until the controller is constructed there is no
// Run to stamp, and a dropped observation costs at most one coalescing
// interval of resolution.
let livenessRecorder: { recordRunActivity: (o: RunActivityObservation) => void } | null = null;
const monitor = new ClaudeCliMonitor({
  stallThresholdMs: 90_000,
  rateLimitMatchers: RATE_LIMIT_MATCHERS,
  monotonicNow: () => {
    const perf = (globalThis as { performance?: { now: () => number } }).performance;
    return perf ? perf.now() : Date.now();
  },
  now: () => new Date(),
  audit: auditWriter,
  // Feature FR-R3-007 — CLI output goes to the bounded sink, not `audit.log`.
  // The root is re-read per emit rather than closed over: a host outlives one
  // folder, and the destination and its containment root are derived together
  // so the two cannot disagree.
  // FR-R3-106 — wrapped so backpressure refusals reach evidence health.
  transport: withDropReporting(
    createCliTransportSink(() => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null, logger),
    evidenceHealth
  ),
  activity: {
    record: (observation) => {
      livenessRecorder?.recordRunActivity(observation);
    }
  },
  logger
});
// Sampler is created before its late-bound projector and runner hooks.
const telemetryShellOut =
  process.platform === 'win32' ? windowsShellOut : psShellOut;
let telemetryProjector: { updateTelemetry: (snap: TelemetrySnapshot | null) => void } | null =
  null;
const sampler = new TelemetrySamplerImpl({
  shellOutFn: telemetryShellOut,
  logger,
  onSample: (snap) => {
    telemetryProjector?.updateTelemetry(snap);
  }
});
/** FR-R3-081 — run id → sampled pid, so an exit can name its own series. */
const samplerPidByRun = new Map<string, number>();
disposables.push({
  dispose: () => {
    samplerPidByRun.clear();
    sampler.dispose();
  }
});
// Invocation runners are lazy and share one monitor hook.
const backendKind = resolveBackendKind(
  vscode.workspace.getConfiguration('schegent.backend').get<string>('runner'),
  logger
);
// FR-R3-064 — one reader, two tenures. The literals stay spelled out here
// because FR-R3-056's `uncontained-backend-not-hardcoded` gate asserts this
// file reads `getConfiguration('schegent.backend')` for the posture: the wiring
// site is where an auditor sees it enter the system.
const readUncontainedAllowed = (): boolean =>
  vscode.workspace
    .getConfiguration('schegent.backend')
    .get<boolean>('allowUncontainedBackends') === true;
// FR-R3-083 — a runner reports; this records. Gate: tree-degradation-emission-funnel.
const treeDegradationRecorder = new ProcessTreeDegradationRecorder((e) => auditWriter.append(e));
const spawnIdentityRecorder = createSpawnIdentityRecorder({
  store,
  now: () => Date.now(),
  log: (message) => logger.info(message)
});
const runnerRegistry = new BackendRunnerRegistry({
  // FR-R3-056 (H-01) — the shipped posture. Unset reads as the manifest default
  // (`false`), so a fresh install refuses an uncontained backend. See
  // docs/architecture/agent-capability-posture.md.
  allowUncontained: readUncontainedAllowed(),
  // Feature 093 (T046) — forward each event to the Run that produced it.
  // The hook stays one window-level function; only the addressing changes.
  monitorHook: (event) => {
    if (event.kind === 'started') {
      monitor.onSpawnPid(event.runId, event.pid);
      // FR-R3-103 (FR-041) — persist the tree's identity so a later host can ask
      // whether it is still alive before resuming into the same worktree.
      void spawnIdentityRecorder.recordSpawn(event.runId, event.pid);
      if (event.pid !== null) {
        // FR-R3-081 — remembered so the exit can name WHICH child it was. The
        // `'exited'` event carries the run id and not the pid, and with more
        // than one run sampled a sampler that has to guess stops the wrong
        // series: the survivor goes unsampled and the dead pid is polled until
        // the window closes.
        if (event.runId !== null) samplerPidByRun.set(event.runId, event.pid);
        sampler.start(event.pid, Date.now());
      }
    } else if (event.kind === 'stdout-chunk') {
      monitor.onStdoutChunk(event.runId, event.chunk);
    } else if (event.kind === 'stderr-chunk') {
      monitor.onStderrChunk(event.runId, event.chunk);
    } else if (event.kind === 'exited') {
      // FR-R3-103 — cleared at reaped exit, so a finished Run does not read as an orphan.
      void spawnIdentityRecorder.clearOnExit(event.runId);
      monitor.onExit(event.runId, {
        exitCode: event.exitCode,
        signal: event.signal,
        killed: event.killed,
        timedOut: event.timedOut
      });
      const exitedPid = event.runId === null ? undefined : samplerPidByRun.get(event.runId);
      if (event.runId !== null) samplerPidByRun.delete(event.runId);
      sampler.stop({
        signal: event.signal as NodeJS.Signals | null,
        ...(exitedPid === undefined ? {} : { pid: exitedPid })
      });
    } else if (event.kind === 'tree-unconfirmed') {
      // FR-R3-083 — best-effort by design; arrives after the phase has ended.
      void treeDegradationRecorder.record(event);
    }
  },
  probeTransport: true,
  logger
}, backendKind);
// Stage 2 teardown cancels workspace-bound subprocesses.
disposables.push({ dispose: () => runnerRegistry.cancelAll() });
let capabilityProjector: Pick<StateProjector, 'kick'> | null = null;
const backendDiagnostics = createBackendDiagnosticsWiring({
  workspaceRoot,
  claudePath: cliPath,
  environmentPolicy: processEnvironmentPolicy,
  audit: auditWriter,
  logger,
  onDidChange: () => capabilityProjector?.kick()
});
const backendCapabilities = backendDiagnostics.capabilities;
const backendPing = backendDiagnostics.ping;
disposables.push(backendDiagnostics);
const historyStore = new HistoryStore(store);
const promptBuilder = new PromptBuilder();
const rawTranscript = new RawTranscriptWriter(
  workspaceRoot,
  logger,
  undefined,
  evidenceHealth
);
const verboseAccessor = {
  isVerboseDiagnosticsEnabled: () =>
    vscode.workspace
      .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
      .get<boolean>('logging.verbose', false)
};
  return {
    monitor,
    sampler,
    runnerRegistry,
    historyStore,
    promptBuilder,
    rawTranscript,
    backendKind,
    backendCapabilities,
    backendPing,
    readUncontainedAllowed,
    verboseAccessor,
    bindLivenessRecorder: (r) => {
      livenessRecorder = r;
    },
    bindTelemetryProjector: (p) => {
      telemetryProjector = p;
    },
    bindCapabilityProjector: (p) => {
      capabilityProjector = p;
    }
  };
}
