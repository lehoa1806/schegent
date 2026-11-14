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
  //
  // Drawn as the redesign's picker row: the kind's icon, the name in bold, and
  // the description with the version beneath it. The redesign draws the picker
  // as radios; this stays a toggle, because pressing the chosen row again clears
  // the choice, which a radio cannot do.
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
    class="pick row-select"
    data-testid="launchable-select-{entry.kind}-{entry.id}"
    aria-pressed={selected}
    onclick={() => onSelect()}
  >
    <span class="kicon {entry.kind === 'workflow' ? 'k-workflow' : 'k-phase'}"
    ><svg class="i" aria-hidden="true"><use href={entry.kind === 'workflow' ? '#i-workflow' : '#i-phase'}></use></svg></span>
    <span class="row-text">
      <span class="t">{entry.name} <span class="tag">Active</span></span>
      <span class="d">{#if entry.description}{entry.description} ·{/if} <span class="mono" title="Active version">{entry.activeVersionId}</span></span>
    </span>
  </button>
</li>

<style>
  .launchable-row {
    display: flex;
    min-width: 0;
  }

  .row-text {
    min-width: 0;
  }

  .tag {
    font-weight: 400;
  }

  .mono {
    font-size: inherit;
  }
</style>
