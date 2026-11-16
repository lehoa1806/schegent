<script lang="ts">
  // FR-R4-F02 (spec 240, US8; contract E3 G10, G11; TA3; FR-037 to FR-040) — the limits this Run
  // runs under, and where each came from.
  //
  // The disclosure page lists the defaults, and trusted workspace and folder settings can move every
  // one of them, so before this panel an operator could not tell from the page which bound a given
  // Run was held to. Each row is a number and a closed origin from the host's resolver, which calls
  // the functions execution calls.
  //
  // Fixed text only. Only numbers and closed enums cross the snapshot boundary, and this component
  // maps each origin to one of five fixed phrases, so no label can carry a workspace path, a secret
  // value or repository markup. There is no `{@html}` here and nothing the snapshot says is
  // interpolated except those numbers.

  import type { EffectiveLimitsProjection, LimitOrigin } from '../../lib/snapshot-types';

  interface Props {
    /** The queue whose Run this is; scopes every test id. */
    queueId: string;
    effectiveLimits: EffectiveLimitsProjection;
  }

  const { queueId, effectiveLimits }: Props = $props();

  const ORIGIN_TEXT: Readonly<Record<LimitOrigin, string>> = {
    default: 'default',
    user: 'user settings',
    workspace: 'workspace settings',
    'workspace-folder': 'folder settings',
    phase: 'this Phase'
  };

  const CONTINUE_TEXT =
    'At the iteration cap this Phase advances with its condition unverified; the delayed-retry cap still applies.';
  const CONTINUE_DEGRADED_TEXT =
    'At the iteration cap this Phase advances and the Run is marked degraded; the delayed-retry cap still applies.';
  // FR-R4-F17 (contract L2) — the unchanged-metrics bound's two reasons for not applying. Fixed text, so
  // the only interpolated value in that row is the integer.
  const INERT_CAP_OUTCOME_TEXT = 'This Phase advances at the iteration cap, so the early stop does not apply.';
  const INERT_NO_CONDITION_TEXT = 'This Phase has no retry condition, so there is nothing to compare.';
  const NO_SPEND_TEXT = "No spend bound applies to this Phase's backend.";
  const NOT_TRUSTWORTHY_TEXT =
    'Spend bound shown but not trustworthy: spend for this run cannot be fully measured.';

  const OUTCOME_TEXT = { fail: 'fails the run', continue: 'advances', 'continue-degraded': 'advances, marked degraded' } as const;

  const unchanged = $derived(effectiveLimits.unchangedComparisons);
  /** One closed state, one fixed phrase; a state outside the set shows nothing. */
  const unchangedText = (limit: EffectiveLimitsProjection['unchangedComparisons']): string => {
    switch (limit.state) {
      case 'active':
        return `after ${limit.value} unchanged comparison${limit.value === 1 ? '' : 's'}`;
      case 'disabled':
        return 'off';
      case 'inert-cap-outcome':
      case 'inert-no-retry-condition':
        return `${limit.value}, not applied`;
      default:
        return '';
    }
  };

  const seconds = (value: number): string => `${value.toLocaleString('en-US')} s`;
  const spendFigure = (denomination: 'usd' | 'tokens', value: number): string =>
    denomination === 'usd' ? `$${value.toFixed(2)}` : `${value.toLocaleString('en-US')} tokens`;
</script>

<!-- Drawn as one of the redesign's cards with its key-value list (`.card`, `.kv`), the way its run
     page draws a step's limits: the value, then where it came from, muted. -->
<section class="run-limits card" data-testid="run-limits-{queueId}" aria-label="Limits this run runs under">
  <h2 class="title">Limits in force</h2>
  <dl class="kv limits">
    <dt>Iteration cap</dt>
    <dd data-testid="run-limits-iteration-{queueId}">
      {effectiveLimits.iterationCap.value}
      <span class="origin" data-testid="run-limits-iteration-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.iterationCap.origin]}</span>
    </dd>

    <dt>Idle timeout</dt>
    <dd data-testid="run-limits-idle-{queueId}">
      {seconds(effectiveLimits.idleTimeoutSeconds.value)}
      <span class="origin" data-testid="run-limits-idle-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.idleTimeoutSeconds.origin]}</span>
    </dd>

    <dt>Wall-clock timeout</dt>
    <dd data-testid="run-limits-wall-clock-{queueId}">
      {seconds(effectiveLimits.maxDurationSeconds.value)}
      <span class="origin" data-testid="run-limits-wall-clock-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.maxDurationSeconds.origin]}</span>
    </dd>

    <dt>Delayed-retry cap</dt>
    <dd data-testid="run-limits-retry-cap-{queueId}">
      {effectiveLimits.retryCap.value}
      <span class="origin" data-testid="run-limits-retry-cap-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.retryCap.origin]}</span>
    </dd>

    <dt>At the iteration cap</dt>
    <dd data-testid="run-limits-retry-outcome-{queueId}">
      {OUTCOME_TEXT[effectiveLimits.onRetryCap.value]}
      <span class="origin" data-testid="run-limits-retry-outcome-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.onRetryCap.origin]}</span>
      {#if effectiveLimits.onRetryCap.value === 'continue'}
        <p class="note" data-testid="run-limits-continue-note-{queueId}">{CONTINUE_TEXT}</p>
      {:else if effectiveLimits.onRetryCap.value === 'continue-degraded'}
        <p class="note" data-testid="run-limits-continue-note-{queueId}">{CONTINUE_DEGRADED_TEXT}</p>
      {/if}
    </dd>

    <dt>Unchanged-metrics stop</dt>
    <dd data-testid="run-limits-unchanged-{queueId}">
      {unchangedText(unchanged)}
      <span class="origin" data-testid="run-limits-unchanged-origin-{queueId}">{ORIGIN_TEXT[unchanged.origin]}</span>
      {#if unchanged.state === 'inert-cap-outcome'}
        <p class="note" data-testid="run-limits-unchanged-note-{queueId}">{INERT_CAP_OUTCOME_TEXT}</p>
      {:else if unchanged.state === 'inert-no-retry-condition'}
        <p class="note" data-testid="run-limits-unchanged-note-{queueId}">{INERT_NO_CONDITION_TEXT}</p>
      {/if}
    </dd>

    <dt>Spend bound</dt>
    <dd data-testid="run-limits-spend-{queueId}">
      {#if effectiveLimits.spend.kind === 'none'}
        <span data-testid="run-limits-no-spend-{queueId}">{NO_SPEND_TEXT}</span>
      {:else}
        {spendFigure(effectiveLimits.spend.denomination, effectiveLimits.spend.limit.value)}
        <span class="origin" data-testid="run-limits-spend-origin-{queueId}">{ORIGIN_TEXT[effectiveLimits.spend.limit.origin]}</span>
        {#if effectiveLimits.spend.trust === 'not-trustworthy'}
          <p class="note" role="status" data-testid="run-limits-not-trustworthy-{queueId}">{NOT_TRUSTWORTHY_TEXT}</p>
        {/if}
      {/if}
    </dd>
  </dl>
</section>

<style>
  .run-limits {
    flex-shrink: 0;
    margin-bottom: var(--schegent-space-3-5);
  }
  .title {
    margin-bottom: var(--schegent-space-2);
    font-size: var(--schegent-text-body);
    font-weight: 600;
  }
  /* Two pairs to a row while the page is wide, so the card stays short above the run's columns;
     one pair to a row where the redesign stacks its columns. */
  dl.limits {
    grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr);
  }
  /* The origins are fixed words the tests read exactly, so the separator is drawn, and its
     alternative text is empty: a screen reader hears the value, then the origin. */
  .origin {
    color: var(--schegent-muted-fg);
  }
  .origin:not(:empty)::before {
    content: '· ' / '';
  }
  .note {
    margin: var(--schegent-space-0-5) 0 0;
  }
  @media (max-width: 860px) {
    dl.limits {
      grid-template-columns: max-content minmax(0, 1fr);
    }
  }
</style>
