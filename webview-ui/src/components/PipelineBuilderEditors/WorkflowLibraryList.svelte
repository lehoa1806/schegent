<script lang="ts">
  // Feature 083 (US5, T055/T056, FR-036) — the Library list.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget.
  //
  // Feature 186 (FR-003) — a row shows the name, the id and the state and
  // validity badges, and nothing else. It used to summarise the whole definition
  // (purpose, Pipeline sequence, derived ports, node count); the open Workflow
  // shows that now: the purpose in `WorkflowSettingsInspector`'s General
  // section, the ports in its Inputs and outputs section, the steps on the canvas.
  //
  // Feature 101 (US1, T037) — T037 names `WorkflowCatalogEditor.svelte`, but the
  // Workflow list rows were split out here for that file's 500-line budget, so
  // this is where its rows are. The lifecycle facts arrive as a map rather than
  // on `MutableWorkflow`: the mutable row is the editable copy every save body
  // is stripped out of, and a projected view field there is one strip away from
  // being sent back to the host (FR-010).
  import type { BuilderLifecycle } from "../../lib/snapshot-types";
  import DefinitionLifecycleRow from "../Builder/DefinitionLifecycleRow.svelte";
  import type { MutableWorkflow } from "./types";

  interface Props {
    rows: readonly MutableWorkflow[];
    selectedKey: string | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    onselect: (sourceKey: string) => void;
  }

  const { rows, selectedKey, lifecycleByKey, onselect }: Props = $props();
</script>

<div class="phase-list">
  {#each rows as row (row.sourceKey)}
    <div class="phase-list-row">
      <button
        class="phase-list-item {selectedKey === row.sourceKey
          ? 'selected'
          : ''}"
        data-testid="workflows-list-item-{row.workflowId}"
        aria-current={selectedKey === row.sourceKey ? "true" : undefined}
        onclick={() => onselect(row.sourceKey)}
      >
        <div class="phase-list-title">{row.name || "Untitled Workflow"}</div>
        <div class="phase-list-id">{row.workflowId}</div>
      </button>
      <!-- Outside the selection button, not inside it: a control nested in a
           button is invalid markup and unreachable by keyboard.
           Feature 186 (US3, T017, D-2) — everything but the two badges moved
           to `DefinitionLifecyclePanel` on the inspector's resting branch. -->
      <DefinitionLifecycleRow
        definitionId={row.workflowId}
        lifecycle={lifecycleByKey.get(row.sourceKey)}
        validity={row.sourceStatus}
      />
    </div>
  {/each}
</div>
