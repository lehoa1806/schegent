// Feature 063 — T043. Unit-level coverage for `useConfirm` orchestration:
// short-circuit gates (confirmationsEnabled, suppressed, modal-open),
// modal mount + resolution, suppression persistence, and Escape/Cancel
// fallback. The dialog component itself is covered separately in
// `components/__tests__/ConfirmDialog.test.ts`; here we focus on the
// pre-mount routing and the post-confirmation side effects.
//
// Contract: specs/063-clean-all-confirmations/contracts/confirm-dialog.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { CMD_SET_CONFIRM_SUPPRESSION } from '../messages';
import type { WorkflowSnapshot } from '../snapshot-types';

// Mutable wires injected into the mocked stores so each test can stage
// the snapshot's `confirmationsEnabled` and the suppression set without
// touching real module state.
type SuppressionState = {
  enabled: boolean;
  suppressedKeys: Set<string>;
};

const state: SuppressionState = {
  enabled: true,
  suppressedKeys: new Set<string>()
};

const postCommandSpy = vi.fn((type: string, payload?: unknown, opts?: unknown) => ({ correlationId: 'corr-1' }));

vi.mock('../vscode-api', () => ({
  postCommand: (type: string, payload?: unknown, opts?: unknown) => postCommandSpy(type, payload, opts)
}));

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    get snapshot(): Partial<WorkflowSnapshot> {
      return {
        confirmationsEnabled: state.enabled,
        confirmSuppression: {
          suppressedActionKeys: Array.from(state.suppressedKeys)
        }
      } as unknown as unknown as WorkflowSnapshot;
    }
  }
}));

vi.mock('../confirm-suppression-store.svelte', async () => {
  // Real isSuppressed/setSuppressed implementations would touch the
  // snapshot + post `CMD_SET_CONFIRM_SUPPRESSION`. Reuse the spy so the
  // assertion in test (e) is straightforward.
  return {
    confirmSuppressionStore: {
      isSuppressed(actionKey: string): boolean {
        return state.suppressedKeys.has(actionKey);
      },
      setSuppressed(actionKey: string, suppressed: boolean): void {
        if (suppressed) {
          state.suppressedKeys.add(actionKey);
        } else {
          state.suppressedKeys.delete(actionKey);
        }
        postCommandSpy(CMD_SET_CONFIRM_SUPPRESSION, { actionKey, suppressed });
      }
    }
  };
});

import { useConfirm, isModalOpen } from '../use-confirm';

function getDialog(): HTMLElement | null {
  return document.querySelector('[data-testid="confirm-dialog"]');
}

function getButton(testId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`button not found: ${testId}`);
  return el as HTMLButtonElement;
}

function getCheckbox(): HTMLInputElement {
  const el = document.querySelector('[data-testid="confirm-dialog-suppression-checkbox"]');
  if (!el) throw new Error('suppression checkbox not found');
  return el as HTMLInputElement;
}

beforeEach(() => {
  postCommandSpy.mockClear();
  state.enabled = true;
  state.suppressedKeys = new Set<string>();
});

afterEach(() => {
  // Strip every dialog host left over from a test that returned without
  // resolving (shouldn't happen, but keeps the DOM clean).
  document.querySelectorAll('.confirm-dialog-host').forEach((el) => el.remove());
});

describe('useConfirm', () => {
  it('(a) suppressed action with confirmationsEnabled === true resolves true without mounting the modal', async () => {
    state.suppressedKeys.add('queue.clear-done');
    const p = useConfirm('queue.clear-done', { context: { completedCount: 3 } });
    expect(getDialog()).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('(b) unsuppressed action opens the modal (does not resolve until user acts)', async () => {
    let resolvedValue: boolean | null = null;
    const p = useConfirm('queue.pause').then((v) => {
      resolvedValue = v;
      return v;
    });
    await tick();
    expect(getDialog()).not.toBeNull();
    expect(resolvedValue).toBeNull();
    // Cleanup: cancel to settle the promise.
    getButton('confirm-dialog-cancel').click();
    await p;
  });

  it('(c) confirmationsEnabled === false short-circuits regardless of suppression state (suppressed)', async () => {
    state.enabled = false;
    state.suppressedKeys.add('queue.pause');
    const p = useConfirm('queue.pause');
    expect(getDialog()).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('(c2) confirmationsEnabled === false short-circuits regardless of suppression state (unsuppressed)', async () => {
    state.enabled = false;
    state.suppressedKeys = new Set<string>();
    const p = useConfirm('queue.pause');
    expect(getDialog()).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('(d) module-scoped modalOpen blocks concurrent calls (second resolves false synchronously)', async () => {
    const first = useConfirm('queue.pause');
    await tick();
    expect(isModalOpen()).toBe(true);
    const second = useConfirm('queue.resume');
    // The second call must not mount a dialog while one is up.
    await expect(second).resolves.toBe(false);
    // First dialog is still open.
    expect(getDialog()).not.toBeNull();
    getButton('confirm-dialog-cancel').click();
    await first;
    expect(isModalOpen()).toBe(false);
  });

  it('(e) confirming with checkbox ticked posts CMD_SET_CONFIRM_SUPPRESSION', async () => {
    const p = useConfirm('queue.clear-done', { context: { completedCount: 1 } });
    await tick();
    // Toggle the suppression checkbox via the bound property + input
    // event to drive Svelte's two-way binding.
    const checkbox = getCheckbox();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    getButton('confirm-dialog-confirm').click();
    await expect(p).resolves.toBe(true);
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SET_CONFIRM_SUPPRESSION, {
      actionKey: 'queue.clear-done',
      suppressed: true
    });
    // And the in-memory set reflects the write (so a subsequent call
    // short-circuits).
    expect(state.suppressedKeys.has('queue.clear-done')).toBe(true);
  });

  it('(e2) confirming with checkbox UNticked does NOT post CMD_SET_CONFIRM_SUPPRESSION', async () => {
    const p = useConfirm('queue.clear-done', { context: { completedCount: 1 } });
    await tick();
    getButton('confirm-dialog-confirm').click();
    await expect(p).resolves.toBe(true);
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('(f) Escape key on the dialog resolves false', async () => {
    const p = useConfirm('queue.pause');
    await tick();
    const dialog = getDialog();
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(false);
    // After resolution the host wrapper is torn down.
    expect(getDialog()).toBeNull();
  });

  it('Cancel button resolves false and does NOT persist suppression even with the box ticked', async () => {
    const p = useConfirm('queue.clear-done', { context: { completedCount: 1 } });
    await tick();
    const checkbox = getCheckbox();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    getButton('confirm-dialog-cancel').click();
    await expect(p).resolves.toBe(false);
    expect(postCommandSpy).not.toHaveBeenCalled();
    expect(state.suppressedKeys.has('queue.clear-done')).toBe(false);
  });

  it('workspace.reset is never suppressible — checkbox is not rendered and short-circuit gate does not apply', async () => {
    // Even if the suppression set somehow contains the key, the helper
    // must ignore it (NEVER_SUPPRESSIBLE list).
    state.suppressedKeys.add('workspace.reset');
    const p = useConfirm('workspace.reset');
    await tick();
    expect(getDialog()).not.toBeNull();
    expect(document.querySelector('[data-testid="confirm-dialog-suppression-checkbox"]')).toBeNull();
    getButton('confirm-dialog-cancel').click();
    await expect(p).resolves.toBe(false);
  });

  /**
   * FR-R3-143 (T049 run 8) — `settings.disable-confirmations` is the second
   * member of `NEVER_SUPPRESSIBLE`, and until this test only the first one was
   * ever exercised. A membership nothing runs is a declaration, and the module's
   * own header records what happened the last time this list was described
   * rather than checked.
   *
   * The action is the reason the rule exists at one more level: a "Don't ask
   * again" on the prompt guarding "turn every prompt off" would suppress the
   * mechanism that reads the suppression set.
   */
  it('settings.disable-confirmations is never suppressible — it still prompts with the key suppressed', async () => {
    state.suppressedKeys.add('settings.disable-confirmations');
    const p = useConfirm('settings.disable-confirmations');
    await tick();
    expect(
      getDialog(),
      'a suppressed key must still raise this prompt; resolving true here is the surface ' +
        'silently disabling every other confirmation'
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="confirm-dialog-suppression-checkbox"]'),
      'and the dialog must not offer the checkbox that would record the suppression'
    ).toBeNull();
    getButton('confirm-dialog-cancel').click();
    await expect(p).resolves.toBe(false);
  });

  it('teardown clears modalOpen even when the user cancels (lock is released)', async () => {
    const p = useConfirm('queue.pause');
    await tick();
    expect(isModalOpen()).toBe(true);
    getButton('confirm-dialog-cancel').click();
    await p;
    expect(isModalOpen()).toBe(false);
  });

  it('does not reach the modal when confirmationsEnabled === false (lock stays free)', async () => {
    state.enabled = false;
    const p = useConfirm('queue.pause');
    expect(isModalOpen()).toBe(false);
    await expect(p).resolves.toBe(true);
    expect(isModalOpen()).toBe(false);
  });
});
