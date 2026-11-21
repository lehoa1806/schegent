<script lang="ts">
  // Feature 326 — Single Builder-level modal host for process-YAML import.
  //
  // Wraps `ProcessImportPreflight.svelte` inside an accessible modal dialog
  // (`role="dialog"`, `aria-modal="true"`, keyboard focus trap, Escape &
  // backdrop dismissal suppressed while committing, and focus restoration to
  // the invoking trigger button on close).
  import { onMount, tick } from 'svelte';
  import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';
  import type { ImportTargetGate } from '../ProcessImport/process-import-state';

  interface Props {
    originatingElement: HTMLElement | null;
    targetGate: ImportTargetGate;
    disabledReason?: string | null;
    autoInspect?: boolean;
    onclose: () => void;
  }

  const {
    originatingElement,
    targetGate,
    disabledReason = null,
    autoInspect = true,
    onclose
  }: Props = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);
  let committing = $state(false);
  let wasCommitting = false;

  function focusableControls(): HTMLElement[] {
    if (!dialogEl) return [];
    return [
      ...dialogEl.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ];
  }

  function requestClose(): void {
    if (committing) return;
    onclose();
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableControls();
    if (focusable.length === 0) {
      event.preventDefault();
      dialogEl?.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? focusable.indexOf(active) : -1;
    if (event.shiftKey) {
      if (idx <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      }
    } else if (idx === -1 || idx === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });

  $effect(() => {
    if (committing) {
      wasCommitting = true;
      dialogEl?.focus();
      return;
    }
    if (wasCommitting) {
      wasCommitting = false;
      if (dialogEl && (!dialogEl.contains(document.activeElement) || document.activeElement === dialogEl)) {
        const closeBtn = dialogEl.querySelector<HTMLElement>(
          '[data-testid="builder-import-close"]:not(:disabled)'
        );
        (closeBtn ?? focusableControls().at(0) ?? dialogEl).focus();
      }
    }
  });

  onMount(() => {
    void tick().then(() => {
      const first = focusableControls().at(0);
      if (first) first.focus();
      else dialogEl?.focus();
    });
    return () => {
      if (originatingElement?.isConnected) {
        originatingElement.focus();
      } else {
        document.querySelector<HTMLElement>('[data-testid="builder-import-btn"]')?.focus();
      }
    };
  });
</script>

<div
  class="sg import-modal-backdrop"
  role="presentation"
  data-testid="builder-import-backdrop"
  onclick={handleBackdropClick}
>
  <div
    class="import-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="process-import-title"
    tabindex="-1"
    data-testid="builder-import-modal"
    bind:this={dialogEl}
  >
    <ProcessImportPreflight
      modalMode={true}
      {autoInspect}
      {targetGate}
      {disabledReason}
      onclose={requestClose}
      oncommittingchange={(active) => (committing = active)}
      oncancelwithoutplan={requestClose}
    />
  </div>
</div>

<style>
  .import-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--schegent-z-modal-backdrop);
    display: grid;
    place-items: center;
    padding: var(--schegent-space-4);
    background: color-mix(in srgb, var(--schegent-bg) 72%, transparent);
  }

  .import-modal {
    position: relative;
    z-index: var(--schegent-z-modal);
    width: min(680px, 100%);
    max-height: min(85vh, 720px);
    overflow-y: auto;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-bg);
    color: var(--schegent-fg);
    padding: var(--schegent-space-4);
    box-shadow: var(--schegent-shadow-popover);
  }
</style>
