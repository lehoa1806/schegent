<script lang="ts">
  // Feature 065 (T027, revised per BUG-001 / 2026-05-23) — Inline
  // start-mode chooser for queue-level scheduling.
  //
  // The chooser is now the SOLE entry point for queue scheduling and is
  // reached exclusively from the "Start queue" affordance against an
  // idle-pending queue (FR-018). It is NOT presented at task-submit time
  // (BUG-001 removed the submit-intercept flow); enqueue and start are
  // fully orthogonal at the UI level.
  //
  // Four primary affordances per spec FR-009:
  //   1. Start now
  //   2. Start in HH:MM (duration, one-minute granularity)
  //   3. Start at HH:MM (clock time, one-minute granularity, host TZ)
  //   4. Close (dismiss — closes the chooser without mutating queue state)
  //
  // Plus the "Cancel schedule" affordance (FR-015) which clears any armed
  // scheduledStartAt on the queue while remaining in idle-pending.
  //
  // The chooser is *non-modal*: it renders inline in the queue panel and
  // does not capture focus or insert a backdrop. Sibling controls remain
  // interactive while the chooser is open.
  //
  // Inline validation: an in-duration entry > 7 days (FR-009c, SC-008)
  // shows an inline error and prevents commit. The translator
  // (`choiceToIntent` in lib/start-mode.ts) also throws
  // `ScheduledStartHorizonError` as a defense-in-depth check.
  //
  // The chooser emits a `StartQueueIntent` exclusively — `source` is
  // always `'operator-restart'` (the only legal source on CMD_START_QUEUE
  // per the IPC contract). There is no destructive-confirm path here;
  // the BUG-001 patch removed "Cancel and discard" since the chooser no
  // longer owns the task draft.

  import {
    choiceToIntent,
    ScheduledStartHorizonError,
    StartModeValidationError,
    type StartModeChoice
  } from '../lib/start-mode';

  export interface StartQueueIntent {
    readonly startMode: 'now' | 'scheduled' | 'cancel-schedule';
    readonly scheduledStartAt?: number;
    readonly source: 'operator-restart';
  }

  interface Props {
    readonly onCommit: (intent: StartQueueIntent | null) => void;
  }

  const { onCommit }: Props = $props();

  let activeAffordance = $state<
    'none' | 'in-duration' | 'at-clock-time'
  >('none');

  let inDurationHours = $state<string | number>('0');
  let inDurationMinutes = $state<string | number>('30');
  let atClockTimeHours = $state<string | number>('09');
  let atClockTimeMinutes = $state<string | number>('00');

  let validationError = $state<string | null>(null);

  function parseNumeric(raw: string | number): number {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return Number.NaN;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  function emitIntent(choice: StartModeChoice): void {
    validationError = null;
    try {
      const intent = choiceToIntent(choice, 'operator-restart');
      if (intent === null) {
        // Close (= dismiss); the chooser closes without mutating state.
        onCommit(null);
        return;
      }
      const restartIntent: StartQueueIntent = {
        startMode: intent.startMode,
        ...(intent.scheduledStartAt !== undefined
          ? { scheduledStartAt: intent.scheduledStartAt }
          : {}),
        source: 'operator-restart'
      };
      onCommit(restartIntent);
    } catch (err) {
      if (err instanceof ScheduledStartHorizonError) {
        validationError =
          'Scheduled start exceeds the 7-day limit. Pick a sooner time.';
        return;
      }
      if (err instanceof StartModeValidationError) {
        validationError = err.message;
        return;
      }
      throw err;
    }
  }

  function onStartNowClick(): void {
    emitIntent({ kind: 'now' });
  }

  function onConfirmInDuration(): void {
    const hours = parseNumeric(inDurationHours);
    const minutes = parseNumeric(inDurationMinutes);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      validationError = 'Enter whole-minute hours and minutes.';
      return;
    }
    emitIntent({ kind: 'in-duration', hours, minutes });
  }

  function onConfirmAtClockTime(): void {
    const hours = parseNumeric(atClockTimeHours);
    const minutes = parseNumeric(atClockTimeMinutes);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      validationError = 'Enter whole-minute hours and minutes.';
      return;
    }
    emitIntent({ kind: 'at-clock-time', hours, minutes });
  }

  function onCloseClick(): void {
    // Close keeps the existing schedule untouched and dismisses the
    // chooser. Distinct from "Cancel schedule" below.
    onCommit(null);
  }

  function onCancelScheduleClick(): void {
    const restartIntent: StartQueueIntent = {
      startMode: 'cancel-schedule',
      source: 'operator-restart'
    };
    onCommit(restartIntent);
  }
</script>

<div class="start-mode-chooser" data-testid="start-mode-chooser" role="group" aria-label="Start mode">
  <div class="chooser-header">
    <p class="chooser-title">Start the queue</p>
  </div>

  <div class="primary-affordances">
    <button
      type="button"
      class="affordance affordance-now"
      data-testid="start-mode-chooser-now"
      onclick={onStartNowClick}
    >
      Start now
    </button>

    <button
      type="button"
      class="affordance affordance-in"
      class:active={activeAffordance === 'in-duration'}
      data-testid="start-mode-chooser-in-duration-toggle"
      aria-expanded={activeAffordance === 'in-duration' ? 'true' : 'false'}
      onclick={() => {
        activeAffordance = activeAffordance === 'in-duration' ? 'none' : 'in-duration';
        validationError = null;
      }}
    >
      Start in HH:MM
    </button>

    <button
      type="button"
      class="affordance affordance-at"
      class:active={activeAffordance === 'at-clock-time'}
      data-testid="start-mode-chooser-at-clock-time-toggle"
      aria-expanded={activeAffordance === 'at-clock-time' ? 'true' : 'false'}
      onclick={() => {
        activeAffordance = activeAffordance === 'at-clock-time' ? 'none' : 'at-clock-time';
        validationError = null;
      }}
    >
      Start at HH:MM
    </button>
  </div>

  {#if activeAffordance === 'in-duration'}
    <div class="duration-panel" data-testid="start-mode-chooser-in-duration-panel">
      <label class="duration-label">
        <span>Hours</span>
        <input
          type="number"
          min="0"
          max="168"
          step="1"
          bind:value={inDurationHours}
          data-testid="start-mode-chooser-in-duration-hours"
          aria-label="Hours from now"
        />
      </label>
      <label class="duration-label">
        <span>Minutes</span>
        <input
          type="number"
          min="0"
          max="59"
          step="1"
          bind:value={inDurationMinutes}
          data-testid="start-mode-chooser-in-duration-minutes"
          aria-label="Minutes from now"
        />
      </label>
      <button
        type="button"
        class="confirm-button"
        data-testid="start-mode-chooser-in-duration-confirm"
        onclick={onConfirmInDuration}
      >
        Schedule
      </button>
    </div>
  {/if}

  {#if activeAffordance === 'at-clock-time'}
    <div class="clock-panel" data-testid="start-mode-chooser-at-clock-time-panel">
      <label class="clock-label">
        <span>Hour</span>
        <input
          type="number"
          min="0"
          max="23"
          step="1"
          bind:value={atClockTimeHours}
          data-testid="start-mode-chooser-at-clock-time-hours"
          aria-label="Hour of day"
        />
      </label>
      <label class="clock-label">
        <span>Minute</span>
        <input
          type="number"
          min="0"
          max="59"
          step="1"
          bind:value={atClockTimeMinutes}
          data-testid="start-mode-chooser-at-clock-time-minutes"
          aria-label="Minute"
        />
      </label>
      <button
        type="button"
        class="confirm-button"
        data-testid="start-mode-chooser-at-clock-time-confirm"
        onclick={onConfirmAtClockTime}
      >
        Schedule
      </button>
    </div>
  {/if}

  {#if validationError}
    <p
      class="chooser-error"
      role="status"
      data-testid="start-mode-chooser-error"
    >
      {validationError}
    </p>
  {/if}

  <div class="secondary-affordances">
    <button
      type="button"
      class="affordance-link"
      data-testid="start-mode-chooser-cancel-schedule"
      onclick={onCancelScheduleClick}
    >
      Cancel schedule
    </button>
    <button
      type="button"
      class="affordance-link"
      data-testid="start-mode-chooser-restart-dismiss"
      onclick={onCloseClick}
    >
      Close
    </button>
  </div>
</div>

<style>
  .start-mode-chooser {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: var(--vscode-list-hoverBackground);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
  }
  .chooser-header { display: flex; flex-direction: column; gap: 4px; }
  .chooser-title { margin: 0; font-weight: 600; color: var(--schegent-fg); }
  .primary-affordances {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .affordance {
    flex: 1 1 auto;
    min-width: 100px;
    padding: 8px 12px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--schegent-fg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    cursor: pointer;
    font-size: 0.9em;
  }
  .affordance:hover { background: var(--vscode-list-activeSelectionBackground); }
  .affordance.active {
    border-color: var(--schegent-focus-border);
    box-shadow: var(--sch-glow-active);
  }
  .affordance-now {
    background: var(--sch-accent-gradient);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .duration-panel, .clock-panel {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .duration-label, .clock-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.8em;
    color: var(--schegent-fg);
  }
  .duration-label input, .clock-label input {
    width: 80px;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    font: inherit;
  }
  .confirm-button {
    padding: 6px 12px;
    background: var(--sch-accent-gradient);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: var(--schegent-radius);
    cursor: pointer;
  }
  .chooser-error {
    margin: 0;
    color: var(--vscode-errorForeground);
    font-size: 0.85em;
  }
  .secondary-affordances {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .affordance-link {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.85em;
    text-decoration: underline;
  }
</style>
