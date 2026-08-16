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
import type { SaveModelsImportRequest, SaveModelsImportResult } from '../../lib/save-models';
import type { SavePhaseRow, SavePhasesRequest, SavePhasesResult } from '../../lib/save-phases';
import type {
  SavePipelineRow,
  SavePipelinesRequest,
  SavePipelinesResult
} from '../../lib/save-pipelines';
import type { SaveWorkflowRow } from '../../lib/save-workflows';
import { refusalHeadline } from '../ProcessImport/process-import-state';
import type {
  ImportedPhaseDefinition,
  ImportTargetLayers
} from '../ProcessImport/process-import-state';

const preflightSpy = vi.fn<() => Promise<PreflightProcessYamlResult>>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  preflightProcessYaml: () => preflightSpy()
}));

// The commit goes through the shared savePhases helper — import adds no mutating
// IPC command of its own (research R2) — so stubbing that helper is stubbing the
// whole write path, and the request it is handed is the assertable artifact.
const saveSpy = vi.fn<(request: SavePhasesRequest) => Promise<SavePhasesResult>>();
vi.mock('../../lib/save-phases', () => ({
  savePhases: (request: SavePhasesRequest) => saveSpy(request)
}));

// Feature 085 T048 — the Pipeline half of a package commit goes through the
// Pipeline catalog's own shared helper, for the same reason: one write per layer,
// each carrying its own expected revision and its own single intent (FR-043).
const savePipelinesSpy = vi.fn<(request: SavePipelinesRequest) => Promise<SavePipelinesResult>>();
vi.mock('../../lib/save-pipelines', () => ({
  savePipelines: (request: SavePipelinesRequest) => savePipelinesSpy(request)
}));

// Feature 096 T024 — Model Catalog commits through its own single-write helper,
// never through `runImportCommit`/`savePhases` (Implementation Notes point 1),
// so it gets its own mock rather than reusing `saveSpy`.
const saveModelsImportSpy = vi.fn<
  (request: SaveModelsImportRequest) => Promise<SaveModelsImportResult>
>();
vi.mock('../../lib/save-models', () => ({
  saveModelsImport: (request: SaveModelsImportRequest) => saveModelsImportSpy(request)
}));

// Late import so the component binds to the mocked call sites above.
import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';

const REVISIONS = Object.freeze({ user: 'user-rev-1', workspace: 'workspace-rev-1' });
const PIPELINE_REVISIONS = Object.freeze({
  user: 'user-pipe-rev-1',
  workspace: 'workspace-pipe-rev-1'
});

function plan(rows: readonly ImportPlanRow[]): ImportPlan {
  return {
    rows,
    counts: {
      import: rows.filter((row) => row.outcome === 'import').length,
      skip: rows.filter((row) => row.outcome === 'skip').length,
      blocked: rows.filter((row) => row.outcome === 'blocked').length,
      invalid: rows.filter((row) => row.outcome === 'invalid').length
    },
    computedAgainstRevision: REVISIONS
  };
}

/** A plan whose Pipeline half can be written: it carries the Pipeline revision. */
function packagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstPipelineRevision: PIPELINE_REVISIONS };
}

const MODELS_REVISION = 'models-rev-1';

/**
 * A Model Catalog plan — what preflight produces for a document that declares
 * ONLY a ModelCatalog (FR-015 homogeneity). `computedAgainstModelsRevision` is
 * the one signal `isModelCatalogPlan` reads to choose the scope-less branch.
 */
function modelCatalogPlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstModelsRevision: MODELS_REVISION };
}

const MODEL_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'modelCatalog',
  resourceId: 'custom-model-a',
  backend: 'claude',
  modelId: 'custom-model-a'
};

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
    resourceKind: 'phase',
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
  savePipelinesSpy.mockReset();
  savePipelinesSpy.mockResolvedValue({ status: 'accepted' });
  saveModelsImportSpy.mockReset();
  saveModelsImportSpy.mockResolvedValue({ status: 'accepted' });
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

  it('requests nothing — not a location, and as of 085 not a kind either', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);
    expect(preflightSpy).toHaveBeenCalledTimes(1);
    // Feature 085 research R8 — the document declares its own `kind` and
    // preflight dispatches on that (FR-055a). A kind on the request would be a
    // second, unauthoritative claim about what the file is, and the only thing
    // it could do is disagree with the file.
    expect(preflightSpy).toHaveBeenCalledWith();
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
    'duplicate-id',
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
          resourceKind: 'phase',
          resourceId: 'specify',
          name: 'Specify',
          presentIn: 'user',
          presentRowStatus: 'invalid'
        },
        {
          outcome: 'invalid',
          resourceKind: 'phase',
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
          resourceKind: 'phase',
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
          resourceKind: 'phase',
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
  const LAYERS = Object.freeze({
    user: {
      phases: [HELD],
      pipelines: [] as readonly SavePipelineRow[],
      workflows: [] as readonly SaveWorkflowRow[]
    },
    workspace: {
      phases: [] as readonly SavePhaseRow[],
      pipelines: [] as readonly SavePipelineRow[],
      workflows: [] as readonly SaveWorkflowRow[]
    }
  });

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
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'specify',
          name: 'Specify',
          presentIn: 'user',
          presentRowStatus: 'effective'
        }
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
      // The single-Phase standalone document keeps `import`, which the host reads
      // differently from `import-package` when it refuses a stale save.
      mutation: { kind: 'import', phaseId: 'brought-in' },
      // The layer is carried across and the declared version is sent as authored.
      phases: [HELD, { id: 'brought-in', name: 'Brought In', version: 7, instruction: 'Do the thing.' }]
    });
    // No Pipeline row in the plan, so no Pipeline write — a layer nobody asked to
    // change must not be rewritten on its way past.
    expect(savePipelinesSpy).not.toHaveBeenCalled();
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
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'specify',
          name: 'Specify',
          presentIn: 'user',
          presentRowStatus: 'effective'
        }
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
    user: { phases: [], pipelines: [], workflows: [] } as ImportTargetLayers,
    workspace: { phases: [], pipelines: [], workflows: [] } as ImportTargetLayers
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

// Feature 085 T034 — the same surface, handed a document it did not ask to
// classify (FR-055a). What changes here is what it must SAY: a kind per row
// (FR-056), counts that add up now that `blocked` is reachable (FR-028), what
// confirming writes and where (FR-058), and an honest closed state when the plan
// needs a write this commit does not yet perform (FR-057).
//
// The wording itself is pinned in process-import-state.test.ts. These assert the
// component is wired to it — that the kind shown is the ROW's and not the
// document's, and that the statement re-reads the scope when the operator picks
// one.
describe('Feature 085 T034 — a package in the plan', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'specify',
    name: 'Specify',
    version: 2,
    instruction: 'Write the spec.'
  };

  const PIPELINE_ROW: ImportPlanRow = {
    outcome: 'import',
    resourceKind: 'pipeline',
    resourceId: 'ship-it',
    name: 'Ship It',
    definition: {
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 1,
      phaseIds: ['specify'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    }
  };

  const HELD_PIPELINE: SavePipelineRow = {
    id: 'held-pipeline',
    name: 'Held Pipeline',
    version: 2,
    phases: ['specify']
  };
  const LAYERS = Object.freeze({
    user: { phases: [], pipelines: [HELD_PIPELINE], workflows: [] } as ImportTargetLayers,
    workspace: { phases: [], pipelines: [], workflows: [] } as ImportTargetLayers
  });

  it('labels each row with the kind that row declares, not the document (FR-056)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        PIPELINE_ROW,
        {
          outcome: 'blocked',
          resourceKind: 'pipeline',
          resourceId: 'deploy-it',
          name: 'Deploy It',
          reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'finalize' } }
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const kinds = Array.from(
      container.querySelectorAll('[data-testid="process-import-row-kind"]')
    ).map((cell) => cell.textContent?.trim());
    expect(kinds).toEqual(['Phase', 'Pipeline', 'Pipeline']);

    // The machine-readable form travels with it, so a stylesheet or a later
    // assertion never has to re-derive the kind from the label.
    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-plan-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['kind'])).toEqual(['phase', 'pipeline', 'pipeline']);

    // FR-033's distinction survives the trip: the blocked Pipeline names the
    // Phase it needs, which is the thing importing something else would fix.
    expect(rows[2]?.textContent).toContain('Blocked');
    expect(rows[2]?.textContent).toContain('finalize');
  });

  // Feature 086 T038 — the third kind on the same table. Asserted through the
  // rendered plan rather than through `resourceKindLabel` alone, because the two
  // halves of the row can disagree: the label is a function of the kind and the
  // `data-kind` attribute is the raw discriminator, and a Workflow row that
  // renders "Phase" beside `data-kind="workflow"` is a surface that contradicts
  // itself about which catalog the operator is about to change.
  it('labels a Workflow row and states its blocked reason (FR-056, FR-040)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        PIPELINE_ROW,
        {
          outcome: 'blocked',
          resourceKind: 'workflow',
          resourceId: 'ship-it-flow',
          name: 'Ship It Flow',
          reason: {
            code: 'dependency-blocked',
            dependency: { kind: 'pipeline', resourceId: 'deploy-it' },
            via: { kind: 'phase', resourceId: 'finalize' }
          }
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const kinds = Array.from(
      container.querySelectorAll('[data-testid="process-import-row-kind"]')
    ).map((cell) => cell.textContent?.trim());
    expect(kinds).toEqual(['Phase', 'Pipeline', 'Workflow']);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-plan-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['kind'])).toEqual(['phase', 'pipeline', 'workflow']);

    // The reason names the Pipeline, because that is the dependency direction a
    // Workflow has. Naming the Phase here would be the shipped 085 wording
    // surviving a kind it was never written for.
    const reason = rows[2]?.querySelector('[data-testid="process-import-row-reason"]');
    expect(rows[2]?.textContent).toContain('Blocked');
    expect(reason?.textContent).toContain('Pipeline deploy-it');
  });

  it('states every count, so the four add up to the rows shown (FR-028)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        {
          outcome: 'skip',
          resourceKind: 'pipeline',
          resourceId: 'ship-it',
          name: 'Ship It',
          presentIn: 'workspace',
          presentRowStatus: 'effective'
        },
        {
          outcome: 'blocked',
          resourceKind: 'pipeline',
          resourceId: 'deploy-it',
          name: 'Deploy It',
          reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'finalize' } }
        },
        {
          outcome: 'invalid',
          resourceKind: 'pipeline',
          resourceId: 'broken',
          defects: [{ field: 'phases', code: 'non-empty-list-required', message: 'Saw none.' }],
          totalDefects: 1
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    // `blocked` was unreachable before the package resolver, so omitting it used
    // to be invisible. On this plan a missing count shows totals that do not sum
    // to the four rows on screen.
    const counts = getByTestId('process-import-counts').textContent ?? '';
    expect(counts).toContain('1 to import');
    expect(counts).toContain('1 skipped');
    expect(counts).toContain('1 blocked');
    expect(counts).toContain('1 invalid');
    expect(container.querySelectorAll('[data-testid="process-import-plan-row"]')).toHaveLength(4);
  });

  it('says what confirming writes, and names the scope once one is chosen (FR-058)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'plan',
          name: 'Plan',
          presentIn: 'user',
          presentRowStatus: 'effective'
        }
      ])
    });

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    // Before a scope is chosen the statement is still true and still says what
    // is excluded — it just cannot name a layer, and must not invent one.
    const before = getByTestId('process-import-commit-statement').textContent ?? '';
    expect(before).toContain('1 resource');
    expect(before).toContain('the scope you choose');
    expect(before).toContain('The other row is left unchanged.');
    expect(before).not.toContain('workspace');

    await chooseScope(getByTestId, 'workspace');

    const after = getByTestId('process-import-commit-statement').textContent ?? '';
    expect(after).toContain('the workspace layer');
    expect(after).toContain('nothing else');
  });

  it('stops describing a pending write once the write has happened', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([importRow(DEFINITION)]) });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    // A sentence in the future tense left standing next to the results reads as
    // a second, pending write.
    expect(getByTestId('process-import-results')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="process-import-commit-statement"]')
    ).toBeNull();
  });

  it('holds confirmation closed when the plan carries no Pipeline revision to gate on (FR-057)', async () => {
    // `plan()` — not `packagePlan()`: a Pipeline row with no
    // `computedAgainstPipelineRevision` has nothing for its write to check
    // against. Both rows are eligible, so this is NOT "nothing to import"; the
    // surface must say what is actually missing rather than letting Confirm write
    // the Phase and drop the Pipeline silently.
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([importRow(DEFINITION), PIPELINE_ROW])
    });

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    const reason = getByTestId('process-import-confirm-blocked').textContent ?? '';
    expect(reason).toContain('Pipeline catalog revision');
    expect(reason).not.toContain('nothing to import');

    await confirm(getByTestId);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(savePipelinesSpy).not.toHaveBeenCalled();
  });
});

// Feature 085 T048/T049 — what a confirmed PACKAGE does: two ordered writes into
// one chosen scope, each gated on its own layer's revision and carrying exactly
// one intent (FR-036, FR-038, FR-043), and a three-valued outcome reported with
// no compensating action (FR-042a, FR-042c).
describe('Feature 085 T048/T049 — the confirmed package write', () => {
  const PHASE: ImportedPhaseDefinition = {
    phaseId: 'specify',
    name: 'Specify',
    version: 2,
    instruction: 'Write the spec.'
  };
  const SECOND_PHASE: ImportedPhaseDefinition = {
    phaseId: 'plan',
    name: 'Plan',
    version: 1,
    instruction: 'Plan the work.'
  };
  const PIPELINE_ROW: ImportPlanRow = {
    outcome: 'import',
    resourceKind: 'pipeline',
    resourceId: 'ship-it',
    name: 'Ship It',
    definition: {
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 1,
      phaseIds: ['specify'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    }
  };
  const HELD_PHASE: SavePhaseRow = { id: 'held', name: 'Held', version: 4, instruction: 'Hold.' };
  const HELD_PIPELINE: SavePipelineRow = {
    id: 'held-pipeline',
    name: 'Held Pipeline',
    version: 2,
    phases: ['specify']
  };
  const LAYERS = Object.freeze({
    user: { phases: [HELD_PHASE], pipelines: [HELD_PIPELINE], workflows: [] } as ImportTargetLayers,
    workspace: { phases: [], pipelines: [], workflows: [] } as ImportTargetLayers
  });

  function packageResult(): PreflightProcessYamlResult {
    return {
      outcome: 'planned',
      plan: packagePlan([importRow(PHASE), importRow(SECOND_PHASE), PIPELINE_ROW])
    };
  }

  it('writes the Phase layer before the Pipeline layer (FR-038)', async () => {
    const order: string[] = [];
    saveSpy.mockImplementation(async () => {
      order.push('phases');
      return { status: 'accepted' };
    });
    savePipelinesSpy.mockImplementation(async () => {
      order.push('pipelines');
      return { status: 'accepted' };
    });
    preflightSpy.mockResolvedValue(packageResult());

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    // A Pipeline written first would reference Phases the catalog does not hold.
    expect(order).toEqual(['phases', 'pipelines']);
  });

  it('gates each layer on its OWN revision and declares one intent per write (FR-043)', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toEqual({
      scope: 'user',
      expectedRevision: 'user-rev-1',
      // Two Phases under one intent — a package is not N `import` saves, because
      // each save writes the whole layer and moves the revision the next would
      // have gated on.
      mutation: { kind: 'import-package', phaseIds: ['specify', 'plan'] },
      phases: [
        HELD_PHASE,
        { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
        { id: 'plan', name: 'Plan', version: 1, instruction: 'Plan the work.' }
      ]
    });

    expect(savePipelinesSpy).toHaveBeenCalledTimes(1);
    expect(savePipelinesSpy.mock.calls[0][0]).toEqual({
      scope: 'user',
      // The Pipeline catalog's revision, not the Phase catalog's — they move
      // independently, and cross-wiring them would gate on the wrong write.
      expectedRevision: 'user-pipe-rev-1',
      mutation: { kind: 'import-package', pipelineIds: ['ship-it'] },
      pipelines: [
        HELD_PIPELINE,
        { id: 'ship-it', name: 'Ship It', version: 1, phases: ['specify'], inputs: [], outputs: [], bindings: [], recommendedNext: [] }
      ]
    });
  });

  it('writes both layers into the one scope the operator chose (FR-036)', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'workspace');
    await confirm(getByTestId);

    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      scope: 'workspace',
      expectedRevision: 'workspace-rev-1'
    });
    expect(savePipelinesSpy.mock.calls[0][0]).toMatchObject({
      scope: 'workspace',
      expectedRevision: 'workspace-pipe-rev-1'
    });
    // The workspace layer held nothing, so each write is exactly its imports.
    expect(saveSpy.mock.calls[0][0].phases.map((row) => row.id)).toEqual(['specify', 'plan']);
    expect(savePipelinesSpy.mock.calls[0][0].pipelines.map((row) => row.id)).toEqual(['ship-it']);
  });

  it('reports every row imported when both layers are accepted', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'imported', 'imported']);
    const outcome = getByTestId('process-import-outcome');
    expect(outcome.dataset['outcome']).toBe('imported');
    expect(outcome.textContent).toContain('user');
  });

  it('reports the partial outcome exactly, and offers no undo (FR-042a, FR-042c)', async () => {
    savePipelinesSpy.mockResolvedValue({ status: 'rejected', reason: 'stale-catalog' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    // The Phase write landed and the Pipeline write did not. Each row reports its
    // OWN layer's fate — collapsing them to one verdict would either claim an
    // unwritten Pipeline or disown two written Phases.
    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'imported', 'failed']);
    expect(rows[2].textContent).toContain('stale-catalog');

    const outcome = getByTestId('process-import-outcome');
    expect(outcome.dataset['outcome']).toBe('partial');
    // FR-042c — nothing is rolled back, and no control is offered that would.
    expect(container.querySelector('[data-testid="process-import-undo"]')).toBeNull();
    // FR-042b — the recovery named is re-running the same document, which skips
    // what is already there.
    expect(outcome.textContent).toContain('again');
  });

  it('does not send the Pipeline write when the Phase write is rejected', async () => {
    saveSpy.mockResolvedValue({ status: 'rejected', reason: 'stale-catalog' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await chooseScope(getByTestId, 'user');
    await confirm(getByTestId);

    // A Pipeline whose Phases were never written would reference absent rows.
    expect(savePipelinesSpy).not.toHaveBeenCalled();
    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['failed', 'failed', 'failed']);
    // The Pipeline row was never attempted, so it must not borrow the Phase
    // layer's reason and send the operator to fix the wrong thing.
    expect(rows[2].textContent).toContain('stopped before this layer');
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('failed');
  });
});

// Feature 096 T024 — wiring the modelCatalog branch: no scope selector, and
// confirm dispatches through `saveModelsImport`, never `savePhases`.
describe('Feature 096 T024 — the Model Catalog branch (FR-015, FR-056)', () => {
  it('names Model Catalog among the accepted document kinds', () => {
    render(ProcessImportPreflight);
    expect(document.getElementById('process-import-title')?.textContent).toContain('Model Catalog');
  });

  it('renders no scope selector, and confirms without one chosen (FR-056)', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: modelCatalogPlan([MODEL_IMPORT_ROW]) });
    const { container, getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect(container.querySelector('[data-testid="process-import-scope"]')).toBeNull();
    // Nothing left to choose, so nothing blocks confirmation.
    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
  });

  it('states what confirming will do without naming a scope or layer (FR-058)', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: modelCatalogPlan([MODEL_IMPORT_ROW]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    const statement = getByTestId('process-import-commit-statement').textContent ?? '';
    expect(statement).toContain('model catalog');
    expect(statement).not.toContain('chosen scope');
  });

  it('holds confirmation closed on a plan carrying no Model Catalog revision, and says why', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([MODEL_IMPORT_ROW]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('Model Catalog revision');
  });

  it('sends the delta grouped by backend, the plan revision, and the import-package intent', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: modelCatalogPlan([MODEL_IMPORT_ROW]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(saveModelsImportSpy).toHaveBeenCalledTimes(1);
    expect(saveModelsImportSpy.mock.calls[0][0]).toEqual({
      models: { claude: ['custom-model-a'] },
      expectedRevision: MODELS_REVISION,
      mutation: { kind: 'import-package' }
    });
    // Model Catalog's single write must not fall through to the Phase path.
    expect(saveSpy).not.toHaveBeenCalled();
    expect(savePipelinesSpy).not.toHaveBeenCalled();
  });

  it('renders the Model Catalog outcome sentence, not the layered one (FR-042a)', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: modelCatalogPlan([MODEL_IMPORT_ROW]) });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);
    await confirm(getByTestId);

    const outcome = getByTestId('process-import-outcome');
    expect(outcome.dataset['outcome']).toBe('imported');
    expect(outcome.textContent).toContain('added to the catalog');
    const row = getByTestId('process-import-result-row');
    expect(row.dataset['outcome']).toBe('imported');
    expect(row.textContent).toContain('claude');
  });

  it('reports a rejected save as failed, with the recovery detail for a stale catalog', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: modelCatalogPlan([MODEL_IMPORT_ROW]) });
    saveModelsImportSpy.mockResolvedValue({ status: 'rejected', reason: 'stale-catalog' });
    const { getByTestId } = render(ProcessImportPreflight);
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('failed');
    expect(getByTestId('process-import-result-outcome').textContent).toBe('failed');
    expect(getByTestId('process-import-result-detail').textContent).toContain('inspect it again');
  });
});
