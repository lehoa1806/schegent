<script lang="ts">
  // Feature 102 (US1, T013, FR-006, FR-035) — one of the two sections Runs is
  // made of.
  //
  // A labelled region, so a screen reader can move between "Pipelines" and
  // "Workflows" directly and hears which one it landed in. The name is a prop
  // rather than a literal keyed off `kind`: the two sections then differ in
  // exactly one place, and the heading an operator reads is the accessible name
  // by construction rather than by a second string kept in step with it.
  //
  // **Four arms, chosen from the section state and never from the list length.**
  // Three of the four render no entries, so the length cannot tell them apart —
  // conflating them is how a workspace that has definitions gets told it has
  // none. Absence of the section is the loading arm (FR-006); the host omits
  // `launchables` until both catalogs have resolved, and a confident "nothing
  // here" for a host that has not looked yet is a wrong answer, not an empty one.
  //
  // Feature 102 (T045, US5 — FR-028, FR-029, FR-030) — the two empty arms are
  // split, and each carries its true reason and a reachable action. The
  // placeholder T013 left said "Nothing to start here yet", which was honest and
  // useless: it named neither of the two things that could be wrong and neither of
  // the two different fixes.
  //
  // Both messages come from `contracts/empty-catalog-guidance.ts`, not from
  // literals here. The no-definitions text is shared with the Builder's own empty
  // state and with the host's launch refusal (FR-029) — three surfaces, one string,
  // which is only true if none of them owns a copy. The none-Active text has one
  // renderer today and lives beside it anyway: the moment a second surface needs to
  // say "publish it first", the shared source is already where it would look.
  //
  // That module is a leaf and imports nothing, which is what makes it safe for a
  // webview component to value-import a file out of `src/`.
  //
  // Feature 102 (T022, US2 — FR-014) — the section renders the selection but does
  // not hold it. There is one selection across both sections, so a section that
  // kept its own would have to be told when the other one changed; passing it
  // down means "selected in Pipelines" and "selected in Workflows" cannot both be
  // true, by construction rather than by coordination.
  import type { Launchable, LaunchSection } from '../../lib/snapshot-types';
  import {
    EMPTY_CATALOG_GUIDANCE,
    NONE_ACTIVE_GUIDANCE
  } from '../../../../src/contracts/empty-catalog-guidance';
  import LaunchableRow from './LaunchableRow.svelte';
  import { isSelected, type LaunchSelection } from './launch-selection';

  interface Props {
    /** The heading an operator reads, and the region's accessible name. */
    name: string;
    /** Which catalog this section offers — the test handle and the id namespace. */
    kind: 'pipeline' | 'workflow';
    /** Absent while the host has not resolved both catalogs. Not a fourth arm. */
    section: LaunchSection | undefined;
    /** The surface's one selection, which may name an entry in the other section. */
    selection: LaunchSelection;
    onSelect: (entry: Launchable) => void;
  }

  const { name, kind, section, selection, onSelect }: Props = $props();
</script>

<section
  class="launch-section"
  data-testid="launch-section-{kind}"
  aria-labelledby="launch-section-heading-{kind}"
>
  <h3 class="section-heading" id="launch-section-heading-{kind}">{name}</h3>
  {#if section === undefined}
    <p class="section-note" data-testid="launch-section-loading-{kind}">Loading…</p>
  {:else if section.state === 'entries'}
    <ul class="section-list" data-testid="launch-section-list-{kind}">
      {#each section.entries as entry (entry.kind + entry.id)}
        <LaunchableRow
          {entry}
          selected={isSelected(entry, selection)}
          onSelect={() => onSelect(entry)}
        />
      {/each}
    </ul>
  {:else if section.state === 'no-definitions'}
    <div class="section-guidance" data-testid="launch-section-no-definitions-{kind}">
      <p class="guidance-headline">{EMPTY_CATALOG_GUIDANCE.headline}</p>
      <p class="section-note">{EMPTY_CATALOG_GUIDANCE.body}</p>
    </div>
  {:else}
    <div class="section-guidance" data-testid="launch-section-none-active-{kind}">
      <p class="guidance-headline">{NONE_ACTIVE_GUIDANCE.headline}</p>
      <p class="section-note">{NONE_ACTIVE_GUIDANCE.body}</p>
    </div>
  {/if}
</section>

<style>
  .launch-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .section-heading {
    font-size: 0.9em;
    margin: 0;
    text-transform: uppercase;
  }

  .section-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .section-guidance {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .guidance-headline {
    font-size: 0.85em;
    font-weight: 600;
    margin: 0;
    padding: 0 8px;
  }

  .section-note {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    margin: 0;
    padding: 0 8px;
  }
</style>
