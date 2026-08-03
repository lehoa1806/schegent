// Feature 084 T036 — the preflight surface's four states, and the rendering
// discipline for document-derived text.
//
// The states are asserted through the component's own outcome, not through a
// mocked host: `preflightProcessYaml` is the single call site (FR-058), so
// stubbing it is stubbing the whole boundary. What matters here is that the
// component shows a non-committal progress state and NO plan until validation
// finishes (FR-055), and that every string that came out of the document is
// rendered as inert text rather than as markup the interface interprets
// (FR-050).

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentRefusalCode,
  ImportPlan,
  ImportPlanRow,
  PreflightProcessYamlResult
} from '../../lib/messages';
import type { SavePhaseRow, SavePhasesRequest, SavePhasesResult } from '../../lib/save-phases';
import { refusalHeadline } from '../ProcessImport/process-import-state';
import type { ImportedPhaseDefinition } from '../ProcessImport/process-import-state';

const preflightSpy = vi.fn<(kind: string) => Promise<PreflightProcessYamlResult>>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  preflightProcessYaml: (kind: string) => preflightSpy(kind)
}));

// The commit goes through the shared savePhases helper — import adds no mutating
// IPC command of its own (research R2) — so stubbing that helper is stubbing the
// whole write path, and the request it is handed is the assertable artifact.
const saveSpy = vi.fn<(request: SavePhasesRequest) => Promise<SavePhasesResult>>();
vi.mock('../../lib/save-phases', () => ({
  savePhases: (request: SavePhasesRequest) => saveSpy(request)
}));

// Late import so the component binds to the mocked call sites above.
import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';

const REVISIONS = Object.freeze({ user: 'user-rev-1', workspace: 'workspace-rev-1' });

function plan(rows: readonly ImportPlanRow[]): ImportPlan {
  return {
    rows,
    counts: {
      import: rows.filter((row) => row.outcome === 'import').length,
      skip: rows.filter((row) => row.outcome === 'skip').length,
      invalid: rows.filter((row) => row.outcome === 'invalid').length
    },
    computedAgainstRevision: REVISIONS
  };
}

/**
 * An `import` row carries the definition the commit writes, exactly as the
 * document declared it (FR-046a). `resourceId` and `name` are the bounded copies
 * the row renders, so they are derived from it rather than passed separately.
 */
function importRow(
  definition: ImportedPhaseDefinition,
  requiresRetryConditionCapability = false
): ImportPlanRow {
  return {
    outcome: 'import',
    resourceId: definition.phaseId,
    name: definition.name,
    requiresRetryConditionCapability,
    definition
  };
}

/** Click Import and let the mocked promise settle. */
async function inspect(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await fireEvent.click(getByTestId('process-import-inspect'));
  await tick();
  await tick();
}

/** Pick a target scope, the way the operator does (FR-056: never defaulted). */
async function chooseScope(
  getByTestId: (id: string) => HTMLElement,
  scope: string
): Promise<void> {
  await fireEvent.change(getByTestId('process-import-scope'), { target: { value: scope } });
  await tick();
}

/** Click Confirm and let the mocked save settle. */
async function confirm(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await fireEvent.click(getByTestId('process-import-confirm'));
  await tick();
  await tick();
}

beforeEach(() => {
  preflightSpy.mockReset();
  saveSpy.mockReset();
  saveSpy.mockResolvedValue({ status: 'accepted' });
});

afterEach(cleanup);

describe('Feature 084 T036 — import preflight states', () => {
  it('shows nothing but the control before the operator asks for anything', () => {
    const { container, getByTestId } = render(ProcessImportPreflight);
    expect(getByTestId('process-import-inspect')).not.toBeNull();
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-validating"]')).toBeNull();
  });

  it('shows a non-committal progress state and no plan until validation finishes', async () => {
    let settle: (result: PreflightProcessYamlResult) => void = () => {};
    preflightSpy.mockImplementation(
      () =>
        new Promise<PreflightProcessYamlResult>((resolve) => {
          settle = resolve;
        })
    );

    const { container, getByTestId } = render(ProcessImportPreflight);
    await fireEvent.click(getByTestId('process-import-inspect'));
    await tick();

    const progress = getByTestId('process-import-validating');
    expect(progress.textContent).toContain('Reading and validating');
    // FR-055: no plan, no counts, and no outcome word while it is in flight.
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-counts"]')).toBeNull();
    expect(progress.textContent).not.toContain('Import');
    expect(progress.textContent).not.toContain('Skip');
    // The control is disabled while in flight, so a second ack cannot race the
    // first onto the same surface.
    expect((getByTestId('process-import-inspect') as HTMLButtonElement).disabled).toBe(true);

    settle({ outcome: 'planned', plan: plan([]) });
    await tick();
    await tick();
    expect(container.querySelector('[data-testid="process-import-validating"]')).toBeNull();
    expect((getByTestId('process-import-inspect') as HTMLButtonElement).disabled).toBe(false);
  });

  it('requests the phase kind and nothing else', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);
    expect(preflightSpy).toHaveBeenCalledTimes(1);
    expect(preflightSpy).toHaveBeenCalledWith('phase');
  });

  it('renders a document-level refusal with its code and message, and no plan', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'refused',
      refusal: { code: 'too-large', message: 'The document is larger than 1 MiB.' }
    });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-refusal-code').textContent).toBe('too-large');
    expect(getByTestId('process-import-refusal-message').textContent).toContain('larger than 1 MiB');
    // FR-027: a refusal produces no plan at all — not an empty one.
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-empty-plan"]')).toBeNull();
  });

  // T051/FR-057 — a code is not a stated reason. Every class an operator can hit
  // says, in prose, what was wrong and that nothing was imported.
  const REFUSAL_CODES: readonly DocumentRefusalCode[] = [
    'unreadable',
    'too-large',
    'unsupported-version',
    'unsupported-kind',
    'disallowed-syntax',
    'multi-document',
    'empty'
  ];

  for (const code of REFUSAL_CODES) {
    it(`states a reason for a ${code} refusal, not just the code`, async () => {
      preflightSpy.mockResolvedValue({
        outcome: 'refused',
        refusal: { code, message: 'The host said what specifically was wrong.' }
      });

      const { getByTestId } = render(ProcessImportPreflight);
      await inspect(getByTestId);

      expect(getByTestId('process-import-refusal-title').textContent).toContain('refused');
      expect(getByTestId('process-import-refusal-title').textContent).toContain(
        'nothing was imported'
      );
      // Prose, and specific to the class rather than a shared placeholder.
      const headline = getByTestId('process-import-refusal-headline').textContent ?? '';
      expect(headline).toBe(refusalHeadline(code));
      expect(headline.length).toBeGreaterThan('This document was not accepted.'.length - 1);
      // The host's own detail and the code both survive alongside it.
      expect(getByTestId('process-import-refusal-message').textContent).toContain(
        'what specifically was wrong'
      );
      expect(getByTestId('process-import-refusal-code').textContent).toBe(code);
    });
  }

  it('gives every refusal class its own sentence (T051)', () => {
    const headlines = REFUSAL_CODES.map((code) => refusalHeadline(code));
    expect(new Set(headlines).size).toBe(REFUSAL_CODES.length);
  });

  it('distinguishes a refused document from a canceled dialog (T051)', async () => {
    // The pair an operator must never confuse: a refusal is this build declining
    // a document it was given, a cancellation is the operator declining to give
    // one. They must not share a surface, a tone, or a reason.
    preflightSpy.mockResolvedValue({
      outcome: 'refused',
      refusal: { code: 'disallowed-syntax', message: 'An anchor is not accepted.' }
    });
    const refused = render(ProcessImportPreflight);
    await inspect(refused.getByTestId);

    const alert = refused.getByTestId('process-import-refused');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(refused.container.querySelector('[data-testid="process-import-canceled"]')).toBeNull();
    const refusedText = alert.textContent ?? '';
    cleanup();

    preflightSpy.mockResolvedValue({ outcome: 'canceled' });
    const canceled = render(ProcessImportPreflight);
    await inspect(canceled.getByTestId);

    const note = canceled.getByTestId('process-import-canceled');
    // A cancellation is not an alert, carries no refusal reason, and renders no
    // refusal element at all.
    expect(note.getAttribute('role')).toBeNull();
    expect(canceled.container.querySelector('[data-testid="process-import-refused"]')).toBeNull();
    expect(canceled.container.querySelector('[data-testid="process-import-refusal-code"]')).toBeNull();
    expect(note.textContent).not.toBe(refusedText);
    expect(note.textContent).not.toContain('refused');
  });

  it('renders an explicit empty-plan state rather than an empty table', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([]) });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-empty-plan').textContent).toContain('nothing to import');
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
  });

  it('renders id, outcome, and reason for every row, with counts (FR-054)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(
          { phaseId: 'ship-it', name: 'Ship It', version: 3, instruction: 'Ship it.' },
          true
        ),
        {
          outcome: 'skip',
          resourceId: 'specify',
          name: 'Specify',
          presentIn: 'user',
          presentRowStatus: 'invalid'
        },
        {
          outcome: 'invalid',
          resourceId: null,
          defects: [{ field: 'version', code: 'positive-integer-required', message: 'Saw "soon".' }],
          totalDefects: 1
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-counts').textContent).toContain('1 to import');
    expect(getByTestId('process-import-counts').textContent).toContain('1 skipped');
    expect(getByTestId('process-import-counts').textContent).toContain('1 invalid');

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-plan-row"]')
    ) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['import', 'skip', 'invalid']);

    const text = rows.map((row) => row.textContent ?? '');
    expect(text[0]).toContain('ship-it');
    expect(text[0]).toContain('Import');
    // Advisory only: the capability gate is re-checked at commit (FR-012a), so
    // the row must not read as already granted.
    expect(text[0]).toContain('checks separately');

    expect(text[1]).toContain('specify');
    expect(text[1]).toContain('Skip');
    // FR-030: the reason names the layer AND the row state, so an id being
    // repaired is visibly the thing that blocked the import.
    expect(text[1]).toContain('user');
    expect(text[1]).toContain('invalid');

    // An id-less resource still gets a row and states its defect (FR-025).
    expect(text[2]).toContain('no id declared');
    expect(text[2]).toContain('version: Saw "soon".');
  });

  it('says how many defects a bounded list left out', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        {
          outcome: 'invalid',
          resourceId: 'over-cap',
          defects: Array.from({ length: 20 }, (_unused, index) => ({
            field: `field-${index}`,
            code: 'bad',
            message: 'no'
          })),
          totalDefects: 25
        }
      ])
    });

    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-row-reason').textContent).toContain('5 more not shown');
  });

  it('renders document-derived text as inert content it does not interpret (FR-050)', async () => {
    // The host sanitized and bounded these strings; the component's remaining
    // job is to not interpret them. Markup, a quote that would break out of an
    // attribute, and a brace sequence a template language might expand are all
    // rendered literally.
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>{{7*7}}';
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        {
          outcome: 'invalid',
          resourceId: hostile,
          defects: [{ field: hostile, code: 'unknown-key', message: hostile }],
          totalDefects: 1
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The characters survive as text, escaped — the check that matters is that
    // none of them became markup, so no element carries an event handler.
    expect(container.innerHTML).toContain('&lt;img');
    const handlers = Array.from(container.querySelectorAll('*')).filter((element) =>
      element.getAttributeNames().some((name) => name.startsWith('on'))
    );
    expect(handlers).toEqual([]);
    // Rendered as the literal characters the document carried, unexpanded.
    expect(getByTestId('process-import-row-id').textContent).toBe(hostile);
    expect(getByTestId('process-import-row-reason').textContent).toContain('{{7*7}}');
  });

  it('reports a canceled dialog without a plan or an error', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'canceled' });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-canceled').textContent).toContain('No document was chosen');
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-failed"]')).toBeNull();
  });

  it('surfaces a host-side failure message and shows no plan', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'failed',
      message: 'Could not read the document.'
    });

    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(getByTestId('process-import-failed').textContent).toContain('Could not read the document.');
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
  });
});

// The decisions themselves are pinned in process-import-state.test.ts. What is
// asserted here is that the component is wired to them: the offered scopes, the
// gate on the control, the request the confirm sends, and the result it renders.
describe('Feature 084 T037–T040 — confirming the import', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'brought-in',
    name: 'Brought In',
    version: 7,
    instruction: 'Do the thing.'
  };
  const HELD: SavePhaseRow = { id: 'held', name: 'Held', version: 4, instruction: 'Hold.' };
  const LAYERS = Object.freeze({ user: [HELD], workspace: [] as readonly SavePhaseRow[] });

  function importable(): PreflightProcessYamlResult {
    return { outcome: 'planned', plan: plan([importRow(DEFINITION)]) };
  }

  it('offers the two writable scopes with nothing preselected (FR-035, FR-056)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const select = getByTestId('process-import-scope') as HTMLSelectElement;
    const values = Array.from(select.options, (option) => option.value);
    // The placeholder is the initial selection, so an unchosen scope is not the
    // workspace by omission. Built-in is not offered at all.
    expect(values).toEqual(['', 'user', 'workspace']);
    expect(select.value).toBe('');
    expect(values).not.toContain('built-in');
  });

  it('withholds confirmation until a scope is chosen, and says why (FR-056, FR-057)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('Choose');

    await chooseScope(getByTestId, 'user');
    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('withholds confirmation on a plan with nothing to import, and says why (FR-036)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        { outcome: 'skip', resourceId: 'specify', name: 'Specify', presentIn: 'user', presentRowStatus: 'effective' }
      ])
    });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('nothing to import');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('offers no confirmation at all for a refused document (FR-036)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'refused',
      refusal: { code: 'unsupported-kind', message: 'The document declares another kind.' }
    });
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    // A refusal produces no plan, so there is nothing to confirm — the control is
    // absent rather than present-and-dead.
    expect(container.querySelector('[data-testid="process-import-confirm"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-scope"]')).toBeNull();
  });

  it('sends the declared definition, the plan revision, and the import intent (FR-037, FR-046a)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toEqual({
      scope: 'user',
      // FR-038 — the revision the PLAN was computed against for that scope, so a
      // layer written since the preflight refuses as stale.
      expectedRevision: 'user-rev-1',
      mutation: { kind: 'import', phaseId: 'brought-in' },
      // The layer is carried across and the declared version is sent as authored.
      phases: [HELD, { id: 'brought-in', name: 'Brought In', version: 7, instruction: 'Do the thing.' }]
    });
  });

  it('gates on the chosen scope, not the one the plan was listed under', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'workspace');
    await confirm(getByTestId);

    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      scope: 'workspace',
      expectedRevision: 'workspace-rev-1',
      // The workspace layer was empty, so the import is the only row.
      phases: [{ id: 'brought-in' }]
    });
  });

  it('renders one result per plan row once the save is acked (FR-042)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        { outcome: 'skip', resourceId: 'specify', name: 'Specify', presentIn: 'user', presentRowStatus: 'effective' }
      ])
    });
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'skipped']);
    expect(rows[0].textContent).toContain('brought-in');
    // FR-046 — the origin named is the scope the operator chose.
    expect(rows[0].textContent).toContain('user');
    // The skipped row keeps the reason preflight gave it.
    expect(rows[1].textContent).toContain('Already present');
  });

  it('reports a rejected save as a failure with its reason, not as an import', async () => {
    preflightSpy.mockResolvedValue(importable());
    saveSpy.mockResolvedValue({ status: 'rejected', reason: 'stale-catalog' });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    expect(getByTestId('process-import-result-outcome').textContent).toBe('failed');
    expect(getByTestId('process-import-result-detail').textContent).toContain('stale-catalog');
  });

  it('withholds confirmation while a commit is in flight, and says why', async () => {
    preflightSpy.mockResolvedValue(importable());
    let settle: (result: SavePhasesResult) => void = () => {};
    saveSpy.mockImplementation(
      () =>
        new Promise<SavePhasesResult>((resolve) => {
          settle = resolve;
        })
    );

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('in progress');
    // A second activation cannot double-write.
    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();

    settle({ status: 'accepted' });
    await tick();
    await tick();
    expect(getByTestId('process-import-results')).not.toBeNull();
  });

  it('drops the previous result and scope choice when a new document is inspected', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);
    expect(getByTestId('process-import-results')).not.toBeNull();

    await inspect(getByTestId);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();
    // FR-056 — a target picked for one document is not carried onto the next.
    expect((getByTestId('process-import-scope') as HTMLSelectElement).value).toBe('');
    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

// The entry point the Phase manager renders, and what the operator can reach
// from a keyboard once it is open.
describe('Feature 084 T066/T067 — the entry point and its accessibility', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'brought-in',
    name: 'Brought In',
    version: 7,
    instruction: 'Do the thing.'
  };
  const LAYERS = Object.freeze({
    user: [] as readonly SavePhaseRow[],
    workspace: [] as readonly SavePhaseRow[]
  });

  function importable(): PreflightProcessYamlResult {
    return { outcome: 'planned', plan: plan([importRow(DEFINITION)]) };
  }

  it('states the manager-level reason it cannot be started, rather than only dimming (FR-057)', () => {
    const { getByTestId } = render(ProcessImportPreflight, {
      props: { disabledReason: 'This workspace is not trusted.' }
    });

    expect((getByTestId('process-import-inspect') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-unavailable').textContent).toContain('not trusted');
    // The reason is text, not only a title: a title is unavailable to anyone who
    // is not hovering.
    expect(getByTestId('process-import-inspect').getAttribute('aria-describedby')).toBe(
      'process-import-unavailable'
    );
  });

  it('sends no request when the reason arrives between render and click', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, {
      props: { disabledReason: 'A Phase save is still in progress.' }
    });

    // Activation is refused by the handler, not merely by the attribute, because
    // the parent's conditions can change after the control was rendered.
    await inspect(getByTestId);
    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('offers the control with no reason attached when an import can be started', () => {
    const { container, getByTestId } = render(ProcessImportPreflight);
    expect((getByTestId('process-import-inspect') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="process-import-unavailable"]')).toBeNull();
    expect(getByTestId('process-import-inspect').getAttribute('aria-describedby')).toBeNull();
  });

  it('names its own region so the surface is identifiable', () => {
    const { getByTestId } = render(ProcessImportPreflight);
    const labelledBy = getByTestId('process-import-preflight').getAttribute('aria-labelledby');
    expect(labelledBy).toBe('process-import-title');
    expect(document.getElementById(labelledBy!)?.textContent).toContain('Import a Phase');
  });

  it('names each table and puts the Phase id in a row header (T067)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const planTable = getByTestId('process-import-plan');
    // Two tables with the same-shaped columns; without names an operator reading
    // the second cannot tell it is the result and not the plan again.
    expect(planTable.getAttribute('aria-label')).toBe('Import plan');
    expect(planTable.getAttribute('aria-describedby')).toBe('process-import-counts');
    expect(getByTestId('process-import-counts').id).toBe('process-import-counts');
    // The subject of the row, so "import" is announced against a Phase.
    const planId = getByTestId('process-import-row-id');
    expect(planId.tagName).toBe('TH');
    expect(planId.getAttribute('scope')).toBe('row');

    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);
    expect(getByTestId('process-import-results').getAttribute('aria-label')).toBe('Import results');
    const resultId = getByTestId('process-import-result-id');
    expect(resultId.tagName).toBe('TH');
    expect(resultId.getAttribute('scope')).toBe('row');
  });

  it('announces why confirmation is withheld and links it to the reachable control (T067)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const reason = getByTestId('process-import-confirm-blocked');
    // Confirm is genuinely `disabled` — a commit in flight must not be
    // re-activatable — so it takes no focus and its description would never be
    // read on the way past. The live region is what carries the reason.
    expect(reason.getAttribute('role')).toBe('status');
    expect(reason.getAttribute('aria-live')).toBe('polite');
    expect(reason.id).toBe('process-import-confirm-reason');
    expect(getByTestId('process-import-confirm').getAttribute('aria-describedby')).toBe(
      'process-import-confirm-reason'
    );
    // The scope select IS focusable, so the same reason is reachable by keyboard.
    expect(getByTestId('process-import-scope').getAttribute('aria-describedby')).toBe(
      'process-import-confirm-reason'
    );
  });

  it('drops the description once confirmation is available', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');

    // A description pointing at an element that no longer exists is worse than
    // none: it reads as an empty explanation.
    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
    expect(getByTestId('process-import-confirm').getAttribute('aria-describedby')).toBeNull();
    expect(getByTestId('process-import-scope').getAttribute('aria-describedby')).toBeNull();
  });
});
