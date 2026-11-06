// FR-R4-F03 (FR-017; contract O2; R17) — `Schegent: Reset Audit History Checkpoint`.
//
// WHAT IT IS FOR. The head checkpoint is kept outside the workspace, so once audit history is lost, or
// removed on purpose, the checkpoint keeps saying "established history existed here" and the loss finding
// would last for ever (the owner finds it again at its first append after every restart). The reset
// retires the checkpoint so the history that follows can begin, and that next history's first row is a
// reset record, so the history itself shows the reset.
//
// WHAT IT NEVER DOES. It never deletes or moves evidence. While ANY `audit.log*` file is present it
// refuses, and tells the operator to move the history out of `.schegent/` first (hard rule 9, FR-004).
// It asks for modal confirmation, and it writes nothing at all when the operator cancels.
//
// WHO MAY RUN IT. It is a mutating, owner-only command (`OWNER_ONLY_COMMAND_IDS`): untrusted, it is
// refused by the guard with the trust refusal; in a window that is not the owner, with the palette
// wording. Both checks live in `registerGuardedCommand`, so this module asks neither, and the writer's
// `retireCheckpoint()` asks the authority again inside its own step, so a window that lost ownership
// during the modal still writes nothing.
import * as path from 'path';
import * as vscode from 'vscode';
import { collectChainFiles } from '../audit/audit-chain';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Notifier } from '../ui/notifications';

/** Exported so tests pin the module's own wording rather than a copy of it. */
export const RESET_AUDIT_CHECKPOINT_TEXT = {
  filesPresent:
    'Schegent: audit history is still present under .schegent/. Move the audit history out of .schegent/ ' +
    'first; this command never deletes or moves evidence.',
  absent: 'Schegent: there is no audit history checkpoint to reset.',
  confirmPrompt:
    'Reset the audit history checkpoint? Loss detection stops treating the removed history as expected, ' +
    'and the next recorded event starts a new history. This cannot be undone.',
  confirmLabel: 'Reset Checkpoint',
  done:
    'Schegent: the audit history checkpoint was retired. The next recorded event starts a new history, ' +
    'beginning with a reset record.',
  notOwner: 'Schegent: another window holds the workspace lock; ignoring request.',
  unavailable:
    'Schegent: the audit history checkpoint could not be read or written, so it was not reset. Nothing ' +
    'was changed.'
} as const;

export interface ResetAuditCheckpointDeps {
  readonly workspaceRoot: string;
  readonly notifier: Pick<Notifier, 'info' | 'warn'>;
  readonly writer: Pick<AuditLogWriter, 'readCheckpoint' | 'retireCheckpoint'>;
}

export async function runResetAuditCheckpoint(deps: ResetAuditCheckpointDeps): Promise<void> {
  const { notifier, writer } = deps;
  const auditDir = path.join(deps.workspaceRoot, '.schegent');

  // The pre-check, before any modal: a refusal and an empty answer should not ask a question.
  if (collectChainFiles(auditDir) !== null) {
    void notifier.warn(RESET_AUDIT_CHECKPOINT_TEXT.filesPresent);
    return;
  }
  const stored = await writer.readCheckpoint();
  if (stored.status === 'absent' || stored.status === 'retired') {
    notifier.info(RESET_AUDIT_CHECKPOINT_TEXT.absent);
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    RESET_AUDIT_CHECKPOINT_TEXT.confirmPrompt,
    { modal: true },
    RESET_AUDIT_CHECKPOINT_TEXT.confirmLabel
  );
  if (choice !== RESET_AUDIT_CHECKPOINT_TEXT.confirmLabel) return;

  // The step re-checks ownership and the chain files, so what it answers decides the message.
  const outcome = await writer.retireCheckpoint();
  switch (outcome) {
    case 'retired':
      notifier.info(RESET_AUDIT_CHECKPOINT_TEXT.done);
      return;
    case 'absent':
      notifier.info(RESET_AUDIT_CHECKPOINT_TEXT.absent);
      return;
    case 'files-present':
      void notifier.warn(RESET_AUDIT_CHECKPOINT_TEXT.filesPresent);
      return;
    case 'not-owner':
      void notifier.warn(RESET_AUDIT_CHECKPOINT_TEXT.notOwner);
      return;
    case 'unavailable':
      void notifier.warn(RESET_AUDIT_CHECKPOINT_TEXT.unavailable);
      return;
  }
}

export const REANCHOR_AUDIT_CHECKPOINT_TEXT = {
  noChain: 'Schegent: no audit history is present under .schegent/ to re-anchor a checkpoint against.',
  chainBroken:
    'Schegent: the audit chain under .schegent/ is not intact, so the checkpoint cannot be re-anchored.',
  confirmPrompt:
    'Re-anchor the audit history checkpoint to the current verified chain head in place? ' +
    'A checkpoint-reanchored record will be appended to the audit log.',
  confirmUnreadablePrompt:
    'The stored audit history checkpoint could not be read. Overwrite it and re-anchor to the current ' +
    'verified chain head? A checkpoint-reanchored record will be appended to the audit log.',
  confirmLabel: 'Re-anchor Checkpoint',
  done:
    'Schegent: the audit history checkpoint was re-anchored to the current verified chain head and a ' +
    'checkpoint-reanchored record was appended.',
  notOwner: 'Schegent: another window holds the workspace lock; ignoring request.',
  unavailable:
    'Schegent: the audit history checkpoint could not be re-anchored. Nothing was changed.'
} as const;

export interface ReanchorAuditCheckpointDeps {
  readonly workspaceRoot: string;
  readonly notifier: Pick<Notifier, 'info' | 'warn'>;
  readonly writer: Pick<AuditLogWriter, 'readCheckpoint' | 'reanchorCheckpoint'>;
}

export async function runReanchorAuditCheckpoint(deps: ReanchorAuditCheckpointDeps): Promise<void> {
  const { notifier, writer } = deps;
  const auditDir = path.join(deps.workspaceRoot, '.schegent');

  if (collectChainFiles(auditDir) === null) {
    notifier.info(REANCHOR_AUDIT_CHECKPOINT_TEXT.noChain);
    return;
  }
  const stored = await writer.readCheckpoint();
  if (stored.status === 'unreadable' && stored.reason === 'unreachable') {
    void notifier.warn(REANCHOR_AUDIT_CHECKPOINT_TEXT.unavailable);
    return;
  }
  const allowOverwriteUnreadable = stored.status === 'unreadable';
  const prompt = allowOverwriteUnreadable
    ? REANCHOR_AUDIT_CHECKPOINT_TEXT.confirmUnreadablePrompt
    : REANCHOR_AUDIT_CHECKPOINT_TEXT.confirmPrompt;
  const choice = await vscode.window.showWarningMessage(
    prompt,
    { modal: true },
    REANCHOR_AUDIT_CHECKPOINT_TEXT.confirmLabel
  );
  if (choice !== REANCHOR_AUDIT_CHECKPOINT_TEXT.confirmLabel) return;

  const outcome = await writer.reanchorCheckpoint({ allowOverwriteUnreadable });
  switch (outcome) {
    case 'reanchored':
      notifier.info(REANCHOR_AUDIT_CHECKPOINT_TEXT.done);
      return;
    case 'no-chain':
      notifier.info(REANCHOR_AUDIT_CHECKPOINT_TEXT.noChain);
      return;
    case 'chain-broken':
      void notifier.warn(REANCHOR_AUDIT_CHECKPOINT_TEXT.chainBroken);
      return;
    case 'not-owner':
      void notifier.warn(REANCHOR_AUDIT_CHECKPOINT_TEXT.notOwner);
      return;
    case 'unreadable-refused':
    case 'unavailable':
      void notifier.warn(REANCHOR_AUDIT_CHECKPOINT_TEXT.unavailable);
      return;
  }
}
