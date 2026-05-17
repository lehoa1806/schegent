<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';
  import type {
    FreshnessState,
    MonitorStatus,
    TelemetrySnapshot
  } from '../lib/snapshot-types';

  const liveActivity = $derived(snapshotStore.snapshot?.liveActivity ?? null);
  const freshness: FreshnessState = $derived(liveActivity?.freshness ?? 'idle');
  const staleSeconds = $derived(liveActivity?.staleSeconds ?? null);
  const summary = $derived(liveActivity?.summary ?? null);
  const monitor = $derived(snapshotStore.monitor);
  const freshnessLabel = $derived(mapFreshnessLabel(freshness, staleSeconds));
  const monitorLine = $derived(monitor !== null ? formatMonitorLine(monitor.status, monitor.msSinceLastStdout) : null);
  // Feature 033 — ephemeral telemetry projection. The host clears this
  // to `null` one publish after the runner's `exited` event; the field
  // is optional on the snapshot for legacy-tolerance, so we treat
  // `undefined` the same as `null`.
  const telemetry: TelemetrySnapshot | null = $derived(snapshotStore.snapshot?.telemetry ?? null);
  const telemetryLine = $derived(telemetry !== null ? formatTelemetryLine(telemetry) : null);

  function mapFreshnessLabel(state: FreshnessState, secs: number | null): string {
    if (state === 'live') return 'live';
    if (state === 'paused') return 'paused';
    if (state === 'idle') return 'idle';
    if (state === 'slowing') {
      return secs !== null && Number.isFinite(secs) ? `slowing — ${secs}s` : 'slowing';
    }
    if (state === 'stalled') {
      return secs !== null && Number.isFinite(secs) ? `stalled — ${secs}s` : 'stalled';
    }
    return state;
  }

  function formatMonitorLine(status: MonitorStatus, ms: number | null): string {
    const label = status.replace('_', ' ');
    if (ms === null || !Number.isFinite(ms)) return label;
    return `${label} · stdout ${formatDuration(ms)}`;
  }

  function formatTelemetryLine(snap: TelemetrySnapshot): string {
    if (snap.status === 'unavailable') {
      return `PID ${snap.pid} · telemetry unavailable`;
    }
    const cpu = snap.cpuPercent;
    const rss = snap.memoryRssBytes;
    const up = snap.uptimeMs;
    const cpuLabel = cpu !== null && Number.isFinite(cpu)
      ? `${formatCpu(cpu)}% CPU`
      : null;
    const memLabel = rss !== null && Number.isFinite(rss)
      ? `${formatMemMB(rss)} MB`
      : null;
    const upLabel = up !== null && Number.isFinite(up)
      ? formatUptimeMmSs(up)
      : null;
    const parts = [`PID ${snap.pid}`, cpuLabel, memLabel, upLabel].filter(
      (p): p is string => typeof p === 'string'
    );
    return parts.join(' · ');
  }

  function formatCpu(p: number): string {
    // Integer when whole, one decimal otherwise. Matches the host
    // ps `%cpu` semantics: 0–100 per core. Clamp to non-negative.
    const v = Math.max(0, p);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  }

  function formatMemMB(bytes: number): string {
    const mb = Math.max(0, bytes) / (1024 * 1024);
    return String(Math.round(mb));
  }

  function formatUptimeMmSs(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
</script>

<div class="current-task" data-testid="sidebar-current-task">
  <div class="freshness-row freshness-{freshness}" data-testid="sidebar-freshness" aria-label={`Freshness: ${freshness}`}>
    <span class="dot" aria-hidden="true"></span>
    <span class="freshness-label">{freshnessLabel}</span>
  </div>
  <div class="activity" title={summary ?? ''}>{summary ?? ''}</div>
  {#if monitor !== null && monitorLine !== null}
    <div class="monitor-row" data-testid="sidebar-monitor-row">{monitorLine}</div>
  {/if}
  {#if telemetry !== null && telemetryLine !== null}
    <div class="telemetry-row" data-testid="sidebar-telemetry-row">{telemetryLine}</div>
  {/if}
</div>

<style>
  .current-task {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--schegent-divider);
    min-width: 0;
  }
  .freshness-row {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
    min-width: 0;
  }
  .dot {
    flex: 0 0 auto;
    width: 0.65em;
    height: 0.65em;
    border-radius: 50%;
    background: var(--schegent-color-system);
  }
  .freshness-live .dot { background: var(--schegent-color-active); }
  .freshness-slowing .dot { background: var(--schegent-color-warning); }
  .freshness-stalled .dot { background: var(--schegent-color-error); }
  .freshness-paused .dot { background: var(--schegent-color-warning); }
  .freshness-idle .dot { background: var(--schegent-color-system); }
  .freshness-label {
    font-weight: 600;
    font-size: 0.9em;
    color: var(--schegent-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .freshness-stalled .freshness-label { color: var(--schegent-color-error); }
  .freshness-slowing .freshness-label { color: var(--schegent-color-warning); }
  .activity {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-height: 1em;
  }
  .monitor-row {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .telemetry-row {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
</style>
