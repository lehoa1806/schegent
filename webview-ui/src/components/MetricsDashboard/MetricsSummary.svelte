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

<dl class="summary-strip" data-testid="metrics-summary-cards" aria-label="Workflow totals">
  <div class="summary-item">
    <dt class="summary-label">Tasks Completed</dt>
    <dd class="summary-value" data-testid="metrics-summary-tasks-completed">{tasksCompleted}</dd>
  </div>
  <div class="summary-item">
    <dt class="summary-label">Total Elapsed</dt>
    <dd class="summary-value" data-testid="metrics-summary-elapsed">{formatDuration(elapsedMs)}</dd>
  </div>
  <div class="summary-item">
    <dt class="summary-label">Total Cost</dt>
    <dd
      class="summary-value"
      class:cost-not-recorded={totalCostUsd === undefined}
      data-testid="metrics-summary-cost"
    >{formatCost(totalCostUsd)}</dd>
  </div>
  <div class="summary-item">
    <dt class="summary-label">Backend Calls</dt>
    <dd class="summary-value" data-testid="metrics-summary-invocations">{backendInvocations}</dd>
  </div>
</dl>

<style>
  .summary-strip {
    display: flex;
    flex-wrap: wrap;
    margin: 0;
    padding: 8px 0;
    border-block: 1px solid var(--schegent-divider);
  }
  .summary-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 140px;
    min-width: 0;
    padding: 4px var(--schegent-pad);
  }
  .summary-item + .summary-item {
    border-inline-start: 1px solid var(--schegent-divider);
  }
  .summary-label {
    order: 2;
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
  }
  .summary-value {
    order: 1;
    margin: 0;
    font-size: 1.3em;
    font-weight: 600;
  }

  @media (max-width: 560px) {
    .summary-item {
      flex-basis: 50%;
    }
    .summary-item:nth-child(3) {
      border-inline-start: 0;
    }
  }
</style>
