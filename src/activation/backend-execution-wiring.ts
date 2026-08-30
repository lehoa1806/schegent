// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Constructs the CLI monitor, the telemetry sampler and the runner registry, and
// returns three late-binding setters. `new RunnerRegistry(...)` spawns nothing;
// the spawn happens when a Run starts, and no Run starts in an untrusted window.
// The one `disposables.push` here is `cancelAll` at teardown.

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
import {
  resolveUncontainedGrant,
  type GrantedUncontainedBackends
} from '../services/backend-containment-policy';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { TelemetrySamplerImpl } from '../telemetry/telemetry-sampler';
import type { TelemetrySnapshot } from '../telemetry/telemetry-snapshot';
import type { StateProjector } from '../ui/sidebar/state-projector';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import { RATE_LIMIT_MATCHERS } from '../parser/credit-error-detector';
import { withDropReporting, type BoundedTransport } from '../monitor/drop-reporting-transport';
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
  /**
   * FR-R3-137 (FR-009, C5) — `context.subscriptions`, for the partial-construction
   * net registered beside the sink below. Distinct from `disposables`, and the
   * distinction is the requirement: `disposables` is private to `wireStage2` and
   * is never swept when `wireStage2` throws, so it cannot carry a net.
   */
  readonly hostSubscriptions: { dispose(): unknown }[];
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly processEnvironmentPolicy: ProcessEnvironmentPolicy;
}

export interface BackendExecutionWiring {
  readonly monitor: ClaudeCliMonitor;
  /**
   * FR-R3-137 (FR-008) — the transport, so the composition root's teardown has
   * something to close. Carried on the wiring rather than reached for through a
   * module-level reference, for the reason `Stage2Wiring.reset` records: a reload
   * replaces the graph, and a teardown must reach the CURRENT sink.
   */
  readonly transport: BoundedTransport;
  readonly sampler: TelemetrySamplerImpl;
  readonly runnerRegistry: BackendRunnerRegistry;
  readonly historyStore: HistoryStore;
  readonly promptBuilder: PromptBuilder;
  readonly rawTranscript: RawTranscriptWriter;
  readonly backendKind: ReturnType<typeof resolveBackendKind>;
  readonly backendCapabilities: BackendDiagnosticsWiring['capabilities'];
  readonly backendPing: BackendDiagnosticsWiring['ping'];
  /**
   * FR-R3-125 — per backend, not per host. Re-resolves the setting on each call
   * for the reason `BackendPostureAccessor` gives: a value cached at activation
   * would record an activation-time posture for a Run happening now.
   */
  readonly readUncontainedAllowed: (kind: BackendRunnerKind) => boolean;
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
    hostSubscriptions,
    evidenceHealth,
    processEnvironmentPolicy
  } = deps;

// FR-R3-137 (FR-008) — hoisted out of the monitor's option literal, because the
// thing that owns a descriptor has to be reachable by the thing that closes it.
//
// Constructed inline as a constructor argument, this reference existed for one
// expression and then only the monitor held it — narrowed to `CliTransportRecorder`,
// one method, no close on it. Nothing in the host could dispose the sink because
// nothing in the host could name it. It is returned on the wiring below, so the
// composition root's teardown has an owner to call.
//
// FR-R3-007 — the root is re-read per emit rather than closed over: a host
// outlives one folder, and the destination and its containment root are derived
// together so the two cannot disagree.
// FR-R3-106 — wrapped so backpressure refusals reach evidence health.
const transport: BoundedTransport = withDropReporting(
  createCliTransportSink(() => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null, logger),
  evidenceHealth
);
// FR-R3-137 (FR-009, C5) — the partial-construction net, registered HERE, at the
// moment the sink exists, rather than at the end of a successful `wireStage2`.
//
// The window it covers: `wireStage2` throws somewhere between this line and its
// return. The ordered teardown in `stage2-teardown.ts` was never built, and
// `disposables` — the array `wireStage2` sweeps on its one existing failure path
// — is private to it and unswept on a throw. So on that path nobody could close
// this sink, and the monitor is already recording into it by then (FR-R3-008's
// late binding): exactly the case C5 names, a record reaching a sink whose Stage 2
// never became reachable.
//
// It goes on the HOST's subscriptions because that is the only list a failed
// activation disposes. Ordering is by construction: `extension.ts` pushes its
// awaited `hostTeardown` entry during stage 1, before any of this runs, so the
// ordered teardown always precedes this net in the array. Firing second is free
// — `flushAndDispose` memoises its drain, so both await the same promise.
//
// Accepted cost: a folder change builds a new Stage 2 and leaves this entry
// behind holding a settled sink whose maps are empty. One small object per folder
// change, released when the window closes.
hostSubscriptions.push({ dispose: () => void transport.flushAndDispose() });

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
  // The monitor's own field stays `CliTransportRecorder`: one method, no
  // lifecycle. That narrowing is correct — a stream handler has no business
  // closing anything — which is why the owner is the wiring, not the monitor.
  transport,
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
// FR-R3-125 (FR-004, FR-004a) — the value is a list now, so reading it means
// resolving it: unsupported entries and already-contained entries grant nothing
// and are reported rather than silently dropped. Anything that is not an array
// yields an empty grant, which is the fail-closed direction.
const readUncontainedGrant = (): GrantedUncontainedBackends =>
  resolveUncontainedGrant(
    vscode.workspace.getConfiguration('schegent.backend').get<unknown>('uncontainedBackends')
  );
// FR-R3-083 — a runner reports; this records. Gate: tree-degradation-emission-funnel.
const treeDegradationRecorder = new ProcessTreeDegradationRecorder((e) => auditWriter.append(e));
const spawnIdentityRecorder = createSpawnIdentityRecorder({
  store,
  now: () => Date.now(),
  log: (message) => logger.info(message)
});
// FR-R3-125 (FR-004a) — an entry that grants nothing says why, once, at the
// wiring site. Never thrown: a malformed safety setting fails closed and leaves
// the product usable, and an operator whose extension will not start does not
// read the reason.
//
// FR-R3-146 (FR-003) — deliberately still ONE resolution, and deliberately not
// the one the factory judges against. This is a report about the setting as it
// stood at activation; repeating it per phase would turn one misconfiguration
// into a log entry on every run.
for (const problem of readUncontainedGrant().problems) logger.warn(problem.message);
const runnerRegistry = new BackendRunnerRegistry({
  // FR-R3-056 (H-01), reshaped by FR-R3-125 — the shipped posture. Unset reads as
  // the manifest default (`[]`), so a fresh install refuses every uncontained
  // backend. See docs/architecture/agent-capability-posture.md.
  //
  // FR-R3-146 (FR-003) — a thunk, so the registry holds the READER and not a
  // resolved set. This registry lives for the window, so a set resolved here is a
  // set frozen at activation, and a grant written mid-session — by an operator
  // editing settings, or by the consent modal — would not take effect until a
  // reload. The warning loop above resolves once ON PURPOSE, because it reports on
  // the setting as it stood at activation; this must not. Same rule the spend
  // bound follows at `run-safety-wiring.ts`, and the same rule
  // `readUncontainedAllowed` below was already following for the other consumer.
  uncontainedGranted: () => readUncontainedGrant().granted,
  // FR-R3-125 (FR-007) — so the factory can state the compounding case
  // (no OS bound AND the full ambient environment) where both facts are known.
  environmentMode: processEnvironmentPolicy.mode,
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
    } else {
      // FR-R3-083 — best-effort by design; arrives after the phase has ended.
      //
      // `else`, not `else if (event.kind === 'tree-unconfirmed')`: the four
      // branches above exhaust the event union, so that re-test is a comparison
      // the compiler has already made — `no-unnecessary-condition` reports it as
      // always true. The `satisfies` keeps what the removed comparison implied: a
      // sixth event kind stops compiling on this line instead of silently
      // arriving in the tree-unconfirmed branch and being recorded as one.
      void treeDegradationRecorder.record(event satisfies { kind: 'tree-unconfirmed' });
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
    transport,
    sampler,
    runnerRegistry,
    historyStore,
    promptBuilder,
    rawTranscript,
    backendKind,
    backendCapabilities,
    backendPing,
    readUncontainedAllowed: (kind) => readUncontainedGrant().granted.has(kind),
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
