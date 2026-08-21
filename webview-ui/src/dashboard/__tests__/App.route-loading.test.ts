// Feature 105 (T587, T587b, T587c) — the route loader, the boundary, and the bound.
//
// Everything here is a consequence of one measurement: the History route in the
// built bundle rendered its loading placeholder forever, and the reason was a
// synchronous throw during mount that the loader promise's `.catch()` could not
// see. A promise handler cannot observe an exception raised by the render it
// caused, so the loading branch stayed in the DOM with `aria-busy="true"` while
// nothing was loading. The diagnosis is in
// `docs/operations/built-artifact-route-diagnosis.md`.
//
// Three separate holes, and each needs its own observation:
//   - nothing caught a mount throw (the boundary, FR-004);
//   - loading was caused by calling `navigate` rather than by the route's value,
//     so any other assignment switched the route and left the outlet behind
//     (the effect, FR-005);
//   - a promise that never settled left the placeholder up forever (the bound,
//     FR-007).
//
// These tests observe what the loader causes rather than what it is: which
// fixture mounted, how often, and which render branch is on screen.
// `fixtures/route-mount-ledger.ts` is that channel. It is needed because the
// route *components* are reached through `import()` inside the outlet, so a test
// has no way to hand them anything — not because the loader is unreachable.
// `route-loader.ts` is a plain module and directly callable since T588h; the
// behaviour asserted below is the loader and the outlet together, which is the
// pairing the built bundle actually ships.
//
// One thing deliberately NOT asserted here. SC-009b's "without a second chunk
// request" is not observable in jsdom: vitest serves a mocked module from its
// own registry, so a re-import and a cache hit are indistinguishable from
// inside the test. What IS observable is the mechanism that makes it true —
// mount-failure recovery goes through the boundary's `reset`, which re-renders
// without re-running the loader effect, so the loading branch never reappears;
// load-rejection recovery goes through `retryRoute`, which does re-run it, so
// the loading branch does. Those two assertions are below. The request count
// itself belongs to the browser suite, where a chunk request is a real thing —
// T587d.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../App.svelte';
import { ledger } from './fixtures/route-mount-ledger';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

// Every route the tests below touch is replaced by a ledger fixture. The real
// surfaces are not the subject here — the loading machinery around them is, and
// a real surface would fail for its own reasons.
//
// `vi.mock` factories are hoisted above the imports, so each one reaches the
// ledger through a dynamic import rather than the file-level binding.
vi.mock('../../components/OperationsSurface.svelte', async () => {
  const { ledger: l } = await import('./fixtures/route-mount-ledger');
  l.recordImport('operations');
  return { default: (await import('./fixtures/LedgerOperationsSurface.svelte')).default };
});

vi.mock('../../components/HistoryDashboard.svelte', async () => {
  const { ledger: l } = await import('./fixtures/route-mount-ledger');
  l.recordImport('history');
  return { default: (await import('./fixtures/LedgerHistorySurface.svelte')).default };
});

vi.mock('../../components/MetricsDashboard/MetricsDashboard.svelte', async () => {
  const { ledger: l } = await import('./fixtures/route-mount-ledger');
  l.recordImport('metrics');
  return { default: (await import('./fixtures/LedgerMetricsSurface.svelte')).default };
});

// Gated: the factory does not return until the test opens the gate. `system`
// serves the bound (never opened), `builder` serves the stale resolution.
vi.mock('../../components/SystemTab.svelte', async () => {
  const { ledger: l } = await import('./fixtures/route-mount-ledger');
  await l.gate('system');
  l.recordImport('system');
  return { default: (await import('./fixtures/LedgerSystemSurface.svelte')).default };
});

vi.mock('../../components/PipelineBuilder.svelte', async () => {
  const { ledger: l } = await import('./fixtures/route-mount-ledger');
  await l.gate('builder');
  l.recordImport('builder');
  return { default: (await import('./fixtures/LedgerBuilderSurface.svelte')).default };
});

// The rejecting route: a factory that throws makes the dynamic import reject,
// which is the load failure the pre-existing `.catch()` already handled. It is
// here as the contrast case for recovery, not as new coverage.
vi.mock('../../components/SettingsSurface.svelte', () => {
  throw new Error('settings chunk unavailable');
});

// Two source paths because the route machinery is no longer in the shell (T588h).
// `App.svelte` keeps the nav and the `route` value; `RouteOutlet.svelte` owns the
// load, the boundary, and the error presentation. The runtime assertions in this
// file did not move — they mount `App` and reach the outlet through it — but each
// source-shape assertion has to read the file that now holds the shape.
const APP_SOURCE_PATH = resolve(__dirname, '..', 'App.svelte');
const OUTLET_SOURCE_PATH = resolve(__dirname, '..', 'RouteOutlet.svelte');

/**
 * A minimal ready snapshot, modelled on the one `App.nav.test.ts` builds.
 * Duplicated rather than shared: that file is fenced unmodified by FR-028 and
 * SC-014, because it is the pre-existing coverage this feature must not have
 * quietly rewritten to suit itself, and extracting a shared helper out of it
 * would be exactly that.
 *
 * The return type is annotated, so this fixture is checked against the real
 * interface rather than asserted into it. It began as a copy carrying
 * `as unknown as WorkflowSnapshot`, and dropping that cast (T588f) showed the
 * copy was wrong in two ways: `availableModels` was an array where the type is
 * `Record<BackendRunnerKind, readonly string[]>`, and `availableBackends` was
 * absent. A double cast through `unknown` silences exactly the check that would
 * have said so — which is the same failure this feature found in the visual
 * fixture, one layer down. `App.nav.test.ts` carries the uncorrected version and
 * is left alone by the fence; the divergence is recorded in the diagnosis
 * document instead.
 */
function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
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
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  });
}

/**
 * Two macrotask turns, which is enough for a settled promise chain plus the
 * Svelte flush it schedules. Named rather than inlined so the reason it is two
 * and not one stays attached to it: `Promise.race` → `.then` → state write →
 * flush is more than one microtask deep.
 */
async function flushTasks(): Promise<void> {
  await new Promise((settle) => setTimeout(settle, 0));
  await new Promise((settle) => setTimeout(settle, 0));
}

// The return type is inferred, not annotated. `ReturnType<typeof render>` looks
// like the right annotation and is not: it instantiates the generic at its
// default, which widens every bound query to the union of all query shapes, so
// `getByTestId(...)` comes back as `HTMLElement | HTMLElement[] | Promise<...> |
// null` and cannot be handed to `fireEvent`. Inference keeps the specialization
// that a direct `render(App)` call has.
function mountApp() {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: buildSnapshot()
  });
  return render(App);
}

/**
 * A `console.error` collector. The diagnostic line is an assertion target
 * (SC-009c) and an expected side effect of every failing-mount test, so it is
 * captured rather than left to print — an expected error that still reaches the
 * reporter is indistinguishable from an unexpected one.
 */
function captureConsoleErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

let consoleErrors: { lines: string[]; restore: () => void };

beforeEach(() => {
  ledger.reset();
  consoleErrors = captureConsoleErrors();
});

afterEach(() => {
  cleanup();
  consoleErrors.restore();
  vi.useRealTimers();
});

describe('Feature 105 — the loader effect (US5, FR-005)', () => {
  it('drives the load from `route`, with navigate reduced to an assignment', () => {
    // What this can and cannot observe, stated plainly.
    //
    // The property FR-005 asks for is that *any* assignment to `route` drives a
    // load. No second assignment path exists in the component today, so a
    // runtime test cannot distinguish an effect-driven loader from the
    // `navigate`-driven one it replaced: clicking a nav button mounts the
    // surface either way. Asserting the shape is therefore the only way to hold
    // the property — a future imperative load re-added to `navigate` fails here,
    // and that is the regression FR-005 is about.
    //
    // The two halves live in two files since T588h: the shell still owns the
    // assignment, the outlet owns the effect that reacts to it. Splitting the
    // assertion is the point — it is the *absence* of a load in `navigate` that
    // FR-005 protects, and that absence is now a property of `App.svelte` alone.
    expect(readFileSync(APP_SOURCE_PATH, 'utf8')).toContain(
      '  function navigate(next: DashboardRoute): void {\n    route = next;\n  }'
    );
    expect(readFileSync(OUTLET_SOURCE_PATH, 'utf8')).toMatch(
      /\$effect\(\(\) => \{\n {4}const active = route;/
    );
  });

  it('mounts the route the value names', async () => {
    const { container, getByTestId } = mountApp();
    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    });
    expect(ledger.mountCount('history')).toBe(1);
  });

  it('mounts a preloaded route exactly once (FR-006)', async () => {
    const { container, getByTestId } = mountApp();
    const button = getByTestId('dashboard-route-history');
    // Hover populates the cache; the click must consume that entry rather than
    // start a second load. Two loads would mount twice, and the second mount is
    // what would discard whatever state the first one had built.
    await fireEvent.pointerEnter(button);
    await fireEvent.click(button);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    });
    expect(ledger.mountCount('history')).toBe(1);
  });

  it('leaves the current route mounted when a slower one resolves late (FR-010)', async () => {
    ledger.closeGate('builder');
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-builder'));
    expect(container.querySelector('[data-testid="dashboard-route-loading"]')).not.toBeNull();

    await fireEvent.click(getByTestId('dashboard-route-metrics'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-metrics"]')).not.toBeNull();
    });

    // Builder's import now completes, after its route stopped being current.
    //
    // Waiting on the import count rather than on a bare `setTimeout(0)`: the
    // first version of this test did the latter and passed with the staleness
    // guard removed, because the mocked module had not finished resolving by the
    // time the assertions ran. It was asserting that nothing had happened yet,
    // not that the late resolution was discarded. The import count is recorded
    // by the factory after the gate opens, so it is the first moment at which
    // there is something to discard.
    ledger.openGate('builder');
    await vi.waitFor(() => {
      expect(ledger.importCount('builder')).toBe(1);
    });
    await flushTasks();

    expect(container.querySelector('[data-testid="ledger-metrics"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ledger-builder"]')).toBeNull();
    // Not merely unrendered — never mounted. A discarded resolution that still
    // instantiated the component would have run its `$effect`s and its
    // subscriptions, and only the mount count can tell the two apart.
    expect(ledger.mountCount('builder')).toBe(0);
  });

  // T587e — added after the browser route walk found what this suite had missed.
  //
  // A nav click moves `route` immediately; the loader effect clears the mounted
  // component a flush later. For that one flush the two disagree, and the outlet
  // used to pick props by `route` while taking the component from a separate
  // signal — so History was torn down and re-created as the *Metrics* branch,
  // with `active={true}` and no `snapshot`. Its `$derived` read `snapshot.history`
  // and threw. The mount count is what makes the window visible from here: a
  // subtree that is destroyed and rebuilt mounts twice, and a subtree that merely
  // waits to be unmounted mounts once.
  //
  // Worth its own test rather than an extra assertion on an existing one: the
  // defect is in the *transition*, and every other test in this file arrives at
  // one route and stays there.
  it('does not re-create the outgoing route as the incoming one (FR-005)', async () => {
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    });
    expect(ledger.mountCount('history')).toBe(1);

    // Metrics is the route whose props differ most from History's: it takes
    // `active`, History takes `snapshot`. A pair that agreed on props would make
    // the tear invisible.
    await fireEvent.click(getByTestId('dashboard-route-metrics'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-metrics"]')).not.toBeNull();
    });

    expect(
      ledger.mountCount('history'),
      'history was re-created on the way out, so the outlet paired one route with the props of another'
    ).toBe(1);
    // The same defect, stated as the consequence rather than the symptom, so a
    // failure says what was wrong and not only that a count moved.
    expect(ledger.violations()).toEqual([]);
  });
});

describe('Feature 105 — the bound (US1, FR-007, FR-008, FR-009)', () => {
  it('resolves a never-settling load into the error branch at 10 000 ms', async () => {
    ledger.closeGate('system');
    vi.useFakeTimers();
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-system'));
    const loading = container.querySelector('[data-testid="dashboard-route-loading"]');
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('aria-busy')).toBe('true');

    // One millisecond short of the bound: still loading. Without this the test
    // would pass on any timeout at all, including none.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(container.querySelector('[data-testid="dashboard-route-loading"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const error = container.querySelector('[data-testid="dashboard-route-error"]');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    // FR-009 — `aria-busy` is gone, not merely false. A stuck `aria-busy="true"`
    // is what a screen reader would still be announcing as in progress.
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(ledger.mountCount('system')).toBe(0);
  });

  it('clears aria-busy on the success path too (FR-009)', async () => {
    const { container, getByTestId } = mountApp();
    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    });
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});

describe('Feature 105 — the boundary (US1, FR-004)', () => {
  it('renders the error branch when a lazily loaded route throws during mount', async () => {
    ledger.failEveryMount('history');
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dashboard-route-error"]')).not.toBeNull();
    });
    const error = container.querySelector('[data-testid="dashboard-route-error"]');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('History');
    // The mount was attempted and failed — this is the case the loader's
    // `.catch()` structurally could not see, since the promise had already
    // resolved before the render threw.
    expect(ledger.mountCount('history')).toBe(1);
    expect(container.querySelector('[data-testid="ledger-history"]')).toBeNull();
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });

  it('renders the error branch when the eagerly rendered operations route throws (SC-009a)', async () => {
    // `operations` is rendered directly, with no loader and no promise. Before
    // the boundary it was the one route that could not have been protected by
    // any amount of care in the loader — the throw went to the console and the
    // shell stayed up with nothing inside it.
    ledger.failEveryMount('operations');
    const { container } = mountApp();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dashboard-route-error"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="ledger-operations"]')).toBeNull();
    expect(ledger.mountCount('operations')).toBe(1);
  });
});

describe('Feature 105 — recovery (US1, FR-004b, FR-004c)', () => {
  it('recovers a mount failure by re-rendering, without returning to loading', async () => {
    ledger.failNextMount('history');
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dashboard-route-error"]')).not.toBeNull();
    });

    const retry = container.querySelector(
      '[data-testid="dashboard-route-error"] button'
    ) as HTMLButtonElement;
    await fireEvent.click(retry);

    // Synchronously after the click, before any await: the surface is already
    // mounted and the loading branch never appeared. That is the observable
    // signature of recovery from cache (FR-004b) — the boundary's `reset`
    // re-renders the children it already has, and the loader effect does not
    // re-run, so there is nothing to wait for.
    expect(container.querySelector('[data-testid="dashboard-route-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    expect(ledger.mountCount('history')).toBe(2);
  });

  it('recovers a load rejection by asking again, which does return to loading', async () => {
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-settings'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dashboard-route-error"]')).not.toBeNull();
    });

    const retry = container.querySelector(
      '[data-testid="dashboard-route-error"] button'
    ) as HTMLButtonElement;
    await fireEvent.click(retry);

    // The contrast with the case above. Here the module never arrived, so
    // recovery has to re-run the loader effect — and the loading branch
    // reappearing is what proves it did. Retry on this path going through the
    // boundary's `reset` instead would render the error branch again forever,
    // since `reset` re-renders state that is still an error.
    expect(container.querySelector('[data-testid="dashboard-route-loading"]')).not.toBeNull();
  });

  it('renders one error definition from both paths (SC-009d)', () => {
    const source = readFileSync(OUTLET_SOURCE_PATH, 'utf8');
    const definitions = source.match(/data-testid="dashboard-route-error"/g) ?? [];
    const renders = source.match(/\{@render routeError\(/g) ?? [];
    // One definition, two callers. Counted in the source because the property
    // is about the markup, not about a render: two copies that happen to agree
    // today would satisfy every runtime assertion in this file and drift apart
    // on the next edit to either one.
    expect(definitions).toHaveLength(1);
    expect(renders).toHaveLength(2);
  });
});

describe('Feature 105 — the diagnostic line (US1, FR-004a, FR-012, SC-009c)', () => {
  it('names the route and the message, and carries no path', async () => {
    // A real one: this is what a failed dynamic import reports, and it is the
    // reason the message is scrubbed rather than trusted.
    ledger.failEveryMount(
      'history',
      'Failed to fetch dynamically imported module: vscode-webview://1a2b/dist/webview/chunks/HistoryDashboard.js'
    );
    const { container, getByTestId } = mountApp();

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dashboard-route-error"]')).not.toBeNull();
    });

    expect(consoleErrors.lines).toHaveLength(1);
    const [line] = consoleErrors.lines;
    expect(line).toContain('route=history');
    expect(line).toContain('Failed to fetch dynamically imported module');
    // Scrubbed, not absent: asserting only that the URL is missing would pass
    // on a diagnostic that dropped the message entirely.
    expect(line).toContain('<path>');
    expect(line).not.toContain('vscode-webview://');
    expect(line).not.toContain('/dist/webview/');
    expect(line).not.toContain('.js');
    expect(line).not.toContain('\n    at ');
  });

  it('emits nothing when routes mount cleanly', async () => {
    const { container, getByTestId } = mountApp();
    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ledger-history"]')).not.toBeNull();
    });
    expect(consoleErrors.lines).toEqual([]);
  });
});

describe('Feature 105 — the bound is a constant, not a setting (FR-008)', () => {
  it('is named in the module that owns the loading and nowhere in the settings surface', () => {
    // "The module that owns the loading" is `RouteOutlet.svelte` since T588h. The
    // wording was already about ownership rather than about a filename, and the
    // extraction is what made the distinction load-bearing.
    const source = readFileSync(OUTLET_SOURCE_PATH, 'utf8');
    expect(source).toContain('const ROUTE_LOAD_TIMEOUT_MS = 10_000;');
    // Not reachable from settings: the snapshot contract is how a setting would
    // arrive in the webview, so the absence of the name there is the check that
    // matters. A configurable bound is a knob whose only correct value is the
    // one that makes the surface appear.
    const snapshotTypes = readFileSync(
      resolve(__dirname, '..', '..', 'lib', 'snapshot-types.ts'),
      'utf8'
    );
    expect(snapshotTypes).not.toContain('ROUTE_LOAD_TIMEOUT');
    expect(snapshotTypes.toLowerCase()).not.toContain('routeloadtimeout');
  });
});
