<script lang="ts">
  // Feature 063 — T027. Generic confirmation dialog used by every
  // destructive action surface via the `useConfirm` helper. Replaces
  // the legacy `ConfirmDeleteDialog.svelte`.
  //
  // Contract: specs/063-clean-all-confirmations/contracts/confirm-dialog.md
  //
  // - role="dialog" + aria-modal="true"
  // - aria-labelledby → title id; aria-describedby → body id
  // - Initial focus on Cancel
  // - Focus trap: Cancel → Confirm → suppression checkbox → Cancel (loop)
  //   The suppression checkbox is rendered AFTER the action buttons in
  //   DOM order so the natural tab order matches the focus-trap rule
  //   without any JS reshuffling (research.md R-011).
  // - Escape calls onCancel
  // - Focus restored to `originatingElement` on unmount

  import { onMount, tick } from 'svelte';
  import { SUPPRESSION_CHECKBOX_LABEL, type Severity } from '../lib/action-copy';

  interface ConfirmationRequest {
    readonly actionKey: string;
    readonly severity: Severity;
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
    readonly originatingElement: HTMLElement | null;
    readonly suppressible: boolean;
  }

  interface Props {
    request: ConfirmationRequest;
    onConfirm: (suppressFuture: boolean) => void;
    onCancel: () => void;
  }

  const { request, onConfirm, onCancel }: Props = $props();

  let suppress = $state(false);

  // Stable ids so multiple stacked dialogs do not collide. The dialog
  // is gated by the single-modal flag (FR-019) so collisions are
  // unlikely in practice; suffixing with the action key keeps DevTools
  // readable. `$derived` keeps Svelte's reactive analysis happy: the
  // `request` prop is effectively immutable per mount, so these ids
  // never actually change after first compute.
  const titleId = $derived(`confirm-dialog-title-${request.actionKey}`);
  const bodyId = $derived(`confirm-dialog-body-${request.actionKey}`);

  let cancelButtonEl: HTMLButtonElement | null = $state(null);
  let confirmButtonEl: HTMLButtonElement | null = $state(null);
  let suppressionInputEl: HTMLInputElement | null = $state(null);

  onMount(() => {
    void tick().then(() => {
      cancelButtonEl?.focus();
    });
    return () => {
      // Restore focus to the element that opened us.
      request.originatingElement?.focus?.();
    };
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    // Focus trap. The natural tab order is Cancel → Confirm →
    // (suppression checkbox?) so we only intervene at the boundaries
    // (forward from the last element, backward from the first).
    const order: ReadonlyArray<HTMLElement | null> = request.suppressible
      ? [cancelButtonEl, confirmButtonEl, suppressionInputEl]
      : [cancelButtonEl, confirmButtonEl];
    const focusable = order.filter((el): el is HTMLElement => el !== null);
    if (focusable.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? focusable.indexOf(active) : -1;
    if (event.shiftKey) {
      if (idx <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      }
    } else {
      if (idx === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }
  }

  function handleConfirm(): void {
    onConfirm(request.suppressible && suppress);
  }
</script>

<div
  class="confirm-backdrop"
  role="presentation"
  onkeydown={handleKeydown}
>
  <div
    class="confirm-dialog severity-{request.severity}"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={bodyId}
    data-testid="confirm-dialog"
    data-action-key={request.actionKey}
    data-severity={request.severity}
  >
    <h2 id={titleId} data-testid="confirm-dialog-title">{request.title}</h2>
    <p id={bodyId} data-testid="confirm-dialog-body">{request.body}</p>
    <div class="confirm-actions">
      <button
        type="button"
        class="btn-cancel"
        data-testid="confirm-dialog-cancel"
        bind:this={cancelButtonEl}
        onclick={onCancel}
      >Cancel</button>
      <button
        type="button"
        class="btn-confirm btn-{request.severity}"
        data-testid="confirm-dialog-confirm"
        bind:this={confirmButtonEl}
        onclick={handleConfirm}
      >{request.confirmLabel}</button>
    </div>
    {#if request.suppressible}
      <label class="suppression-row" data-testid="confirm-dialog-suppression-row">
        <input
          type="checkbox"
          data-testid="confirm-dialog-suppression-checkbox"
          bind:this={suppressionInputEl}
          bind:checked={suppress}
        />
        <span>{SUPPRESSION_CHECKBOX_LABEL}</span>
      </label>
    {/if}
  </div>
</div>

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 16px;
    background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
  }

  .confirm-dialog {
    width: min(480px, 100%);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-editor-background);
    color: var(--schegent-fg);
    box-shadow: 0 12px 32px color-mix(in srgb, var(--vscode-widget-shadow) 35%, transparent);
    padding: 16px;
  }

  .severity-destructive {
    border-color: var(--vscode-inputValidation-errorBorder);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 1rem;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: var(--schegent-muted-fg);
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  button {
    min-height: 28px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
    color: var(--schegent-fg);
    font: inherit;
    padding: 0 10px;
    cursor: pointer;
  }

  button:hover,
  button:focus-visible {
    border-color: var(--schegent-focus-border);
    outline: none;
  }

  .btn-info {
    border-color: var(--schegent-color-active);
    color: var(--schegent-color-active);
  }

  .btn-caution {
    border-color: var(--schegent-color-warning, var(--schegent-color-active));
    color: var(--schegent-color-warning, var(--schegent-fg));
  }

  .btn-destructive {
    border-color: var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
  }

  .suppression-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
    cursor: pointer;
  }

  .suppression-row input {
    cursor: pointer;
  }
</style>
