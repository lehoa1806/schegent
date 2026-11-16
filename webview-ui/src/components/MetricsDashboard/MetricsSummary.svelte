<script lang="ts">
  import { formatDuration } from '../../lib/format-duration';

  interface Props {
    tasksCompleted: number;
    elapsedMs: number;
    totalCostUsd: number | undefined;
    backendInvocations: number;
  }

  const { tasksCompleted, elapsedMs, totalCostUsd, backendInvocations }: Props = $props();

  function formatCost(value: number | undefined): string {
    return value === undefined ? 'Not recorded' : `$${value.toFixed(2)}`;
  }
</script>

<!-- FR-R3-009 — these figures cover only the runs the retained audit corpus
     still holds, which is why the label names that scope: the all-time
     cumulative strip above carries its own, wider window. -->
<dl class="summary-strip" data-testid="metrics-summary-cards" aria-label="Retained run detail totals">
  <div class="summary-item">
    <dt>Completed</dt>
    <dd data-testid="metrics-summary-tasks-completed">{tasksCompleted}</dd>
  </div>
  <div class="summary-item">
    <dt>Run time</dt>
    <dd data-testid="metrics-summary-elapsed">{formatDuration(elapsedMs)}</dd>
  </div>
  <div class="summary-item">
    <dt>Cost</dt>
    <dd
      class:cost-not-recorded={totalCostUsd === undefined}
      data-testid="metrics-summary-cost"
    >{formatCost(totalCostUsd)}</dd>
  </div>
  <div class="summary-item">
    <dt>Backend calls</dt>
    <dd data-testid="metrics-summary-invocations">{backendInvocations}</dd>
  </div>
</dl>

<style>
  /* One line of figures, in the mockup's "a · b · c" context style. */
  .summary-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    margin: 0;
    font-size: var(--schegent-text-secondary);
  }
  .summary-item {
    display: inline-flex;
    align-items: baseline;
    gap: var(--schegent-space-1);
  }
  /* The dot is a separator, not content: its alternative text is empty. */
  .summary-item + .summary-item::before {
    content: '·' / '';
    margin-inline: var(--schegent-space-1-5);
    color: var(--schegent-muted-fg);
  }
  dt {
    color: var(--schegent-muted-fg);
  }
  dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
