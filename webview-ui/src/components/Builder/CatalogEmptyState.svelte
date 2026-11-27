<script lang="ts">
  // Feature 101 (US6, T064, FR-032, FR-033) & Feature 326 — the Builder's front
  // door when a catalog has nothing in it.
  //
  // The words are imported from the shared contract (`emptyCatalogGuidance`),
  // never restated here. In Feature 326 this component no longer mounts its own
  // inline preflight widget: its secondary `Import…` button opens the single
  // top-level Builder Import modal.
  import type { CatalogKind } from "../../../../src/contracts/catalog-store";
  import { emptyCatalogGuidance } from "../../../../src/contracts/empty-catalog-guidance";

  interface Props {
    /** Which tab is empty — the test handle, and nothing else. The words are shared. */
    kind: CatalogKind;
    /** How many definitions this tab has. Zero is the only value that shows anything. */
    count: number;
    /**
     * Why an import cannot start right now (e.g. secondary window), or null.
     */
    disabledReason?: string | null;
    /** Opens the single top-level Builder Import modal, passing the trigger for focus return. */
    onimport?: (originatingElement: HTMLElement | null) => void;
  }

  const { kind, count, disabledReason = null, onimport }: Props = $props();

  const guidance = $derived(emptyCatalogGuidance(count));
  const reasonId = $derived(`catalog-empty-import-unavailable-${kind}`);
</script>

{#if guidance}
  <div class="empty catalog-empty-state" data-testid="catalog-empty-state-{kind}">
    <p
      class="empty-catalog-headline"
      data-testid="catalog-empty-headline-{kind}"
    >
      {guidance.headline}
    </p>
    <p class="empty-catalog-body" data-testid="catalog-empty-body-{kind}">
      {guidance.body}
    </p>
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="catalog-empty-import-{kind}"
      disabled={disabledReason !== null}
      title={disabledReason ?? "Choose a document to inspect"}
      aria-describedby={disabledReason !== null ? reasonId : undefined}
      onclick={(event) => {
        if (disabledReason !== null) return;
        onimport?.(event.currentTarget);
      }}
    >
      <svg class="i" aria-hidden="true"><use href="#i-import"></use></svg>Import…
    </button>
    {#if disabledReason !== null}
      <p
        class="empty-import-note"
        id={reasonId}
        data-testid="catalog-empty-import-unavailable-{kind}"
      >
        {disabledReason}
      </p>
    {/if}
  </div>
{/if}

<style>
  .catalog-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--schegent-space-2);
  }

  .empty-catalog-headline {
    color: var(--schegent-fg);
    font-size: var(--schegent-text-subheading);
    font-weight: 600;
    margin: 0;
  }

  .empty-catalog-body {
    color: var(--schegent-muted-fg);
    max-width: 52ch;
    margin: 0;
  }

  .empty-import-note {
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    margin: 0;
  }
</style>
