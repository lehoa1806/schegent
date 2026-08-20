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
import type { LifecycleResult } from '../../lib/catalog-lifecycle';
import type {
  PackageLayer,
  PackagePublishRequest
} from '../../../../src/contracts/catalog-lifecycle';
import type {
  SavePhaseRow,
  SavePipelineRow,
  SaveWorkflowRow
} from '../../lib/definition-rows';
import { refusalHeadline } from '../ProcessImport/process-import-state';
import type {
  ImportedPhaseDefinition,
  ImportTargetLayers
} from '../ProcessImport/process-import-state';

const preflightSpy = vi.fn<() => Promise<PreflightProcessYamlResult>>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  preflightProcessYaml: () => preflightSpy()
}));

// The commit goes through the shared package publish — import adds no mutating
// IPC command of its own (research R2) — so stubbing that sender is stubbing the
// whole write path, and the layers it is handed are the assertable artifact.
//
// Feature 101 (T029) — one spy where there were three. The three per-kind `save*`
// shims each translated into exactly this call before dispatching; with them gone
// the kind travels in the layer, so `layersSent` is how a test names which write
// it is looking at. Acks are queued in send order and default to accepted.
const publishSpy = vi.fn<(request: PackagePublishRequest) => Promise<LifecycleResult>>();
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  publishDefinitionPackage: (request: PackagePublishRequest) => publishSpy(request)
}));

/** Every layer the commit sent, flattened in send order. */
function layersSent(): readonly PackageLayer[] {
  return publishSpy.mock.calls.flatMap((call) => call[0].layers);
}

/** The one layer sent for `kind`, or `undefined` if that kind was never written. */
function layerFor(kind: PackageLayer['kind']): PackageLayer | undefined {
  return layersSent().find((layer) => layer.kind === kind);
}

/** Queue the acks the sender answers with, in send order; the rest are accepted. */
function ackWith(...acks: readonly LifecycleResult[]): void {
  let call = 0;
  publishSpy.mockImplementation(async () => acks[call++] ?? { status: 'accepted' });
}

// Feature 096 T024 — Model Catalog commits through its own single-write helper,
// never through `runImportCommit`/the package publish (Implementation Notes
// point 1), so it gets its own mock rather than reusing `publishSpy`.
const saveModelsImportSpy = vi.fn<
  (request: SaveModelsImportRequest) => Promise<SaveModelsImportResult>
>();
vi.mock('../../lib/save-models', () => ({
  saveModelsImport: (request: SaveModelsImportRequest) => saveModelsImportSpy(request)
}));

// Late import so the component binds to the mocked call sites above.
import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';

// Feature 099 (T496f, FR-042, FR-044) — a map of layer to revision stood here for
// each kind, and a write picked its gate out of one of them by the scope the
// operator had chosen. One catalog per kind leaves one revision per kind.
const REVISION = 'phase-rev-1';
const PIPELINE_REVISION = 'pipeline-rev-1';

function plan(rows: readonly ImportPlanRow[]): ImportPlan {
  return {
    rows,
    counts: {
      import: rows.filter((row) => row.outcome === 'import').length,
      skip: rows.filter((row) => row.outcome === 'skip').length,
      blocked: rows.filter((row) => row.outcome === 'blocked').length,
      invalid: rows.filter((row) => row.outcome === 'invalid').length
    },
    computedAgainstRevision: REVISION
  };
}

/** A plan whose Pipeline half can be written: it carries the Pipeline revision. */
function packagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstPipelineRevision: PIPELINE_REVISION };
}

const MODELS_REVISION = 'models-rev-1';

/**
 * A Model Catalog plan — what preflight produces for a document that declares
 * ONLY a ModelCatalog (FR-015 homogeneity). `computedAgainstModelsRevision` is
 * the one signal `isModelCatalogPlan` reads to choose the Model Catalog branch.
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

/** Click Confirm and let the mocked save settle. */
async function confirm(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await fireEvent.click(getByTestId('process-import-confirm'));
  await tick();
  await tick();
}

beforeEach(() => {
  preflightSpy.mockReset();
  publishSpy.mockReset();
  publishSpy.mockResolvedValue({ status: 'accepted' });
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
    // FR-030: the reason names the row state, so an id being repaired is visibly
    // the thing that blocked the import. Feature 099 (T496f, FR-042) — it named
    // the layer too, and the layer is deleted; asserted by absence here, because
    // a sentence still naming one would be naming a tier that no longer exists.
    expect(text[1]).toContain('invalid');
    expect(text[1]).not.toContain('user');

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
// asserted here is that the component is wired to them: the gate on the control,
// the request the confirm sends, and the result it renders.
describe('Feature 084 T037–T040 — confirming the import', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'brought-in',
    name: 'Brought In',
    version: 7,
    instruction: 'Do the thing.'
  };
  const HELD: SavePhaseRow = { id: 'held', name: 'Held', version: 4, instruction: 'Hold.' };
  const LAYERS: ImportTargetLayers = Object.freeze({
    phases: [HELD],
    pipelines: [] as readonly SavePipelineRow[],
    workflows: [] as readonly SaveWorkflowRow[]
  });

  function importable(): PreflightProcessYamlResult {
    return { outcome: 'planned', plan: plan([importRow(DEFINITION)]) };
  }

  it('offers no target picker at all (T496f, FR-035, FR-056)', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this enumerated the offered scopes
    // and pinned that none was preselected, because a write had somewhere else it
    // could have gone and choosing wrongly was silent. One catalog leaves nothing
    // to enumerate, so the claim is the control's absence: reduced to a
    // single-option select it would still ask the operator a question with one
    // answer, which is the shape FR-043 deletes rather than simplifies.
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, {
      props: { layers: LAYERS }
    });
    await inspect(getByTestId);

    expect(container.querySelector('[data-testid="process-import-scope"]')).toBeNull();
  });

  it('opens confirmation the moment the plan has something to import (FR-056, FR-057)', async () => {
    // The inversion of the case above it: Confirm was held closed until a scope
    // was picked, and the surface said so. With nothing left to pick there is no
    // reason to state, so the reason element is absent rather than empty — an
    // empty live region announces nothing and reads as a missing explanation.
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, {
      props: { layers: LAYERS }
    });
    await inspect(getByTestId);

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
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
          presentRowStatus: 'effective'
        }
      ])
    });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('nothing to import');
    expect(publishSpy).not.toHaveBeenCalled();
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

  it('sends the declared definition under the plan revision (FR-037, FR-046a)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0]).toEqual({
      layers: [
        {
          kind: 'phase',
          // FR-038 — the revision the PLAN was computed against, so a catalog
          // written since the preflight refuses as stale. Feature 099 (T496f,
          // FR-042) — the request named a destination beside it; `toEqual` is
          // exact, so its absence is pinned by this assertion and not a second one.
          //
          // Feature 101 (T029) — a `mutation` naming the `import` intent stood
          // here too. It has reached no host since feature 100 routed this write
          // through the package publish, which carries ids and no intent.
          expectedRevision: REVISION,
          // Feature 100 (T509b, FR-039a) — the write carries the document's own
          // row and nothing else. It used to carry `HELD` in front of it, because
          // a save replaced the whole layer and omitting a stored row deleted it;
          // a publication names definitions, and one it does not name it leaves
          // exactly as it was (FR-039b). Carrying `HELD` now would publish a new
          // version of a definition this document never mentioned. The declared
          // version is still sent as authored (FR-046a).
          definitions: [
            {
              id: 'brought-in',
              body: {
                id: 'brought-in',
                name: 'Brought In',
                version: 7,
                instruction: 'Do the thing.'
              }
            }
          ]
        }
      ]
    });
    // `HELD` is not merely absent from the array — it has no route into the write
    // at all, so a reintroduced merge fails here rather than in one fixture.
    expect(JSON.stringify(publishSpy.mock.calls[0][0])).not.toContain(HELD.id);
    // No Pipeline row in the plan, so no Pipeline write — a layer nobody asked to
    // change must not be rewritten on its way past.
    expect(layerFor('pipeline')).toBeUndefined();
  });

  it('gates on the revision the plan carries, not on one read at confirm time', async () => {
    // Feature 099 (T496f, FR-042, FR-044) — this picked the OTHER scope and
    // pinned that the gate followed the choice rather than the listing. There is
    // no other scope; what the case was really defending is that the gate is a
    // property of the plan, so it is asked here of a plan carrying a revision no
    // fixture default would produce.
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: { ...plan([importRow(DEFINITION)]), computedAgainstRevision: 'moved-rev' }
    });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(layerFor('phase')).toMatchObject({ expectedRevision: 'moved-rev' });
    expect(layerFor('phase')).not.toHaveProperty('scope');
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
          presentRowStatus: 'effective'
        }
      ])
    });
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'skipped']);
    expect(rows[0].textContent).toContain('brought-in');
    // FR-046 — the destination named is the one catalog the write went to.
    expect(rows[0].textContent).toContain('catalog');
    // The skipped row keeps the reason preflight gave it.
    expect(rows[1].textContent).toContain('Already present');
  });

  it('reports a rejected save as a failure with its reason, not as an import', async () => {
    preflightSpy.mockResolvedValue(importable());
    ackWith({ status: 'rejected', reason: 'stale-catalog' });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(getByTestId('process-import-result-outcome').textContent).toBe('failed');
    expect(getByTestId('process-import-result-detail').textContent).toContain('stale-catalog');
  });

  it('withholds confirmation while a commit is in flight, and says why', async () => {
    preflightSpy.mockResolvedValue(importable());
    let settle: (result: LifecycleResult) => void = () => {};
    publishSpy.mockImplementation(
      () =>
        new Promise<LifecycleResult>((resolve) => {
          settle = resolve;
        })
    );

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-confirm-blocked').textContent).toContain('in progress');
    // A second activation cannot double-write.
    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();

    settle({ status: 'accepted' });
    await tick();
    await tick();
    expect(getByTestId('process-import-results')).not.toBeNull();
  });

  it('drops the previous result when a new document is inspected', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);
    expect(getByTestId('process-import-results')).not.toBeNull();

    await inspect(getByTestId);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();
    // Feature 099 (T496f, FR-056) — the target picked for one document not being
    // carried onto the next was half of this case, and there is no target to
    // carry. The other half survives whole: the surface is back to describing a
    // write that has not happened yet, rather than a finished one.
    expect(getByTestId('process-import-commit-statement')).not.toBeNull();
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
  const LAYERS: ImportTargetLayers = Object.freeze({ phases: [], pipelines: [], workflows: [] });

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

    await confirm(getByTestId);
    expect(getByTestId('process-import-results').getAttribute('aria-label')).toBe('Import results');
    const resultId = getByTestId('process-import-result-id');
    expect(resultId.tagName).toBe('TH');
    expect(resultId.getAttribute('scope')).toBe('row');
  });

  it('announces why confirmation is withheld, the live region carrying it alone (T067)', async () => {
    // Feature 099 (T496f, FR-043) — the withholding this used to provoke was "no
    // scope chosen", and the reason was ALSO the description of the scope select,
    // which took focus and could carry it. That control is gone, so the live
    // region is the whole announcement — which makes it more load-bearing than
    // before, not less, and worth provoking with a refusal that still exists.
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      // A Pipeline row on a plan carrying no Pipeline revision: eligible, so the
      // surface renders its controls, and held closed, so there is a reason to
      // announce. An empty plan would not do — it renders no Confirm at all.
      plan: plan([
        {
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
        }
      ])
    });
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
  });

  it('attaches no description once confirmation is available', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    // A description pointing at an element that no longer exists is worse than
    // none: it reads as an empty explanation.
    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
    expect(getByTestId('process-import-confirm').getAttribute('aria-describedby')).toBeNull();
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
// document's, and that the commit statement is complete before the click.
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
  const LAYERS: ImportTargetLayers = Object.freeze({
    phases: [],
    pipelines: [HELD_PIPELINE],
    workflows: []
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

  it('says what confirming writes, and names the one catalog it writes (FR-058)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'plan',
          name: 'Plan',
          presentRowStatus: 'effective'
        }
      ])
    });

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    // Feature 099 (T496f, FR-043) — the statement was read twice, before and
    // after a scope was chosen, because its destination clause changed. It has
    // one destination now and states it immediately, so what is asserted is that
    // the sentence is complete on first read: the count, the destination, and
    // what is left out, with no deferred half.
    const statement = getByTestId('process-import-commit-statement').textContent ?? '';
    expect(statement).toContain('1 resource');
    expect(statement).toContain('the catalog');
    expect(statement).toContain('nothing else');
    expect(statement).toContain('The other row is left unchanged.');
    expect(statement).not.toContain('scope');
    expect(statement).not.toContain('layer');
  });

  it('stops describing a pending write once the write has happened', async () => {
    preflightSpy.mockResolvedValue({ outcome: 'planned', plan: plan([importRow(DEFINITION)]) });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
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

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    const reason = getByTestId('process-import-confirm-blocked').textContent ?? '';
    expect(reason).toContain('Pipeline catalog revision');
    expect(reason).not.toContain('nothing to import');

    await confirm(getByTestId);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// Feature 085 T048/T049 — what a confirmed PACKAGE does: two ordered writes, each
// gated on its own catalog's revision and carrying exactly one intent
// (FR-036, FR-038, FR-043), and a three-valued outcome reported with
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
  const LAYERS: ImportTargetLayers = Object.freeze({
    phases: [HELD_PHASE],
    pipelines: [HELD_PIPELINE],
    workflows: []
  });

  function packageResult(): PreflightProcessYamlResult {
    return {
      outcome: 'planned',
      plan: packagePlan([importRow(PHASE), importRow(SECOND_PHASE), PIPELINE_ROW])
    };
  }

  it('writes the Phase layer before the Pipeline layer (FR-038)', async () => {
    preflightSpy.mockResolvedValue(packageResult());

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    // A Pipeline written first would reference Phases the catalog does not hold.
    // Two publishes, not one carrying both layers: the second is conditional on
    // the first, and one package would send them together.
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(layersSent().map((layer) => layer.kind)).toEqual(['phase', 'pipeline']);
  });

  it('gates each layer on its OWN revision, naming only the ids it writes (FR-043)', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(publishSpy.mock.calls[0][0]).toEqual({
      layers: [
        {
          kind: 'phase',
          // Two Phases in one layer — a package is not N separate saves, because
          // both are gated on the same revision, and the first accepted save
          // moves the revision the second would have gated on.
          //
          // Feature 101 (T029) — the `import-package` intent that said so
          // explicitly is gone with the whole-array request; the shared gate is
          // what carries the claim now.
          expectedRevision: REVISION,
          // Feature 100 (T509b, FR-039a) — the document's two Phases, and only
          // those. `HELD_PHASE` used to lead this array; see the standalone case
          // above for why it no longer travels.
          definitions: [
            {
              id: 'specify',
              body: { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' }
            },
            {
              id: 'plan',
              body: { id: 'plan', name: 'Plan', version: 1, instruction: 'Plan the work.' }
            }
          ]
        }
      ]
    });

    expect(publishSpy.mock.calls[1][0]).toEqual({
      layers: [
        {
          kind: 'pipeline',
          // The Pipeline catalog's revision, not the Phase catalog's — they move
          // independently, and cross-wiring them would gate on the wrong write.
          expectedRevision: PIPELINE_REVISION,
          definitions: [
            {
              id: 'ship-it',
              body: { id: 'ship-it', name: 'Ship It', version: 1, phases: ['specify'], inputs: [], outputs: [], bindings: [], recommendedNext: [] }
            }
          ]
        }
      ]
    });
  });

  it('writes both kinds naming only what the document declared (FR-036, FR-039a)', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this chose the workspace and pinned
    // that BOTH writes followed the one choice, the failure guarded against being
    // a package split across two layers. Feature 100 (T509b) — neither write can
    // name a layer OR a stored row now, and this is where that holds across two
    // kinds at once: a merge reintroduced in one kind's row builder would leave
    // the other correct, so both are asserted here in one case.
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(layerFor('phase')).not.toHaveProperty('scope');
    expect(layerFor('pipeline')).not.toHaveProperty('scope');
    expect(layerFor('phase')?.definitions.map((row) => row.id)).toEqual(['specify', 'plan']);
    expect(layerFor('pipeline')?.definitions.map((row) => row.id)).toEqual(['ship-it']);
    // The rows the catalog already holds were handed to the component and reached
    // neither write — the property, rather than these two orderings of it.
    expect(JSON.stringify(layersSent())).not.toContain(HELD_PHASE.id);
    expect(JSON.stringify(layersSent())).not.toContain(HELD_PIPELINE.id);
  });

  it('reports every row imported when both layers are accepted', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'imported', 'imported']);
    const outcome = getByTestId('process-import-outcome');
    expect(outcome.dataset['outcome']).toBe('imported');
    expect(outcome.textContent).toContain('catalog');
  });

  it('reports the partial outcome exactly, and offers no undo (FR-042a, FR-042c)', async () => {
    ackWith({ status: 'accepted' }, { status: 'rejected', reason: 'stale-catalog' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
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
    ackWith({ status: 'rejected', reason: 'stale-catalog' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    // A Pipeline whose Phases were never written would reference absent rows.
    expect(layerFor('pipeline')).toBeUndefined();
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

// Feature 096 T024 — wiring the modelCatalog branch: confirm dispatches through
// `saveModelsImport`, never the catalog lifecycle.
describe('Feature 096 T024 — the Model Catalog branch (FR-015, FR-056)', () => {
  it('names Model Catalog among the accepted document kinds', () => {
    render(ProcessImportPreflight);
    expect(document.getElementById('process-import-title')?.textContent).toContain('Model Catalog');
  });

  it('confirms with nothing withheld once the revision is carried (FR-056)', async () => {
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
    // Model Catalog's single write must not fall through to the catalog path.
    expect(publishSpy).not.toHaveBeenCalled();
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
