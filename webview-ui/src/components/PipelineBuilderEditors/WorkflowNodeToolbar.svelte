<script lang="ts">
  // The selected card's operations, drawn as the redesign's `.ntool` (sg-builder.css)
  // and floating beside the card's top-right corner, or over it where a fork's next
  // arm stands beside the card (workflow-flow.css).
  //
  // Three buttons where the redesign has five, and only Delete is one of its five.
  // Move earlier and Move later are the product's: they move the step within the
  // Workflow's authored list of steps, the order its definition saves (the canvas
  // draws reachable steps in offer order whatever that list says). Of the
  // redesign's others, "Add after" is the `+` under a terminal card and on every
  // arm, "Open definition" is the child Workflow's preview line, and Replace and
  // Duplicate have no operation behind them in the Builder yet; a button that does
  // nothing is worse than none.
  //
  // Every button stays in the Tab order. The canvas carries no `tabindex` at all,
  // so no arrow key moves between the buttons. A `toolbar` role promises one Tab
  // stop and arrow keys, so the buttons are a `group` named for the card. The
  // redesign's toolbar declares the role without the keys.
  import { tick } from 'svelte';

  interface Props {
    index: number;
    /** How many nodes the authored list holds, so the last one cannot move later. */
    count: number;
    title: string;
    onmove: (delta: number) => void;
    onremove: () => void;
  }

  const { index, count, title, onmove, onremove }: Props = $props();

  let earlier = $state<HTMLButtonElement>();
  let later = $state<HTMLButtonElement>();
  let remove = $state<HTMLButtonElement>();

  /**
   * A move to either end disables the button just pressed, and a disabled
   * button drops focus to the page. Focus goes to the next button that still
   * works: the other direction, or Delete when the node is the only one.
   */
  async function move(delta: number): Promise<void> {
    onmove(delta);
    await tick();
    const pressed = delta < 0 ? earlier : later;
    const other = delta < 0 ? later : earlier;
    const next = [pressed, other, remove].find((button) => button !== undefined && !button.disabled);
    next?.focus();
  }
</script>

<div class="ntool wf-ntool" role="group" aria-label="Actions for {title}">
  <button
    type="button"
    class="icon-btn"
    data-testid="workflow-node-up-{index}"
    aria-label="Move {title} earlier"
    title="Move earlier"
    disabled={index === 0}
    bind:this={earlier}
    onclick={() => void move(-1)}
  >
    <svg class="i wf-flip" aria-hidden="true"><use href="#i-chev"></use></svg>
  </button>
  <button
    type="button"
    class="icon-btn"
    data-testid="workflow-node-down-{index}"
    aria-label="Move {title} later"
    title="Move later"
    disabled={index === count - 1}
    bind:this={later}
    onclick={() => void move(1)}
  >
    <svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg>
  </button>
  <button
    type="button"
    class="icon-btn destructive-icon"
    data-testid="workflow-node-remove-{index}"
    aria-label="Delete {title}"
    title="Delete"
    bind:this={remove}
    onclick={onremove}
  >
    <svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>
  </button>
</div>
