// FR-R4-F05 — what a rejected settings write reports to the host, apart from the reason the
// operator is answered with. `writeGeneralSettings` answers a code (`write-failed:<key>`); the
// exception behind it goes here, to a hook the host wires to the sanitizing logger.

/** Which of a batch's updates was rejected. */
export type SettingsWriteFailureStage = 'write' | 'clear' | 'rollback';

export interface SettingsWriteFailure {
  readonly key: string;
  readonly stage: SettingsWriteFailureStage;
  readonly error: unknown;
}

/**
 * Fire the hook for one rejected `config.update`. A hook that throws is ignored: it is
 * diagnostics, and the caller's answer is already decided.
 */
export function reportWriteFailure(
  onWriteFailure: ((failure: SettingsWriteFailure) => void) | undefined,
  failure: SettingsWriteFailure
): void {
  try {
    onWriteFailure?.(failure);
  } catch {
    // Diagnostics only.
  }
}
