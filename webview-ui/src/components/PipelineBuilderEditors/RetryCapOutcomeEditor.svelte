<script lang="ts">
  /**
   * FR-R3-157 (T047, FR-014/FR-015/FR-016) — what this phase does when its retry
   * condition is still unsatisfied at the cap.
   *
   * A sibling component rather than more markup inside `PhaseCatalogEditor.svelte`
   * for the ordinary reason: that file is at 472 of its 500-line budget and this
   * control is not four lines. But the split earns its keep beyond the budget —
   * the outcome is the one field on that card whose DISPLAYED value is not the
   * field's own value. Every other control shows what the phase says; this one
   * shows what the phase will DO, which is a different question whenever the
   * phase says nothing, or says it in the deprecated spelling.
   *
   * Both answers come from `src/contracts/retry-cap-outcome.ts` — the same two
   * functions the controller calls, imported rather than restated. That import is
   * the whole point of the module's location: a webview copy of the precedence
   * would be individually correct and would disagree with the controller only on
   * a phase carrying both spellings, which is to say it would disagree only where
   * this control is telling an operator something they cannot check.
   */
  import {
    resolveRetryCapOutcome,
    statesRetryCapOutcome
  } from '../../../../src/contracts/retry-cap-outcome';
  import type { RetryCapOutcome } from '../../lib/snapshot-types';
  import type { MutablePhase } from './types';

  /**
   * research.md D7. Each label says what the RUN does, never what the file says:
   * an operator choosing here is choosing a behaviour, and `continue-degraded` is
   * not a phrase anyone should have to learn to pick the middle option.
   */
  const OUTCOMES: readonly { value: RetryCapOutcome; label: string; helper: string }[] = [
    {
      value: 'fail',
      label: 'Fail the task',
      helper: 'Default. The condition guards something real.'
    },
    {
      value: 'continue',
      label: 'Continue with a warning',
      helper: 'Advance anyway. Nothing durable is recorded.'
    },
    {
      value: 'continue-degraded',
      label: 'Continue, marked unverified',
      helper: 'Advance, and record that this condition was never satisfied.'
    }
  ];

  interface Props {
    phase: MutablePhase;
    /** `schegent.retry.forceContinueOnCap`, or undefined when the host sent none. */
    workspaceDefault: boolean | undefined;
    /** The retry toggle's own disabled expression, passed down rather than rebuilt. */
    readonly: boolean;
    onchange: (outcome: RetryCapOutcome) => void;
  }

  const { phase, workspaceDefault, readonly, onchange }: Props = $props();

  const effective = $derived(resolveRetryCapOutcome(phase, workspaceDefault));
  const stated = $derived(statesRetryCapOutcome(phase));
  const helper = $derived(OUTCOMES.find((outcome) => outcome.value === effective)?.helper ?? '');
</script>

<label class="form-field full-width retry-cap-row">
  <span class="form-label">When retries run out</span>
  <select
    class="select-input"
    data-testid="phases-retry-cap-{phase.id}"
    value={effective}
    disabled={readonly}
    onchange={(event) => onchange(event.currentTarget.value as RetryCapOutcome)}
  >
    {#each OUTCOMES as outcome (outcome.value)}
      <option value={outcome.value}>{outcome.label}</option>
    {/each}
  </select>
  <span class="field-hint">{helper}</span>
  <!-- FR-016. Which outcome is in effect does not say whose it is: `fail` is both
       the commonest choice and what an unconfigured workspace falls back to, so
       without this line an operator cannot tell whether changing the workspace
       setting would move this phase. -->
  <span class="field-hint" data-testid="phases-retry-cap-origin-{phase.id}">
    {stated ? 'Set on this phase.' : 'Inherited from the workspace default.'}
  </span>
</label>

<style>
  .retry-cap-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-hint {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
</style>
