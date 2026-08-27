// FR-R3-127 (FR-006) — the two commands `docs/operations/evidence-retention-disclosure.md`
// has been promising since FR-R3-085.
//
// THE FINDING THIS CLOSES. That page's "What you can do about it" table told
// operators to run `Schegent: Export Run Evidence` and `Schegent: Delete Run
// Evidence`. Neither existed. `exportRunEvidence` and `deleteRunEvidence` were
// fully implemented in `src/services/`, carried twenty unit tests between them,
// and had no production caller anywhere — no manifest entry, no IPC handler, no
// registration. A reader followed the instruction, found nothing in the palette,
// and had no way to know which half was wrong.
//
// This module is deliberately THIN. The services own the behaviour, including
// every refusal, and they are not re-litigated here (FR-R3-127 A3). What this adds
// is the three inputs a palette invocation has to supply and the rendering of an
// outcome union.
//
// WHY THE OUTCOME IS RENDERED ARM BY ARM. `deleteRunEvidence` distinguishes
// "removed", "refused because a writer is live", "refused, there was nothing", and
// "removed some, and here is what it could not touch". Collapsing those into a
// grade would make "refused" and "nothing was there" read the same, and those are
// opposite facts — the same argument `HistoryEvidencePanel`'s docblock makes for
// its five arms.
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { deleteRunEvidence, type DeleteOutcome } from '../services/evidence-delete';
import { exportRunEvidence, type ExportResult } from '../services/evidence-export';

/** The run-id shape both services already enforce; checked early so the prompt can. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EvidenceCommandDeps {
  readonly workspaceRoot: string;
  /**
   * Whether a Run is still executing.
   *
   * FR-R3-127 A2a — this must be the SAME probe `src/activation/run-safety-wiring.ts`
   * wires for checkpoint attribution: the non-terminal count over the store's Run
   * map. Two definitions of "still executing" is how one of them comes to permit a
   * delete the other would refuse.
   */
  readonly isRunActive: (runId: string) => boolean;
  /** Absent argument path: ask for the Run id. Injected so the handler is testable. */
  readonly promptForRunId: () => Promise<string | undefined>;
  /** Where an export is written. Injected for the same reason. */
  readonly promptForDestination: () => Promise<string | undefined>;
  /**
   * Modal confirmation before a delete.
   *
   * The pattern is the one already in `run-safety-wiring.ts`: a modal warning with
   * a detail body and an explicit approve label. A destructive command reachable
   * from the palette by fuzzy match is not "an operator action on their own
   * evidence" unless they are asked (constitution IV).
   */
  readonly confirmDelete: (runId: string) => Promise<boolean>;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  /** Audit sink for the deletion, using the service's own outcome vocabulary. */
  readonly auditDeletion: (runId: string, outcome: DeleteOutcome) => Promise<void>;
}

/** `.schegent/` is the evidence store; an export written into it is a loop. */
export function destinationIsInsideEvidenceStore(destination: string): boolean {
  return /(^|[\\/])\.schegent([\\/]|$)/.test(destination);
}

async function resolveRunId(
  provided: unknown,
  deps: EvidenceCommandDeps
): Promise<string | null> {
  const candidate =
    typeof provided === 'string' && provided.length > 0 ? provided : await deps.promptForRunId();
  if (candidate === undefined || candidate.trim().length === 0) return null;
  const runId = candidate.trim();
  if (!RUN_ID.test(runId)) {
    // Refused here as well as in the service, because the operator typed it and
    // the message they need is about what they typed.
    void deps.notifier.warn(
      `Schegent: '${runId.slice(0, 60)}' is not a Run id. A Run id is the UUID shown in the run ` +
        'detail and in history.'
    );
    return null;
  }
  return runId;
}

/**
 * `Schegent: Export Run Evidence`.
 *
 * Writes an archive plus a manifest of exactly what it contains and what it
 * deliberately omits — which is what the disclosure page has always said it does.
 */
export async function runExportRunEvidenceCommand(
  deps: EvidenceCommandDeps,
  providedRunId?: unknown
): Promise<ExportResult | null> {
  const runId = await resolveRunId(providedRunId, deps);
  if (runId === null) return null;

  const destination = await deps.promptForDestination();
  if (destination === undefined || destination.length === 0) return null;
  if (destinationIsInsideEvidenceStore(destination)) {
    // Two reasons, and the second is the one that matters: it is a loop, and it is
    // a way to move unredacted content past a retention sweep by parking a copy
    // where the sweep does not look for archives.
    void deps.notifier.warn(
      'Schegent: refusing to export into `.schegent/`. That is the evidence store this export ' +
        'reads from; choose a directory outside it.'
    );
    return null;
  }

  const result = await exportRunEvidence(deps.workspaceRoot, runId, destination);
  if (result.outcome === 'exported') {
    void deps.notifier.warn(
      `Schegent: exported evidence for run ${runId} to ${result.directory}. The manifest beside ` +
        'the archive lists what it contains and what was deliberately omitted.'
    );
  } else {
    void deps.notifier.warn(`Schegent: export refused (${result.reason}). ${result.detail}`);
  }
  deps.logger.info(`evidence export for ${runId}: ${result.outcome}`);
  return result;
}

/**
 * `Schegent: Delete Run Evidence`.
 *
 * Reports what it removed **and** what it could not, and refuses rather than
 * racing a live writer — both properties belong to `deleteRunEvidence` and neither
 * is weakened here.
 */
export async function runDeleteRunEvidenceCommand(
  deps: EvidenceCommandDeps,
  providedRunId?: unknown
): Promise<DeleteOutcome | null> {
  const runId = await resolveRunId(providedRunId, deps);
  if (runId === null) return null;

  if (!(await deps.confirmDelete(runId))) {
    deps.logger.info(`evidence deletion for ${runId}: declined at confirmation`);
    return null;
  }

  const outcome = await deleteRunEvidence(deps.workspaceRoot, runId, {
    isRunActive: deps.isRunActive
  });
  await deps.auditDeletion(runId, outcome);

  // Arm by arm. See the module docblock.
  if (outcome.outcome === 'completed') {
    const retained = outcome.retained.length;
    void deps.notifier.warn(
      retained === 0
        ? `Schegent: removed ${outcome.removed.length} evidence artifact(s) for run ${runId}.`
        : `Schegent: removed ${outcome.removed.length} artifact(s) for run ${runId}; ${retained} ` +
            `could not be removed. First: ${outcome.retained[0]!.path} (${outcome.retained[0]!.reason}).`
    );
  } else if (outcome.reason === 'active-writer') {
    void deps.notifier.warn(
      `Schegent: refused to delete evidence for run ${runId} — ${outcome.artifact}. Nothing was ` +
        'removed. Wait for the Run to reach a terminal state and try again.'
    );
  } else if (outcome.reason === 'no-evidence') {
    // NOT the same as a refusal to act: there was nothing to act on.
    void deps.notifier.warn(
      `Schegent: no evidence is held for run ${runId}. Nothing to remove.`
    );
  } else {
    void deps.notifier.warn(`Schegent: ${outcome.artifact}`);
  }
  deps.logger.info(`evidence deletion for ${runId}: ${outcome.outcome}`);
  return outcome;
}
