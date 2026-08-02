<script lang="ts">
  // Feature 082 (US3, T039) — one bounded error region.
  //
  // Every region carries a stable `id` so the control that owns it can point at
  // it with `aria-describedby` and name only its own messages (FR-038). What
  // does not fit is counted rather than dropped, so an operator always knows
  // more remains (FR-032).
  import { boundFieldErrors, type PipelineDraftError } from './pipeline-catalog-state';

  interface Props {
    id: string;
    errors: readonly PipelineDraftError[];
    /**
     * Prefix each message with the field it names. Only useful for the
     * Pipeline-level region, where the message is not already sitting beside
     * the control it describes.
     */
    withField?: boolean;
    testId?: string;
  }

  const { id, errors, withField = false, testId }: Props = $props();

  const bounded = $derived(boundFieldErrors(errors));
</script>

{#if errors.length > 0}
  <div class="field-errors full-width" {id} role="alert" data-testid={testId}>
    {#each bounded.visible as error (error.field + error.code)}
      <!-- prettier-ignore -->
      <div data-testid="pipeline-field-error">{#if withField}<strong>{error.field}:</strong> {/if}{error.message}</div>
    {/each}
    {#if bounded.withheld > 0}
      <div data-testid="pipeline-field-errors-overflow">+{bounded.withheld} more not shown</div>
    {/if}
  </div>
{/if}
