<script lang="ts">
  import { untrack } from 'svelte';
  import { availabilityPhrase } from '../../../src/contracts/change-review';
  import type { RuntimePostureVisibility } from '../lib/messages';
  import { requestExecutionVisibility } from '../lib/execution-visibility-ipc';

  let loading = $state(false);
  let posture = $state<RuntimePostureVisibility | null>(null);
  let notice = $state('');

  $effect(() => {
    untrack(() => {
      void refreshPosture();
    });
  });

  async function refreshPosture(): Promise<void> {
    loading = true;
    const env = await requestExecutionVisibility({ op: 'runtimePosture' });
    loading = false;
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'runtimePosture') {
      posture = env.response.posture;
      notice = `Updated runtime posture (${posture.telemetry.stateKind}).`;
    }
  }

  function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
</script>

<section class="runtime-health" aria-label="Telemetry and isolated lane health" data-testid="telemetry-runtime-health-panel">
  <header class="rh-header">
    <div>
      <h2>OTLP telemetry &amp; execution lane posture</h2>
      <p class="rh-sub">Metadata-only export health, spool bounds, cardinality guard, and isolated worktree lanes.</p>
    </div>
    <button
      type="button"
      class="btn"
      disabled={loading}
      data-testid="runtime-health-refresh"
      onclick={() => void refreshPosture()}
    >
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </header>

  <p class="rh-status" role="status" aria-live="polite" data-testid="runtime-health-notice">{notice}</p>

  {#if posture === null}
    <p class="rh-sub">Reading runtime posture…</p>
  {:else if !posture.available}
    <p class="rh-sub" data-testid="runtime-health-unavailable">
      SQLite runtime store: {availabilityPhrase('unavailable')}. OTLP export remains fail-closed ({posture.telemetry.stateKind}).
    </p>
  {:else}
    <div class="rh-cards">
      <section class="rh-card" aria-label="OpenTelemetry export health" data-testid="otlp-health-card">
        <h3>OpenTelemetry export</h3>
        <dl class="rh-dl">
          <div>
            <dt>Authorization</dt>
            <dd><span class="badge">{posture.telemetry.enabled ? 'Authorized' : 'Disabled / Refused'}</span></dd>
          </div>
          <div>
            <dt>Delivery health</dt>
            <dd>
              <span class="badge">{posture.telemetry.stateKind}</span>
              {#if posture.telemetry.reasonCode !== null}
                ({posture.telemetry.reasonCode})
              {/if}
            </dd>
          </div>
          <div>
            <dt>Protocol &amp; policy</dt>
            <dd>{posture.telemetry.protocol ?? 'inactive'} &middot; {posture.telemetry.contentPolicyMode}</dd>
          </div>
          <div>
            <dt>Export ledger copies</dt>
            <dd>
              {posture.telemetry.exportedCopyCount} exported,
              {posture.telemetry.pendingCopyCount} pending,
              {posture.telemetry.droppedCopyCount} dropped
            </dd>
          </div>
          <div>
            <dt>Durable disk spool</dt>
            <dd>
              {posture.telemetry.spooledBatchCount} batch(es) &middot;
              {fmtBytes(posture.telemetry.spooledBytes)} / {fmtBytes(posture.telemetry.spoolCeilingBytes)}
            </dd>
          </div>
          <div>
            <dt>Metric series cardinality</dt>
            <dd>
              {posture.telemetry.activeSeriesCount} / {posture.telemetry.seriesCap} active sets
              ({posture.telemetry.overflowCount} overflow folded)
            </dd>
          </div>
        </dl>
        <p class="rh-preview" data-testid="otlp-preview-disclosure">{posture.telemetry.previewSummary}</p>
      </section>

      <section class="rh-card" aria-label="Isolated execution lanes" data-testid="lanes-health-card">
        <h3>Isolated execution lanes</h3>
        <dl class="rh-dl">
          <div>
            <dt>Feature posture</dt>
            <dd><span class="badge">{posture.lanes.enabled ? 'Enabled' : 'Disabled (shared workspace)'}</span></dd>
          </div>
          <div>
            <dt>Live worktree cap</dt>
            <dd>{posture.lanes.activeLanes} / {posture.lanes.liveLaneCap} active lane(s)</dd>
          </div>
          <div>
            <dt>Recorded lanes</dt>
            <dd>{posture.lanes.totalLanes} total</dd>
          </div>
          <div>
            <dt>Pending integrations</dt>
            <dd>{posture.lanes.pendingIntegrations} awaiting verification, review, or landing</dd>
          </div>
        </dl>
      </section>
    </div>
  {/if}
</section>

<style>
  .runtime-health { display: flex; flex-direction: column; gap: 12px; padding: 14px; width: 100%; overflow-y: auto; box-sizing: border-box; }
  .rh-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .rh-header h2, .rh-card h3 { margin: 0; font-size: 0.95rem; }
  .rh-sub, .rh-status, .rh-preview { margin: 2px 0 0; font-size: 0.84em; color: var(--schegent-muted-fg); }
  .rh-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .rh-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-surface); }
  .rh-dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 0; font-size: 0.84em; }
  .rh-dl dt { color: var(--schegent-muted-fg); }
  .rh-dl dd { margin: 2px 0 0; }
  .badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); }
  .btn { padding: 4px 10px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); cursor: pointer; font: inherit; font-size: 0.85em; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
