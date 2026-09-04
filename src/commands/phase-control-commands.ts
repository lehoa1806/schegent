// FR-R3-154 (T1645) — the three Phase-control commands, extracted from their
// registration site so they have a result a caller can read.
//
// WHAT MOVED AND WHY. `src/activation/ui-wiring.ts` registered these three
// inline, and each body already computed the `MutationResult` it needed:
//
//     const result = await deps.controller.pauseActivePhase(queueId);
//     if (!result.ok) deps.notifier.warn(`… rejected (${result.reason}).`);
//
// and then returned `void`. The refusal was shown to the operator and dropped
// on the floor, so `cmd-pause-phase.ts` — which executes this command over IPC
// — had nothing to ACK but `accepted`. Extracting the bodies is what makes the
// result both returnable and directly testable; `registerGuardedCommand`
// already preserves a handler's return value, so nothing else had to change on
// the registration side.
//
// NOTIFICATION IS NOT THE RESULT. The toast stays here, next to the human copy
// and the operator it is for. The returned `CommandOutcome` is the transport's
// answer. T1645 requires both, separately: "Do not swallow a structured
// refusal after logging … keep notification behavior separate from the returned
// result." A palette invocation reads the toast; the webview reads the ACK; and
// neither is derived from the other.
//
// WHY THE CATCH IS HERE. This is the owning command boundary, so it is where an
// unexpected error is converted, once. `reason` is a code and the message goes
// only to the logger: the reason crosses the IPC boundary, and an error message
// from this layer carries workspace paths.

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { Notifier } from '../ui/notifications';
import { ACCEPTED, failed, refused, type CommandOutcome } from '../contracts/command-outcome';
import { errorMessage } from '../lib/errors';

export interface PhaseControlCommandDeps {
  readonly controller: Pick<
    SchegentWorkflowController,
    'pauseActivePhase' | 'resumeActivePhase' | 'restartActivePhase'
  >;
  readonly notifier: Pick<Notifier, 'warn' | 'error'>;
  readonly logger: Pick<SanitizedLogger, 'error'>;
}

type PhaseControlAction = 'pause' | 'resume' | 'restart';

/**
 * One failure code per action, so a `failed` ACK says which control broke
 * without carrying the error that broke it.
 */
const FAILURE_REASON: Readonly<Record<PhaseControlAction, string>> = {
  pause: 'pause-phase-failed',
  resume: 'resume-phase-failed',
  restart: 'restart-phase-failed'
};

async function runPhaseControl(
  action: PhaseControlAction,
  deps: PhaseControlCommandDeps,
  act: () => Promise<{ ok: boolean; reason?: string }>
): Promise<CommandOutcome> {
  try {
    const result = await act();
    if (result.ok) return ACCEPTED;
    // The reason vocabulary is FR-R3-151's (`resolveControlTarget`,
    // `PhaseControlService`); it travels verbatim in both directions.
    const reason = result.reason ?? 'operation-rejected';
    void deps.notifier.warn(`Schegent: ${action} phase rejected (${reason}).`);
    return refused(reason);
  } catch (err) {
    deps.logger.error(`${action}Phase failed: ${errorMessage(err)}`);
    deps.notifier.error(`Schegent: ${action} phase failed.`);
    return failed(FAILURE_REASON[action]);
  }
}

/**
 * Feature 093 (FR-018 / T080) — the sidebar always passes the addressed queue;
 * a human invoking these from the palette passes nothing and the controller
 * resolves a sole Run, refusing when N are in flight.
 */
export function runPausePhase(
  queueId: string | undefined,
  deps: PhaseControlCommandDeps
): Promise<CommandOutcome> {
  return runPhaseControl('pause', deps, () => deps.controller.pauseActivePhase(queueId));
}

export function runResumePhase(
  prompt: string | undefined,
  queueId: string | undefined,
  deps: PhaseControlCommandDeps
): Promise<CommandOutcome> {
  return runPhaseControl('resume', deps, () =>
    deps.controller.resumeActivePhase(prompt, queueId)
  );
}

export function runRestartPhase(
  queueId: string | undefined,
  deps: PhaseControlCommandDeps
): Promise<CommandOutcome> {
  return runPhaseControl('restart', deps, () => deps.controller.restartActivePhase(queueId));
}
