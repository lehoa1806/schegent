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

  // These two said "regardless of suppression state", which enumerates two states
  // and reads as if it covered a third: a key that is not suppressible at all.
  // Both bodies use `queue.pause`, an ordinarily suppressible key, and neither
  // ever staged a `NEVER_SUPPRESSIBLE` member. The titles were the reason nobody
  // looked — they claimed the interaction in the words a reader would grep for,
  // and the interaction was broken. Filed by FR-R3-143 (T044); the coverage they
  // appeared to provide is in "the never-suppressible set survives the global
  // toggle" below. The titles now say which keys they are about.
  it('(c) a suppressible key short-circuits on confirmationsEnabled === false (already suppressed)', async () => {
    state.enabled = false;
    state.suppressedKeys.add('queue.pause');
    const p = useConfirm('queue.pause');
    expect(getDialog()).toBeNull();
    await expect(p).resolves.toBe(true);
  });

  it('(c2) a suppressible key short-circuits on confirmationsEnabled === false (not suppressed)', async () => {
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

  // "short-circuit gate" named neither of the two the module's own header numbers,
  // and this body stages only guard 2 — `state.enabled` is left at its `beforeEach`
  // default of `true`. Read against guard 1 the old title was false, and it was the
  // sentence a reader auditing the set would find first. The title now names the
  // guard it exercises; guard 1 is covered in the parameterised block below.
  it('workspace.reset ignores the per-action suppression guard — no checkbox, still prompts', async () => {
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

  /**
   * The bug T044 filed and this change closes. `NEVER_SUPPRESSIBLE` protected its
   * members from guard 2 (per-action "Don't ask again") and not from guard 1
   * (`confirmationsEnabled === false`), which returned before the set was ever
   * consulted. Every member resolved `true` with no dialog, exactly like an
   * ordinary suppressed action, and the set's name said otherwise.
   *
   * These cases are parameterised over the whole set on purpose. The bug survived
   * two members and was found by reading; the third (`backend.grant-uncontained`)
   * was added afterwards and inherited it silently. A per-member test would have
   * to be remembered each time the set grows, which is the thing that did not
   * happen. `action-copy.test.ts` already pins the `ActionKey` union, so a member
   * added here without a case is a compile error rather than a silent gap.
   */
  const NEVER_SUPPRESSIBLE_KEYS = [
    'workspace.reset',
    'settings.disable-confirmations',
    'backend.grant-uncontained'
  ] as const;

  // Only `backend.grant-uncontained` has placeholders; the other two take
  // `Record<string, never>`. `useConfirm`'s per-key context type is what makes a
  // single loop over the set need this, and typing it as the union keeps the call
  // below honest rather than reaching for `any`.
  type NeverSuppressibleKey = (typeof NEVER_SUPPRESSIBLE_KEYS)[number];
  function promptFor(key: NeverSuppressibleKey): Promise<boolean> {
    if (key === 'backend.grant-uncontained') {
      return useConfirm(key, {
        context: { label: 'Test Backend', refusal: 'no sandbox is available on this platform' }
      });
    }
    return useConfirm(key);
  }

  describe('the never-suppressible set survives the global toggle', () => {
    for (const key of NEVER_SUPPRESSIBLE_KEYS) {
      it(`${key} still prompts with confirmationsEnabled === false`, async () => {
        state.enabled = false;
        const p = promptFor(key);
        await tick();
        expect(
          getDialog(),
          `${key} is in NEVER_SUPPRESSIBLE; the global toggle is an operator preference ` +
            'and must not empty a set whose members each have a stated reason it cannot answer'
        ).not.toBeNull();
        expect(
          document.querySelector('[data-testid="confirm-dialog-suppression-checkbox"]'),
          'and the prompt it raises must still hide the checkbox'
        ).toBeNull();
        getButton('confirm-dialog-cancel').click();
        await expect(p).resolves.toBe(false);
      });

      it(`${key} still prompts with the toggle off AND the key suppressed`, async () => {
        // Both escapes staged at once: neither may reach the resolve(true) path.
        state.enabled = false;
        state.suppressedKeys.add(key);
        const p = promptFor(key);
        await tick();
        expect(getDialog(), `${key} must not be silenced by the two guards combined`).not.toBeNull();
        getButton('confirm-dialog-cancel').click();
        await expect(p).resolves.toBe(false);
      });
    }

    it('holds the modal lock for a never-suppressible prompt raised past the toggle', async () => {
      state.enabled = false;
      const p = useConfirm('workspace.reset');
      await tick();
      expect(isModalOpen(), 'the prompt is a real modal, so the FR-019 lock must be taken').toBe(
        true
      );
      getButton('confirm-dialog-cancel').click();
      await p;
      expect(isModalOpen()).toBe(false);
    });
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
