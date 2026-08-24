// Feature 064 T013 — top-level flat nav, extended into the operator flow used
// by the redesigned dashboard shell. Feature 091 (T017, FR-018) added `runs` as
// a seventh surface, positioned after `operations`.
//
// Covers:
//   - Seven nav buttons render in the operator flow used by the dashboard shell.
//   - Each carries the stable data-testid from the navigation contract.
//   - Clicking each route switches the rendered content surface.
//   - No `dashboard-tabs` (legacy two-tier) markup remains anywhere.
//   - The landing surface is still `operations` after the addition.
//   - The lazy-route wait budget stays inside the bounds its measurement set.

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { RunnerTask, RunnerTestCase } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import App from '../App.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import {
  DASHBOARD_ROUTES,
  DASHBOARD_ROUTE_LABELS,
  DEFAULT_DASHBOARD_ROUTE
} from '../routes';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      }),
      workflowElapsedMs: null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-11T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as unknown as WorkflowSnapshot;
}

afterEach(() => cleanup());

/**
 * FR-R3-068 — the wait budget for the two lazily imported route assertions below.
 *
 * WHY AN EXPLICIT NUMBER AT ALL
 *
 * Both waits sit on a route component reached through `import()` in
 * `route-loader.ts`, and this file mocks only `lib/vscode-api` — so the import is
 * real and carries a first-time transform. `vi.waitFor`'s default is 1000 ms and
 * is NOT governed by `--testTimeout`; raising that looks like a fix and changes
 * nothing here. Verified.
 *
 * THE MEASUREMENT (2026-08-24, darwin/arm64, module cache cleared before each run)
 *
 *   RunsSurface.svelte       idle  n=5   361-418 ms   median 384
 *                            loaded n=12 384-1362 ms  median 799   <- 5 samples over 1000
 *   HistoryDashboard.svelte  idle  n=5   170-207 ms   median 184
 *                            loaded n=12 194-652 ms   median 340
 *
 * "Loaded" means the host suite, a full build and the performance suite running
 * concurrently — which is not a contrived condition: `verify:all` runs the host
 * suite immediately before this leg.
 *
 * WORST OBSERVED: 1362 ms. The source finding recorded 1005-1027 ms; those were
 * the marginal cases and the tail is materially worse.
 *
 * THE TWO BOUNDS
 *
 *   above  1362 ms, with margin for a shared CI runner slower than this machine;
 *   below  the per-test timeout, which `webview-ui/vitest.config.ts` does not set,
 *          so vitest's 5000 ms default applies. A budget near that ceiling would
 *          never fire: the runner would kill the test first and a broken import
 *          would surface as a bare timeout instead of a diagnosable wait failure.
 *
 * 3000 ms is 2.2x the measured worst case and leaves 2000 ms under the ceiling —
 * the whole file runs in about a second idle, so that is ample.
 *
 * WHAT THIS DOES NOT DETECT, stated rather than left to be discovered: a route
 * that legitimately regressed to, say, 2.5 s would still pass. This budget
 * catches a route that fails to load, not one that merely became slow. That is
 * the price of not flaking on a loaded runner, and `tests/visual/` remains the
 * honest coverage for this behaviour (FR-R3-021).
 *
 * ONE constant for both waits on purpose. The two components differ by roughly a
 * factor of two, and sizing each to its own measurement would give the smaller
 * one the smaller margin — exactly backwards for a slow runner.
 *
 * Deliberately NOT done: no retry (a retried flake is a flake with worse
 * diagnostics, and it would let a genuine intermittent route-load regression
 * through — the class REL-N1 was), no skip, no selector loosened, and no
 * pre-warming of the transform, which would change what these assertions
 * exercise.
 */
const LAZY_ROUTE_WAIT_MS = 3000;

/** The measured loaded worst case the budget must clear. See above. */
const MEASURED_WORST_TRANSFORM_MS = 1362;

/**
 * How far above that worst case the budget must sit. Named rather than inlined so
 * the lower bound's failure message can state what it actually enforces — "clears
 * 1362 ms with margin" is satisfied by 1400 ms, which is not what this bound means.
 */
const MIN_MARGIN_OVER_WORST_CASE = 2;

/**
 * The share of the per-test timeout the budget may occupy, leaving the rest for
 * the render, the click and teardown that the same test performs.
 *
 * The per-test timeout itself is deliberately NOT restated as a constant here.
 * Restating it is what lets the pair drift apart: a `testTimeout` added to
 * `webview-ui/vitest.config.ts` — or a `--testTimeout` on the command line —
 * below this budget would leave a broken import killed by the runner and
 * reported as a bare "test timed out", while a check written against a
 * hardcoded 5000 stayed green. The bound below reads the timeout actually in
 * force from the two tests it governs instead.
 */
const BUDGET_SHARE_OF_PER_TEST_TIMEOUT = 0.7;

/**
 * The two tests whose waits spend this budget, named so both bounds are checked
 * against *their* task rather than against the bounds test's own.
 *
 * Reading the bounds test's own task catches a `testTimeout` or `retry` from the
 * config or the command line, and nothing else. Vitest also takes both per test
 * (`it(name, { timeout }, fn)`) and per suite (`describe(name, { retry }, fn)`),
 * and either one on a route test reinstates exactly what these bounds exist to
 * prevent — a broken import killed by the runner before a 3000 ms wait can
 * report, or a flake retried into green — while a self-read stayed green.
 *
 * A rename fails the lookup below rather than quietly checking nothing.
 */
const BUDGETED_TEST_NAMES: readonly string[] = [
  'keeps the shell structural and exposes exactly one main landmark per route',
  'loads its surface on demand when the route is opened'
];

/** Every test case collected from this file, flattened out of the suite tree. */
function testCasesInThisFile(self: RunnerTestCase): readonly RunnerTestCase[] {
  const flatten = (nodes: readonly RunnerTask[]): RunnerTestCase[] =>
    nodes.flatMap((node) => (node.type === 'suite' ? flatten(node.tasks) : [node]));
  return flatten(self.file.tasks);
}

/*
 * FR-R3-068 — the budget is a consequence of two measurements, so both bounds are
 * asserted rather than only described. An edit to either end fails here instead of
 * drifting: raising it toward the per-test timeout would stop it ever firing, and
 * lowering it toward the measured worst case would restore the flake this replaced.
 *
 * It sits beside the constant rather than inside a route's describe block because
 * it asserts nothing about any one route — it constrains the value both route
 * waits below share.
 */
describe('FR-R3-068 — the lazy-route wait budget', () => {
  it('stays inside the bounds its measurement set', ({ task }) => {
    expect(
      LAZY_ROUTE_WAIT_MS,
      `the budget must be at least ${MIN_MARGIN_OVER_WORST_CASE}x the measured loaded worst case of ` +
        `${MEASURED_WORST_TRANSFORM_MS} ms, leaving margin for a CI runner slower than the machine ` +
        "measured; see the constant's comment for the measurement"
    ).toBeGreaterThan(MEASURED_WORST_TRANSFORM_MS * MIN_MARGIN_OVER_WORST_CASE);

    const governedTests = testCasesInThisFile(task).filter((one) =>
      BUDGETED_TEST_NAMES.includes(one.name)
    );
    expect(
      governedTests.map((one) => one.name).sort(),
      'both tests this budget governs must still be present under these names, or the bounds below ' +
        'are checked against nothing'
    ).toEqual([...BUDGETED_TEST_NAMES].sort());

    for (const governed of governedTests) {
      // `governed.timeout` is the per-test timeout in force for that test — the
      // config's value, a `--testTimeout` override, an `it`/`describe` option, or
      // vitest's default when none of those applies.
      expect(
        LAZY_ROUTE_WAIT_MS,
        `the budget must stay well under the ${governed.timeout} ms per-test timeout in force for ` +
          `"${governed.name}", or a broken import is killed by the runner and surfaces as a bare ` +
          'timeout rather than a wait failure'
      ).toBeLessThan(governed.timeout * BUDGET_SHARE_OF_PER_TEST_TIMEOUT);

      // FR-R3-068 refuses a retry, and a refusal nothing checks is a refusal that
      // slips. `retry` is undefined when none is configured; any other value means
      // one arrived from the config, the command line, or an `it`/`describe`
      // option, which would mask exactly the flake this budget was measured to
      // remove.
      expect(
        governed.retry ?? 0,
        `no retry may be configured for "${governed.name}": a retried flake is a flake with worse ` +
          'diagnostics, and it would let a genuine intermittent route-load regression through'
      ).toBe(0);
    }
  });
});

describe('Feature 064 T013 — flat seven-route top-level nav', () => {
  it('renders seven nav buttons in order with stable data-testids', () => {
    // Push a ready snapshot so the nav (and routes) render.
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    const buttons = container.querySelectorAll('[data-testid^="dashboard-route-"]');
    expect(buttons.length).toBe(7);
    expect(buttons[0].getAttribute('data-testid')).toBe('dashboard-route-operations');
    expect(buttons[1].getAttribute('data-testid')).toBe('dashboard-route-runs');
    expect(buttons[2].getAttribute('data-testid')).toBe('dashboard-route-history');
    expect(buttons[3].getAttribute('data-testid')).toBe('dashboard-route-metrics');
    expect(buttons[4].getAttribute('data-testid')).toBe('dashboard-route-system');
    expect(buttons[5].getAttribute('data-testid')).toBe('dashboard-route-builder');
    expect(buttons[6].getAttribute('data-testid')).toBe('dashboard-route-settings');
  });

  it('switches the visible surface when each route is clicked', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);

    const metBtn = container.querySelector(
      '[data-testid="dashboard-route-metrics"]'
    ) as HTMLButtonElement;
    const opBtn = container.querySelector(
      '[data-testid="dashboard-route-operations"]'
    ) as HTMLButtonElement;
    const historyBtn = container.querySelector(
      '[data-testid="dashboard-route-history"]'
    ) as HTMLButtonElement;
    const pbBtn = container.querySelector(
      '[data-testid="dashboard-route-builder"]'
    ) as HTMLButtonElement;
    const sysBtn = container.querySelector(
      '[data-testid="dashboard-route-system"]'
    ) as HTMLButtonElement;
    const setBtn = container.querySelector(
      '[data-testid="dashboard-route-settings"]'
    ) as HTMLButtonElement;

    await fireEvent.click(pbBtn);
    expect(container.querySelector('[data-testid="dashboard-route-builder"].active')).not.toBeNull();
    await fireEvent.click(sysBtn);
    expect(container.querySelector('[data-testid="dashboard-route-system"].active')).not.toBeNull();
    await fireEvent.click(setBtn);
    expect(container.querySelector('[data-testid="dashboard-route-settings"].active')).not.toBeNull();
    await fireEvent.click(opBtn);
    expect(container.querySelector('[data-testid="dashboard-route-operations"].active')).not.toBeNull();
    await fireEvent.click(historyBtn);
    expect(container.querySelector('[data-testid="dashboard-route-history"].active')).not.toBeNull();
    await fireEvent.click(metBtn);
    expect(container.querySelector('[data-testid="dashboard-route-metrics"].active')).not.toBeNull();
  });

  it('does NOT render the legacy dashboard-tabs (inner two-tier) markup', () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    expect(container.querySelector('.dashboard-tabs')).toBeNull();
  });

  it('keeps the shell structural and exposes exactly one main landmark per route', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container, getByTestId } = render(App);
    expect(getByTestId('dashboard-app-root').tagName).toBe('DIV');
    expect(container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(
      () => {
        expect(container.querySelector('[data-testid="history-dashboard"]')).not.toBeNull();
      },
      { timeout: LAZY_ROUTE_WAIT_MS }
    );
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });
});

// Feature 091 (T017, US2 — FR-018) — the mount, seen from the nav.
//
// Two claims, and the second is the one that could quietly cost an operator
// something. The first is that the surface is genuinely reachable: a button
// exists, clicking it loads a real component, and the component is the Runs
// surface rather than the loading placeholder. The second is that adding it
// moved nobody's landing page — `DEFAULT_DASHBOARD_ROUTE` is asserted directly
// rather than inferred from what renders first, because a default that changed
// while the first render happened to agree is exactly the regression a
// render-only assertion would miss.
describe('Feature 091 T017 — the Runs route (FR-018)', () => {
  it('appears in the nav labelled "Runs"', () => {
    expect(DASHBOARD_ROUTES).toContain('runs');
    expect(DASHBOARD_ROUTE_LABELS.runs).toBe('Runs');

    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { getByTestId } = render(App);
    expect(getByTestId('dashboard-route-runs').textContent).toContain('Runs');
  });

  it('sits directly after operations, before history', () => {
    expect(DASHBOARD_ROUTES.indexOf('runs')).toBe(DASHBOARD_ROUTES.indexOf('operations') + 1);
    expect(DASHBOARD_ROUTES.indexOf('runs')).toBeLessThan(DASHBOARD_ROUTES.indexOf('history'));
  });

  it('loads its surface on demand when the route is opened', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container, getByTestId } = render(App);

    // Not loaded until asked for — that is what "on demand" means here, and a
    // statically imported surface would already be in the DOM's reach.
    expect(container.querySelector('[data-testid="runs-surface"]')).toBeNull();

    await fireEvent.click(getByTestId('dashboard-route-runs'));
    await vi.waitFor(
      () => {
        expect(container.querySelector('[data-testid="runs-surface"]')).not.toBeNull();
      },
      { timeout: LAZY_ROUTE_WAIT_MS }
    );
    expect(container.querySelector('[data-testid="dashboard-route-runs"].active')).not.toBeNull();
  });

  it('leaves the landing surface on operations', () => {
    expect(DEFAULT_DASHBOARD_ROUTE).toBe('operations');

    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    expect(
      container.querySelector('[data-testid="dashboard-route-operations"].active')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="dashboard-route-runs"].active')).toBeNull();
  });
});
