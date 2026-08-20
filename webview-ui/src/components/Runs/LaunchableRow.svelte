<script lang="ts">
  // Feature 102 (US1, T012, FR-036) — one thing Runs can start.
  //
  // It is an `<li>` because a section is a list of these and nothing else; the
  // list semantics and the item semantics belong to the same pairing rather than
  // to a wrapper the section would have to remember to add.
  //
  // Every entry here is Active by construction — the projection lists no other
  // kind (FR-002) — so the badge is a constant, not a state read off the row. It
  // is still shown, because "which version am I about to run" is the question
  // this surface exists to answer, and an unlabelled version id does not answer
  // it. The word is the Builder's word (FR-036).
  //
  // Name, description, and version id all originate in operator-authored
  // documents and all render through text interpolation, never Svelte's raw-HTML
  // directive (FR-040). The directive is not named here in full because the test
  // that enforces its absence greps this file for the token.
  //
  // Feature 102 (T022, US2 — FR-014, FR-015) — the whole row is the control that
  // selects it, rather than a hit target tucked beside the name: the row is one
  // choice and there is nothing else on it to press. `aria-pressed` is what tells
  // a screen reader which of the two sections' rows is the current one, since the
  // selected row differs from its neighbours only in styling otherwise.
  //
  // The control is never barred. A window that cannot start runs can still read
  // both lists and select within them (FR-015) — what it cannot do is Trigger,
  // and that is the detail panel's control to withhold, not this one.
  import type { Launchable } from '../../lib/snapshot-types';

  interface Props {
    /** The projected entry, rendered as-is. Nothing is re-derived here. */
    entry: Launchable;
    /** Whether this row is the surface's one selection. */
    selected: boolean;
    onSelect: () => void;
  }

  const { entry, selected, onSelect }: Props = $props();
</script>

<li class="launchable-row" data-testid="launchable-row-{entry.kind}-{entry.id}">
  <button
    type="button"
    class="row-select"
    class:selected
    data-testid="launchable-select-{entry.kind}-{entry.id}"
    aria-pressed={selected}
    onclick={() => onSelect()}
  >
    <span class="row-head">
      <span class="row-name">{entry.name}</span>
      <span class="state-badge">Active</span>
      <span class="row-version" title="Active version">{entry.activeVersionId}</span>
    </span>
    {#if entry.description}
      <span class="row-description">{entry.description}</span>
    {/if}
  </button>
</li>

<style>
  .launchable-row {
    display: flex;
    min-width: 0;
  }

  .row-select {
    background: none;
    border: 1px solid transparent;
    border-radius: 2px;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    flex-direction: column;
    font: inherit;
    gap: 2px;
    min-width: 0;
    padding: 4px 8px;
    text-align: left;
  }

  .row-select.selected {
    border-color: var(--vscode-focusBorder);
  }

  .row-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .row-name {
    font-weight: 600;
  }

  .state-badge {
    background: var(--vscode-badge-background);
    border-radius: 2px;
    color: var(--vscode-badge-foreground);
    font-size: 0.8em;
    padding: 0 4px;
  }

  .row-version {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  .row-description {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
</style>
