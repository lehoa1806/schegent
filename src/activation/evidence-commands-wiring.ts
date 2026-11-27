// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers
// commands through `registerGuardedCommand`; the registrations themselves
// perform nothing, and each handler re-checks trust at the point of effect, the
// same as every other registration in `ui-wiring.ts`.
//
// FR-R4-F04 (TA4) — the evidence commands, extracted out of `registerStage2Ui()`
// together.
//
// WHY THESE THREE. Export Audit Log, Export Run Evidence and Delete Run Evidence
// are one subject: the operator's way to take evidence out of the workspace or
// remove it. Later stories of this feature add the diagnostics bundle and the
// pseudonym reset to the same subject, so their registrations belong in one
// module and not scattered through the Stage 2 command list.
//
// WHY EXTRACTED AT ALL. `registerStage2Ui()` measures 398 of the 400-line
// composition-root bound (`tests/lint/source-loc-budget.test.ts`), so nothing
// could be added to the evidence commands inline: the same forcing function that
// produced `audit-commands-wiring.ts` under feature 250, and the response that
// gate's own message asks for. `registerStage2Ui` spreads the result, so it
// shrinks. The handlers, the confirmation modal and the audit append moved
// unchanged.

import * as vscode from 'vscode';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { runExportAuditLog } from '../commands/export-audit';
import { exportOutcomePayload } from '../contracts/evidence-export-outcome';
import { RESET_OPERATOR_PSEUDONYM_TEXT, runResetOperatorPseudonym } from '../commands/reset-operator-pseudonym';
import type { OperatorAttribution } from '../lib/operator-attribution';
import {
  DELETE_EVIDENCE_TEXT,
  runDeleteRunEvidenceCommand,
  runExportRunEvidenceCommand,
  type EvidenceCommandDeps
} from '../commands/evidence-commands';
import { readGeneralSettings, type GeneralSettingsConfig } from '../config/general-settings';
import {
  RAW_CONVERSATION_TEXT,
  runCreateDiagnosticsBundle,
  type BundlePreviewAnswer,
  type BundleRunChoice
} from '../commands/create-diagnostics-bundle';
import type { SanitizedLogger } from '../lib/logger';
import type { RuntimeLogAccessor } from '../lib/runtime-log/runtime-log-settings';
import type { TransportRouter } from '../monitor/transport/transport-router';
import type { BundleSources } from '../services/diagnostics-bundle/bundle-collect';
import { readBuildIdentity } from '../lib/build-identity';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';
import type { Notifier } from '../ui/notifications';

export interface EvidenceCommandsWiringDeps {
  readonly workspaceRoot: string;
  readonly store: Pick<WorkspaceStateStore, 'getRunMap' | 'getQueueStates'>;
  /** FR-R4-F04 (B1) — Run history, so the bundle's Run pick lists a Run whose queue request was removed. */
  readonly historyStore: Pick<HistoryStore, 'list'>;
  readonly auditWriter: AuditLogWriter;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  /**
   * FR-R4-F04 (D4) — the extension's private storage root, `context.globalStorageUri.fsPath`, where each
   * Run's recovery checkpoint lives and the deletion removes it.
   */
  readonly globalStorageRoot: string;
  /**
   * FR-R4-F04 (D5) — the transport router, asked when the shared legacy transport ages out. `measure()`
   * runs before the confirmation so the answer is current and not the last Run end's.
   */
  readonly transportRouter: Pick<TransportRouter, 'legacyAgesOutBy' | 'measure'>;
  /** FR-R4-F04 (P4) — the operator attribution, which the reset command replaces. */
  readonly operatorAttribution: Pick<OperatorAttribution, 'reset'>;
  /** FR-R4-F04 (B3) — the runtime log's place, for the diagnostics bundle's lines for one Run. */
  readonly runtimeLogAccessor: Pick<RuntimeLogAccessor, 'read'>;
}

/**
 * FR-R3-127 — the three inputs a palette invocation has to supply, assembled in
 * one place so both evidence commands read the same answers.
 *
 * `isRunActive` is the SAME probe `run-safety-wiring.ts` wires for checkpoint
 * attribution — the non-terminal count over the store's Run map. Two definitions
 * of "still executing" is how one of them comes to permit a delete the other
 * would refuse.
 */
function evidenceCommandDeps(deps: EvidenceCommandsWiringDeps): EvidenceCommandDeps {
  return {
    workspaceRoot: deps.workspaceRoot,
    isRunActive: (runId) =>
      Object.values(deps.store.getRunMap()).some(
        (run) => run.id === runId && !isTerminalRunStatus(run.status)
      ),
    promptForRunId: async () =>
      vscode.window.showInputBox({
        title: 'Run id',
        prompt: 'The UUID shown in the run detail and in history',
        ignoreFocusOut: true
      }),
    // FR-R4-F04 (E4) — the dialog opens in the home directory the command passes, and answers a URI-like
    // value (scheme and path) so the command can refuse a non-local destination before anything is made.
    promptForDestination: async (suggestedPath) => {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(suggestedPath),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Export here'
      });
      const first = picked?.[0];
      return first === undefined ? undefined : { scheme: first.scheme, fsPath: first.fsPath };
    },
    // FR-R4-F04 (E1) — one outcome, one row, through the writer's own append.
    auditExport: async (runId, outcome) => {
      await deps.auditWriter.append({
        runId,
        phase: 'operator',
        iteration: 0,
        eventType: 'evidence-exported',
        outcome: 'info',
        payload: { ...exportOutcomePayload(outcome) }
      });
    },
    // The modal pattern already used by `run-safety-wiring.ts` for the mutation
    // approval, rather than a second one. A destructive command reachable from the
    // palette by fuzzy match is not an operator decision unless they are asked.
    // FR-R4-F04 (O1) — the text is the table's, which says what is removed and what is kept and never
    // "all local evidence". The Run id is a validated UUID, so it can sit in the detail.
    confirmDelete: async (runId) => {
      await deps.transportRouter.measure();
      const answer = await vscode.window.showWarningMessage(
        DELETE_EVIDENCE_TEXT.confirmPrompt,
        { modal: true, detail: `Run ${runId}. ${DELETE_EVIDENCE_TEXT.confirmDetail}` },
        DELETE_EVIDENCE_TEXT.confirmLabel
      );
      return answer === DELETE_EVIDENCE_TEXT.confirmLabel;
    },
    checkpointRoot: deps.globalStorageRoot,
    legacyAgesOutBy: () => deps.transportRouter.legacyAgesOutBy(),
    showRetainedItems: async (rows) => {
      await vscode.window.showQuickPick([...rows], { title: DELETE_EVIDENCE_TEXT.retainedViewTitle });
    },
    notifier: deps.notifier,
    logger: deps.logger,
    auditDeletion: async (runId, outcome) => {
      await deps.auditWriter.append({
        runId,
        phase: 'operator',
        iteration: 0,
        eventType: 'evidence-deleted',
        // `info` for a refusal too: the refusal is the mechanism working, not a
        // failure of it, and `AuditOutcome` has no third word for that.
        outcome: 'info',
        payload:
          outcome.outcome === 'completed'
            ? { artifacts: outcome.removed.length, retained: outcome.retained.length }
            : { artifacts: 0, refusedReason: outcome.reason }
      });
    }
  };
}

/** The most characters of a Task's description shown in the Run pick; it is sanitized first. */
const RUN_LABEL_MAX = 60;
const UNKNOWN_VERSION = 'unknown';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * FR-R4-F04 (B1) — the Runs a bundle can be made for, newest first: every Run a queue request names, and
 * every Run history names (a removed request leaves its Run's history row, failure record and audit rows
 * behind). Each is labelled by its description (sanitized, collapsed, cut) and status; a Run both name is
 * listed once, from its request.
 */
export function bundleRunChoices(
  deps: Pick<EvidenceCommandsWiringDeps, 'store' | 'historyStore'> & { readonly logger: Pick<SanitizedLogger, 'sanitize'> }
): BundleRunChoice[] {
  const choice = (runId: string, description: string, status: string, at: number) => {
    const title = deps.logger.sanitize(description).replace(/\s+/g, ' ').trim().slice(0, RUN_LABEL_MAX);
    return { at, choice: { runId, label: `${title.length > 0 ? title : 'Untitled Task'} (${status})`, status } };
  };
  const byRun = new Map<string, ReturnType<typeof choice>>();
  for (const request of Object.values(deps.store.getQueueStates()).flatMap((queue) => queue.requests)) {
    if (typeof request.runId === 'string' && request.runId.length > 0) {
      byRun.set(request.runId, choice(request.runId, request.description, request.status, request.updatedAt));
    }
  }
  for (const record of deps.historyStore.list()) {
    if (record.runId.length > 0 && !byRun.has(record.runId)) {
      byRun.set(record.runId, choice(record.runId, record.descriptionPreview, record.terminalStatus, Date.parse(record.completedAt)));
    }
  }
  return [...byRun.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).map((entry) => entry.choice);
}

/**
 * FR-R4-F04 (FR-034) — the one Run's status as a projection of closed values and counts: no description, no
 * error text. The Run record is read from the run map when it is still there, and the queue request's own
 * status is added; a Run neither knows is `null`, which the plan lists as "nothing recorded".
 */
function bundleRunStatus(deps: EvidenceCommandsWiringDeps, runId: string): Record<string, unknown> | null {
  const run = Object.values(deps.store.getRunMap()).find((candidate) => candidate.id === runId);
  const request = Object.values(deps.store.getQueueStates())
    .flatMap((queue) => queue.requests)
    .find((candidate) => candidate.runId === runId);
  // A Run listed from history alone (B1) still has its terminal status there.
  const record = run === undefined && request === undefined ? deps.historyStore.list().find((entry) => entry.runId === runId) : undefined;
  if (run === undefined && request === undefined) return record === undefined ? null : { historyStatus: record.terminalStatus };
  return {
    ...(request === undefined ? {} : { taskStatus: request.status, retryCount: request.retryCount }),
    ...(run === undefined
      ? {}
      : {
          status: run.status,
          currentPhase: run.currentPhase,
          currentIteration: run.currentIteration,
          startedAt: new Date(run.startedAt).toISOString(),
          lastTransitionAt: new Date(run.lastTransitionAt).toISOString(),
          phasesCompleted: run.phasesCompleted.length,
          ...(run.failureCause === undefined ? {} : { failureCause: run.failureCause }),
          ...(run.lastError === null ? {} : { lastErrorCode: run.lastError.code, lastErrorPhase: run.lastError.phase })
        })
  };
}

function bundleSources(deps: EvidenceCommandsWiringDeps): BundleSources {
  return {
    workspaceRoot: deps.workspaceRoot,
    sanitize: (text) => deps.logger.sanitize(text),
    sanitizeRecord: (record) => deps.logger.sanitizeRecord(record),
    // The version is shown in the bundle, so it is accepted by pattern and nothing else.
    hostVersion: (() => {
      const version: unknown = vscode.extensions.getExtension('schegent.schegent')?.packageJSON?.version;
      return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : UNKNOWN_VERSION;
    })(),
    // FR-R4-F09 (BI4): the commit and mode esbuild stamped into this bundle, or `unknown`.
    hostBuild: readBuildIdentity(),
    hostSettings: () =>
      ({
        ...readGeneralSettings(
          vscode.workspace.getConfiguration('schegent', vscode.Uri.file(deps.workspaceRoot)) as unknown as GeneralSettingsConfig
        )
      }) as Record<string, unknown>,
    runStatus: (runId) => bundleRunStatus(deps, runId),
    runtimeLog: () => {
      const settings = deps.runtimeLogAccessor.read();
      return settings === null ? null : { path: settings.path, maxGenerations: settings.maxGenerations };
    }
  };
}

const PREVIEW_ACTIONS: ReadonlyArray<{ readonly label: string; readonly answer: BundlePreviewAnswer }> = [
  { label: 'Create bundle', answer: 'create' },
  { label: 'Include raw conversation…', answer: 'include-raw' },
  { label: 'Cancel', answer: 'cancel' }
];

/** Register the evidence commands (the two exports, the deletion, the pseudonym reset and the diagnostics bundle) through the guarded registration; each handler re-checks trust at the point of effect. */
export function registerEvidenceCommands(
  guard: GuardedCommandDeps,
  deps: EvidenceCommandsWiringDeps
): vscode.Disposable[] {
  return [
    registerGuardedCommand(guard, 'schegent.exportAuditLog', () =>
      runExportAuditLog({
        workspaceRoot: deps.workspaceRoot,
        notifier: deps.notifier,
        auditWriter: deps.auditWriter,
        // FR-R4-F04 (E4) — the save dialog starts in the home directory, not the workspace.
        promptForTarget: async (suggestedPath) => {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggestedPath),
            filters: { 'JSON Lines': ['jsonl'] },
            saveLabel: 'Export metadata-only audit'
          });
          return target === undefined ? undefined : { scheme: target.scheme, fsPath: target.fsPath };
        }
      })
    ),
    // FR-R3-127 (FR-006) — the two commands
    // `docs/operations/evidence-retention-disclosure.md` has promised since
    // FR-R3-085. The services existed, tested, with no caller; nothing declared
    // them, so a reader following that page found an empty palette.
    // `tests/lint/documented-commands-exist.test.ts` is what stops that recurring.
    registerGuardedCommand(guard, 'schegent.exportRunEvidence', (runId?: unknown) =>
      runExportRunEvidenceCommand(evidenceCommandDeps(deps), runId)
    ),
    registerGuardedCommand(guard, 'schegent.deleteRunEvidence', (runId?: unknown) =>
      runDeleteRunEvidenceCommand(evidenceCommandDeps(deps), runId)
    ),
    // FR-R4-F04 (FR-028, P4) — replaces the operator pseudonym after a modal, recording the reset first.
    registerGuardedCommand(guard, 'schegent.resetOperatorPseudonym', () =>
      runResetOperatorPseudonym({
        confirm: async () => {
          const answer = await vscode.window.showWarningMessage(
            RESET_OPERATOR_PSEUDONYM_TEXT.confirmPrompt,
            { modal: true, detail: RESET_OPERATOR_PSEUDONYM_TEXT.confirmDetail },
            RESET_OPERATOR_PSEUDONYM_TEXT.confirmLabel
          );
          return answer === RESET_OPERATOR_PSEUDONYM_TEXT.confirmLabel;
        },
        auditWriter: deps.auditWriter,
        attribution: deps.operatorAttribution,
        notifier: deps.notifier
      })
    ),
    // FR-R4-F04 (FR-034, FR-035) — one Run's bundle: pick, preview, optional raw warning, save dialog.
    registerGuardedCommand(guard, 'schegent.createDiagnosticsBundle', () =>
      runCreateDiagnosticsBundle({
        workspaceRoot: deps.workspaceRoot,
        sources: bundleSources(deps),
        listRuns: () => bundleRunChoices(deps),
        pickRun: async (choices) => {
          const answer = await vscode.window.showQuickPick(
            choices.map((choice) => ({ label: choice.label, description: choice.runId, choice })),
            { title: 'Create Diagnostics Bundle: choose a Run', matchOnDescription: true, ignoreFocusOut: true }
          );
          return answer?.choice;
        },
        // Every row is read-only text; the three actions follow it, and a dismissal is a cancel.
        preview: async (rows) => {
          const answer = await vscode.window.showQuickPick(
            [
              ...rows.map((row) => ({ label: row, answer: undefined })),
              ...PREVIEW_ACTIONS.map((action) => ({ label: action.label, answer: action.answer, alwaysShow: true }))
            ],
            { title: 'Diagnostics bundle: what will be included', ignoreFocusOut: true }
          );
          return answer?.answer ?? 'cancel';
        },
        confirmRaw: async () => {
          const answer = await vscode.window.showWarningMessage(
            RAW_CONVERSATION_TEXT.prompt,
            { modal: true, detail: RAW_CONVERSATION_TEXT.detail },
            RAW_CONVERSATION_TEXT.confirmLabel
          );
          return answer === RAW_CONVERSATION_TEXT.confirmLabel;
        },
        // The save dialog starts in the home directory (E4), as the exports' do.
        promptForTarget: async (suggestedPath) => {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggestedPath),
            filters: { JSON: ['json'] },
            saveLabel: 'Save diagnostics bundle'
          });
          return target === undefined ? undefined : { scheme: target.scheme, fsPath: target.fsPath };
        },
        auditWriter: deps.auditWriter,
        notifier: deps.notifier
      })
    )
  ];
}
