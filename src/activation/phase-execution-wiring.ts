// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Four accessors that read a setting at call time, and two sinks. Each sink
// writes when the phase runner calls it, during a Run, and no Run starts in an
// untrusted window.

import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import { PhaseRunner } from '../controller/phase-runner';
import type { LastRetryDecisionSink } from '../controller/phase-retry-evaluator';
import { LIVE_RUN_STATUSES } from '../state/workflow-run';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { PromptBuilder } from '../runner/prompt-builder';
import type { BackendRunnerRegistry } from '../runner/backend-runner-registry';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import type { HistoryStore } from '../state/history-store';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import type { BackendExecutionWiring } from './backend-execution-wiring';
import type { EvidenceWiring } from './evidence-wiring';
import { createRunSafetyWiring } from './run-safety-wiring';
import { readFatalSignaturesSetting } from '../config/general-settings';
import { createAutoCompactOverrideAccessor } from '../lib/auto-compact-override';
import { createPhaseBreakpointAccessor } from '../controller/breakpoint-accessor';

/**
 * FR-R3-119 — everything the phase runner needs to be told, and the safety net
 * around it.
 *
 * The eighth extraction out of `wireStage2()`. 69 lines, seventeen bindings in,
 * two out.
 *
 * WHY THE FOUR ACCESSORS ARE HERE AND NOT INLINE AT THE RUNNER. Each reads a
 * setting at CALL time rather than construction time, and each exists because
 * caching it was a defect the hard rules now forbid by name: `AGENTS.md` has four
 * separate "never cache the X setting on long-lived runner state" rules, one per
 * accessor. Grouping them makes that shared reason visible — they are not four
 * unrelated options, they are one rule applied four times.
 */
export interface PhaseExecutionWiringDeps {
  readonly context: vscode.ExtensionContext;
  readonly workspaceRoot: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly notifier: Notifier;
  readonly auditWriter: AuditLogWriter;
  readonly historyStore: HistoryStore;
  readonly rawTranscript: RawTranscriptWriter;
  readonly promptBuilder: PromptBuilder;
  readonly runnerRegistry: BackendRunnerRegistry;
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly sessionRetention: SessionArtifactRetentionService;
  readonly protectedSessionRunIds: EvidenceWiring['protectedSessionRunIds'];
  readonly readUncontainedAllowed: BackendExecutionWiring['readUncontainedAllowed'];
  readonly verboseAccessor: BackendExecutionWiring['verboseAccessor'];
}

/**
 * Feature 093 (T047) — the decision names its Run, so the write names that Run's
 * queue. T037's interim binding had no identity to work from and so declined
 * whenever more than one Run existed, which is the same defect read defensively: a
 * decision that belonged to a real Run went nowhere. Run ids are unique across
 * queues, so this resolves to exactly one entry — the C-4 aggregate read SC-012
 * exempts, not a Run reached without a queue.
 *
 * FR-R4-F01 (FR-008) — the write is `updateRun`, a PATCH of `lastRetryDecision`
 * applied to the Run as it is inside the `KEYS.run` chain, not a whole Run built
 * from the read above. A cancel that lands in between keeps its status and its
 * cleared pairs; a decision that arrives after the Run ended is refused and
 * dropped, because the audit event is the canonical record and the projection is
 * best-effort (`PhaseRetryEvaluator`).
 *
 * Exported so the interleaving it exists for can be driven against the real store.
 */
export function createLastRetryDecisionSink(
  store: Pick<WorkspaceStateStore, 'getRunMap' | 'updateRun' | 'runCommitClaim'>
): LastRetryDecisionSink {
  return async (runId, decision) => {
    const entry = Object.entries(store.getRunMap()).find(([, run]) => run.id === runId);
    if (entry === undefined) return;
    const [queueId, current] = entry;
    try {
      await store.updateRun(
        queueId,
        {
          runId: current.id,
          allowedStatuses: LIVE_RUN_STATUSES,
          label: 'retry-decision',
          patch: () => ({ lastRetryDecision: decision })
        },
        store.runCommitClaim(queueId)
      );
    } catch (error) {
      if (!isRunRaceRefusal(error)) throw error;
    }
  };
}

export interface PhaseExecutionWiring {
  readonly phaseRunner: PhaseRunner;
  readonly runSafety: Awaited<ReturnType<typeof createRunSafetyWiring>>;
}

export async function wirePhaseExecution(
  deps: PhaseExecutionWiringDeps
): Promise<PhaseExecutionWiring> {
  const {
    context,
    workspaceRoot,
    logger,
    store,
    queue,
    notifier,
    auditWriter,
    historyStore,
    rawTranscript,
    promptBuilder,
    runnerRegistry,
    evidenceHealth,
    sessionRetention,
    protectedSessionRunIds,
    readUncontainedAllowed,
    verboseAccessor
  } = deps;

const fatalSignaturesAccessor = {
  readOperatorAdditions: () =>
    readFatalSignaturesSetting(
      vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
    )
};
const autoCompactOverrideAccessor = createAutoCompactOverrideAccessor(
  () => vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)),
  logger
);
// Feature 093 (T037) — C-3, bind at construction. The accessor is handed a
// resolver rather than an ambient thunk: its own method names the Run by id,
// and this binding answers that id from the whole record — the C-4 aggregate
// SC-012 exempts, not a Run reached without a queue. T041 rebinds the same
// resolver per session, where the queue is known and only that queue is read.
const phaseBreakpointAccessor = createPhaseBreakpointAccessor(
  (runId) => Object.values(store.getRunMap()).find((run) => run.id === runId) ?? null
);
const lastRetryDecisionSink = createLastRetryDecisionSink(store);
// FR-R3-064 — the posture accessor: the same reader, called per emission
// instead of once at activation. The difference between the two uses is WHEN,
// not WHAT; passing the registry's captured boolean here would record an
// activation-time posture for a Run happening now.
const backendPostureAccessor = { isUncontainedAllowed: readUncontainedAllowed };
const phaseRunner = new PhaseRunner(
  runnerRegistry,
  promptBuilder,
  auditWriter,
  logger,
  rawTranscript,
  verboseAccessor,
  fatalSignaturesAccessor,
  autoCompactOverrideAccessor,
  null,
  phaseBreakpointAccessor,
  lastRetryDecisionSink,
  backendPostureAccessor,
  // FR-R3-080 (T1075) — the refused-write drain. Without it a refusal reaches
  // the log and stops there, which is the state this item exists to leave.
  evidenceHealth
);
const runSafety = await createRunSafetyWiring({
  context,
  workspaceRoot,
  store,
  queue,
  historyStore,
  logger,
  rawTranscript,
  sessionRetention,
  protectedSessionRunIds,
  evidenceHealth,
  auditWriter,
  notifier
});
  return { phaseRunner, runSafety };
}
