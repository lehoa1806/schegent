// FR-R3-107 (FR-077, FR-078) — the ONE place `task-execution-ended` is emitted.
//
// WHY THIS EXISTS. `RunDriver.drive()` had three copies of this emission, and they had
// already drifted three ways. The CLI-probe-failure copy hand-wrote `phasesCompleted: 0,
// phasesSkipped: 0` instead of deriving them, omitted the `durationMs` the other two
// carried, and guarded its optional dependency while the others called it unguarded — so
// the same event left three shapes, and one terminal path emitted nothing at all where the
// others logged a warning.
//
// THE ZERO STATS WERE A LATENT BUG, NOT A DELIBERATE SHAPE. They were *correct* — a CLI
// probe fails before any phase runs — but correct **by position**, and nothing pinned the
// position. `computeRunPhaseStats` returns zeros for a Run with no phase records, so
// deriving preserves those values byte-for-byte while making a future reordering visible
// instead of silently wrong.
//
// WHY IT IS A MODULE AND NO LONGER A PRIVATE METHOD ON `RunDriver`, which is the 2026-08-31
// change. "One emitter" was true of the driver and false of the host: the CONTROLLER owns a
// second route to a terminal state. `handleUnexpectedStartFailure` persists
// `status: 'failed'`, finishes the queue row, records history and releases the execution
// lease for a start that threw before or outside the drive — and it wrote no terminal record
// at all, because the only emitter was private to a collaborator it never reached.
//
// The consequence was visible in a live host log and read as nothing at all: four
// `task-execution-started`, one `task-execution-ended`. Three runs that reached `failed` in
// the state store were still *open* in the durable record, indistinguishable from runs in
// flight, with the reason confined to a DEBUG line that is off by default. Recorded as
// finding 2b of the 2026-08-30 host-log triage under `docs/audits/`. That note's file name
// is spelled out nowhere under `src/`, here included: it contains a literal that a gate in
// `tests/lint/` reserves for the runtime-log module, and that gate is a blunt substring
// scan by design. The date is unique enough to find it by.
//
// So the emitter MOVED to where both routes can reach it rather than being copied to the
// second one. Copying is what FR-R3-107 undid, and a fourth copy would have re-opened the
// drift it closed: the payload is unioned by run id downstream, and two shapes would make a
// metrics total depend on which route a run happened to take.
//
// The warning below lost the `run-driver: ` prefix it carried while this was a driver
// method. Deliberate — the prefix was about to become a lie for half the calls, and the
// event name it already carries is unique.
import { computeRunPhaseStats, type WorkflowRun } from '../state/workflow-run';
import { errorMessage } from '../lib/errors';

/**
 * The audit surface this needs, named structurally rather than imported.
 *
 * `WorkflowLifecycleAuditor` (controller) and `RunDriverDeps.emitTaskLifecycleAudit`
 * (services) both satisfy it, and neither is named here — this module sits under both and
 * must not acquire an edge to either.
 */
export interface TaskLifecycleAuditSink {
  emitTaskLifecycle(
    eventType: 'task-execution-ended',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void>;
}

/**
 * The terminal record for a Run that has reached `completed` or `failed`.
 *
 * `sink` is nullable because both callers treat the audit writer as optional — an absent
 * one is a no-op, not a crash. The try/catch is per-emission and warns rather than
 * throwing, because an audit failure must not turn a completed Run into a failed one, and
 * the warning names WHICH terminal status failed; before the consolidation, two of the
 * three copies did not.
 */
export async function emitTerminalOutcomeAudit(
  sink: TaskLifecycleAuditSink | null | undefined,
  logger: { warn(message: string): void },
  run: WorkflowRun,
  terminalStatus: 'completed' | 'failed',
  extra: { readonly lastErrorSummary?: string } = {}
): Promise<void> {
  try {
    if (!sink) return;
    await sink.emitTaskLifecycle('task-execution-ended', run, {
      taskId: run.featureId,
      runId: run.id,
      terminalStatus,
      durationMs: Date.now() - run.startedAt,
      // FR-R3-009 — derived through the same function the durable metrics rollup uses, so
      // both report the same three numbers. They are unioned by run id downstream; two
      // implementations would let a total depend on which range a run fell in.
      ...computeRunPhaseStats(run),
      ...extra
    });
  } catch (err) {
    logger.warn(`task-execution-ended (${terminalStatus}) audit failed: ${errorMessage(err)}`);
  }
}
