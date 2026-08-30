// FR-R3-143 (T042) — the confirmation in front of turning confirmations off.
//
// The claim under test is an ASYMMETRY, so both directions are pinned. Turning
// prompts off raises a prompt; turning them back on does not. Neither direction
// is implemented by a branch on the new value — `useConfirm` short-circuits on
// the projected `confirmationsEnabled`, which still reads `true` while
// disabling and already reads `false` while enabling — so a test that only
// checked the disabling direction would pass against a guard that prompts
// unconditionally, which is the thing this must not do.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { WorkflowSnapshot } from '../../../../lib/snapshot-types';

// The projected value the ladder reads. `enabled` is what the operator has NOW,
// which is the opposite of what they are moving toward in the disabling case.
const state = { enabled: true, suppressedKeys: new Set<string>() };

vi.mock('../../../../lib/vscode-api', () => ({
  postCommand: () => ({ correlationId: 'corr-settings-confirm' })
}));

vi.mock('../../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    get snapshot(): Partial<WorkflowSnapshot> {
      return {
        confirmationsEnabled: state.enabled,
        confirmSuppression: { suppressedActionKeys: Array.from(state.suppressedKeys) }
      } as unknown as WorkflowSnapshot;
    }
  }
}));

vi.mock('../../../../lib/confirm-suppression-store.svelte', () => ({
  confirmSuppressionStore: {
    isSuppressed: (key: string) => state.suppressedKeys.has(key),
    setSuppressed: (key: string, suppressed: boolean) => {
      if (suppressed) state.suppressedKeys.add(key);
      else state.suppressedKeys.delete(key);
    }
  }
}));

import { confirmSettingsWrite } from '../confirm-settings-write';

const DISABLE = { 'ui.confirmations.enable': false };
const ENABLE = { 'ui.confirmations.enable': true };

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="confirm-dialog"]');
}

function click(testId: string): void {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`button not found: ${testId}`);
  (el as HTMLButtonElement).click();
}

beforeEach(() => {
  state.enabled = true;
  state.suppressedKeys = new Set<string>();
});

afterEach(() => {
  document.querySelectorAll('.confirm-dialog-host').forEach((el) => el.remove());
});

describe('FR-R3-143 — writing ui.confirmations.enable', () => {
  it('asks before turning prompts off, and proceeds when confirmed', async () => {
    const promise = confirmSettingsWrite(DISABLE);
    await tick();
    expect(dialog(), 'disabling every prompt is itself worth one prompt').not.toBeNull();
    click('confirm-dialog-confirm');
    await expect(promise).resolves.toBe(true);
  });

  it('abandons the write when the operator declines', async () => {
    const promise = confirmSettingsWrite(DISABLE);
    await tick();
    click('confirm-dialog-cancel');
    await expect(promise).resolves.toBe(false);
  });

  it('does not ask when turning prompts back on', async () => {
    // The other half of the asymmetry, and the reason no direction check exists
    // in the guard: here the projection already reads `false`, so `useConfirm`
    // short-circuits on its own. A guard that prompted on every write of this
    // key would fail exactly here.
    state.enabled = false;
    const promise = confirmSettingsWrite(ENABLE);
    await tick();
    expect(dialog()).toBeNull();
    await expect(promise).resolves.toBe(true);
  });

  it('does not ask for a payload that leaves the setting alone', async () => {
    const promise = confirmSettingsWrite({ 'cli.path': '/usr/local/bin/claude' });
    await tick();
    expect(dialog()).toBeNull();
    await expect(promise).resolves.toBe(true);
  });

  it('offers no "Don\'t ask again", and honours no earlier suppression', async () => {
    // `settings.disable-confirmations` is in NEVER_SUPPRESSIBLE: a suppression
    // on this prompt would silence the guard in front of the switch that turns
    // off the mechanism reading the suppression set. Staged as ALREADY
    // suppressed, because a set membership that is merely declared and never
    // consulted would pass a test that only looked for the checkbox.
    state.suppressedKeys.add('settings.disable-confirmations');
    const promise = confirmSettingsWrite(DISABLE);
    await tick();
    expect(dialog(), 'a prior suppression must not silence this one').not.toBeNull();
    expect(
      document.querySelector('[data-testid="confirm-dialog-suppression-checkbox"]'),
      'and the dialog must not offer to create one'
    ).toBeNull();
    click('confirm-dialog-cancel');
    await promise;
  });
});
