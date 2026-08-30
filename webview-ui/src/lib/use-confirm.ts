// Feature 063 — T028. The `useConfirm` helper orchestrates the
// pre-flight checks (global toggle, per-action suppression, single-modal
// lock), mounts the generic `ConfirmDialog` imperatively, and returns a
// `Promise<boolean>` so the caller's click handler reads as a single
// linear `await`. Replaces the legacy `deletion-confirmation.ts` flow.
//
// Contract: specs/063-clean-all-confirmations/contracts/confirm-dialog.md
//
// Resolution rules, in the order they are evaluated:
//   0. the action is in `NEVER_SUPPRESSIBLE`          → rules 1 and 2 do not run.
//   1. `schegent.ui.confirmations.enable === false` → resolve(true) sync.
//   2. operator previously checked "Don't ask again" → resolve(true) sync.
//   3. another modal already open (FR-019)           → resolve(false) sync.
//   4. otherwise mount the dialog and await the user's choice.
//
// Rule 0 is written first because it was not always true. Until FR-R3-143's T044
// bug was fixed, rule 1 was evaluated before the membership test and returned
// before it, so every member of the set resolved `true` with no dialog whenever
// the global toggle was off — the set protected against rule 2 alone, while its
// name and three product surfaces said otherwise.
//
// Some actions are always-confirm: their prompts are unsuppressible. The
// helper translates that into `suppressible: false` on the
// `ConfirmationRequest` so the dialog hides the "Don't ask again" checkbox.
// `NEVER_SUPPRESSIBLE` below is the list; this sentence deliberately does not
// restate its members, because it named only `workspace.reset` for as long as
// that was true and went on saying so after T042 added a second.

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

// The non-suppressible actions. Reset Workspace wipes every memento (including
// the suppression set), so the operator must always see the prompt before
// triggering it.
//
// FR-R3-143 (T042) — `settings.disable-confirmations` joins it on the same
// reasoning applied one level up: a "Don't ask again" on the prompt that guards
// turning all prompts off would suppress the mechanism that reads the
// suppression set.
//
// This membership buys protection from BOTH silencing routes: per-action
// suppression and the global `schegent.ui.confirmations.enable` toggle. It used
// to buy only the first, because the `FR-017 short-circuit` returned before this
// set was consulted; T044 filed that ordering and it is now fixed below.
//
// The global toggle is an operator preference and this set is a floor under it.
// That is not a new position for the product: `Schegent: Reset Workspace State`
// already raises its confirmation host-side and unconditionally, outside this
// setting's reach, for the same action as the first member here. What changed is
// that the sidebar route now agrees with the Command Palette route.
//
// FR-R3-144 (T033, FR-007) — `backend.grant-uncontained` joins it. The item asks
// for one confirmation PER BACKEND; a "Don't ask again" would make the second
// grant silent, which is the same as asking once for all of them. That is the
// arrangement FR-R3-125 removed when it replaced the boolean with a per-backend
// list, and a suppression checkbox would have restored it through the back door.
const NEVER_SUPPRESSIBLE: ReadonlySet<ActionKey> = new Set<ActionKey>([
  'workspace.reset',
  'settings.disable-confirmations',
  'backend.grant-uncontained'
]);

export function useConfirm<K extends ActionKey>(
  actionKey: K,
  options: UseConfirmOptions<K> = {}
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const confirmationsEnabled = snapshotStore.snapshot?.confirmationsEnabled ?? true;
    const suppressible = !NEVER_SUPPRESSIBLE.has(actionKey);

    // Both silencing routes live inside this branch, and the nesting is the
    // point rather than a style choice: membership of `NEVER_SUPPRESSIBLE` is a
    // floor under operator preference, so every route that resolves `true`
    // without asking has to be below it. Guard 1 used to sit above the
    // membership test and skipped the set entirely — filed by FR-R3-143 (T044),
    // fixed here. A fourth silencing route added outside this branch would
    // reopen the same hole; `use-confirm.test.ts` parameterises its cases over
    // the whole set so a new member cannot inherit one silently.
    if (suppressible) {
      // Guard 1 (FR-017): workspace owner disabled prompts globally.
      if (!confirmationsEnabled) {
        resolve(true);
        return;
      }

      // Guard 2: operator previously checked "Don't ask again".
      if (confirmSuppressionStore.isSuppressed(actionKey)) {
        resolve(true);
        return;
      }
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
