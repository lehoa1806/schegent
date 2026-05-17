<script lang="ts">
  import type { DeleteConfirmationCopy } from '../lib/deletion-confirmation';

  interface Props {
    copy: DeleteConfirmationCopy;
    onCancel: () => void;
    onConfirm: () => void;
  }

  const { copy, onCancel, onConfirm }: Props = $props();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<div
  class="confirm-backdrop"
  role="presentation"
  onkeydown={onKeydown}
>
  <div
    class="confirm-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-delete-title"
    aria-describedby="confirm-delete-message"
    data-testid="confirm-delete-dialog"
  >
    <h2 id="confirm-delete-title">{copy.title}</h2>
    <p id="confirm-delete-message">{copy.message}</p>
    <div class="confirm-actions">
      <button type="button" data-testid="confirm-delete-cancel" onclick={onCancel}>Cancel</button>
      <button
        type="button"
        class="destructive"
        data-testid="confirm-delete-confirm"
        onclick={onConfirm}
      >{copy.confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 16px;
    background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
  }

  .confirm-dialog {
    width: min(420px, 100%);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-editor-background);
    color: var(--schegent-fg);
    box-shadow: 0 12px 32px color-mix(in srgb, var(--vscode-widget-shadow) 35%, transparent);
    padding: 16px;
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

  .destructive {
    border-color: var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
  }
</style>
