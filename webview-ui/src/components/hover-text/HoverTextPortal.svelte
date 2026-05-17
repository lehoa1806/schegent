<script lang="ts">
  import { tick, onDestroy } from 'svelte';
  import type {
    ControlDescription,
    HoverTextAnchor,
    HoverTextPreferredPlacement
  } from './hover-text-types';
  import { computePlacement } from './hover-text-positioning';

  interface Props {
    controlId: string;
    description: ControlDescription;
    anchorEl: HTMLElement;
    anchor?: HoverTextAnchor;
    preferredPlacement?: HoverTextPreferredPlacement;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }

  const {
    controlId,
    description,
    anchorEl,
    anchor = 'bottom',
    preferredPlacement = 'auto',
    onMouseEnter,
    onMouseLeave
  }: Props = $props();

  let popoverEl: HTMLDivElement | undefined = $state();
  let resolvedSide: HoverTextAnchor = $state('bottom');
  let popoverLeft = $state(0);
  let popoverTop = $state(0);

  async function recomputePlacement(): Promise<void> {
    await tick();
    if (!popoverEl || !anchorEl) return;
    const triggerRect = anchorEl.getBoundingClientRect();
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

  function onWindowResize(): void {
    void recomputePlacement();
  }

  function onScroll(): void {
    void recomputePlacement();
  }

  $effect(() => {
    void recomputePlacement();
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  onDestroy(() => {
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('scroll', onScroll, true);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="tooltip"
  id={`hover-text-${controlId}`}
  class="hover-text-popover-body"
  data-placement={resolvedSide}
  style:left={`${popoverLeft}px`}
  style:top={`${popoverTop}px`}
  bind:this={popoverEl}
  onmouseenter={() => onMouseEnter?.()}
  onmouseleave={() => onMouseLeave?.()}
>
  {#if description.title}
    <strong class="hover-text-title">{description.title}</strong>
  {/if}
  <p class="hover-text-body">{description.body}</p>
</div>

<!-- Styles live in webview-ui/src/lib/theme.css (global). -->
