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

  // The redesign's status chip colours: done for an output that was written, warning for one the
  // Phases never produced.
  const STATUS_CHIP: Record<RunOutputRecord['status'], string> = {
    resolved: 's-ok',
    unresolved: 's-warn'
  };
</script>

<!-- Drawn as the redesign's outputs table: each output, its state as the redesign's status chip
     and where it was written. An output that did not resolve keeps its row with a warning chip.
     The tab names the table, so it carries no title. -->
{#if outputs.length > 0}
  <section class="run-outputs" data-testid="run-outputs">
    <div class="table-wrap">
      <table class="t fit">
        <thead>
          <tr>
            <th scope="col">Output</th>
            <th scope="col">Status</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          {#each outputs as output, index (index)}
            <tr data-testid={`run-output-record-${output.name}`}>
              <td class="output-name" data-output-name>{output.name}</td>
              <td>
                <span
                  class="chip output-status {STATUS_CHIP[output.status]}"
                  data-testid={`run-output-status-${output.name}`}
                  ><span class="dot" aria-hidden="true"></span>{output.status}</span
                >
              </td>
              <td>
                {#if output.reference !== undefined}
                  <span class="mono output-reference" data-testid={`run-output-reference-${output.name}`}
                    >{output.reference}</span
                  >
                {:else}
                  <span class="muted">no location recorded</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<style>
  /* A long name or location wraps inside its cell rather than widening the table. */
  .output-name,
  .output-reference {
    overflow-wrap: anywhere;
  }
  /* The status reads in the chip's sentence case; the text stays the recorded word. */
  .output-status {
    text-transform: capitalize;
  }
</style>
