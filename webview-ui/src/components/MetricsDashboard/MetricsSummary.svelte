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

<div class="summary-cards" data-testid="metrics-summary-cards">
  <div class="summary-card">
    <span class="summary-label">Tasks Completed</span>
    <span class="summary-value" data-testid="metrics-summary-tasks-completed">{tasksCompleted}</span>
  </div>
  <div class="summary-card">
    <span class="summary-label">Total Elapsed</span>
    <span class="summary-value" data-testid="metrics-summary-elapsed">{formatDuration(elapsedMs)}</span>
  </div>
  <div class="summary-card">
    <span class="summary-label">Total Cost</span>
    <span
      class="summary-value"
      class:cost-not-recorded={totalCostUsd === undefined}
      data-testid="metrics-summary-cost"
    >{formatCost(totalCostUsd)}</span>
  </div>
  <div class="summary-card">
    <span class="summary-label">Backend Calls</span>
    <span class="summary-value" data-testid="metrics-summary-invocations">{backendInvocations}</span>
  </div>
</div>

<style>
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--schegent-gap);
  }
  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--schegent-pad);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    box-shadow: var(--sch-card-shadow);
  }
  .summary-label {
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .summary-value {
    font-size: 1.3em;
    font-weight: 600;
  }
</style>
