<script lang="ts">
  // Feature 087 T064 (FR-042, FR-043, FR-048) — the named outputs a Run
  // recorded, shown in Run details beside the Phase progression and the
  // activity feed rather than on a surface of their own. They are part of what
  // the Run *was*, and an operator reading a finished Run reads them there.
  //
  // An unresolved output is listed, not hidden (FR-042): a declared output the
  // Phases never produced is the thing the operator most needs to see, and
  // omitting it would make an incomplete Run look complete.
  //
  // Every value here is interpolated with `{}`, which escapes. Nothing on this
  // surface uses `{@html}`, and nothing should: the name comes from the
  // Pipeline the operator wrote and the reference from the target they typed
  // (FR-048). The host sanitizes both before they cross; this is the second
  // half of the same rule, not a substitute for it.
  //
  // Keyed by index rather than by name. Names are unique among a Pipeline's
  // declared ports, but the host caps them at 64 characters on the way out, so
  // two long names could arrive identical — an index key turns that into a
  // duplicated row instead of a thrown keyed-each error.

  import type { RunOutputRecord } from '../lib/snapshot-types';

  interface Props {
    readonly outputs: readonly RunOutputRecord[];
  }

  const { outputs }: Props = $props();
</script>

{#if outputs.length > 0}
  <section class="run-outputs" data-testid="run-outputs">
    <header class="zone-title">Run Outputs</header>
    <ul class="output-list">
      {#each outputs as output, index (index)}
        <li class="output-row" data-testid={`run-output-record-${output.name}`}>
          <span class="output-name" data-output-name>{output.name}</span>
          <span
            class="output-status"
            class:unresolved={output.status === 'unresolved'}
            data-testid={`run-output-status-${output.name}`}
          >
            {output.status}
          </span>
          {#if output.reference !== undefined}
            <span class="output-reference" data-testid={`run-output-reference-${output.name}`}
              >{output.reference}</span
            >
          {:else}
            <span class="output-absent">no location recorded</span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .run-outputs {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .zone-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    margin: 0 0 var(--schegent-gap) 0;
    letter-spacing: 0.05em;
  }
  .output-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
  }
  .output-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .output-name {
    font-weight: 600;
    font-size: 0.85em;
    flex-shrink: 0;
  }
  .output-status {
    font-size: 0.75em;
    opacity: 0.8;
  }
  .output-status.unresolved {
    color: var(--vscode-editorWarning-foreground, var(--schegent-muted-fg));
    opacity: 1;
  }
  .output-reference,
  .output-absent {
    font-size: 0.8em;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .output-absent {
    font-style: italic;
  }
</style>
