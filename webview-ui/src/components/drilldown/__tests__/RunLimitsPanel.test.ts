// FR-R4-F02 (spec 240, US8; contract E3 G10, G11; US8-5; FR-040) — the surface for the limits one Run
// runs under. Each closed origin renders one fixed phrase; the three special cases render the
// contract's own sentences; and nothing the snapshot carries beyond the projection's numbers and
// enums can reach the panel, so a hostile setting value has no place to land.
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import RunLimitsPanel from '../RunLimitsPanel.svelte';
import RunDetailTier from '../RunDetailTier.svelte';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { IDLE_DELAYED_RETRY, IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type { EffectiveLimitsProjection, LimitOrigin, WorkflowSnapshot } from '../../../lib/snapshot-types';

const QUEUE_ID = 'q-beta';

function limits(overrides: Partial<EffectiveLimitsProjection> = {}): EffectiveLimitsProjection {
  return {
    iterationCap: { value: 10, origin: 'default' },
    idleTimeoutSeconds: { value: 5400, origin: 'default' },
    maxDurationSeconds: { value: 21600, origin: 'default' },
    retryCap: { value: 5, origin: 'default' },
    onRetryCap: { value: 'fail', origin: 'default' },
    unchangedComparisons: { value: 0, origin: 'default', state: 'disabled' },
    spend: { kind: 'none' },
    ...overrides
  };
}

const mount = (effectiveLimits: EffectiveLimitsProjection) =>
  render(RunLimitsPanel, { queueId: QUEUE_ID, effectiveLimits });

afterEach(() => cleanup());

describe('each LimitOrigin renders its fixed text (E3 G10)', () => {
  const EXPECTED: ReadonlyArray<readonly [LimitOrigin, string]> = [
    ['default', 'default'],
    ['user', 'user settings'],
    ['workspace', 'workspace settings'],
    ['workspace-folder', 'folder settings'],
    ['phase', 'this Phase']
  ];

  it.each(EXPECTED)('%s reads "%s" on every row that carries an origin', (origin, text) => {
    const { getByTestId } = mount(
      limits({
        iterationCap: { value: 3, origin },
        idleTimeoutSeconds: { value: 60, origin },
        maxDurationSeconds: { value: 600, origin },
        retryCap: { value: 5, origin },
        onRetryCap: { value: 'fail', origin },
        spend: { kind: 'bounded', denomination: 'usd', limit: { value: 2, origin }, trust: 'enforced' }
      })
    );

    for (const row of ['iteration', 'idle', 'wall-clock', 'retry-cap', 'retry-outcome', 'spend']) {
      expect(getByTestId(`run-limits-${row}-origin-${QUEUE_ID}`).textContent).toBe(text);
    }
  });
});

describe('the numbers and units (US8-2)', () => {
  it('shows each limit\'s value', () => {
    const { getByTestId } = mount(
      limits({
        iterationCap: { value: 4, origin: 'workspace' },
        idleTimeoutSeconds: { value: 600, origin: 'workspace' },
        maxDurationSeconds: { value: 7200, origin: 'user' }
      })
    );

    expect(getByTestId(`run-limits-iteration-${QUEUE_ID}`).textContent).toContain('4');
    expect(getByTestId(`run-limits-idle-${QUEUE_ID}`).textContent).toContain('600 s');
    expect(getByTestId(`run-limits-wall-clock-${QUEUE_ID}`).textContent).toContain('7,200 s');
    expect(getByTestId(`run-limits-retry-cap-${QUEUE_ID}`).textContent).toContain('5');
  });

  it('shows a USD bound in dollars and a token bound in tokens', () => {
    const usd = mount(limits({ spend: { kind: 'bounded', denomination: 'usd', limit: { value: 2.5, origin: 'user' }, trust: 'enforced' } }));
    expect(usd.getByTestId(`run-limits-spend-${QUEUE_ID}`).textContent).toContain('$2.50');
    cleanup();

    const tokens = mount(limits({ spend: { kind: 'bounded', denomination: 'tokens', limit: { value: 2_000_000, origin: 'user' }, trust: 'enforced' } }));
    expect(tokens.getByTestId(`run-limits-spend-${QUEUE_ID}`).textContent).toContain('2,000,000 tokens');
  });
});

describe('the special cases render the contract\'s sentences (E3 G11; US8-3, US8-4)', () => {
  it('onRetryCap continue: the unverified-advance sentence, and the retry cap is still shown', () => {
    const { getByTestId } = mount(limits({ onRetryCap: { value: 'continue', origin: 'workspace' } }));

    expect(getByTestId(`run-limits-continue-note-${QUEUE_ID}`).textContent).toBe(
      'At the retry cap this Phase advances with its condition unverified; the retry cap still applies.'
    );
    expect(getByTestId(`run-limits-retry-cap-${QUEUE_ID}`).textContent).toContain('5');
  });

  it('onRetryCap fail: no note', () => {
    const { queryByTestId } = mount(limits());

    expect(queryByTestId(`run-limits-continue-note-${QUEUE_ID}`)).toBeNull();
  });

  it('onRetryCap continue-degraded: says it advances and marks the Run degraded', () => {
    const { getByTestId } = mount(limits({ onRetryCap: { value: 'continue-degraded', origin: 'phase' } }));

    expect(getByTestId(`run-limits-continue-note-${QUEUE_ID}`).textContent).toContain('marked degraded');
  });

  it('spend none: "No spend bound applies to this Phase\'s backend."', () => {
    const { getByTestId } = mount(limits({ spend: { kind: 'none' } }));

    expect(getByTestId(`run-limits-no-spend-${QUEUE_ID}`).textContent).toBe("No spend bound applies to this Phase's backend.");
  });

  it('not-trustworthy spend: the contract\'s sentence, only when the trust is not enforced', () => {
    const untrusted = mount(limits({ spend: { kind: 'bounded', denomination: 'usd', limit: { value: 1, origin: 'user' }, trust: 'not-trustworthy' } }));
    expect(untrusted.getByTestId(`run-limits-not-trustworthy-${QUEUE_ID}`).textContent).toBe(
      'Spend bound shown but not trustworthy: spend for this run cannot be fully measured.'
    );
    cleanup();

    const trusted = mount(limits({ spend: { kind: 'bounded', denomination: 'usd', limit: { value: 1, origin: 'user' }, trust: 'enforced' } }));
    expect(trusted.queryByTestId(`run-limits-not-trustworthy-${QUEUE_ID}`)).toBeNull();
  });
});

// FR-R4-F17 (feature 245, contract L2 and L4.2; FR-022; SC-008) — the row for the unchanged-metrics bound.
// Four states, each with its own fixed text; the two inert ones add a note that says why the bound does
// not apply. Only the integer is interpolated, and a state outside the closed set has no text to show.
describe('the unchanged-metrics stop row (L2, L4.2)', () => {
  type Unchanged = EffectiveLimitsProjection['unchangedComparisons'];
  const row = (value: number, state: Unchanged['state'], origin: LimitOrigin = 'workspace') =>
    limits({ unchangedComparisons: { value, origin, state } });
  const valueText = (view: ReturnType<typeof mount>) =>
    view.getByTestId(`run-limits-unchanged-${QUEUE_ID}`).textContent;

  it('is labelled "Unchanged-metrics stop"', () => {
    const { getByText } = mount(row(2, 'active'));

    expect(getByText('Unchanged-metrics stop')).toBeTruthy();
  });

  it('active: "after 2 unchanged comparisons", with its origin and no note', () => {
    const view = mount(row(2, 'active', 'workspace'));

    expect(valueText(view)).toContain('after 2 unchanged comparisons');
    expect(view.getByTestId(`run-limits-unchanged-origin-${QUEUE_ID}`).textContent).toBe('workspace settings');
    expect(view.queryByTestId(`run-limits-unchanged-note-${QUEUE_ID}`)).toBeNull();
  });

  it('active at 1: "after 1 unchanged comparison", singular (L2.4)', () => {
    const view = mount(row(1, 'active'));

    expect(valueText(view)).toContain('after 1 unchanged comparison');
    expect(valueText(view)).not.toContain('comparisons');
  });

  it('disabled: "off", with the default origin and no note', () => {
    const view = mount(row(0, 'disabled', 'default'));

    expect(valueText(view)).toContain('off');
    expect(view.getByTestId(`run-limits-unchanged-origin-${QUEUE_ID}`).textContent).toBe('default');
    expect(view.queryByTestId(`run-limits-unchanged-note-${QUEUE_ID}`)).toBeNull();
  });

  it('inert because the Phase advances at its cap: "2, not applied", and says why', () => {
    const view = mount(row(2, 'inert-cap-outcome'));

    expect(valueText(view)).toContain('2, not applied');
    expect(view.getByTestId(`run-limits-unchanged-note-${QUEUE_ID}`).textContent).toBe(
      'This Phase advances at the retry cap, so the early stop does not apply.'
    );
  });

  it('inert because the Phase has no retry condition: "2, not applied", and says why', () => {
    const view = mount(row(2, 'inert-no-retry-condition'));

    expect(valueText(view)).toContain('2, not applied');
    expect(view.getByTestId(`run-limits-unchanged-note-${QUEUE_ID}`).textContent).toBe(
      'This Phase has no retry condition, so there is nothing to compare.'
    );
  });

  it.each<readonly [LimitOrigin, string]>([
    ['default', 'default'],
    ['user', 'user settings'],
    ['workspace', 'workspace settings'],
    ['workspace-folder', 'folder settings']
  ])('shows the layer %s as "%s" (L2.2)', (origin, text) => {
    const view = mount(row(3, 'active', origin));

    expect(view.getByTestId(`run-limits-unchanged-origin-${QUEUE_ID}`).textContent).toBe(text);
  });

  it('control: the other rows are still there and still carry their own text', () => {
    const view = mount(row(2, 'active'));

    expect(view.getByTestId(`run-limits-iteration-${QUEUE_ID}`).textContent).toContain('10');
    expect(view.getByTestId(`run-limits-retry-outcome-${QUEUE_ID}`).textContent).toContain('fails the run');
  });

  it('a state or a string outside the closed set has no text to render (L2.3, hard rule 2)', () => {
    const hostile = '<script>alert(1)</script>';
    const forged = limits({
      unchangedComparisons: {
        value: 2,
        origin: 'workspace',
        state: hostile as unknown as Unchanged['state'],
        note: hostile
      } as unknown as Unchanged
    });

    const { container, getByTestId } = mount(forged);

    // The row is there, so the absence below is about its text and not about a missing row.
    expect(getByTestId(`run-limits-unchanged-${QUEUE_ID}`)).toBeTruthy();
    expect(container.textContent).not.toContain(hostile);
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('hostile values never reach the panel (US8-5, FR-040)', () => {
  const HOSTILE = ['/Users/someone/secret-project', 'sk-ant-api03-SECRETSECRETSECRET', '<script>alert(1)</script>'];

  it('renders none of the strings a forged projection carries beyond its numbers and enums', () => {
    const forged = {
      ...limits(),
      iterationCap: { value: 10, origin: 'default', note: HOSTILE[0] },
      spend: { kind: 'bounded', denomination: 'usd', limit: { value: 1, origin: 'user' }, trust: 'enforced', detail: HOSTILE[1] },
      label: HOSTILE[2]
    } as unknown as EffectiveLimitsProjection;

    const { container } = mount(forged);

    for (const text of HOSTILE) expect(container.textContent).not.toContain(text);
    expect(container.querySelector('script')).toBeNull();
  });

  it('an origin outside the closed set has no text to render, so it cannot become a label', () => {
    const { getByTestId } = mount(
      limits({ iterationCap: { value: 10, origin: '<script>alert(1)</script>' as unknown as LimitOrigin } })
    );

    expect(getByTestId(`run-limits-iteration-origin-${QUEUE_ID}`).textContent).toBe('');
  });

  it('through the Run detail tier: a snapshot whose other fields are hostile puts none of them in the panel', () => {
    const snapshot = Object.freeze({
      schemaVersion: 4,
      isPrimary: true,
      queues: Object.freeze([
        buildQueueRuntime({
          queueId: QUEUE_ID,
          name: HOSTILE[0],
          position: 0,
          lifecycle: 'running',
          tasks: [
            {
              id: 'r-1', label: HOSTILE[2], enqueuedAt: '2026-08-12T00:00:00.000Z', startedAt: null,
              updatedAt: '2026-08-12T00:00:00.000Z', completedAt: null, status: 'in-flight', retryCount: 0,
              lastErrorSummary: HOSTILE[1], pausedReason: null, currentPhase: null, position: 0, phaseProgress: null
            }
          ],
          inFlightRun: {
            runId: 'run-1',
            status: 'running',
            feature: { id: 'r-1', label: HOSTILE[2], startedAt: '2026-08-12T00:00:00.000Z' },
            pipeline: null,
            elapsedMs: 1,
            liveActivity: { summary: HOSTILE[1], category: 'phase-transition', lastEventAt: '2026-08-12T00:00:00.000Z', freshness: 'live', staleSeconds: 0 },
            delayedRetry: IDLE_DELAYED_RETRY,
            resumeTargetPhaseId: null,
            outputs: [],
            effectiveLimits: limits()
          }
        })
      ]),
      queue: Object.freeze({ inFlight: null, pending: Object.freeze([]), recent: Object.freeze([]), orderedItems: Object.freeze([]), paused: false }),
      auditTail: Object.freeze([]),
      monitor: null,
      history: Object.freeze([]),
      producedAt: '2026-08-12T00:00:30.000Z',
      availablePipelines: Object.freeze([]),
      availablePhases: Object.freeze([]),
      availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
      availableBackends: Object.freeze(['claude']),
      generalSettings: IDLE_GENERAL_SETTINGS
    }) as unknown as WorkflowSnapshot;

    const { getByTestId } = render(RunDetailTier, {
      props: { snapshot, queueId: QUEUE_ID, runId: 'r-1', isPrimary: true, onBack: () => {} }
    });

    const panel = getByTestId(`run-limits-${QUEUE_ID}`).textContent;
    for (const text of HOSTILE) expect(panel).not.toContain(text);
  });
});
