<script lang="ts">
  import { tick, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';
  import {
    INLINE_BODY_MAX_CHARS,
    type ControlDescription,
    type HoverTextAnchor,
    type HoverTextPreferredPlacement
  } from './hover-text-types';
  import { computePlacement } from './hover-text-positioning';

  interface Props {
    controlId: string;
    description: ControlDescription;
    anchor?: HoverTextAnchor;
    preferredPlacement?: HoverTextPreferredPlacement;
    disabled?: boolean;
    children?: Snippet<[{ describedBy: string | undefined }]>;
  }

  const {
    controlId,
    description,
    anchor = 'bottom',
    preferredPlacement = 'auto',
    disabled = false,
    children
  }: Props = $props();

  const HOVER_OPEN_DELAY_MS = 400;
  const MOUSELEAVE_GRACE_MS = 100;

  type HoverTextState =
    | { kind: 'closed' }
    | { kind: 'transient-open'; via: 'hover' | 'focus'; openedAt: number };

  let openState: HoverTextState = $state({ kind: 'closed' });
  let resolvedSide: HoverTextAnchor = $state('bottom');
  let popoverLeft = $state(0);
  let popoverTop = $state(0);

  let containerEl: HTMLSpanElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();

  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let blurMicrotask = 0;
  let resizeAttached = false;

  const isInline = $derived(description.body.length <= INLINE_BODY_MAX_CHARS);
  const isOpen = $derived(openState.kind !== 'closed');
  const describedBy = $derived(
    disabled
      ? undefined
      : isInline
        ? `desc-${controlId}`
        : isOpen
          ? `hover-text-${controlId}`
          : undefined
  );

  function clearOpenTimer(): void {
    if (openTimer !== undefined) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
  }

  function clearLeaveTimer(): void {
    if (leaveTimer !== undefined) {
      clearTimeout(leaveTimer);
      leaveTimer = undefined;
    }
  }

  function attachResize(): void {
    if (!resizeAttached) {
      window.addEventListener('resize', onWindowResize);
      resizeAttached = true;
    }
  }

  function detachResize(): void {
    if (resizeAttached) {
      window.removeEventListener('resize', onWindowResize);
      resizeAttached = false;
    }
  }

  function transitionTo(next: HoverTextState): void {
    const wasOpen = openState.kind !== 'closed';
    openState = next;
    if (next.kind === 'closed') {
      if (wasOpen) detachResize();
    } else {
      attachResize();
      void recomputePlacement();
    }
  }

  async function recomputePlacement(): Promise<void> {
    if (!isOpen) return;
    await tick();
    if (!containerEl || !popoverEl) return;
    const triggerRect = containerEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placement = computePlacement(
      {
        left: triggerRect.left,
        top: triggerRect.top,
        right: triggerRect.right,
        bottom: triggerRect.bottom,
        width: triggerRect.width,
        height: triggerRect.height
      },
      { width: popoverRect.width, height: popoverRect.height },
      viewport,
      anchor,
      preferredPlacement
    );
    resolvedSide = placement.side;
    popoverLeft = placement.offsetX;
    popoverTop = placement.offsetY;
  }

  function onContainerMouseEnter(): void {
    if (disabled || isInline) return;
    clearLeaveTimer();
    clearOpenTimer();
    if (openState.kind === 'transient-open') return;
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (openState.kind === 'closed') {
        transitionTo({ kind: 'transient-open', via: 'hover', openedAt: Date.now() });
      }
    }, HOVER_OPEN_DELAY_MS);
  }

  function onContainerMouseLeave(): void {
    if (disabled || isInline) return;
    clearOpenTimer();
    if (openState.kind !== 'transient-open') return;
    clearLeaveTimer();
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      if (openState.kind === 'transient-open') {
        transitionTo({ kind: 'closed' });
      }
    }, MOUSELEAVE_GRACE_MS);
  }

  function onPopoverMouseEnter(): void {
    clearLeaveTimer();
  }

  function onPopoverMouseLeave(): void {
    if (openState.kind !== 'transient-open') return;
    clearLeaveTimer();
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      if (openState.kind === 'transient-open') {
        transitionTo({ kind: 'closed' });
      }
    }, MOUSELEAVE_GRACE_MS);
  }

  function onContainerFocusIn(): void {
    if (disabled || isInline) return;
    clearOpenTimer();
    if (openState.kind === 'transient-open') return;
    transitionTo({ kind: 'transient-open', via: 'focus', openedAt: Date.now() });
  }

  function onContainerFocusOut(event: FocusEvent): void {
    if (disabled || isInline) return;
    if (openState.kind !== 'transient-open') return;
    const next = event.relatedTarget as Node | null;
    if (next && containerEl && containerEl.contains(next)) return;
    if (next && popoverEl && popoverEl.contains(next)) return;
    blurMicrotask = (blurMicrotask + 1) % 1_000_000;
    const ticket = blurMicrotask;
    queueMicrotask(() => {
      if (ticket !== blurMicrotask) return;
      if (openState.kind === 'transient-open') {
        transitionTo({ kind: 'closed' });
      }
    });
  }

  function onContainerKeyDown(event: KeyboardEvent): void {
    if (disabled || isInline) return;
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      transitionTo({ kind: 'closed' });
    }
  }

  function onWindowResize(): void {
    void recomputePlacement();
  }

  onDestroy(() => {
    clearOpenTimer();
    clearLeaveTimer();
    detachResize();
  });
</script>

{#if disabled}
  {@render children?.({ describedBy: undefined })}
{:else if isInline}
  <span class="hover-text-container hover-text-inline" data-hover-text-mode="inline">
    {@render children?.({ describedBy })}
    <p id={`desc-${controlId}`} class="hover-text-inline-help">{description.body}</p>
  </span>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="hover-text-container hover-text-popover"
    data-hover-text-mode="popover"
    bind:this={containerEl}
    onmouseenter={onContainerMouseEnter}
    onmouseleave={onContainerMouseLeave}
    onfocusin={onContainerFocusIn}
    onfocusout={onContainerFocusOut}
    onkeydown={onContainerKeyDown}
  >
    {@render children?.({ describedBy })}
    {#if isOpen}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        role="tooltip"
        id={`hover-text-${controlId}`}
        class="hover-text-popover-body"
        data-placement={resolvedSide}
        style:left={`${popoverLeft}px`}
        style:top={`${popoverTop}px`}
        bind:this={popoverEl}
        onmouseenter={onPopoverMouseEnter}
        onmouseleave={onPopoverMouseLeave}
      >
        {#if description.title}
          <strong class="hover-text-title">{description.title}</strong>
        {/if}
        <p class="hover-text-body">{description.body}</p>
      </div>
    {/if}
  </span>
{/if}

<!-- Styles live in webview-ui/src/lib/theme.css (global) so both this
     inline wrapper and the portal-mounted HoverTextPortal share them. -->
