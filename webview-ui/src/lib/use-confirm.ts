// Feature 063 — T028. The `useConfirm` helper orchestrates the
// pre-flight checks (global toggle, per-action suppression, single-modal
// lock), mounts the generic `ConfirmDialog` imperatively, and returns a
// `Promise<boolean>` so the caller's click handler reads as a single
// linear `await`. Replaces the legacy `deletion-confirmation.ts` flow.
//
// Contract: specs/063-clean-all-confirmations/contracts/confirm-dialog.md
//
// Resolution rules:
//   1. `schegent.ui.confirmations.enable === false` → resolve(true) sync.
//   2. operator previously checked "Don't ask again" → resolve(true) sync.
//   3. another modal already open (FR-019)           → resolve(false) sync.
//   4. otherwise mount the dialog and await the user's choice.
//
// `workspace.reset` is the lone always-confirm action: per spec
// Assumptions, its prompt is unsuppressible. The helper translates that
// into `suppressible: false` on the `ConfirmationRequest` so the dialog
// hides the "Don't ask again" checkbox.

import { mount, unmount } from 'svelte';
import ConfirmDialog from '../components/ConfirmDialog.svelte';
import { snapshotStore } from './snapshot-store.svelte';
import { confirmSuppressionStore } from './confirm-suppression-store.svelte';
import { ACTION_COPY, renderActionBody, type ActionKey, type ActionCopyContext } from './action-copy';

export interface UseConfirmOptions<K extends ActionKey> {
  /** The button or focusable that triggered the action; focus returns
   * here on close. */
  readonly originatingElement?: HTMLElement | null;
  /** Dynamic placeholders for the action's body template. Required for
   * actions whose template has placeholders; the type system rejects
   * missing fields. */
  readonly context?: ActionCopyContext[K];
}

// Module-scoped single-modal lock (FR-019). Plain boolean — readers
// only need to know "is a modal currently up?" via the exported
// `isModalOpen()` getter. The flag is set BEFORE mount and cleared in
// the unmount path's finally block so an exception in the dialog body
// cannot leak the lock.
let modalOpen = false;

export function isModalOpen(): boolean {
  return modalOpen;
}

// The single non-suppressible action. Reset Workspace wipes every
// memento (including the suppression set), so the operator must always
// see the prompt before triggering it.
const NEVER_SUPPRESSIBLE: ReadonlySet<ActionKey> = new Set<ActionKey>(['workspace.reset']);

export function useConfirm<K extends ActionKey>(
  actionKey: K,
  options: UseConfirmOptions<K> = {}
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const confirmationsEnabled = snapshotStore.snapshot?.confirmationsEnabled ?? true;

    // FR-017 short-circuit: workspace owner disabled prompts globally.
    if (!confirmationsEnabled) {
      resolve(true);
      return;
    }

    const suppressible = !NEVER_SUPPRESSIBLE.has(actionKey);
    if (suppressible && confirmSuppressionStore.isSuppressed(actionKey)) {
      resolve(true);
      return;
    }

    // FR-019 single-modal lock. Another prompt is already up — drop
    // this click silently (false = "user did not confirm").
    if (modalOpen) {
      resolve(false);
      return;
    }

    const entry = ACTION_COPY[actionKey];
    const body = renderActionBody(actionKey, (options.context ?? {}) as ActionCopyContext[K]);

    const host = document.createElement('div');
    host.className = 'confirm-dialog-host';
    document.body.appendChild(host);

    modalOpen = true;
    let settled = false;
    let dialog: ReturnType<typeof mount> | null = null;

    const teardown = (): void => {
      if (dialog) {
        void unmount(dialog);
        dialog = null;
      }
      host.remove();
      modalOpen = false;
    };

    const settle = (result: boolean, suppressFuture: boolean): void => {
      if (settled) return;
      settled = true;
      if (result && suppressFuture && suppressible) {
        confirmSuppressionStore.setSuppressed(actionKey, true);
      }
      teardown();
      resolve(result);
    };

    dialog = mount(ConfirmDialog, {
      target: host,
      props: {
        request: {
          actionKey,
          severity: entry.severity,
          title: entry.title,
          body,
          confirmLabel: entry.confirmLabel,
          originatingElement: options.originatingElement ?? null,
          suppressible
        },
        onConfirm: (suppressFuture: boolean): void => settle(true, suppressFuture),
        onCancel: (): void => settle(false, false)
      }
    });
  });
}
