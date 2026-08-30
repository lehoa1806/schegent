// FR-R3-143 (T042) — the one settings write that asks before it lands.
//
// WHY IT GATES THE PAYLOAD, NOT THE CONTROL. The task named `UiTrustGroup` as
// the site, and a handler on that group's toggle is the obvious placement. It is
// also bypassable: `GeneralSettingsTab.saveAll()` writes every dirty field in
// one transactional payload without going through any group's `onSave`, so a
// guard on the toggle would be defeated by pressing the other button on the same
// tab. What must be confirmed is the WRITE, so this reads the IPC payload both
// paths build and both call it.
//
// WHY THERE IS NO `if (nextValue === false)` ANYWHERE. `useConfirm` already
// short-circuits on `snapshotStore.snapshot?.confirmationsEnabled` (the
// `FR-017 short-circuit` in `use-confirm.ts`). While DISABLING, the projection
// still reads `true`, so the prompt is raised; while ENABLING it already reads
// `false`, so the helper returns `true` at once and no prompt appears. The asymmetry the
// item asks for is that existing behaviour, used rather than re-implemented — a
// hand-written direction check beside it would be a second copy of the rule that
// could drift from the first.
//
// The key is in `NEVER_SUPPRESSIBLE` (`use-confirm.ts`), so no "Don't ask again"
// is offered: that checkbox would suppress the prompt guarding the switch that
// turns off the mechanism reading the suppression set.

import { useConfirm } from '../../../lib/use-confirm';

/** The IPC key whose `false` write silences every other prompt. */
const CONFIRMATIONS_ENABLE_IPC_KEY = 'ui.confirmations.enable';

/**
 * Ask before a settings payload turns confirmation prompts off.
 *
 * @param updates The IPC payload about to be sent, keyed as the host reads it.
 * @returns `true` when the write may proceed; `false` when the operator declined.
 *   Every payload that does not disable prompts resolves `true` without a
 *   dialog, so callers can gate unconditionally.
 */
export async function confirmSettingsWrite(updates: Record<string, unknown>): Promise<boolean> {
  if (updates[CONFIRMATIONS_ENABLE_IPC_KEY] !== false) return true;
  return useConfirm('settings.disable-confirmations');
}
