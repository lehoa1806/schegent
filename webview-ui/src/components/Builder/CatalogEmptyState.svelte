<script lang="ts">
  // Feature 101 (US6, T064, FR-032, FR-033) — the Builder's front door when a
  // catalog has nothing in it.
  //
  // The words are imported, never written here (FR-032). FR-030a of feature 098
  // made the wording a contract between surfaces — the Runs surface and this one
  // say the identical thing — and the only mechanism that survives an edit is a
  // shared constant. A literal here would agree with `RunsSurface.svelte` on the
  // day it was typed and drift the first time either is reworded, silently,
  // because nothing compares two literals in two files.
  //
  // The guidance helper decides *whether* to show, rather than a zero check
  // written here, for the same reason: the rule is as shared as the text, and a
  // rule stated twice is a rule that can be changed once.
  //
  // The import affordance comes with it. Guidance that says "import a process
  // document" beside no way to import one is an instruction, not a front door —
  // and on the Pipelines and Workflows tabs this is the only import entry there
  // is.
  import type { CatalogKind } from '../../../../src/contracts/catalog-store';
  import { emptyCatalogGuidance } from '../../../../src/contracts/empty-catalog-guidance';
  import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';

  interface Props {
    /** Which tab is empty — the test handle, and nothing else. The words are shared. */
    kind: CatalogKind;
    /** How many definitions this tab has. Zero is the only value that shows anything. */
    count: number;
    /**
     * Why an import cannot start right now, or null. Owned by the tab, as it is
     * for the standalone preflight: the conditions are the manager's (FR-057).
     */
    disabledReason?: string | null;
  }

  const { kind, count, disabledReason = null }: Props = $props();

  const guidance = $derived(emptyCatalogGuidance(count));
</script>

{#if guidance}
  <div class="catalog-empty-state" data-testid="catalog-empty-state-{kind}">
    <p class="empty-catalog-headline" data-testid="catalog-empty-headline-{kind}">
      {guidance.headline}
    </p>
    <p class="empty-catalog-body" data-testid="catalog-empty-body-{kind}">{guidance.body}</p>
    <ProcessImportPreflight {disabledReason} />
  </div>
{/if}

<style>
  .catalog-empty-state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }

  .empty-catalog-headline {
    font-weight: 600;
    margin: 0;
  }

  .empty-catalog-body {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
</style>
