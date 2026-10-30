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
import * as os from 'node:os';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { ExportOutcome, ExportRefusal as ExportRefusalCode } from '../contracts/evidence-export-outcome';
import { deleteRunEvidence, type DeleteOutcome, type KeptStore } from '../services/evidence-delete';
import { exportRunEvidence, type ExportResult } from '../services/evidence-export';
import { resolveExportDestination, type ExportDestinationUri } from '../services/export-destination';

/**
 * FR-R4-F04 (contracts O1, O2) — what the deletion says, in one table beside the code that shows it, as
 * `RESET_AUDIT_CHECKPOINT_TEXT` does, so the modal, the notice and their tests read one copy. The facts a
 * text carries are fixed; a count or a date is filled in, and no path, file content or OS identifier ever
 * is. The confirmation must not say "all local evidence": that was the claim the product could not keep.
 */
export const DELETE_EVIDENCE_TEXT = {
  confirmPrompt: "Delete this Run's evidence?",
  confirmDetail:
    "Removes, for this Run only: its session directory (transport included), raw transcripts, verbose " +
    'diagnostics, failure records and private recovery checkpoint. Keeps: the shared audit log, the ' +
    'runtime log, the metrics rollup, Run history, and any shared legacy transport file until it ages ' +
    'out. This cannot be undone.',
  confirmLabel: 'Delete evidence',
  result: (removed: number, retained: number): string =>
    `Deleted ${removed} item(s) of this Run's evidence. ${retained} item(s) were kept.`,
  showRetainedAction: 'Show retained items',
  notRecorded: 'This deletion was not recorded in the audit log.',
  retainedViewTitle: 'Retained after deleting this Run\'s evidence',
  /** The label of each kept store in the retained-items view. */
  keptStore: {
    'audit-log': 'Audit log — shared by every Run, never deleted by a Run\'s deletion',
    'runtime-log': 'Runtime log — host diagnostics, aged by its own settings',
    'metrics-rollup': 'Metrics rollup — cumulative totals across Runs',
    'run-history': 'Run history — kept so the Run stays listed'
  },
  legacyTransport: (agesOutBy: string | null): string =>
    agesOutBy === null
      ? 'Legacy transport — the shared file an earlier release wrote, kept until it ages out'
      : `Legacy transport — the shared file an earlier release wrote; ages out ${agesOutBy.slice(0, 10)}`
} as const;

/**
 * FR-R4-F04 (contracts O5, O6) — what an export says when it could not be recorded or was refused. One
 * table beside the commands that show it (the Run export, the audit export and the diagnostics bundle all
 * read it), filled with nothing: a code selects a sentence, and no path or content is ever interpolated.
 */
export const EXPORT_TEXT = {
  /** The write completed and the audit append did not (E6): the output stays. */
  notRecorded: 'Exported. The export was not recorded in the audit log; see the audit health notice.',
  refusal: {
    'destination-in-evidence-store':
      'That destination is inside the Schegent evidence store. Choose a folder outside `.schegent`.',
    'destination-not-local-file': 'Exports are written only to a local file. Choose a local destination.',
    'destination-unresolvable': 'That destination could not be resolved. Choose another.',
    'no-evidence': 'No evidence found for that Run.',
    'invalid-run-id': 'That is not a Run id.',
    'write-failed': 'The export could not be written. Some files may remain at the destination.'
  } satisfies Readonly<Record<ExportRefusalCode, string>>
} as const;

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
  /**
   * Where an export is written. Injected for the same reason. It is handed the home directory, where the
   * dialog starts (E4), and answers the operator's choice as a URI-like value, so the scheme can be checked
   * before anything is created (E3).
   */
  readonly promptForDestination: (suggestedPath: string) => Promise<ExportDestinationUri | undefined>;
  /** FR-R4-F04 (E4) — the home directory the folder dialog opens in. Defaults to the OS answer. */
  readonly homeDirectory?: () => string;
  /**
   * FR-R4-F04 (FR-020, E1) — records one export outcome in the audit log, through the writer's own append.
   * The Run's id for an outcome about a Run, and `''` for one that names none.
   */
  readonly auditExport: (runId: string, outcome: ExportOutcome) => Promise<void>;
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
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn' | 'sanitize'>;
  /** Audit sink for the deletion, using the service's own outcome vocabulary. */
  readonly auditDeletion: (runId: string, outcome: DeleteOutcome) => Promise<void>;
  /**
   * FR-R4-F04 (D4) — the extension's private storage, where a Run's recovery checkpoint lives. The
   * deletion removes that checkpoint with the Run's workspace evidence.
   */
  readonly checkpointRoot: string;
  /** FR-R4-F04 (D5) — when the shared legacy transport ages out, or `null` when none exists. */
  readonly legacyAgesOutBy: () => string | null;
  /** FR-R4-F04 (O2) — opens the retained-items view: one row per retained item, then per kept store. */
  readonly showRetainedItems: (rows: readonly string[]) => Promise<void>;
}

/** `.schegent/` is the evidence store; an export written into it is a loop. */
export function destinationIsInsideEvidenceStore(destination: string): boolean {
  return /(^|[\\/])\.schegent([\\/]|$)/.test(destination);
}

type RunIdReading =
  | { readonly status: 'dismissed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly runId: string };

async function readRunId(provided: unknown, deps: EvidenceCommandDeps): Promise<RunIdReading> {
  const candidate =
    typeof provided === 'string' && provided.length > 0 ? provided : await deps.promptForRunId();
  if (candidate === undefined || candidate.trim().length === 0) return { status: 'dismissed' };
  const runId = candidate.trim();
  if (!RUN_ID.test(runId)) {
    // Refused here as well as in the service, because the operator typed it and
    // the message they need is about what they typed.
    void deps.notifier.warn(
      `Schegent: '${runId.slice(0, 60)}' is not a Run id. A Run id is the UUID shown in the run ` +
        'detail and in history.'
    );
    return { status: 'invalid' };
  }
  return { status: 'ok', runId };
}

async function resolveRunId(provided: unknown, deps: EvidenceCommandDeps): Promise<string | null> {
  const reading = await readRunId(provided, deps);
  return reading.status === 'ok' ? reading.runId : null;
}

/**
 * Record one export outcome. `true` when it landed. A failed append is logged without its message (it has
 * already taken the audit-health path inside the writer) and never undoes what was written (E6).
 */
async function recordExport(deps: EvidenceCommandDeps, runId: string, outcome: ExportOutcome): Promise<boolean> {
  try {
    await deps.auditExport(runId, outcome);
    return true;
  } catch {
    deps.logger.warn('evidence export: the audit append failed; the export is not recorded');
    return false;
  }
}

/** The contract's refusal code for a service refusal. A planted link is a write that could not be made. */
function refusalCodeFor(reason: Extract<ExportResult, { outcome: 'refused' }>['reason']): ExportRefusalCode {
  if (reason === 'no-evidence' || reason === 'invalid-run-id') return reason;
  return 'write-failed';
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
  const reading = await readRunId(providedRunId, deps);
  if (reading.status === 'dismissed') return null;
  if (reading.status === 'invalid') {
    // The operator made a request and it was refused: one row, naming no Run (FR-020, E1).
    await recordExport(deps, '', { kind: 'run-evidence', outcome: 'refused', included: 0, omitted: 0, refusal: 'invalid-run-id' });
    return null;
  }
  const { runId } = reading;

  const picked = await deps.promptForDestination((deps.homeDirectory ?? os.homedir)());
  // A dismissed dialog decided nothing, and records nothing.
  if (picked === undefined || picked.fsPath.length === 0) return null;
  const destination = await resolveExportDestination(picked, deps.workspaceRoot);
  if (!destination.ok) {
    // Two reasons a destination in `.schegent/` is refused, and the second is the one that matters: it is
    // a loop, and it is a way to move unredacted content past a retention sweep by parking a copy where the
    // sweep does not look for archives. The same check refuses a link that RESOLVES there (E3).
    await recordExport(deps, runId, { kind: 'run-evidence', outcome: 'refused', included: 0, omitted: 0, refusal: destination.refusal });
    void deps.notifier.warn(`Schegent: export refused. ${EXPORT_TEXT.refusal[destination.refusal]}`);
    return null;
  }

  const result = await exportRunEvidence(deps.workspaceRoot, runId, destination.path);
  if (result.outcome === 'exported') {
    const recorded = await recordExport(deps, runId, {
      kind: 'run-evidence',
      outcome: 'exported',
      included: result.manifest.contents.length,
      omitted: result.manifest.deliberateOmissions.length
    });
    void deps.notifier.warn(
      `Schegent: exported evidence for run ${runId} to ${result.directory}. The manifest beside ` +
        'the archive lists what it contains and what was deliberately omitted.'
    );
    if (!recorded) void deps.notifier.warn(EXPORT_TEXT.notRecorded);
  } else {
    const refusal = refusalCodeFor(result.reason);
    await recordExport(deps, runId, { kind: 'run-evidence', outcome: 'refused', included: 0, omitted: 0, refusal });
    void deps.notifier.warn(`Schegent: export refused. ${EXPORT_TEXT.refusal[refusal]}`);
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
    isRunActive: deps.isRunActive,
    checkpointRoot: deps.checkpointRoot,
    legacyAgesOutBy: deps.legacyAgesOutBy
  });
  // FR-R4-F04 (D7) — the result is shown whether or not the audit append succeeds. The deletion has
  // happened by now, and an operator who is told nothing because a log write failed would not know
  // whether their evidence is gone. A failed append is logged without its message and says so in the
  // notice; `AuditLogWriter.append` has already taken it down the audit-health path.
  let recorded = true;
  try {
    await deps.auditDeletion(runId, outcome);
  } catch {
    recorded = false;
    deps.logger.warn(`evidence deletion for ${runId}: the audit append failed; the deletion is not recorded`);
  }

  // Arm by arm. See the module docblock.
  if (outcome.outcome === 'completed') {
    const text = recorded
      ? DELETE_EVIDENCE_TEXT.result(outcome.removed.length, outcome.retained.length)
      : `${DELETE_EVIDENCE_TEXT.result(outcome.removed.length, outcome.retained.length)} ${DELETE_EVIDENCE_TEXT.notRecorded}`;
    // Not awaited: a toast stays until the operator closes it, and a command whose promise waits on that
    // would hold every programmatic caller. The view opens when, and only when, they ask for it.
    void deps.notifier.warn(text, DELETE_EVIDENCE_TEXT.showRetainedAction).then(async (picked) => {
      if (picked === DELETE_EVIDENCE_TEXT.showRetainedAction) {
        await deps.showRetainedItems(retainedItemRows(outcome, (label) => deps.logger.sanitize(label)));
      }
    });
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

/**
 * The rows of the retained-items view (O2): one per retained item, as `<path> — <reason>`, then one per
 * kept store, the legacy transport carrying the date it ages out. Every label passes through the UI
 * sanitizer, because a retained path is a file name an operator or a workspace chose (hard rule 2).
 */
export function retainedItemRows(
  outcome: Extract<DeleteOutcome, { outcome: 'completed' }>,
  sanitize: (label: string) => string
): readonly string[] {
  const keptLabel = (kept: KeptStore): string =>
    kept.store === 'legacy-transport'
      ? DELETE_EVIDENCE_TEXT.legacyTransport(kept.agesOutBy)
      : DELETE_EVIDENCE_TEXT.keptStore[kept.store];
  return [
    ...outcome.retained.map((item) => sanitize(`${item.path} — ${item.reason}`)),
    ...outcome.keptStores.map((kept) => sanitize(keptLabel(kept)))
  ];
}
