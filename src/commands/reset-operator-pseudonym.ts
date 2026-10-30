// FR-R4-F04 (FR-028, contract P4; O8, O9) — `Schegent: Reset Operator Pseudonym`.
//
// WHAT IT IS FOR. Audit rows name who acted with a per-workspace pseudonym (`pseudonym-<16 hex>`) in place
// of the OS account name. A pseudonym is stable, so rows by one operator are linkable to each other, and an
// operator who no longer wants that link to continue can replace it. Rows already written keep the pseudonym
// they carry (they cannot be rewritten without breaking the hash chain, FR-029); later rows carry the new one.
//
// THE ORDER IS THE POINT. The reset is recorded BEFORE the new pseudonym is stored. A reset that stored first
// and appended second could leave a new identity with no record that the old one was retired; one whose row
// carried either value would put the identifier it exists to replace into the evidence. So the row is empty
// (`payload: {}`), it is appended first, and only a successful append lets the new value be stored. If the
// append fails nothing changes and the operator is told so (O9).
//
// WHO MAY RUN IT. It is a mutating, owner-only command: untrusted it is refused by the guard, in a window that
// does not own the workspace it is refused with the palette wording. The writer asks the authority again inside
// its own append, so a window that lost ownership during the modal still writes nothing.

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { OperatorAttribution } from '../lib/operator-attribution';
import type { Notifier } from '../ui/notifications';

/** Exported so the modal, the notices and their tests read one copy (contract O8, O9). */
export const RESET_OPERATOR_PSEUDONYM_TEXT = {
  confirmPrompt: 'Reset your operator pseudonym for this workspace?',
  confirmDetail:
    'New audit rows will carry a new pseudonym. Rows already written keep the old one. The reset is ' +
    'recorded without either value.',
  confirmLabel: 'Reset pseudonym',
  done: 'Operator pseudonym reset.',
  failed: 'The pseudonym was not reset, because the reset could not be recorded in the audit log.'
} as const;

export interface ResetOperatorPseudonymDeps {
  /** The modal (O8): `true` when the operator confirms. Injected so the command is tested without a window. */
  readonly confirm: () => Promise<boolean>;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly attribution: Pick<OperatorAttribution, 'reset'>;
  readonly notifier: Pick<Notifier, 'info' | 'warn'>;
}

/** Run the reset: confirm, append the row, then store the new pseudonym; nothing changes when the append fails. */
export async function runResetOperatorPseudonym(deps: ResetOperatorPseudonymDeps): Promise<void> {
  // Decline: no write and no row.
  if (!(await deps.confirm())) return;
  try {
    await deps.auditWriter.append({
      runId: '',
      phase: 'operator',
      iteration: 0,
      eventType: 'operator-pseudonym-reset',
      outcome: 'info',
      payload: {}
    });
  } catch {
    // Nothing was stored, so nothing changed. The error has already taken the audit-health path inside the writer.
    void deps.notifier.warn(RESET_OPERATOR_PSEUDONYM_TEXT.failed);
    return;
  }
  try {
    await deps.attribution.reset();
  } catch {
    // The row is written and the new value could not be kept: the old pseudonym still stands, and the
    // operator is told the reset did not complete rather than that it did.
    void deps.notifier.warn(RESET_OPERATOR_PSEUDONYM_TEXT.failed);
    return;
  }
  deps.notifier.info(RESET_OPERATOR_PSEUDONYM_TEXT.done);
}
