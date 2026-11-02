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

const publishSpy = vi.fn<(request: PackagePublishRequest) => Promise<LifecycleResult>>();
let lastWait: { readonly onLateOutcome?: (late: LifecycleResult) => void } | undefined;
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  publishDefinitionPackage: (
    request: PackagePublishRequest,
    _unused?: unknown,
    wait?: { readonly onLateOutcome?: (late: LifecycleResult) => void }
  ) => {
    lastWait = wait;
    return publishSpy(request);
  }
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

const saveModelsImportSpy = vi.fn<
  (request: SaveModelsImportRequest) => Promise<SaveModelsImportResult>
>();
vi.mock('../../lib/save-models', () => ({
  saveModelsImport: (request: SaveModelsImportRequest) => saveModelsImportSpy(request)
}));

// Late import so the component binds to the mocked call sites above.
import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';

const REVISION = 'phase-rev-1';
const WORKFLOW_REVISION = 'workflow-rev-1';

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

/** A plan whose Workflow half can be written: it carries the Workflow revision. */
function packagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstWorkflowRevision: WORKFLOW_REVISION };
}

const MODELS_REVISION = 'models-rev-1';

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
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-counts"]')).toBeNull();
    expect(progress.textContent).not.toContain('Import');
    expect(progress.textContent).not.toContain('Skip');
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
    expect(container.querySelector('[data-testid="process-import-plan"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-import-empty-plan"]')).toBeNull();
  });

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
      const headline = getByTestId('process-import-refusal-headline').textContent ?? '';
      expect(headline).toBe(refusalHeadline(code));
      expect(headline.length).toBeGreaterThan('This document was not accepted.'.length - 1);
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
    expect(text[0]).toContain('checks separately');

    expect(text[1]).toContain('specify');
    expect(text[1]).toContain('Skip');
    expect(text[1]).toContain('invalid');
    expect(text[1]).not.toContain('user');

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
    expect(container.innerHTML).toContain('&lt;img');
    const handlers = Array.from(container.querySelectorAll('*')).filter((element) =>
      element.getAttributeNames().some((name) => name.startsWith('on'))
    );
    expect(handlers).toEqual([]);
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
    workflows: [] as readonly SaveWorkflowRow[]
  });

  function importable(): PreflightProcessYamlResult {
    return { outcome: 'planned', plan: plan([importRow(DEFINITION)]) };
  }

  it('offers no target picker at all (T496f, FR-035, FR-056)', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, {
      props: { layers: LAYERS }
    });
    await inspect(getByTestId);

    expect(container.querySelector('[data-testid="process-import-scope"]')).toBeNull();
  });

  it('opens confirmation the moment the plan has something to import (FR-056, FR-057)', async () => {
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
          expectedRevision: REVISION,
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
    expect(JSON.stringify(publishSpy.mock.calls[0][0])).not.toContain(HELD.id);
    expect(layerFor('workflow')).toBeUndefined();
  });

  it('gates on the revision the plan carries, not on one read at confirm time', async () => {
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
    expect(rows[0].textContent).toContain('catalog');
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
    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();

    settle({ status: 'accepted' });
    await tick();
    await tick();
    expect(getByTestId('process-import-results')).not.toBeNull();
  });

  it('reports a thrown publish as a failed commit rather than latching', async () => {
    preflightSpy.mockResolvedValue(importable());
    publishSpy.mockRejectedValue(new Error('could not be cloned'));

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('failed');
    expect(getByTestId('process-import-result-detail').textContent).toContain('dispatch-failed');
    expect(getByTestId('process-import-result-detail').textContent).not.toContain('cloned');
    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
  });

  it('lets the operator retry after a thrown publish', async () => {
    preflightSpy.mockResolvedValue(importable());
    publishSpy.mockRejectedValueOnce(new Error('could not be cloned'));

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('failed');

    await inspect(getByTestId);
    await confirm(getByTestId);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('imported');
  });

  it('drops the previous result when a new document is inspected', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);
    expect(getByTestId('process-import-results')).not.toBeNull();

    await inspect(getByTestId);
    expect(container.querySelector('[data-testid="process-import-results"]')).toBeNull();
    expect(getByTestId('process-import-commit-statement')).not.toBeNull();
  });
});

describe('Feature 084 T066/T067 — the entry point and its accessibility', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'brought-in',
    name: 'Brought In',
    version: 7,
    instruction: 'Do the thing.'
  };
  const LAYERS: ImportTargetLayers = Object.freeze({ phases: [], workflows: [] });

  function importable(): PreflightProcessYamlResult {
    return { outcome: 'planned', plan: plan([importRow(DEFINITION)]) };
  }

  it('states the manager-level reason it cannot be started, rather than only dimming (FR-057)', () => {
    const { getByTestId } = render(ProcessImportPreflight, {
      props: { disabledReason: 'This workspace is not trusted.' }
    });

    expect((getByTestId('process-import-inspect') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-import-unavailable').textContent).toContain('not trusted');
    expect(getByTestId('process-import-inspect').getAttribute('aria-describedby')).toBe(
      'process-import-unavailable'
    );
  });

  it('sends no request when the reason arrives between render and click', async () => {
    preflightSpy.mockResolvedValue(importable());
    const { getByTestId } = render(ProcessImportPreflight, {
      props: { disabledReason: 'A Phase save is still in progress.' }
    });

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
    expect(planTable.getAttribute('aria-label')).toBe('Import plan');
    expect(planTable.getAttribute('aria-describedby')).toBe('process-import-counts');
    expect(getByTestId('process-import-counts').id).toBe('process-import-counts');
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
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        {
          outcome: 'import',
          resourceKind: 'workflow',
          resourceId: 'ship-it',
          name: 'Ship It',
          definition: {
            workflowId: 'ship-it',
            name: 'Ship It',
            version: 1,
            nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
            connections: [],
            startNodeIds: ['specify']
          }
        }
      ])
    });
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    const reason = getByTestId('process-import-confirm-blocked');
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

    expect(container.querySelector('[data-testid="process-import-confirm-blocked"]')).toBeNull();
    expect(getByTestId('process-import-confirm').getAttribute('aria-describedby')).toBeNull();
  });
});

describe('Feature 085 T034 — a package in the plan', () => {
  const DEFINITION: ImportedPhaseDefinition = {
    phaseId: 'specify',
    name: 'Specify',
    version: 2,
    instruction: 'Write the spec.'
  };

  const WORKFLOW_ROW: ImportPlanRow = {
    outcome: 'import',
    resourceKind: 'workflow',
    resourceId: 'ship-it',
    name: 'Ship It',
    definition: {
      workflowId: 'ship-it',
      name: 'Ship It',
      version: 1,
      nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
      connections: [],
      startNodeIds: ['specify']
    }
  };

  const HELD_WORKFLOW: SaveWorkflowRow = {
    workflowId: 'held-workflow',
    name: 'Held Workflow',
    version: 2,
    nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
    connections: [],
    startNodeIds: ['specify']
  };
  const LAYERS: ImportTargetLayers = Object.freeze({
    phases: [],
    workflows: [HELD_WORKFLOW]
  });

  it('labels each row with the kind that row declares, not the document (FR-056)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        WORKFLOW_ROW,
        {
          outcome: 'blocked',
          resourceKind: 'workflow',
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
    expect(kinds).toEqual(['Phase', 'Workflow', 'Workflow']);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-plan-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['kind'])).toEqual(['phase', 'workflow', 'workflow']);

    expect(rows[2]?.textContent).toContain('Blocked');
    expect(rows[2]?.textContent).toContain('finalize');
  });

  it('labels a composable Workflow row and states its blocked reason (FR-056, FR-040)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        WORKFLOW_ROW,
        {
          outcome: 'blocked',
          resourceKind: 'workflow',
          resourceId: 'ship-it-flow',
          name: 'Ship It Flow',
          reason: {
            code: 'dependency-blocked',
            dependency: { kind: 'workflow', resourceId: 'deploy-it' },
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
    expect(kinds).toEqual(['Phase', 'Workflow', 'Workflow']);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-plan-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['kind'])).toEqual(['phase', 'workflow', 'workflow']);

    const reason = rows[2]?.querySelector('[data-testid="process-import-row-reason"]');
    expect(rows[2]?.textContent).toContain('Blocked');
    expect(reason?.textContent).toContain('Workflow deploy-it');
  });

  it('states every count, so the four add up to the rows shown (FR-028)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([
        importRow(DEFINITION),
        {
          outcome: 'skip',
          resourceKind: 'workflow',
          resourceId: 'ship-it',
          name: 'Ship It',
          presentRowStatus: 'effective'
        },
        {
          outcome: 'blocked',
          resourceKind: 'workflow',
          resourceId: 'deploy-it',
          name: 'Deploy It',
          reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'finalize' } }
        },
        {
          outcome: 'invalid',
          resourceKind: 'workflow',
          resourceId: 'broken',
          defects: [{ field: 'nodes', code: 'non-empty-list-required', message: 'Saw none.' }],
          totalDefects: 1
        }
      ])
    });

    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

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

    expect(getByTestId('process-import-results')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="process-import-commit-statement"]')
    ).toBeNull();
  });

  it('holds confirmation closed when the plan carries no Workflow revision to gate on (FR-057)', async () => {
    preflightSpy.mockResolvedValue({
      outcome: 'planned',
      plan: plan([importRow(DEFINITION), WORKFLOW_ROW])
    });

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);

    expect((getByTestId('process-import-confirm') as HTMLButtonElement).disabled).toBe(true);
    const reason = getByTestId('process-import-confirm-blocked').textContent ?? '';
    expect(reason).toContain('Workflow catalog revision');
    expect(reason).not.toContain('nothing to import');

    await confirm(getByTestId);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

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
  const WORKFLOW_ROW: ImportPlanRow = {
    outcome: 'import',
    resourceKind: 'workflow',
    resourceId: 'ship-it',
    name: 'Ship It',
    definition: {
      workflowId: 'ship-it',
      name: 'Ship It',
      version: 1,
      nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
      connections: [],
      startNodeIds: ['specify']
    }
  };
  const HELD_PHASE: SavePhaseRow = { id: 'held', name: 'Held', version: 4, instruction: 'Hold.' };
  const HELD_WORKFLOW: SaveWorkflowRow = {
    workflowId: 'held-workflow',
    name: 'Held Workflow',
    version: 2,
    nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
    connections: [],
    startNodeIds: ['specify']
  };
  const LAYERS: ImportTargetLayers = Object.freeze({
    phases: [HELD_PHASE],
    workflows: [HELD_WORKFLOW]
  });

  function packageResult(): PreflightProcessYamlResult {
    return {
      outcome: 'planned',
      plan: packagePlan([importRow(PHASE), importRow(SECOND_PHASE), WORKFLOW_ROW])
    };
  }

  it('sends a payload the host transport can actually clone', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const cloneFailures: string[] = [];
    publishSpy.mockImplementation(async (request) => {
      try {
        structuredClone(request);
      } catch (err) {
        cloneFailures.push((err as Error).message);
      }
      return { status: 'accepted' };
    });

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(cloneFailures).toEqual([]);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('imported');
  });

  it('sends the Phase layer and the Workflow layer in one request, Phase first (FR-013, FR-038)', async () => {
    preflightSpy.mockResolvedValue(packageResult());

    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(layersSent().map((layer) => layer.kind)).toEqual(['phase', 'workflow']);
  });

  it('gates each layer on its OWN revision, naming only the ids it writes (FR-043)', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0]).toEqual({
      layers: [
        {
          kind: 'phase',
          expectedRevision: REVISION,
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
        },
        {
          kind: 'workflow',
          expectedRevision: WORKFLOW_REVISION,
          definitions: [
            {
              id: 'ship-it',
              body: {
                workflowId: 'ship-it',
                name: 'Ship It',
                version: 1,
                nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
                connections: [],
                startNodeIds: ['specify']
              }
            }
          ]
        }
      ]
    });
  });

  it('writes both kinds naming only what the document declared (FR-036, FR-039a)', async () => {
    preflightSpy.mockResolvedValue(packageResult());
    const { getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(layerFor('phase')).not.toHaveProperty('scope');
    expect(layerFor('workflow')).not.toHaveProperty('scope');
    expect(layerFor('phase')?.definitions.map((row) => row.id)).toEqual(['specify', 'plan']);
    expect(layerFor('workflow')?.definitions.map((row) => row.id)).toEqual(['ship-it']);
    expect(JSON.stringify(layersSent())).not.toContain(HELD_PHASE.id);
    expect(JSON.stringify(layersSent())).not.toContain(HELD_WORKFLOW.workflowId);
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
    ackWith({
      status: 'rejected',
      reason: 'package-partial',
      result: {
        published: [{ kind: 'phase', total: 2 }],
        draftedOnly: ['workflow'],
        failedKind: 'workflow',
        cause: 'stale'
      }
    });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['imported', 'imported', 'failed']);
    expect(rows[2].textContent).toMatch(/changed since you started editing|stale-catalog/);

    const outcome = getByTestId('process-import-outcome');
    expect(outcome.dataset['outcome']).toBe('partial');
    expect(container.querySelector('[data-testid="process-import-undo"]')).toBeNull();
    expect(outcome.textContent).toContain('again');
    expect(outcome.textContent).toContain('Builder');
  });

  it('rejects every layer when the one request is refused, naming the reason on each row', async () => {
    ackWith({ status: 'rejected', reason: 'stale-catalog' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(layersSent().map((layer) => layer.kind)).toEqual(['phase', 'workflow']);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['failed', 'failed', 'failed']);
    for (const row of rows) expect(row.textContent).toMatch(/changed since you started editing|stale-catalog/);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('failed');
  });

  it('shows each validation defect on the row it belongs to (FR-014)', async () => {
    ackWith({
      status: 'rejected',
      reason: 'validation-failed',
      result: {
        defects: [
          {
            kind: 'workflow',
            id: 'ship-it',
            field: 'nodes[0].phaseId',
            code: 'unknown-phase',
            message: 'no such Phase'
          }
        ],
        total: 1
      }
    });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    const rows = Array.from(
      container.querySelectorAll('[data-testid="process-import-result-row"]')
    ) as HTMLElement[];
    expect(rows.map((row) => row.dataset['outcome'])).toEqual(['failed', 'failed', 'failed']);
    expect(rows[2].textContent).toContain('nodes[0].phaseId');
    expect(rows[2].textContent).toContain('no such Phase');
    expect(rows[0].textContent).toContain('Not written: the package was refused');
    expect(rows[1].textContent).toContain('Not written: the package was refused');
    expect(rows[0].textContent).not.toContain('nodes[0].phaseId');
  });

  it('marks every row unknown on a timeout, and a late accepted outcome then updates every row', async () => {
    ackWith({ status: 'rejected', reason: 'timeout' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    const rowOutcomes = () =>
      (
        Array.from(
          container.querySelectorAll('[data-testid="process-import-result-row"]')
        ) as HTMLElement[]
      ).map((row) => row.dataset['outcome']);
    expect(rowOutcomes()).toEqual(['unknown', 'unknown', 'unknown']);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('unknown');

    expect(lastWait?.onLateOutcome).toBeTypeOf('function');
    lastWait?.onLateOutcome?.({ status: 'accepted' });
    await tick();

    expect(rowOutcomes()).toEqual(['imported', 'imported', 'imported']);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('imported');
  });

  it('updates every row from a late partial outcome, not only the last layer', async () => {
    ackWith({ status: 'rejected', reason: 'timeout' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    lastWait?.onLateOutcome?.({
      status: 'rejected',
      reason: 'package-partial',
      result: {
        published: [{ kind: 'phase', total: 2 }],
        draftedOnly: ['workflow'],
        failedKind: 'workflow',
        cause: 'stale'
      }
    });
    await tick();

    const outcomes = (
      Array.from(container.querySelectorAll('[data-testid="process-import-result-row"]')) as HTMLElement[]
    ).map((row) => row.dataset['outcome']);
    expect(outcomes).toEqual(['imported', 'imported', 'failed']);
    expect(getByTestId('process-import-outcome').dataset['outcome']).toBe('partial');
  });

  it('ignores a late outcome once the report is no longer the unknown one', async () => {
    ackWith({ status: 'accepted' });
    preflightSpy.mockResolvedValue(packageResult());
    const { container, getByTestId } = render(ProcessImportPreflight, { props: { layers: LAYERS } });
    await inspect(getByTestId);
    await confirm(getByTestId);

    lastWait?.onLateOutcome?.({ status: 'rejected', reason: 'stale-catalog' });
    await tick();

    const outcomes = (
      Array.from(container.querySelectorAll('[data-testid="process-import-result-row"]')) as HTMLElement[]
    ).map((row) => row.dataset['outcome']);
    expect(outcomes).toEqual(['imported', 'imported', 'imported']);
  });
});

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
