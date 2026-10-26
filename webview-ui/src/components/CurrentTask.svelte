<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';
  import type {
    FreshnessState,
    MonitorStatus,
    TelemetrySnapshot
  } from '../lib/snapshot-types';

  const liveActivity = $derived(snapshotStore.liveActivity);
  const freshness: FreshnessState = $derived(liveActivity?.freshness ?? 'idle');
  const staleSeconds = $derived(liveActivity?.staleSeconds ?? null);
  const summary = $derived(liveActivity?.summary ?? null);
  const monitor = $derived(snapshotStore.monitor);
  const freshnessLabel = $derived(mapFreshnessLabel(freshness, staleSeconds));
  const monitorLine = $derived(
    monitor !== null
      ? formatMonitorLine(monitor.status, monitor.msSinceLastStdout, monitor.startedAt, monitor.maxDurationMs)
      : null
  );
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
      return secs !== null && Number.isFinite(secs) ? `slowing, ${secs}s` : 'slowing';
    }
    if (state === 'stalled') {
      return secs !== null && Number.isFinite(secs) ? `stalled, ${secs}s` : 'stalled';
    }
    if (state === 'holding') {
      return secs !== null && Number.isFinite(secs) ? `holding, ${secs}s` : 'holding';
    }
    return state;
  }

  function formatMonitorLine(
    status: MonitorStatus,
    ms: number | null,
    startedAt: string,
    maxDurationMs: number | null
  ): string {
    const label = status.replace('_', ' ');
    const head = ms === null || !Number.isFinite(ms) ? label : `${label} / stdout ${formatDuration(ms)}`;
    return `${head}${formatBoundSegment(startedAt, maxDurationMs)}`;
  }

  /**
   * Feature 211 — elapsed against the invocation's absolute bound, or nothing.
   *
   * Empty string when no bound is in force, so the line renders exactly as it did
   * before this feature: a permanent "of --" is furniture, and substituting the
   * setting's default would assert a limit this invocation does not have.
   *
   * Elapsed is measured from `startedAt` and refreshes when the host publishes,
   * which for a live invocation is every chunk. That makes it a few seconds
   * coarse and, against a bound measured in hours, a few seconds is below what
   * the reading is for — which is also why this is not a countdown or a bar.
   */
  function formatBoundSegment(startedAt: string, maxDurationMs: number | null): string {
    if (maxDurationMs === null || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) return '';
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return '';
    const elapsedMs = Math.max(0, Date.now() - startedMs);
    return ` / ${formatDuration(elapsedMs)} of ${formatDuration(maxDurationMs)}`;
  }

  function formatTelemetryLine(snap: TelemetrySnapshot): string {
    if (snap.status === 'unavailable') {
      return `PID ${snap.pid} / telemetry unavailable`;
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
    return parts.join(' / ');
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
  <div class="task-heading">
    <span>Current activity</span>
    <div class="freshness-row freshness-{freshness}" data-testid="sidebar-freshness" aria-label={`Freshness: ${freshness}`}>
      <span class="dot" aria-hidden="true"></span>
      <span class="freshness-label">{freshnessLabel}</span>
    </div>
  </div>
  <div class="activity" title={summary ?? ''}>{summary ?? 'Waiting for the next run event.'}</div>
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
    gap: 5px;
    padding: 9px 10px 11px;
    border-bottom: 1px solid var(--schegent-divider);
    min-width: 0;
  }
  .task-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--schegent-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 650;
  }
  .freshness-row {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .dot {
    flex: 0 0 auto;
    width: 0.65em;
    height: 0.65em;
    border-radius: 50%;
    background: var(--schegent-color-system);
  }
  @keyframes pulseLive {
    0% { transform: scale(0.9); opacity: 1; }
    70% { transform: scale(1.3); opacity: 0.6; }
    100% { transform: scale(0.9); opacity: 1; }
  }
  .freshness-live .dot { 
    background: var(--schegent-color-active); 
    animation: pulseLive 2s infinite;
  }
  .freshness-slowing .dot { background: var(--schegent-color-warning); }
  .freshness-stalled .dot { background: var(--schegent-color-error); }
  .freshness-paused .dot { background: var(--schegent-color-warning); }
  .freshness-idle .dot { background: var(--schegent-color-system); }
  .freshness-holding .dot { background: var(--schegent-color-active); }
  .freshness-label {
    font-weight: 600;
    font-size: var(--schegent-text-caption);
    color: var(--schegent-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .freshness-stalled .freshness-label { color: var(--schegent-error-text); }
  .freshness-slowing .freshness-label { color: var(--schegent-color-warning); }
  .activity {
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-height: 1em;
  }
  .monitor-row {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .telemetry-row {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
</style>
