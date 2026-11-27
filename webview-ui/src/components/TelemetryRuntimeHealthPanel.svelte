<script lang="ts">
  import { untrack } from 'svelte';
  import { availabilityPhrase } from '../../../src/contracts/change-review';
  import type { RuntimePostureVisibility } from '../lib/messages';
  import { requestExecutionVisibility } from '../lib/execution-visibility-ipc';
  import { snapshotStore } from '../lib/snapshot-store.svelte';

  let loading = $state(false);
  let posture = $state<RuntimePostureVisibility | null>(null);
  let notice = $state('');
  let requestGen = 0;
  let lastResyncCount = snapshotStore.resyncCount;

  /** The `.sg` status tone of a delivery state other than healthy; any other state reads as active. */
  const DELIVERY_TONES: Partial<Record<string, string>> = {
    retrying: 's-warn',
    degraded: 's-err'
  };

  $effect(() => {
    untrack(() => {
      void refreshPosture();
    });
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshPosture();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  $effect(() => {
    const currentResync = snapshotStore.resyncCount;
    void snapshotStore.snapshot;
    if (currentResync !== lastResyncCount) {
      lastResyncCount = currentResync;
      untrack(() => {
        void refreshPosture();
      });
    }
  });

  async function refreshPosture(): Promise<void> {
    const gen = ++requestGen;
    loading = true;
    const env = await requestExecutionVisibility({ op: 'runtimePosture' });
    if (gen !== requestGen) return;
    loading = false;
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'runtimePosture') {
      posture = env.response.posture;
      const telemetry = posture.telemetry;
      notice =
        !telemetry.enabled && telemetry.reasonCode !== null
          ? `Updated runtime posture (refused: ${telemetry.reasonCode}).`
          : `Updated runtime posture (${telemetry.stateKind}).`;
    }
  }

  function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function deliveryTone(stateKind: string): string {
    return DELIVERY_TONES[stateKind] ?? 's-run';
  }

  function stateWithReason(stateKind: string, reasonCode: string | null): string {
    return reasonCode === null ? stateKind : `${stateKind} (${reasonCode})`;
  }

  function safeContentPolicyMode(raw: string): 'metadata-only' | 'content' | 'invalid' {
    if (raw === 'metadata-only' || raw === 'content') return raw;
    return 'invalid';
  }
</script>

<section class="runtime" aria-label="Telemetry and isolated lane health" data-testid="telemetry-runtime-health-panel">
  <div class="toolbar">
    <p class="notice small muted" role="status" aria-live="polite" data-testid="runtime-health-notice">{notice}</p>
    <div class="push">
      <button
        type="button"
        class="icon-btn refresh"
        aria-label="Refresh runtime posture"
        title="Refresh"
        aria-disabled={loading ? 'true' : undefined}
        data-testid="runtime-health-refresh"
        onclick={() => {
          if (!loading) void refreshPosture();
        }}
      ><svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg></button>
    </div>
  </div>

  {#if posture === null}
    <p class="empty">Reading runtime posture…</p>
  {:else if !posture.available}
    <p class="empty" data-testid="runtime-health-unavailable">
      SQLite runtime store: {availabilityPhrase('unavailable')}. OTLP export remains fail-closed ({posture.telemetry.stateKind}).
    </p>
  {:else}
    <div class="grid g2">
      <section class="card" aria-label="OpenTelemetry export health" data-testid="otlp-health-card">
        <div class="titlerow">
          <h2>Telemetry export</h2>
          {#if !posture.telemetry.enabled && posture.telemetry.reasonCode !== null}
            <span class="chip s-err"><span class="dot"></span>Refused</span>
          {:else if !posture.telemetry.enabled}
            <span class="chip s-idle"><span class="dot"></span>Off</span>
          {:else if posture.telemetry.stateKind === 'healthy'}
            <span class="chip s-ok"><svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>Healthy</span>
          {:else}
            <span class="chip {deliveryTone(posture.telemetry.stateKind)}"><span class="dot"></span><span class="word">{posture.telemetry.stateKind}</span></span>
          {/if}
        </div>
        {#if !posture.telemetry.enabled && posture.telemetry.reasonCode !== null}
          <p class="refusal small s-err" role="status" data-testid="telemetry-refusal-notice">
            {#if posture.telemetry.reasonCode === 'content-export-unsupported'}
              Export refused (<span class="mono">{posture.telemetry.reasonCode}</span>): requested content policy
              <span class="mono">{safeContentPolicyMode(posture.telemetry.contentPolicyMode)}</span> is unsupported; mapping revision 1 exports allowlisted metadata only.
            {:else}
              Export refused (<span class="mono">{posture.telemetry.reasonCode}</span>).
            {/if}
          </p>
        {/if}
        <p class="small muted" data-testid="otlp-preview-disclosure">{posture.telemetry.previewSummary}</p>
        <dl class="kv">
          <dt>Authorization</dt>
          <dd>
            {#if posture.telemetry.enabled}
              Authorized
            {:else if posture.telemetry.reasonCode !== null}
              Refused ({posture.telemetry.reasonCode})
            {:else}
              Disabled
            {/if}
          </dd>
          <dt>Waiting to send</dt>
          <dd>{posture.telemetry.pendingCopyCount}</dd>
          <dt>Disk used</dt>
          <dd>{fmtBytes(posture.telemetry.spooledBytes)} of {fmtBytes(posture.telemetry.spoolCeilingBytes)}</dd>
        </dl>
        <details class="diag">
          <summary>Diagnostics</summary>
          <dl class="kv">
            <dt>State</dt>
            <dd class="mono">{stateWithReason(posture.telemetry.stateKind, posture.telemetry.reasonCode)}</dd>
            <dt>Protocol</dt>
            <dd class="mono">{posture.telemetry.protocol ?? 'inactive'} &middot; {safeContentPolicyMode(posture.telemetry.contentPolicyMode)}</dd>
            <dt>Ledger</dt>
            <dd class="mono">
              {posture.telemetry.exportedCopyCount} exported &middot; {posture.telemetry.pendingCopyCount} pending &middot;
              {posture.telemetry.droppedCopyCount} dropped
            </dd>
            <dt>Spool</dt>
            <dd class="mono">{posture.telemetry.spooledBatchCount} batch(es)</dd>
            <dt>Series</dt>
            <dd class="mono">
              {posture.telemetry.activeSeriesCount} / {posture.telemetry.seriesCap} active sets
              ({posture.telemetry.overflowCount} overflow folded)
            </dd>
          </dl>
        </details>
      </section>

      <section class="card" aria-label="Isolated execution lanes" data-testid="lanes-health-card">
        <div class="titlerow">
          <h2>Isolated workspaces</h2>
          {#if posture.lanes.enabled}
            <span class="chip s-ok"><svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>On</span>
          {:else}
            <span class="chip s-idle"><span class="dot"></span>Off</span>
          {/if}
        </div>
        <p class="small muted">
          {posture.lanes.enabled
            ? 'Each run works in its own copy of the repository and merges back when it finishes.'
            : 'Runs work in the shared workspace.'}
        </p>
        <dl class="kv">
          <dt>In use</dt>
          <dd>{posture.lanes.activeLanes} / {posture.lanes.liveLaneCap} active lane(s)</dd>
          <dt>Waiting to merge</dt>
          <dd>{posture.lanes.pendingIntegrations} awaiting verification, review, or landing</dd>
          <dt>Recorded</dt>
          <dd>{posture.lanes.totalLanes} total</dd>
        </dl>
        <details class="diag">
          <summary>Diagnostics</summary>
          <dl class="kv">
            <dt>Store</dt>
            <dd class="mono">SQLite runtime store: ok</dd>
            <dt>Worktree cap</dt>
            <dd class="mono">{posture.lanes.liveLaneCap}</dd>
          </dl>
        </details>
      </section>
    </div>
  {/if}
</section>

<style>
  .notice {
    margin: 0;
  }

  .runtime .empty {
    margin: 0;
  }

  .card > p {
    margin: var(--schegent-space-3) 0;
  }

  .refusal {
    color: var(--schegent-status-error-text);
    font-weight: 500;
  }

  .word {
    text-transform: capitalize;
  }

  @media (prefers-reduced-motion: no-preference) {
    .refresh:disabled .i {
      animation: runtime-turn 0.9s linear infinite;
    }
  }

  @keyframes runtime-turn {
    to {
      transform: rotate(360deg);
    }
  }
</style>
