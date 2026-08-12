<script lang="ts">
  import type { CliMonitorState, MonitorStatus } from '../lib/snapshot-types';
  import { formatDuration } from '../lib/format-duration';

  interface Props {
    monitor: CliMonitorState | null;
  }

  const { monitor }: Props = $props();

  const status = $derived<MonitorStatus | null>(monitor?.status ?? null);
  const statusLabel = $derived(formatStatus(status));
  const stdoutLabel = $derived(
    monitor?.msSinceLastStdout != null ? formatDuration(monitor.msSinceLastStdout) : null
  );
  const stderrLabel = $derived(
    monitor?.msSinceLastStderr != null ? formatDuration(monitor.msSinceLastStderr) : null
  );

  function formatStatus(s: MonitorStatus | null): string {
    if (s === null) return '';
    return s.replace('_', ' ');
  }
</script>

{#if monitor !== null && status !== null}
  <span
    class="monitor-pill status-{status}"
    data-testid="monitor-pill"
    data-status={status}
    role="status"
    aria-label={`Monitor ${formatStatus(status)}`}
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="label" data-testid="monitor-pill-label">{statusLabel}</span>
    {#if stdoutLabel !== null}
      <span class="freshness" data-testid="monitor-last-stdout">last stdout: {stdoutLabel}</span>
    {/if}
    {#if stderrLabel !== null}
      <span class="freshness" data-testid="monitor-last-stderr">last stderr: {stderrLabel}</span>
    {/if}
  </span>
{/if}

<style>
  .monitor-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--schegent-gap);
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--schegent-border);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    color: var(--schegent-fg);
    background: transparent;
  }
  .dot {
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
  }
  .status-starting .dot { background: var(--vscode-charts-blue); }
  .status-running .dot { background: var(--vscode-charts-green); }
  .status-stalled .dot { background: var(--vscode-errorForeground); }
  .status-completed .dot { background: var(--vscode-descriptionForeground); }
  .status-failed .dot { background: var(--vscode-errorForeground); }
  .status-timed_out .dot { background: var(--vscode-errorForeground); }
  .status-canceled .dot { background: var(--vscode-errorForeground); }
  .status-paused .dot { background: var(--vscode-descriptionForeground); }

  .status-stalled .label { color: var(--schegent-error-text); }
  .status-failed .label { color: var(--schegent-error-text); }
  .status-timed_out .label { color: var(--schegent-error-text); }
  .status-canceled .label { color: var(--schegent-error-text); }

  .label {
    font-weight: 600;
  }
  .freshness {
    color: var(--schegent-muted-fg);
  }

  .status-running .dot,
  .status-starting .dot {
    animation: monitor-pulse 1.5s ease-in-out infinite;
  }
  @keyframes monitor-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-running .dot,
    .status-starting .dot {
      animation: none;
    }
  }
</style>
