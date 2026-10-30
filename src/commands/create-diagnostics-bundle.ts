// FR-R4-F04 (FR-034, FR-035, B1, B2, B4, B7, B8; O7) — `Schegent: Create Diagnostics Bundle`.
//
// WHAT THE OPERATOR GETS. One JSON file for one Run they pick, holding what a person helping them needs and
// nothing that holds their conversation: the Run's status, its failure records, its metadata-only audit rows,
// the runtime-log lines that name it, and the host version and settings with secrets removed. Raw
// conversation (the transcript, the transport and the verbose diagnostic tree) is in only if they ask for it
// after a warning, per bundle, and the choice is never remembered.
//
// THE ORDER, AND WHERE IT CAN END. Pick a Run, see a preview of every item that will be in the bundle and
// every item that will not (nothing is read beyond a size until they accept), optionally take the raw
// warning (declining it returns to the preview), choose where to save, write. The operator can stop at the
// pick, the preview, the warning or the save dialog; each of those writes no file and no audit row, because
// nothing was decided. A refusal after they chose a destination is one `refused` row; a write is one
// `exported` row (E1), `included` counting the items written and `omitted` the items left out, raw items
// they declined among them.
//
// THE DESTINATION AND THE WRITE are the export's (E3, E5): `resolveExportDestination` decides before
// anything is created, and the file is opened through the checked walk, `0600`. The bundle is collected only
// after the destination is accepted, so a refused destination reads nothing.
//
// EVERYTHING VS CODE IS INJECTED. The pick, the preview, the warning and the save dialog arrive as functions,
// so this module is exercised end to end by `create-diagnostics-bundle.test.ts` without a window.

import * as os from 'node:os';
import * as path from 'node:path';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import { exportOutcomePayload, type ExportOutcome, type ExportRefusal } from '../contracts/evidence-export-outcome';
import { collectBundle, probeBundle, type BundleSources } from '../services/diagnostics-bundle/bundle-collect';
import { planBundle } from '../services/diagnostics-bundle/bundle-plan';
import { bundleFileName, serializeBundle, writeBundleFile } from '../services/diagnostics-bundle/bundle-write';
import { resolveExportDestination, type ExportDestinationUri } from '../services/export-destination';
import type { Notifier } from '../ui/notifications';
import { EXPORT_TEXT } from './evidence-commands';

/** One Run the operator may pick, already labelled with its sanitized Task title and status. */
export interface BundleRunChoice {
  readonly runId: string;
  readonly label: string;
  readonly status: string;
}

export type BundlePreviewAnswer = 'create' | 'include-raw' | 'cancel';

/** FR-035 (O7) — the raw-conversation warning, one place so the modal and the tests read the same words. */
export const RAW_CONVERSATION_TEXT = {
  prompt: 'Include raw conversation in this bundle?',
  detail:
    'The raw transcript, transport and verbose diagnostics hold your prompts, source and model output. ' +
    'Secret patterns are redacted, but everything else is included as it was. Share the bundle only with ' +
    'someone who may read that.',
  confirmLabel: 'Include raw conversation',
  backLabel: 'Back to preview'
} as const;

export const NO_RUNS_TEXT = 'Schegent: no Runs with evidence in this workspace.';
export const BUNDLE_WRITTEN_TEXT = 'Schegent: diagnostics bundle written.';

export interface CreateDiagnosticsBundleDeps {
  readonly workspaceRoot: string;
  readonly sources: BundleSources;
  /** Runs with evidence in this workspace, newest first (B1). */
  readonly listRuns: () => readonly BundleRunChoice[];
  readonly pickRun: (choices: readonly BundleRunChoice[]) => Promise<BundleRunChoice | undefined>;
  /** The preview QuickPick: every row, and the three actions. `cancel` is also a dismissal. */
  readonly preview: (rows: readonly string[]) => Promise<BundlePreviewAnswer>;
  /** O7's modal: `true` for "Include raw conversation", `false` for "Back to preview". */
  readonly confirmRaw: () => Promise<boolean>;
  readonly promptForTarget: (suggestedPath: string) => Promise<ExportDestinationUri | undefined>;
  /** The outcome is one row, through the writer's own append (E1). */
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly notifier: Notifier;
  /** Defaults to the OS answer; a test passes a temporary directory. */
  readonly homeDirectory?: () => string;
  readonly now?: () => Date;
}

/** One outcome, one row. `true` when it landed. */
async function recordOutcome(deps: CreateDiagnosticsBundleDeps, runId: string, outcome: ExportOutcome): Promise<boolean> {
  try {
    await deps.auditWriter.append({
      runId,
      phase: 'operator',
      iteration: 0,
      eventType: 'evidence-exported',
      outcome: 'info',
      payload: { ...exportOutcomePayload(outcome) }
    });
    return true;
  } catch {
    return false;
  }
}

/** Run the command: pick a Run, preview, the optional raw warning, the save dialog, the write, and one audit row. */
export async function runCreateDiagnosticsBundle(deps: CreateDiagnosticsBundleDeps): Promise<void> {
  const choices = deps.listRuns();
  if (choices.length === 0) {
    deps.notifier.info(NO_RUNS_TEXT);
    return;
  }
  const picked = await deps.pickRun(choices);
  if (picked === undefined) return;
  const { runId } = picked;

  // The preview loop: the plan is rebuilt when the operator takes the raw option, from the same probes.
  const probes = await probeBundle(deps.sources, runId);
  let includeRaw = false;
  let plan = planBundle(probes, includeRaw);
  for (;;) {
    const answer = await deps.preview(plan.previewRows);
    if (answer === 'cancel') return;
    if (answer === 'create') break;
    // `include-raw`: the warning is a decision; declining it changes nothing and shows the preview again.
    if (await deps.confirmRaw()) {
      includeRaw = true;
      plan = planBundle(probes, includeRaw);
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  const target = await deps.promptForTarget(path.join((deps.homeDirectory ?? os.homedir)(), bundleFileName(runId, now)));
  if (target === undefined || target.fsPath.length === 0) return;

  const refuse = async (refusal: ExportRefusal): Promise<void> => {
    await recordOutcome(deps, runId, { kind: 'diagnostics-bundle', outcome: 'refused', included: 0, omitted: plan.omitted.length, refusal });
    void deps.notifier.warn(`Schegent: export refused. ${EXPORT_TEXT.refusal[refusal]}`);
  };

  const destination = await resolveExportDestination(target, deps.workspaceRoot);
  if (!destination.ok) {
    await refuse(destination.refusal);
    return;
  }

  // Read only now, with the destination accepted: a refused destination has read nothing.
  const items = await collectBundle(deps.sources, runId, plan);
  const serialized = serializeBundle({
    runId,
    createdAt: now,
    hostVersion: deps.sources.hostVersion,
    rawConversationIncluded: includeRaw,
    items,
    omitted: plan.omitted
  });
  if (!(await writeBundleFile(destination.path, serialized.text))) {
    await refuse('write-failed');
    return;
  }

  const recorded = await recordOutcome(deps, runId, {
    kind: 'diagnostics-bundle',
    outcome: 'exported',
    included: items.length,
    omitted: plan.omitted.length
  });
  deps.notifier.info(BUNDLE_WRITTEN_TEXT);
  // The file stays whatever the append did (E6); the operator is told it was not recorded.
  if (!recorded) void deps.notifier.warn(EXPORT_TEXT.notRecorded);
}
