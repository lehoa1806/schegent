<script lang="ts">
  // Save flows through webview-ui/src/lib/save-wakeup-settings.ts (single
  // call site; lint regression at tests/lint/no-inline-save-wakeup-settings.test.ts).
  // Log list and session-log expansion live in WakeupLogList.svelte (Item 053).
  import {
    IDLE_WAKEUP_LOG,
    IDLE_WAKEUP_SETTINGS,
    RUNNER_DEFAULT_MODEL,
    type WakeUpSettings,
    type WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import { saveWakeUpSettings } from '../../lib/save-wakeup-settings';
  import { wakeUpNow } from '../../lib/wake-up-now';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { WAKEUP_DESCRIPTIONS } from './WakeUpTab.descriptions';
  import WakeupModelSelector from './wakeup/WakeupModelSelector.svelte';
  import WakeupSessionLogPathDisplay from './wakeup/WakeupSessionLogPathDisplay.svelte';
  import WakeupLogList from './wakeup/WakeupLogList.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }

  // Feature 014 (BUG-001 / BUG-002) — FR-025 / SC-010. The tab is
  // mounted by `SettingsSurface` via `{#if}` which destroys and
  // recreates the component on every sub-tab switch. To present the
  // currently saved configuration (not hardcoded defaults), we hydrate
  // `draft` from `snapshot.wakeUpSettings` on mount and resync via a
  // `$effect` when the projection changes — paralleling
  // `GeneralSettingsTab`'s `snapshotToDraft` + `lastProjectedJson`
  // pattern.
  const { snapshot }: Props = $props();

  type SchedulerType = 'chronological' | 'periodic';

  interface Draft {
    enabled: boolean;
    schedulerType: SchedulerType;
    chronologicalTime: string;   // HH:MM, 24-hour
    periodicInterval: string;    // "Every Nm" | "Every Nh"
  }

  const currentSettings = $derived<WakeUpSettings>(
    snapshot.wakeUpSettings ?? IDLE_WAKEUP_SETTINGS
  );
  const wakeUpLog = $derived(snapshot.wakeUpLog ?? IDLE_WAKEUP_LOG);

  function snapshotToDraft(s: WakeUpSettings): Draft {
    return {
      enabled: s.enabled,
      schedulerType: s.schedulerType,
      chronologicalTime: s.chronologicalTime,
      periodicInterval: s.periodicInterval
    };
  }

  let draft = $state<Draft>(snapshotToDraft(IDLE_WAKEUP_SETTINGS));
  let lastProjectedJson = $state('');

  type StatusState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'accepted' }
    | { kind: 'rejected'; reason: string };

  let status = $state<StatusState>({ kind: 'idle' });
  let wakeNowStatus = $state<StatusState>({ kind: 'idle' });

  $effect(() => {
    const next = snapshotToDraft(currentSettings);
    const nextJson = JSON.stringify(next);
    if (nextJson === lastProjectedJson) return;
    draft = next;
    lastProjectedJson = nextJson;
    status = { kind: 'idle' };
  });

  // Boundary-side validation mirrors the host's `WakeUpSettings`
  // invariants from data-model.md so we surface obvious errors before
  // posting. The host is authoritative — these checks are UX-only.
  const HH_MM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const PERIODIC_RE = /^Every\s+(\d+)\s*([mh])$/;

  const chronologicalTimeValid = $derived(HH_MM_RE.test(draft.chronologicalTime));

  const periodicValid = $derived.by(() => {
    const m = PERIODIC_RE.exec(draft.periodicInterval);
    if (!m) return false;
    const n = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(n) || n <= 0) return false;
    // 1-minute floor (FR-016 hard rule lives in the host; this is UX).
    if (unit === 'm' && n < 1) return false;
    return true;
  });

  // R-07 advisory: when the periodic interval is below Claude's
  // documented 5-hour rolling allocation window, surface a warning so
  // the operator knows some fires will waste tokens. NON-BLOCKING —
  // Save remains enabled. Threshold = 300 minutes (5h).
  const FIVE_HOUR_MINUTES = 300;
  const periodicBelowFiveHours = $derived.by(() => {
    if (draft.schedulerType !== 'periodic') return false;
    const m = PERIODIC_RE.exec(draft.periodicInterval);
    if (!m) return false;
    const n = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(n) || n <= 0) return false;
    const minutes = unit === 'h' ? n * 60 : n;
    return minutes < FIVE_HOUR_MINUTES;
  });

  const activeFieldValid = $derived(
    draft.schedulerType === 'chronological' ? chronologicalTimeValid : periodicValid
  );

  // When Wake up is disabled, the user can still hit Save to commit the
  // disabled flip — the active-field validity check is bypassed in that
  // case (the host accepts the disabled payload and uninstalls).
  const canSave = $derived(!draft.enabled || activeFieldValid);

  async function onSave(): Promise<void> {
    if (!canSave) return;
    status = { kind: 'pending' };
    const result = await saveWakeUpSettings({
      enabled: draft.enabled,
      schedulerType: draft.schedulerType,
      chronologicalTime: draft.chronologicalTime,
      periodicInterval: draft.periodicInterval
    });
    status = result.status === 'accepted'
      ? { kind: 'accepted' }
      : { kind: 'rejected', reason: result.reason };
  }

  async function onWakeUpNow(): Promise<void> {
    if (wakeNowStatus.kind === 'pending') return;
    wakeNowStatus = { kind: 'pending' };
    const result = await wakeUpNow();
    if (result.status === 'accepted') {
      wakeNowStatus = {
        kind: 'accepted'
      };
    } else {
      wakeNowStatus = { kind: 'rejected', reason: result.reason };
    }
  }
</script>

<section class="wakeup-settings" data-testid="wakeup-settings-tab">
  <header class="tab-header">
    <h2>{WAKEUP_DESCRIPTIONS['tab-header'].title}</h2>
    <p class="hint">{WAKEUP_DESCRIPTIONS['tab-header'].body}</p>
  </header>

  <div class="field-list">
    <div class="field-row" data-testid="wakeup-field-enabled">
      <div class="field-label">
        <span class="field-name" id="wakeup-label-enabled">Enable Wake up</span>
      </div>
      <div class="field-input">
        <label class="checkbox-label">
          <input
            type="checkbox"
            data-testid="wakeup-input-enabled"
            aria-labelledby="wakeup-label-enabled"
            bind:checked={draft.enabled}
            use:hoverTextAnchor={{
              controlId: 'wakeup-enabled',
              description: WAKEUP_DESCRIPTIONS.enabled
            }}
          />
          <span>{draft.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
    </div>

    <div class="field-row" data-testid="wakeup-field-scheduler-type">
      <div class="field-label">
        <span class="field-name" id="wakeup-label-scheduler-type">Scheduler type</span>
      </div>
      <div class="field-input">
        <select
          class="select-input"
          data-testid="wakeup-input-scheduler-type"
          aria-labelledby="wakeup-label-scheduler-type"
          bind:value={draft.schedulerType}
          disabled={!draft.enabled}
          use:hoverTextAnchor={{
            controlId: 'wakeup-scheduler-type',
            description: WAKEUP_DESCRIPTIONS['scheduler-type']
          }}
        >
          <option value="chronological">Chronological (daily time)</option>
          <option value="periodic">Periodic interval</option>
        </select>
      </div>
    </div>

    {#if draft.schedulerType === 'chronological'}
      <div class="field-row" data-testid="wakeup-field-chronological-time">
        <div class="field-label">
          <span class="field-name" id="wakeup-label-chronological-time">Daily time (HH:MM, 24-hour)</span>
        </div>
        <div class="field-input">
          <input
            type="text"
            class="text-input"
            placeholder="04:00"
            data-testid="wakeup-input-chronological-time"
            aria-labelledby="wakeup-label-chronological-time"
            aria-invalid={draft.enabled && !chronologicalTimeValid ? 'true' : undefined}
            aria-describedby={draft.enabled && !chronologicalTimeValid ? 'wakeup-error-chronological-time' : undefined}
            bind:value={draft.chronologicalTime}
            disabled={!draft.enabled}
            use:hoverTextAnchor={{
              controlId: 'wakeup-chronological-time',
              description: WAKEUP_DESCRIPTIONS['chronological-time']
            }}
          />
          {#if draft.enabled && !chronologicalTimeValid}
            <span
              class="inline-error"
              id="wakeup-error-chronological-time"
              data-testid="wakeup-error-chronological-time"
              role="alert"
            >
              Must be HH:MM in 24-hour format (e.g. 04:00).
            </span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="field-row" data-testid="wakeup-field-periodic-interval">
        <div class="field-label">
          <span class="field-name" id="wakeup-label-periodic-interval">Periodic interval</span>
        </div>
        <div class="field-input">
          <input
            type="text"
            class="text-input"
            placeholder="Every 1h"
            data-testid="wakeup-input-periodic-interval"
            aria-labelledby="wakeup-label-periodic-interval"
            aria-invalid={draft.enabled && !periodicValid ? 'true' : undefined}
            aria-describedby={draft.enabled && !periodicValid
              ? 'wakeup-error-periodic-interval'
              : draft.enabled && periodicBelowFiveHours
                ? 'wakeup-warning-periodic-below-5h'
                : undefined}
            bind:value={draft.periodicInterval}
            disabled={!draft.enabled}
            use:hoverTextAnchor={{
              controlId: 'wakeup-periodic-interval',
              description: WAKEUP_DESCRIPTIONS['periodic-interval']
            }}
          />
          {#if draft.enabled && !periodicValid}
            <span
              class="inline-error"
              id="wakeup-error-periodic-interval"
              data-testid="wakeup-error-periodic-interval"
              role="alert"
            >
              Must match <code>Every Nm</code> or <code>Every Nh</code>
              (e.g. <code>Every 15m</code>, <code>Every 4h</code>).
            </span>
          {/if}
          {#if draft.enabled && periodicValid && periodicBelowFiveHours}
            <span
              class="inline-warning"
              id="wakeup-warning-periodic-below-5h"
              data-testid="wakeup-warning-periodic-below-5h"
              role="status"
            >
              Heads up: this interval is shorter than Claude's 5-hour
              rolling window. Some fires may waste tokens. Save still
              works — this is advisory only.
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <div class="info-note" data-testid="wakeup-info-no-state-verification">
      <strong>Note:</strong> Wake up does not verify whether the
      previous Claude allocation has reset before firing. If the
      interval is shorter than Claude's rolling 5-hour window, some
      wake-ups may waste tokens. This is intentional for the initial
      release; a future version may add allocation-aware skipping.
    </div>

    <!--
      Feature 031 T025 — Wake-up model selector. Mounted between the
      schedule fields + advisory note and the Save row so operators
      can pick a Claude model in the same surface they configure the
      schedule on. The selector owns its own Save flow (separate from
      the schedule Save) because the host re-validates every payload
      transactionally and a single Save would entangle the two failure
      modes.
    -->
    <WakeupModelSelector
      model={currentSettings.model ?? RUNNER_DEFAULT_MODEL}
      settings={{
        enabled: currentSettings.enabled,
        schedulerType: currentSettings.schedulerType,
        chronologicalTime: currentSettings.chronologicalTime,
        periodicInterval: currentSettings.periodicInterval
      }}
    />
  </div>

  <div class="toolbar">
    <button
      type="button"
      class="btn btn-primary"
      data-testid="wakeup-save"
      disabled={!canSave || status.kind === 'pending'}
      onclick={onSave}
      use:hoverTextAnchor={{
        controlId: 'wakeup-save',
        description: WAKEUP_DESCRIPTIONS.save
      }}
    >Save</button>
    {#if status.kind === 'pending'}
      <span class="status-text status-pending" data-testid="wakeup-status" role="status">Saving…</span>
    {:else if status.kind === 'accepted'}
      <span class="status-text status-accepted" data-testid="wakeup-status" role="status">Saved</span>
    {:else if status.kind === 'rejected'}
      <span class="status-text status-rejected" data-testid="wakeup-status" role="alert">
        Rejected: {status.reason}
      </span>
    {/if}
  </div>

  <section class="manual-section" data-testid="wakeup-now-section">
    <div>
      <h3>Wake up now</h3>
      <p class="hint">Run one isolated wake-up attempt immediately.</p>
    </div>
    <div class="toolbar">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="wakeup-now"
        disabled={wakeNowStatus.kind === 'pending'}
        onclick={onWakeUpNow}
        use:hoverTextAnchor={{
          controlId: 'wakeup-now',
          description: WAKEUP_DESCRIPTIONS.now
        }}
      >Wake up now</button>
      {#if wakeNowStatus.kind === 'pending'}
        <span class="status-text status-pending" data-testid="wakeup-now-status" role="status">Running…</span>
      {:else if wakeNowStatus.kind === 'accepted'}
        <span class="status-text status-accepted" data-testid="wakeup-now-status" role="status">Recorded</span>
      {:else if wakeNowStatus.kind === 'rejected'}
        <span class="status-text status-rejected" data-testid="wakeup-now-status" role="alert">
          Rejected: {wakeNowStatus.reason}
        </span>
      {/if}
    </div>
  </section>

  <!--
    Feature 031 T052 — Session log file location strip. Sits between
    the "Wake up now" section and the "Recent attempts" log list so
    operators can locate the on-disk session.log file alongside the
    UI projection. Path text is rendered via `{text}` only (CLAUDE.md
    hard rule); the Reveal button routes through the SOLE call site
    helper at `webview-ui/src/lib/reveal-wakeup-session-log.ts`.
  -->
  <WakeupSessionLogPathDisplay
    sessionLogPath={snapshot.wakeUp?.sessionLogPath ?? null}
  />

  <WakeupLogList {wakeUpLog} />
</section>

<style>
  .wakeup-settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 8px 0;
    height: 100%;
  }
  .tab-header h2 {
    margin: 0 0 4px 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 12px 0;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
  .field-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border-top: 1px solid var(--schegent-divider);
  }
  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas: "label input";
    gap: 4px 12px;
    padding: 14px 0;
    border: 0;
    border-bottom: 1px solid var(--schegent-divider);
    background: transparent;
    align-items: center;
  }
  .field-label {
    grid-area: label;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .field-name { font-weight: 600; }
  .field-input {
    grid-area: input;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .text-input, .select-input {
    background: var(--vscode-input-background);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    padding: 4px 8px;
    border-radius: var(--schegent-radius);
    width: 100%;
    box-sizing: border-box;
  }
  .text-input:focus, .select-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .text-input:disabled, .select-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .inline-error {
    color: var(--schegent-error-text);
    font-size: 0.85em;
  }
  .inline-warning {
    color: var(--vscode-editorWarning-foreground, var(--schegent-muted-fg));
    font-size: 0.85em;
    font-style: italic;
  }
  .info-note {
    padding: 10px 12px;
    border: 1px dashed var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .info-note strong {
    color: var(--schegent-fg);
  }
  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 8px;
  }
  .btn {
    padding: 6px 16px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .status-text {
    font-size: 0.9em;
  }
  .status-pending { color: var(--schegent-muted-fg); }
  .status-accepted { color: var(--vscode-charts-green); }
  .status-rejected { color: var(--schegent-error-text); }
  .manual-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--sch-glass-border);
  }
  @media (max-width: 720px) {
    .field-row {
      grid-template-columns: 1fr;
      grid-template-areas: "label" "input";
    }
  }
</style>
