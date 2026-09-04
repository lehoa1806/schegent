import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import PhaseCatalogEditor from '../PipelineBuilderEditors/PhaseCatalogEditor.svelte';
import type { MutablePhase } from '../PipelineBuilderEditors/types';

afterEach(cleanup);

/**
 * FR-R3-157 (T044/T045, US1) — the per-phase cap outcome, driven through the
 * editor that owns it rather than through the control in isolation.
 *
 * The control could be mounted directly and asserted in a third of these lines.
 * It is not, because two of the three claims this file makes are claims about
 * the SURROUNDINGS: that the control is disabled by exactly the expression the
 * retry toggle beside it uses (C4.7, no new trust surface), and that choosing an
 * option reaches the same `onphasechange` path every other field on this card
 * uses (FR-017, no new IPC message). A test that mounted the control alone would
 * pass with the control wired to nothing at all.
 */

const SNAPSHOT = {
  isPrimary: true,
  availableBackends: ['claude', 'codex', 'agy'],
  availableModels: { claude: ['model-a'], codex: [], agy: [] },
  phaseCatalog: {
    state: 'ready', records: [], effective: [],
    revisions: { user: 'u', workspace: 'w' }, warnings: []
  }
} as unknown as WorkflowSnapshot;

/** A phase with a retry condition, which is the only kind that can reach a cap. */
const RETRYING_PHASE: MutablePhase = {
  id: 'custom', name: 'Custom', version: 2, instruction: 'Run.',
  retryCondition: 'tests-passed',
  sourceKey: 'custom::0', sourceStatus: 'effective',
  sourceErrors: [], persisted: true
};

const CAP_SELECT = '[data-testid="phases-retry-cap-custom"]';
const CAP_ORIGIN = '[data-testid="phases-retry-cap-origin-custom"]';

function withWorkspaceDefault(retryForceContinueOnCap: boolean | undefined): WorkflowSnapshot {
  if (retryForceContinueOnCap === undefined) {
    return SNAPSHOT;
  }
  return { ...SNAPSHOT, generalSettings: { retryForceContinueOnCap } } as unknown as WorkflowSnapshot;
}

function mount(options: {
  phase?: MutablePhase;
  snapshot?: WorkflowSnapshot;
  trusted?: boolean;
  retryConditionsTrusted?: boolean;
  onphasechange?: (index: number, patch: Partial<MutablePhase>) => void;
} = {}) {
  const phases = [options.phase ?? RETRYING_PHASE];
  return render(PhaseCatalogEditor, {
    props: {
      snapshot: options.snapshot ?? SNAPSHOT,
      phases,
      editStateById: Object.fromEntries(phases.map((phase) => [phase.sourceKey, { rawJsonMode: false }])),
      selectedIndex: 0,
      historyIndex: 0, historyLength: 1,
      trusted: options.trusted ?? true,
      retryConditionsTrusted: options.retryConditionsTrusted ?? true,
      showTrustBanner: false,
      showRetryTrustBanner: false, saveError: null, savePending: false,
      mutationActive: false,
      editableSourceKey: null,
      onselect: vi.fn(), onadd: vi.fn(), onremove: vi.fn(), onreset: vi.fn(),
      onphasechange: options.onphasechange ?? vi.fn(), onmoveup: vi.fn(), onmovedown: vi.fn(),
      onundo: vi.fn(), onredo: vi.fn(), onsave: vi.fn(),
      ondismisssaveerror: vi.fn(), ontoggleraw: vi.fn(), onrawsave: vi.fn(),
      ontoggleretry: vi.fn(), onretrychange: vi.fn(), onduplicate: vi.fn()
    }
  });
}

describe('Per-phase retry cap outcome — the control (T044, FR-014, FR-015)', () => {
  it('offers exactly the three outcomes, labelled by what happens (FR-015)', () => {
    const { container } = mount();
    const options = Array.from(container.querySelectorAll(`${CAP_SELECT} option`)) as HTMLOptionElement[];

    expect(
      options.map((option) => option.value),
      'the three values are the closed vocabulary, and there is no fourth'
    ).toEqual(['fail', 'continue', 'continue-degraded']);

    // The labels are the design's (research.md D7), asserted as text rather than
    // by count: "three options" is satisfied by three boxes reading `fail`,
    // `continue` and `continue-degraded`, which is the vocabulary the operator
    // does not have. Each label says what the run does.
    expect(options.map((option) => option.text.trim())).toEqual([
      'Fail the task',
      'Continue with a warning',
      'Continue, marked unverified'
    ]);
  });

  it('names no field of the pipeline file anywhere on the card', () => {
    // FR-015. The operator is choosing a behaviour, not editing a document; the
    // deprecated switch in particular must never surface, because a phase that
    // carries it is a phase whose author should be reading the new vocabulary.
    const { container } = mount({
      phase: { ...RETRYING_PHASE, forceContinueOnRetryCap: true }
    });
    expect(container.textContent).not.toContain('onRetryCap');
    expect(container.textContent).not.toContain('forceContinueOnRetryCap');
  });

  it('submits the phase carrying the chosen outcome, through the ordinary field path', async () => {
    const onphasechange = vi.fn();
    const { container } = mount({ onphasechange });

    await fireEvent.change(container.querySelector(CAP_SELECT) as HTMLSelectElement, {
      target: { value: 'continue-degraded' }
    });

    expect(onphasechange).toHaveBeenCalledWith(0, { onRetryCap: 'continue-degraded' });
  });

  it('writes the new form even when the phase arrived carrying the deprecated one', async () => {
    // The row that decides whether this control can be trusted on an existing
    // pipeline. The phase says `forceContinueOnRetryCap: true`; the operator
    // picks "Fail the task". Writing only `onRetryCap` is correct — the resolver
    // gives the new field precedence (C1.2) — but writing the deprecated field
    // instead, or as well, would be a save that either did nothing visible or
    // left two fields disagreeing in a file a human has to read later.
    const onphasechange = vi.fn();
    const { container } = mount({
      phase: { ...RETRYING_PHASE, forceContinueOnRetryCap: true },
      onphasechange
    });

    await fireEvent.change(container.querySelector(CAP_SELECT) as HTMLSelectElement, {
      target: { value: 'fail' }
    });

    expect(onphasechange).toHaveBeenCalledWith(0, { onRetryCap: 'fail' });
  });

  it('is disabled by exactly the expression the retry toggle beside it uses (C4.7)', () => {
    // Asserted against the toggle rather than against a restatement of
    // `!retryConditionsTrusted || selectedReadOnly`. FR-017a's claim is that this
    // control adds NO new trust surface, and the only way to state that as a
    // test is to compare it to the surface that already exists: a control that
    // stayed enabled in a state where the toggle is disabled would be a second,
    // quieter route to the same authored value.
    for (const trusted of [true, false]) {
      for (const retryConditionsTrusted of [true, false]) {
        const { container, unmount } = mount({ trusted, retryConditionsTrusted });
        const toggle = container.querySelector('[data-testid="phases-retry-toggle"]') as HTMLInputElement;
        const select = container.querySelector(CAP_SELECT) as HTMLSelectElement;

        expect(select, `the control must render for trusted=${trusted}`).not.toBeNull();
        expect(
          select.disabled,
          `trusted=${trusted}, retryConditionsTrusted=${retryConditionsTrusted}: ` +
            'the cap control and the retry toggle must agree on whether this phase is editable'
        ).toBe(toggle.disabled);
        unmount();
      }
    }
  });

  it('is absent for a phase with no retry condition', () => {
    // Not a cosmetic placement. A phase that never retries never reaches a cap,
    // so an outcome authored on it would be a setting with no occasion — and the
    // one thing worse than an unreachable control is one an operator sets and
    // then relies on.
    const { container } = mount({ phase: { ...RETRYING_PHASE, retryCondition: undefined } });
    expect(container.querySelector(CAP_SELECT)).toBeNull();
  });
});

describe('Per-phase retry cap outcome — in effect, and whose (T045, FR-016, SC-011, C4.5)', () => {
  it('shows the workspace default as the outcome in effect, and says it is inherited', () => {
    const { container } = mount({ snapshot: withWorkspaceDefault(true) });
    expect((container.querySelector(CAP_SELECT) as HTMLSelectElement).value).toBe('continue');
    expect(container.querySelector(CAP_ORIGIN)?.textContent).toContain('workspace');
  });

  it("falls back to 'fail' when nothing anywhere states an outcome (FR-005)", () => {
    const { container } = mount({ snapshot: withWorkspaceDefault(undefined) });
    expect((container.querySelector(CAP_SELECT) as HTMLSelectElement).value).toBe('fail');
    expect(container.querySelector(CAP_ORIGIN)?.textContent).toContain('workspace');
  });

  it('reads a phase that states its own outcome as stated, not inherited', () => {
    const { container } = mount({
      phase: { ...RETRYING_PHASE, onRetryCap: 'continue-degraded' },
      snapshot: withWorkspaceDefault(true)
    });
    expect((container.querySelector(CAP_SELECT) as HTMLSelectElement).value).toBe('continue-degraded');
    expect(container.querySelector(CAP_ORIGIN)?.textContent).not.toContain('workspace');
  });

  it('reads the deprecated switch as an outcome this phase states (C4.5)', () => {
    // Both positions, because `false` is the row that a truthiness check gets
    // wrong: it resolves to `'fail'`, the same answer an unconfigured workspace
    // gives, so the ONLY thing separating "this author held this phase to fail"
    // from "nobody decided" is that the field is present. Under a workspace
    // default of `true`, calling that phase inherited would be a display that
    // contradicts what the run will do.
    for (const [switchValue, outcome] of [[true, 'continue'], [false, 'fail']] as const) {
      const { container, unmount } = mount({
        phase: { ...RETRYING_PHASE, forceContinueOnRetryCap: switchValue },
        snapshot: withWorkspaceDefault(true)
      });
      expect((container.querySelector(CAP_SELECT) as HTMLSelectElement).value).toBe(outcome);
      expect(
        container.querySelector(CAP_ORIGIN)?.textContent,
        `forceContinueOnRetryCap: ${switchValue} is an outcome the phase states`
      ).not.toContain('workspace');
      unmount();
    }
  });

  it('shows the stated outcome, not the deprecated switch that contradicts it (C1.2)', () => {
    const { container } = mount({
      phase: { ...RETRYING_PHASE, onRetryCap: 'fail', forceContinueOnRetryCap: true },
      snapshot: withWorkspaceDefault(true)
    });
    expect(
      (container.querySelector(CAP_SELECT) as HTMLSelectElement).value,
      'the editor must show what the controller will do, and the controller reads onRetryCap first'
    ).toBe('fail');
  });
});
