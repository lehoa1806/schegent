<!--
  The redesign's overflow menu: a "more" button that opens a short list of actions.

  The caller supplies the items as `button[role="menuitem"]` elements, with `hr` between groups.
  Each item keeps its own handler and test id, and stays in the document while the menu is closed,
  so moving an action into a menu changes only where it sits.

  An item is disabled with `aria-disabled="true"`, not `disabled`: it stays a stop for the arrow
  keys, so a keyboard user can reach it and read it, or the reason inside it, as the WAI-ARIA menu
  pattern advises. The menu refuses a click on it, or Enter or Space, before the item's own handler
  sees it, and stays open. An item with `disabled` cannot take focus, so the arrow keys pass over it.

  Keyboard: Enter or Space on the button opens the menu and focuses the first item; the arrow keys,
  Home and End move between items; Escape closes; choosing an item closes. In each case focus
  returns to the button. One menu is open at a time.

  A caller that needs an action on the button, such as a hover description, passes it as
  `triggerAction`; the menu itself knows nothing about what the action does.

  Where this departs from the mockups: the open menu is placed against the viewport, not against
  its wrapper. A menu in a table that scrolls sideways would otherwise be cut off at the table's
  edge. For that to hold, no ancestor of a menu may set `transform`, `filter`, `contain` or
  `container-type`.
-->
<script lang="ts" module>
  /** Closes the menu that is open, if there is one. */
  let closeOpenMenu: (() => void) | null = null;
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { Action } from 'svelte/action';

  interface Props {
    /** The button's accessible name, for example "Actions for Default". */
    label: string;
    /** The items: `button[role="menuitem"]` elements, with `hr` between groups. */
    children: Snippet;
    /** Test id of the button. */
    testid?: string;
    disabled?: boolean;
    /** An action for the button. It is applied once, when the button mounts. */
    triggerAction?: Action<HTMLButtonElement>;
  }

  const {
    label,
    children,
    testid,
    disabled = false,
    triggerAction = () => {}
  }: Props = $props();

  const ITEM_SELECTOR = '[role^="menuitem"]';
  /** The items focus can land on: every one but those with `disabled`. */
  const REACHABLE_ITEM_SELECTOR = `${ITEM_SELECTOR}:not(:disabled)`;
  const REFUSED_ITEM_SELECTOR = `${ITEM_SELECTOR}[aria-disabled="true"]`;
  /** Distance between the button and the menu. */
  const GAP_PX = 2;
  /** The closest the menu comes to an edge of the viewport. */
  const EDGE_PX = 8;

  /** Where each key moves focus, given the focused item's index (-1 for none) and the count. */
  const KEY_TARGETS = new Map<string, (index: number, count: number) => number>([
    ['ArrowDown', (index, count) => (index + 1) % count],
    ['ArrowUp', (index, count) => (index <= 0 ? count - 1 : index - 1)],
    ['Home', () => 0],
    ['End', (_index, count) => count - 1]
  ]);

  let open = $state(false);
  let top = $state(0);
  let left = $state(0);
  let wrap = $state<HTMLSpanElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let menu = $state<HTMLDivElement | undefined>(undefined);

  function reachableItems(): HTMLElement[] {
    return menu === undefined ? [] : [...menu.querySelectorAll<HTMLElement>(REACHABLE_ITEM_SELECTOR)];
  }

  /** Below the button and right-aligned to it; above when there is no room below, clamped to the viewport. */
  function place(): void {
    if (trigger === undefined || menu === undefined) return;
    const anchor = trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const below = anchor.bottom + GAP_PX;
    const above = anchor.top - GAP_PX - size.height;
    const fitsBelow = below + size.height <= window.innerHeight - EDGE_PX;
    const preferredTop = fitsBelow ? below : above >= EDGE_PX ? above : below;
    const maxTop = Math.max(EDGE_PX, window.innerHeight - size.height - EDGE_PX);
    top = Math.max(EDGE_PX, Math.min(preferredTop, maxTop));
    const furthestLeft = window.innerWidth - size.width - EDGE_PX;
    left = Math.max(EDGE_PX, Math.min(anchor.right - size.width, furthestLeft));
  }

  /**
   * Focus goes back to the button only if it is still in the menu. An item's own handler runs
   * first and may have moved focus somewhere on purpose.
   */
  function close(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    const focused = document.activeElement;
    const focusLeftBehind = focused === document.body || wrap?.contains(focused) === true;
    if (returnFocus && focusLeftBehind) trigger?.focus();
  }

  function dismiss(): void {
    close(false);
  }

  async function show(): Promise<void> {
    closeOpenMenu?.();
    closeOpenMenu = dismiss;
    open = true;
    await tick();
    place();
    reachableItems().at(0)?.focus({ preventScroll: true });
  }

  function toggle(): void {
    if (open) {
      dismiss();
      return;
    }
    void show();
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Escape closes the menu and nothing else: a drawer or a selection behind it stays.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      // Focus goes to the button first, so the browser's own Tab step continues from there.
      close(true);
      return;
    }
    const target = KEY_TARGETS.get(event.key);
    const items = reachableItems();
    if (target === undefined || items.length === 0) return;
    event.preventDefault();
    const focusedIndex = items.findIndex((item) => item === document.activeElement);
    items.at(target(focusedIndex, items.length))?.focus();
  }

  /**
   * Runs before any item's handler, whether that handler sits on the item or Svelte delegates it,
   * and stops a click on a disabled item there. The menu stays open, since nothing was chosen.
   */
  function onMenuClickCapture(event: MouseEvent): void {
    const refused =
      event.target instanceof Element && event.target.closest(REFUSED_ITEM_SELECTOR) !== null;
    if (!refused) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onMenuClick(event: MouseEvent): void {
    const chosen = event.target instanceof Element && event.target.closest(ITEM_SELECTOR) !== null;
    if (chosen) close(true);
  }

  // While the menu is open: a press outside it closes it, and so does anything that moves the
  // button it is placed against.
  $effect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent): void => {
      const inside = event.target instanceof Node && wrap?.contains(event.target) === true;
      if (!inside) dismiss();
    };
    const onScroll = (event: Event): void => {
      const movesButton =
        trigger !== undefined && event.target instanceof Node && event.target.contains(trigger);
      if (movesButton) dismiss();
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
      if (closeOpenMenu === dismiss) closeOpenMenu = null;
    };
  });
</script>

<span class="menu-wrap" bind:this={wrap}>
  <button
    type="button"
    class="icon-btn"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    data-testid={testid}
    {disabled}
    bind:this={trigger}
    onclick={toggle}
    use:triggerAction
  >
    <svg class="i" aria-hidden="true"><use href="#i-more"></use></svg>
  </button>
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label={label}
    hidden={!open}
    bind:this={menu}
    style:top="{top}px"
    style:left="{left}px"
    onkeydown={onMenuKeydown}
    onclickcapture={onMenuClickCapture}
    onclick={onMenuClick}
  >
    {@render children()}
  </div>
</span>

<style>
  /* Against the viewport, not the wrapper: see the note at the top of this file. The two style
     directives on the element supply `top` and `left`. */
  .menu-wrap > .menu {
    position: fixed;
    right: auto;
  }
</style>
