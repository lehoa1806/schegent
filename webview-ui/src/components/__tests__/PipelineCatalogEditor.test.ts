// Feature 082 (US1, T022) — Pipeline catalog source editor states.
//
// Mirrors PhaseCatalogEditor.test.ts. Drives the T030 rework of
// `PipelineCatalogEditor.svelte` from a name/id/sequence form into a
// source-aware Library backed by the `pipelineCatalog` projection:
//
//   - Rows come from `pipelineCatalog` records, never `availablePipelines`
//     (that list keeps its runtime-selection meaning).
//   - Every row shows its scope badge and effective/shadowed/invalid status
//     (FR-001, FR-002).
//   - Every mutating control is unavailable until the authoritative
//     projection arrives (FR-028) and while trust or an in-flight mutation
//     says otherwise (FR-029).
//   - Built-in rows are read-only with no removal affordance (FR-024).
//   - A persisted `pipelineId` is immutable; a draft requires an explicit
//     writable target scope and an id matching `^[a-z][a-z0-9-]{0,63}$`
//     that is not already taken in that scope (FR-004, FR-006, FR-007).

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineExportInclusion } from '../../lib/messages';
import type { PhaseBinding, WorkflowSnapshot } from '../../lib/snapshot-types';

// Feature 085 T022 — the exchange family's single webview call site, stubbed so
// the export control's request is observable without a host transport. The
// property is a wrapper rather than the spy itself: the factory runs while the
// component module is being evaluated, which is before `exportSpy` initialises,
// so the reference has to stay inside a body that runs at click time.
const exportSpy = vi.fn<(resourceId: string, inclusion: PipelineExportInclusion) => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportPipelineYaml: (resourceId: string, inclusion: PipelineExportInclusion) =>
    exportSpy(resourceId, inclusion)
}));

import PipelineCatalogEditor from '../PipelineBuilderEditors/PipelineCatalogEditor.svelte';
import {
  FIELD_ERROR_MESSAGE_MAX_LEN,
  makeDuplicatePipelineDraft,
  MAX_VISIBLE_FIELD_ERRORS,
  reorderPipelinePhases
} from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { MutablePhase, MutablePipeline } from '../PipelineBuilderEditors/types';

beforeEach(() => exportSpy.mockReset());
afterEach(cleanup);

const READY_CATALOG = {
  state: 'ready',
  records: [],
  effective: [],
  revisions: { user: 'u', workspace: 'w' },
  warnings: []
};

// `availablePipelines` carries a decoy the editor must never render: it is the
// runtime selection list, not the authoring catalog.
const SNAPSHOT = {
  isPrimary: true,
  availableBackends: ['claude', 'codex', 'agy'],
  availableModels: { claude: ['model-a'], codex: [], agy: [] },
  availablePipelines: [
    { id: 'runtime-only-pipeline', name: 'Runtime Only', phases: ['done'] }
  ],
  pipelineCatalog: READY_CATALOG
} as unknown as WorkflowSnapshot;

const EFFECTIVE_PHASES: MutablePhase[] = [
  {
    id: 'speckit-specify',
    name: 'Specify',
    version: 1,
    instruction: 'Write the spec.',
    sourceKey: 'speckit-specify::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  },
  {
    id: 'done',
    name: 'Done',
    version: 1,
    instruction: 'Finish.',
    sourceKey: 'done::1',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  }
];

const WORKSPACE_PIPELINE: MutablePipeline = {
  id: 'custom-flow',
  name: 'Custom Flow',
  version: 2,
  phases: ['speckit-specify', 'done'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: [],
  sourceKey: 'custom-flow::0',
  sourceStatus: 'effective',
  sourceErrors: [],
  persisted: true
};

function mount(
  options: {
    snapshot?: WorkflowSnapshot;
    pipelines?: MutablePipeline[];
    phases?: MutablePhase[];
    selectedIndex?: number | null;
    trusted?: boolean;
    savePending?: boolean;
    mutationActive?: boolean;
    editableSourceKey?: string | null;
    onpipelinechange?: (index: number, patch: Partial<MutablePipeline>) => void;
    onreset?: (index: number) => void;
    onduplicate?: (index: number) => void;
    onmovephaseup?: (index: number) => void;
    onmovephasedown?: (index: number) => void;
  } = {}
) {
  return render(PipelineCatalogEditor, {
    props: {
      snapshot: options.snapshot ?? SNAPSHOT,
      pipelines: options.pipelines ?? [],
      phases: options.phases ?? EFFECTIVE_PHASES,
      selectedIndex: options.selectedIndex ?? null,
      historyIndex: 0,
      historyLength: 1,
      newPhaseId: '',
      trusted: options.trusted ?? true,
      saveError: null,
      savePending: options.savePending ?? false,
      mutationActive: options.mutationActive ?? false,
      editableSourceKey: options.editableSourceKey ?? null,
      getPhaseTooltip: (phaseId: string) => phaseId,
      onselect: vi.fn(),
      onadd: vi.fn(),
      onremove: vi.fn(),
      onreset: options.onreset ?? vi.fn(),
      onduplicate: options.onduplicate ?? vi.fn(),
      onpipelinechange: options.onpipelinechange ?? vi.fn(),
      onphasechange: vi.fn(),
      onundo: vi.fn(),
      onredo: vi.fn(),
      onsave: vi.fn(),
      ondismisssaveerror: vi.fn(),
      onnewphaseidchange: vi.fn(),
      onaddphase: vi.fn(),
      onremovephase: vi.fn(),
      onmovephaseup: options.onmovephaseup ?? vi.fn(),
      onmovephasedown: options.onmovephasedown ?? vi.fn()
    }
  });
}

function draftRow(overrides: Partial<MutablePipeline> = {}): MutablePipeline {
  return {
    ...WORKSPACE_PIPELINE,
    id: 'new-pipeline',
    name: 'New Pipeline',
    version: 1,
    sourceKey: 'draft::new-pipeline',
    sourceStatus: 'effective',
    persisted: false,
    ...overrides
  };
}

describe('Pipeline catalog authoritative-state gating (FR-028)', () => {
  it('renders a non-authoritative loading state and no mutation toolbar', () => {
    const { container } = mount({
      snapshot: { ...SNAPSHOT, pipelineCatalog: undefined } as WorkflowSnapshot
    });
    expect(container.querySelector('[data-testid="pipeline-catalog-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pipelines-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="pipelines-save-all"]')).toBeNull();
  });

  it('renders an error state and no mutation toolbar when resolution failed', () => {
    const { container } = mount({
      snapshot: {
        ...SNAPSHOT,
        pipelineCatalog: {
          ...READY_CATALOG,
          state: 'error',
          error: { code: 'pipeline-catalog-unavailable', message: 'Catalog unavailable.' }
        }
      } as unknown as WorkflowSnapshot
    });
    expect(container.querySelector('[data-testid="pipeline-catalog-error"]')).not.toBeNull();
    expect(container.textContent).toContain('Catalog unavailable.');
    expect(container.querySelector('[data-testid="pipelines-add"]')).toBeNull();
  });

  it('disables add and save while untrusted, saving, or another mutation is in flight', () => {
    for (const gate of [
      { trusted: false },
      { savePending: true },
      { mutationActive: true }
    ] as const) {
      const { container, unmount } = mount({ pipelines: [WORKSPACE_PIPELINE], ...gate });
      const add = container.querySelector('[data-testid="pipelines-add"]') as HTMLButtonElement;
      expect(add, `pipelines-add must render for ${JSON.stringify(gate)}`).not.toBeNull();
      expect(add.disabled, `add disabled for ${JSON.stringify(gate)}`).toBe(true);
      unmount();
    }
  });
});

describe('Pipeline catalog source rendering', () => {
  it('renders rows from the projection and never from availablePipelines', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE] });
    expect(
      container.querySelector('[data-testid="pipelines-list-item-custom-flow"]')
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Runtime Only');
    expect(container.textContent).not.toContain('runtime-only-pipeline');
  });

  it('renders a source status badge for every resolution outcome', () => {
    // Feature 099 (T496f, FR-042, FR-043) — the scope badge and the `shadowed`
    // status were two halves of one answer: which layer a row came from, and
    // which layer hid it. Both are deleted. `PipelineSourceStatus` is down to
    // `effective | invalid`, and every arm of it is still rendered here — the
    // property this case exists for.
    const invalid: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      id: 'broken-flow',
      name: 'Broken Flow',
      sourceKey: 'broken-flow::1',
      sourceStatus: 'invalid',
      sourceErrors: [{ field: 'phaseIds', code: 'empty', message: 'At least one Phase required' }]
    };
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE, invalid] });
    expect(container.textContent).toContain('effective');
    expect(container.textContent).toContain('invalid');
  });

  it('associates invalid source errors with the field they describe', () => {
    const invalid: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      sourceStatus: 'invalid',
      sourceErrors: [{ field: 'name', code: 'invalid-length', message: 'Name is invalid' }]
    };
    const { container } = mount({ pipelines: [invalid], selectedIndex: 0 });
    const name = container.querySelector('[data-testid="pipelines-name-field-custom-flow"]');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(name?.getAttribute('aria-describedby')).toContain('pipeline-errors-custom-flow');
    expect(container.textContent).toContain('Name is invalid');
  });

  it('keeps a stored row editable and offers removal (T496f)', () => {
    // Feature 099 (T496f, FR-042, FR-043) — this seeded a `built-in` row and
    // pinned what the read-only tier withheld: a locked name field and no remove
    // control, with duplicate as the one way out. The tier is deleted, so the
    // inversion is the claim. The id field is the exception and keeps its own
    // case below: it is read-only because the row is PERSISTED, which is a fact
    // about identity rather than about any layer.
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    expect(
      container
        .querySelector('[data-testid="pipelines-name-field-custom-flow"]')
        ?.hasAttribute('readonly')
    ).toBe(false);
    expect(container.querySelector('[data-testid="pipelines-remove"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pipelines-duplicate"]')).not.toBeNull();
  });

  it('keeps a persisted custom pipelineId read-only (FR-007)', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    const idInput = container.querySelector(
      '[data-testid="pipelines-id-field-custom-flow"]'
    ) as HTMLInputElement;
    expect(idInput).not.toBeNull();
    expect(idInput.hasAttribute('readonly')).toBe(true);
  });
});

describe('Pipeline create path (FR-004, FR-007)', () => {
  it('offers no target-scope picker on a draft', () => {
    // Feature 099 (T496f, FR-042, FR-043) — a draft chose between the two
    // writable layers, and the picker forwarded that choice as a patch. There is
    // one catalog to land in, so the control is deleted rather than reduced to a
    // single-option select that decides nothing. Pinned by absence: a build that
    // brings the picker back fails here rather than silently offering a choice
    // the host would ignore.
    const { container } = mount({ pipelines: [draftRow()], selectedIndex: 0 });
    expect(
      container.querySelector('[data-testid="pipelines-scope-select-new-pipeline"]')
    ).toBeNull();
  });

  it('leaves the draft id editable', () => {
    const { container } = mount({ pipelines: [draftRow()], selectedIndex: 0 });
    const idInput = container.querySelector(
      '[data-testid="pipelines-id-field-new-pipeline"]'
    ) as HTMLInputElement;
    expect(idInput.hasAttribute('readonly')).toBe(false);
  });

  it.each([
    ['an empty id', ''],
    ['an uppercase id', 'CustomFlow'],
    ['a leading digit', '1flow'],
    ['an underscore', 'custom_flow'],
    ['an id over 64 characters', `a${'b'.repeat(64)}`]
  ])('blocks save on %s', (_label, id) => {
    const { container } = mount({ pipelines: [draftRow({ id })], selectedIndex: 0 });
    const save = container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('blocks save when the draft id is already taken in the catalog', () => {
    const { container } = mount({
      pipelines: [WORKSPACE_PIPELINE, draftRow({ id: 'custom-flow' })],
      selectedIndex: 1
    });
    const save = container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.textContent).toMatch(/already/i);
  });

  it('permits save once the draft carries a valid, unused id', () => {
    const { container } = mount({
      pipelines: [WORKSPACE_PIPELINE, draftRow({ id: 'release-flow' })],
      selectedIndex: 1
    });
    const save = container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});

// Feature 082 (US3, T040) — FR-019a, clarification 2.
//
// A `recommendedNext` id with no effective definition is advice about a Pipeline
// that may not exist yet — not a defect in this one. It has to be visible, but it
// must never disable save or mark a control invalid, or an operator authoring the
// two Pipelines in either order would deadlock on the first one they wrote.
describe('unresolved recommendedNext stays advisory (US3, FR-019a)', () => {
  const WARNED = {
    ...SNAPSHOT,
    pipelineCatalog: {
      ...READY_CATALOG,
      warnings: [
        {
          code: 'pipeline-recommended-next-unresolved',
          message: "Pipeline 'custom-flow' recommends 'ship-it', which has no effective definition"
        }
      ]
    }
  } as unknown as WorkflowSnapshot;

  it('surfaces the warning without blocking save or flagging a field', () => {
    const { container } = mount({
      snapshot: WARNED,
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0
    });

    const warnings = container.querySelector('[data-testid="pipeline-catalog-warnings"]');
    expect(warnings?.textContent).toContain('ship-it');
    // An advisory belongs in a polite status region, not an alert.
    expect(warnings?.getAttribute('role')).toBe('status');

    expect(
      (container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement).disabled
    ).toBe(false);
    expect(container.querySelector('[data-testid="pipeline-field-error"]')).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
  });
});

// Feature 082 (US2, T033) — reordering Phase references.
//
// A binding addresses a Phase *position*, not a bare `phaseId` (research R3),
// so every reorder must remap `phaseIndex` on both binding endpoints in the
// draft before validation runs. Without the remap a reorder would spuriously
// invalidate bindings that are still perfectly valid.
describe('Phase reference reordering (US2, FR-038)', () => {
  const THREE_PHASE_PIPELINE: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    phases: ['speckit-specify', 'done', 'speckit-specify']
  };

  it('renders the sequence in `phases` order', () => {
    const { container } = mount({ pipelines: [THREE_PHASE_PIPELINE], selectedIndex: 0 });
    const selects = [...container.querySelectorAll('.sequence-select')] as HTMLSelectElement[];
    expect(selects.map((select) => select.value)).toEqual([
      'speckit-specify',
      'done',
      'speckit-specify'
    ]);
  });

  it('exposes keyboard-operable named move controls, bounded at the ends', async () => {
    const onmovephaseup = vi.fn();
    const onmovephasedown = vi.fn();
    const { container } = mount({
      pipelines: [THREE_PHASE_PIPELINE],
      selectedIndex: 0,
      onmovephaseup,
      onmovephasedown
    });
    const up1 = container.querySelector(
      '[data-testid="pipelines-move-phase-up-1"]'
    ) as HTMLButtonElement;
    const down1 = container.querySelector(
      '[data-testid="pipelines-move-phase-down-1"]'
    ) as HTMLButtonElement;
    // Native buttons are focusable and Enter/Space activatable without extra
    // key handlers; the accessible name must say which Phase moves where.
    expect(up1.tagName).toBe('BUTTON');
    expect(up1.getAttribute('aria-label')).toBe('Move Phase 2 up');
    expect(down1.getAttribute('aria-label')).toBe('Move Phase 2 down');
    expect(
      (container.querySelector('[data-testid="pipelines-move-phase-up-0"]') as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (container.querySelector('[data-testid="pipelines-move-phase-down-2"]') as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await fireEvent.click(up1);
    await fireEvent.click(down1);
    expect(onmovephaseup).toHaveBeenCalledWith(1);
    expect(onmovephasedown).toHaveBeenCalledWith(1);
  });

  it('announces the sequence position as a text status cue (FR-038)', () => {
    const { container } = mount({ pipelines: [THREE_PHASE_PIPELINE], selectedIndex: 0 });
    const status = container.querySelector('[data-testid="pipelines-sequence-status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('3');
  });

  it('offers a named discard control that restores the pre-edit order', async () => {
    const onreset = vi.fn();
    const { container } = mount({
      pipelines: [THREE_PHASE_PIPELINE],
      selectedIndex: 0,
      onreset
    });
    const discard = container.querySelector(
      '[data-testid="pipelines-discard"]'
    ) as HTMLButtonElement;
    expect(discard).not.toBeNull();
    await fireEvent.click(discard);
    expect(onreset).toHaveBeenCalledWith(0);
  });
});

// Feature 082 (US3, T039) — bounded, sanitized, adjacent field errors.
//
// FR-017 wants a resolution failure to name the exact binding, the referenced
// port, and the reason. FR-038 wants that message beside the control it names
// and associated for assistive technology, so `aria-describedby` has to point
// at a region holding only that control's messages — not at one card-wide blob.
// FR-032 keeps every region bounded: one pathological message must not be able
// to take over the form.
describe('Pipeline field error presentation (US3, FR-017, FR-032, FR-038)', () => {
  const THREE_PHASE: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    phases: ['speckit-specify', 'done', 'speckit-specify']
  };

  /** The region a control points at, resolved through its own `aria-describedby`. */
  function describedRegion(container: HTMLElement, selector: string): HTMLElement {
    const control = container.querySelector(selector);
    expect(control, `${selector} must render`).not.toBeNull();
    const id = control?.getAttribute('aria-describedby');
    expect(id, `${selector} must name its error region`).toBeTruthy();
    const region = container.querySelector(`#${id}`) as HTMLElement | null;
    expect(region, `region ${id} must render`).not.toBeNull();
    return region as HTMLElement;
  }

  function noisyErrors(count: number, field: string) {
    return Array.from({ length: count }, (_unused, index) => ({
      field,
      code: `code-${index}`,
      message: `Problem ${index + 1}`
    }));
  }

  it('renders a per-position Phase error beside the select it names', () => {
    const row: MutablePipeline = {
      ...THREE_PHASE,
      sourceStatus: 'invalid',
      sourceErrors: [
        { field: 'phaseIds[1]', code: 'unknown-phase', message: 'Phase 2 does not resolve' }
      ]
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const named = container.querySelector('[data-testid="pipelines-phase-select-1"]');
    expect(named?.getAttribute('aria-invalid')).toBe('true');
    expect(describedRegion(container, '[data-testid="pipelines-phase-select-1"]').textContent).toContain(
      'Phase 2 does not resolve'
    );
    // A message about Phase 2 must not flag the neighbouring positions.
    for (const position of [0, 2]) {
      const other = container.querySelector(`[data-testid="pipelines-phase-select-${position}"]`);
      expect(other?.getAttribute('aria-invalid')).toBeNull();
    }
  });

  it('anchors a binding endpoint error to the Phase position it names', () => {
    // The failing endpoint is the *producer* index, so the message belongs
    // beside Phase 3's select rather than beside the consumer at Phase 2.
    const row: MutablePipeline = {
      ...THREE_PHASE,
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'draft',
          source: { from: 'phase-output', phaseIndex: 2, portId: 'spec' }
        }
      ],
      sourceStatus: 'invalid',
      sourceErrors: [
        {
          field: 'bindings[0].src.phaseIndex',
          code: 'binding-forward-reference',
          message: 'Binding 1 reads from Phase 3, which does not run before Phase 2'
        }
      ]
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const region = describedRegion(container, '[data-testid="pipelines-phase-select-2"]');
    expect(region.textContent).toContain('Binding 1 reads from Phase 3');
  });

  it('keeps an error that names no rendered control visible at the Pipeline level', () => {
    // Bindings are not authorable in the Builder yet, so a binding *port* error
    // has no control of its own — it still has to be shown, never dropped.
    const row: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      sourceStatus: 'invalid',
      sourceErrors: [
        {
          field: 'bindings[0].portId',
          code: 'binding-unknown-output-port',
          message: 'Binding 1 writes to an undeclared output port'
        }
      ]
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const region = container.querySelector(
      '[data-testid="pipelines-pipeline-errors"]'
    ) as HTMLElement | null;
    expect(region?.textContent).toContain('Binding 1 writes to an undeclared output port');
    expect(region?.textContent).toContain('bindings[0].portId');
  });

  it('bounds one error region and reports how many messages it withheld', () => {
    const overflow = 4;
    const row: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      sourceStatus: 'invalid',
      sourceErrors: noisyErrors(MAX_VISIBLE_FIELD_ERRORS + overflow, 'name')
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const region = describedRegion(container, '[data-testid="pipelines-name-field-custom-flow"]');
    expect(region.querySelectorAll('[data-testid="pipeline-field-error"]')).toHaveLength(
      MAX_VISIBLE_FIELD_ERRORS
    );
    expect(region.textContent).toContain(`${overflow} more`);
  });

  it('bounds a port error region the same way', () => {
    const overflow = 2;
    const row: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
      sourceStatus: 'invalid',
      sourceErrors: noisyErrors(MAX_VISIBLE_FIELD_ERRORS + overflow, 'inputs[0].portId')
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const region = describedRegion(container, '[data-testid="pipeline-inputs-portid-0"]');
    expect(region.querySelectorAll('[data-testid="pipeline-field-error"]')).toHaveLength(
      MAX_VISIBLE_FIELD_ERRORS
    );
    expect(region.textContent).toContain(`${overflow} more`);
  });

  it('collapses control characters and truncates an over-long message', () => {
    const filler = 'x'.repeat(FIELD_ERROR_MESSAGE_MAX_LEN * 2);
    const row: MutablePipeline = {
      ...WORKSPACE_PIPELINE,
      sourceStatus: 'invalid',
      sourceErrors: [
        { field: 'name', code: 'invalid-length', message: `Line one\n\tLine two ${filler}` }
      ]
    };
    const { container } = mount({ pipelines: [row], selectedIndex: 0 });
    const line = describedRegion(container, '[data-testid="pipelines-name-field-custom-flow"]')
      .querySelector('[data-testid="pipeline-field-error"]') as HTMLElement;
    const rendered = line.textContent ?? '';
    expect(rendered).toContain('Line one Line two');
    expect(rendered).not.toMatch(/[\n\t]/);
    expect(rendered).not.toContain(filler);
    expect(rendered.length).toBeLessThanOrEqual(FIELD_ERROR_MESSAGE_MAX_LEN);
  });

  it('blocks save on a draft error but still lets an invalid persisted row be repaired', () => {
    const blank = mount({ pipelines: [{ ...WORKSPACE_PIPELINE, name: '   ' }], selectedIndex: 0 });
    expect(
      (blank.container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement)
        .disabled
    ).toBe(true);
    blank.unmount();

    // `sourceErrors` describe the record as last persisted and do not clear
    // until the host reprojects, so blocking on them would trap the operator
    // inside the very row they came to repair.
    const repairable = mount({
      pipelines: [
        {
          ...WORKSPACE_PIPELINE,
          sourceStatus: 'invalid',
          sourceErrors: [
            { field: 'phaseIds[0]', code: 'unknown-phase', message: 'Phase 1 does not resolve' }
          ]
        }
      ],
      selectedIndex: 0
    });
    expect(
      (repairable.container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});

describe('reorderPipelinePhases — binding index remap (research R3)', () => {
  const BINDINGS: PhaseBinding[] = [
    // Phase 2 consumes the output of Phase 0.
    {
      kind: 'input',
      phaseIndex: 2,
      inputKey: 'draft',
      source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
    },
    // Phase 1 consumes a Pipeline-level input — unaffected by any reorder.
    {
      kind: 'input',
      phaseIndex: 1,
      inputKey: 'brief',
      source: { from: 'pipeline-input', portId: 'request' }
    },
    { kind: 'output', phaseIndex: 2, portId: 'plan', outputKey: 'plan' }
  ];
  const PIPELINE: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    phases: ['a', 'b', 'c'],
    bindings: BINDINGS
  };

  it('moves a Phase up and shifts the displaced neighbour down', () => {
    const moved = reorderPipelinePhases(PIPELINE, 2, 1);
    expect(moved.phases).toEqual(['a', 'c', 'b']);
  });

  it('moves a Phase down', () => {
    const moved = reorderPipelinePhases(PIPELINE, 0, 1);
    expect(moved.phases).toEqual(['b', 'a', 'c']);
  });

  it('remaps every binding endpoint so a valid binding stays valid', () => {
    // 'c' (index 2) moves to the front: owners 2 → 0, and the producer at 0 → 1.
    const moved = reorderPipelinePhases(PIPELINE, 2, 0);
    expect(moved.phases).toEqual(['c', 'a', 'b']);
    expect(moved.bindings).toEqual([
      {
        kind: 'input',
        phaseIndex: 0,
        inputKey: 'draft',
        source: { from: 'phase-output', phaseIndex: 1, portId: 'spec' }
      },
      {
        kind: 'input',
        phaseIndex: 2,
        inputKey: 'brief',
        source: { from: 'pipeline-input', portId: 'request' }
      },
      { kind: 'output', phaseIndex: 0, portId: 'plan', outputKey: 'plan' }
    ]);
  });

  it('leaves the source row untouched and returns a fresh binding list', () => {
    const moved = reorderPipelinePhases(PIPELINE, 0, 2);
    expect(PIPELINE.phases).toEqual(['a', 'b', 'c']);
    expect(PIPELINE.bindings[0]).toEqual(BINDINGS[0]);
    expect(moved.bindings).not.toBe(PIPELINE.bindings);
  });

  it('is a no-op for an out-of-range or identical position', () => {
    for (const [from, to] of [
      [0, 0],
      [-1, 1],
      [1, 3],
      [3, 0]
    ]) {
      const moved = reorderPipelinePhases(PIPELINE, from, to);
      expect(moved.phases).toEqual(['a', 'b', 'c']);
      expect(moved.bindings).toEqual(BINDINGS);
    }
  });
});

// Feature 082 (US4, T046) — the duplicate path.
//
// A persisted `pipelineId` is immutable (FR-007), so duplicating is the only
// route from an existing Pipeline to a new identity. The copy therefore has to
// arrive with an id nobody has taken and an editable id control, everything
// else the operator authored already filled in, and — because it is a distinct
// definition rather than a revision of the original — its own `version` at 1
// (FR-006). The source row must come out of it untouched, including through
// the nested collections a shallow copy would alias.
describe('Pipeline duplicate path (US4, FR-006, FR-007)', () => {
  const SOURCE: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    version: 7,
    description: 'Original description',
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
    outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }],
    bindings: [
      {
        kind: 'input',
        phaseIndex: 0,
        inputKey: 'brief',
        source: { from: 'pipeline-input', portId: 'brief' }
      }
    ] as PhaseBinding[],
    executionDefaults: { runner: 'claude', model: 'model-a' },
    recommendedNext: ['ship-it']
  };

  it('gives the copy an id no existing row holds, and leaves it editable', () => {
    const copy = makeDuplicatePipelineDraft(SOURCE, [SOURCE]);

    expect(copy.id).not.toBe(SOURCE.id);
    expect([SOURCE].some((row) => row.id === copy.id)).toBe(false);
    expect(copy.persisted).toBe(false);

    const { container } = mount({ pipelines: [copy], selectedIndex: 0 });
    const idInput = container.querySelector(
      `[data-testid="pipelines-id-field-${copy.id}"]`
    ) as HTMLInputElement;
    expect(idInput).not.toBeNull();
    expect(idInput.hasAttribute('readonly')).toBe(false);
  });

  it('keeps stepping the candidate id until it clears the catalog', () => {
    const taken = [
      SOURCE,
      { ...SOURCE, id: 'custom-flow-copy', sourceKey: 'custom-flow-copy::0' },
      { ...SOURCE, id: 'custom-flow-copy-1', sourceKey: 'custom-flow-copy-1::1' }
    ] as MutablePipeline[];

    expect(makeDuplicatePipelineDraft(SOURCE, taken).id).toBe('custom-flow-copy-2');
  });

  it('starts the copy at version 1 rather than continuing the source lineage (FR-006)', () => {
    expect(makeDuplicatePipelineDraft(SOURCE, [SOURCE]).version).toBe(1);
    expect(SOURCE.version).toBe(7);
  });

  it('prefills every other authored field, and renders them in the form', () => {
    const copy = makeDuplicatePipelineDraft(SOURCE, [SOURCE]);

    expect(copy).toMatchObject({
      name: 'Custom Flow (Copy)',
      description: 'Original description',
      phases: SOURCE.phases,
      inputs: SOURCE.inputs,
      outputs: SOURCE.outputs,
      bindings: SOURCE.bindings,
      executionDefaults: SOURCE.executionDefaults,
      recommendedNext: SOURCE.recommendedNext
    });

    const { container } = mount({ pipelines: [copy], selectedIndex: 0 });
    expect(
      (container.querySelector(`[data-testid="pipelines-name-field-${copy.id}"]`) as HTMLInputElement)
        .value
    ).toBe('Custom Flow (Copy)');
    expect(
      (container.querySelector(`[data-testid="pipelines-description-${copy.id}"]`) as HTMLTextAreaElement)
        .value
    ).toBe('Original description');
    expect(container.querySelector('[data-testid="pipelines-sequence-status"]')?.textContent).toContain(
      '1. speckit-specify, 2. done'
    );
  });

  it('leaves the source row untouched, including through the nested collections', () => {
    const before = structuredClone({
      ...SOURCE,
      inputs: [...SOURCE.inputs],
      outputs: [...SOURCE.outputs],
      bindings: [...SOURCE.bindings]
    });
    const copy = makeDuplicatePipelineDraft(SOURCE, [SOURCE]);

    copy.phases.push('speckit-plan');
    copy.inputs.push({ portId: 'extra', label: 'Extra', type: 'text' });
    copy.outputs.length = 0;
    copy.bindings.push({ kind: 'output', phaseIndex: 1, portId: 'x', outputKey: 'x' });
    copy.recommendedNext.push('another');

    expect(SOURCE).toEqual(before);
    // `executionDefaults` is readonly at the type level, so aliasing can only be
    // caught by identity — a shallow spread would hand back the same object.
    expect(copy.executionDefaults).not.toBe(SOURCE.executionDefaults);
    expect(copy.executionDefaults).toEqual(SOURCE.executionDefaults);
  });

  it('gives the copy its own draft key and clears the source projection', () => {
    // Feature 099 (T496f, FR-042, FR-043) — the copy used to be RETARGETED: a
    // `built-in` source produced a `workspace` draft, because the layer it came
    // from could not be written. One layer removes the retargeting and leaves
    // what duplication still has to do — hand the copy an identity of its own and
    // drop the projection metadata that belonged to the row it was copied from.
    const copy = makeDuplicatePipelineDraft(SOURCE, [SOURCE]);

    expect(copy.id).not.toBe(SOURCE.id);
    expect(copy.sourceKey).toBe(`draft::${copy.id}`);
    expect(copy.persisted).toBe(false);
    expect(copy.sourceStatus).toBe('effective');
    expect(copy.sourceErrors).toEqual([]);
  });

  it('forwards the selected row to the duplicate handler', async () => {
    const onduplicate = vi.fn();
    const { container } = mount({
      pipelines: [draftRow(), SOURCE],
      selectedIndex: 1,
      onduplicate
    });

    await fireEvent.click(container.querySelector('[data-testid="pipelines-duplicate"]')!);

    expect(onduplicate).toHaveBeenCalledWith(1);
  });

  it('withholds the duplicate control while untrusted, saving, or mid-mutation (FR-029)', () => {
    for (const gate of [{ trusted: false }, { savePending: true }, { mutationActive: true }] as const) {
      const { container, unmount } = mount({
        pipelines: [WORKSPACE_PIPELINE],
        selectedIndex: 0,
        ...gate
      });
      expect(
        container.querySelector('[data-testid="pipelines-duplicate"]')?.hasAttribute('disabled')
      ).toBe(true);
      unmount();
    }
  });
});

// Feature 082 (US6, T049) — the empty-Phase-prerequisite state.
//
// A Pipeline is an ordered sequence of Phases, so with no effective Phase there
// is nothing a Pipeline could be composed of. The Builder still opens — the
// catalog resolved fine and the operator may want to read existing rows — but
// every control that would produce an unsatisfiable draft has to be visibly
// unavailable, and the reason has to be readable text rather than a disabled
// button the operator is left to interpret (FR-034, SC-007).
describe('Pipeline empty-Phase-prerequisite state (US6, FR-034, SC-007)', () => {
  const mountNoPhases = (options: Parameters<typeof mount>[0] = {}) =>
    mount({ ...options, phases: [] });

  it('explains the missing prerequisite as text, not as a bare disabled control', () => {
    const { container } = mountNoPhases();
    const notice = container.querySelector('[data-testid="pipelines-no-phases"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent ?? '').toMatch(/Phase/i);
    expect((notice?.textContent ?? '').length).toBeGreaterThan(20);
  });

  it('disables add and save while no effective Phase exists', () => {
    const { container } = mountNoPhases();
    expect(
      (container.querySelector('[data-testid="pipelines-add"]') as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (container.querySelector('[data-testid="pipelines-save-all"]') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('leaves no enabled control that would author an unsatisfiable draft', () => {
    const { container } = mountNoPhases({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    for (const testId of [
      'pipelines-add',
      'pipelines-save-all',
      'pipelines-duplicate',
      'pipelines-add-phase'
    ]) {
      const control = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
      expect(control === null || control.disabled, `${testId} must not be enabled`).toBe(true);
    }
    // The append picker offers nothing, so it must not invite a selection.
    const picker = container.querySelector(
      '[data-testid="pipelines-new-phase"]'
    ) as HTMLSelectElement | null;
    expect(picker === null || picker.disabled).toBe(true);
  });

  it('still renders existing rows read-only rather than hiding the catalog', () => {
    const { container } = mountNoPhases({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    expect(
      container.querySelector('[data-testid="pipelines-list-item-custom-flow"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="pipelines-editor-custom-flow"]')).not.toBeNull();
  });

  it('keeps every control available once at least one effective Phase exists', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    expect(container.querySelector('[data-testid="pipelines-no-phases"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="pipelines-add"]') as HTMLButtonElement).disabled
    ).toBe(false);
  });
});

// FR-002 — the Library shows what a change would affect. The list is
// host-resolved (`consumingWorkflowIds` on the matching projection record), not
// derived in the webview, so it always agrees with the removal gate.
describe('Consuming Workflows list (FR-002)', () => {
  function snapshotWithConsumers(
    consumingWorkflowIds?: readonly string[]
  ): WorkflowSnapshot {
    return {
      ...SNAPSHOT,
      pipelineCatalog: {
        ...READY_CATALOG,
        records: [
          {
            key: WORKSPACE_PIPELINE.sourceKey,
            pipelineId: WORKSPACE_PIPELINE.id,
            status: 'effective',
            definition: null,
            display: {},
            errors: [],
            ...(consumingWorkflowIds !== undefined ? { consumingWorkflowIds } : {})
          }
        ]
      }
    } as unknown as WorkflowSnapshot;
  }

  function consumerItems(container: HTMLElement): string[] {
    const region = container.querySelector(
      `[data-testid="pipelines-consuming-workflows-${WORKSPACE_PIPELINE.id}"]`
    );
    return [...(region?.querySelectorAll('li') ?? [])].map((li) => li.textContent ?? '');
  }

  it('renders the host-resolved consuming Workflow ids for the selected Pipeline', () => {
    const { container } = mount({
      snapshot: snapshotWithConsumers(['wf-a', 'wf-z']),
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0
    });
    expect(consumerItems(container)).toEqual(['wf-a', 'wf-z']);
  });

  it('renders the section empty when the host reports no consumers', () => {
    const { container } = mount({
      snapshot: snapshotWithConsumers(),
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0
    });
    expect(
      container.querySelector(
        `[data-testid="pipelines-consuming-workflows-${WORKSPACE_PIPELINE.id}"]`
      )
    ).not.toBeNull();
    expect(consumerItems(container)).toEqual([]);
  });

  it('renders ids as text, never as markup (FR-031)', () => {
    const { container } = mount({
      snapshot: snapshotWithConsumers(['<img src=x onerror=alert(1)>']),
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0
    });
    expect(consumerItems(container)).toEqual(['<img src=x onerror=alert(1)>']);
    expect(container.querySelector('img')).toBeNull();
  });
});

// T056 (FR-038, SC-007) — the Builder audited as an operator using a screen
// reader and a keyboard would meet it. These assertions are structural on
// purpose: they hold for every control the editor renders, so a control added
// later without a name, or a status expressed only in CSS, fails here rather
// than in the field.
describe('Pipeline Builder accessibility audit (FR-038, SC-007)', () => {
  type Control = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  const CONTROL_SELECTOR = 'button, input, select, textarea';

  function controls(container: HTMLElement): Control[] {
    return [...container.querySelectorAll<Control>(CONTROL_SELECTOR)];
  }

  /** aria-label → aria-labelledby → wrapping/associated <label> → own text. */
  function accessibleName(control: Control): string {
    const ariaLabel = control.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    const labelledBy = control.getAttribute('aria-labelledby');
    if (labelledBy) {
      const named = labelledBy
        .split(/\s+/)
        .map((id) => control.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
        .join(' ')
        .trim();
      if (named) return named;
    }
    const wrapping = control.closest('label');
    if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
    if (control.id) {
      const associated = control.ownerDocument.querySelector(`label[for="${control.id}"]`);
      if (associated?.textContent?.trim()) return associated.textContent.trim();
    }
    return control.textContent?.trim() ?? '';
  }

  const INVALID_ROW: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    name: '',
    sourceStatus: 'invalid',
    sourceErrors: [
      {
        field: 'name',
        code: 'pipeline-name-required',
        message: 'Name is required.',
        sourceKey: WORKSPACE_PIPELINE.sourceKey
      }
    ]
  } as unknown as MutablePipeline;

  it('gives every rendered control an accessible name', () => {
    const { container } = mount({
      pipelines: [WORKSPACE_PIPELINE, draftRow()],
      selectedIndex: 0
    });
    const rendered = controls(container);
    expect(rendered.length).toBeGreaterThan(0);
    const unnamed = rendered.filter((control) => accessibleName(control) === '');
    expect(unnamed.map((control) => control.outerHTML)).toEqual([]);
  });

  it('keeps every control natively focusable — nothing is removed from the tab order', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    for (const control of controls(container)) {
      expect(control.getAttribute('tabindex'), control.outerHTML).not.toBe('-1');
    }
  });

  it('drives reorder and removal from real buttons, so keyboard activation works (SC-007)', () => {
    const onmovephasedown = vi.fn();
    const { container } = mount({
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0,
      onmovephasedown
    });
    const down = container.querySelector(
      '[data-testid="pipelines-move-phase-down-0"]'
    ) as HTMLElement;
    expect(down.tagName).toBe('BUTTON');
    // Enter on a focused <button> dispatches click; assert the wiring, not the
    // browser's own key handling.
    down.focus();
    expect(container.ownerDocument.activeElement).toBe(down);
    void fireEvent.click(down);
    expect(onmovephasedown).toHaveBeenCalledWith(0);
  });

  it('conveys source status as text, never by color alone', () => {
    // Feature 099 (T496f, FR-042, FR-043) — two badges were read here, and the
    // scope one is deleted with the tier. The audit property is unchanged and
    // still worth asserting on what remains: the status is legible without
    // seeing the colour it is painted in.
    // Feature 101 (T037) — the badge is read off the whole row rather than off
    // the selection button. It moved out of the button and into
    // `DefinitionLifecycleRow` beside it, because T042 hangs interactive
    // lifecycle actions off that row and a control nested in a button is invalid
    // markup. The audit property is unchanged: the status is still legible
    // without seeing the colour it is painted in.
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    const row = container
      .querySelector('[data-testid="pipelines-list-item-custom-flow"]')
      ?.closest('.phase-list-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('.scope-badge')).toBeNull();
    expect(row.querySelector('.status-badge')?.textContent?.trim()).toBe('effective');
  });

  it('announces the Phase order as text rather than by visual position alone', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    const status = container.querySelector(
      '[data-testid="pipelines-sequence-status"]'
    ) as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('1. speckit-specify');
    expect(status.textContent).toContain('2. done');
  });

  it('associates a field error with its own control and marks the control invalid', () => {
    const { container } = mount({ pipelines: [INVALID_ROW], selectedIndex: 0 });
    const nameField = container.querySelector(
      `[data-testid="pipelines-name-field-${INVALID_ROW.id}"]`
    ) as HTMLInputElement;
    expect(nameField.getAttribute('aria-invalid')).toBe('true');
    const describedBy = nameField.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const region = container.ownerDocument.getElementById(describedBy!);
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('alert');
    expect(region!.textContent).toContain('Name is required.');
  });

  it('leaves a valid control unmarked, so aria-invalid means something', () => {
    const { container } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    const nameField = container.querySelector(
      `[data-testid="pipelines-name-field-${WORKSPACE_PIPELINE.id}"]`
    ) as HTMLInputElement;
    expect(nameField.getAttribute('aria-invalid')).toBeNull();
    expect(nameField.getAttribute('aria-describedby')).toBeNull();
  });

  it('announces the non-authoritative and prerequisite states to assistive tech', () => {
    const loading = mount({
      snapshot: { ...SNAPSHOT, pipelineCatalog: undefined } as WorkflowSnapshot
    });
    const loadingState = loading.container.querySelector(
      '[data-testid="pipeline-catalog-loading"]'
    ) as HTMLElement;
    expect(loadingState.getAttribute('role')).toBe('status');
    expect(loadingState.getAttribute('aria-live')).toBe('polite');
    expect(loadingState.textContent?.trim().length).toBeGreaterThan(0);
  });
});

// Feature 085 T022 (FR-011, FR-055) — exporting the selected Pipeline.
//
// The control names a resource and never a location: the host opens its own
// save dialog, so no path crosses the boundary in either direction (FR-019).
// The inclusion choice (T027, FR-012) sits beside it and defaults to the
// reference package (FR-013).
describe('Feature 085 T022 — the Pipeline export control', () => {
  const UNRESOLVED_ROW: MutablePipeline = {
    ...WORKSPACE_PIPELINE,
    sourceStatus: 'invalid',
    sourceErrors: [
      {
        field: 'phases',
        code: 'pipeline-phase-unknown',
        message: 'Phase done is in no catalog layer.',
        sourceKey: WORKSPACE_PIPELINE.sourceKey
      }
    ]
  } as unknown as MutablePipeline;

  it('asks the host for the selected Pipeline by id, naming no location', async () => {
    const { getByTestId } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    await fireEvent.click(getByTestId('pipelines-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('custom-flow', 'references-only');
  });

  it('offers no reason when the selected Pipeline is exportable', () => {
    const { container, getByTestId } = mount({
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0
    });
    expect((getByTestId('pipelines-export') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="pipelines-export-disabled-reason"]')).toBeNull();
    expect(getByTestId('pipelines-export').getAttribute('aria-describedby')).toBeNull();
  });

  it('refuses an unsaved draft, says why, and posts nothing (FR-057)', async () => {
    const { getByTestId } = mount({ pipelines: [draftRow()], selectedIndex: 0 });

    const button = getByTestId('pipelines-export') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(getByTestId('pipelines-export-disabled-reason').textContent).toContain('Save this');
    // Refused before the click rather than failing after it.
    await fireEvent.click(button);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('exports a saved row whose referenced Phases do not resolve (FR-018)', async () => {
    // The exact case FR-018 exists for: a references-only document carries Phase
    // identifiers and no Phase definitions, so a Pipeline the catalog marks
    // `invalid` still exports with its sequence intact. Gating on `sourceStatus`
    // here would refuse it, and only the host can tell a missing reference from
    // a structural defect.
    const { getByTestId } = mount({ pipelines: [UNRESOLVED_ROW], selectedIndex: 0 });

    expect((getByTestId('pipelines-export') as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(getByTestId('pipelines-export'));
    expect(exportSpy).toHaveBeenCalledWith('custom-flow', 'references-only');
  });

  it('stays available without trust and during an in-flight save', () => {
    // Export writes nothing this extension owns, so neither the trust gate nor
    // the mutation gate applies. Borrowing them would make a read-only action
    // unavailable for reasons that describe writes.
    const { getByTestId } = mount({
      pipelines: [WORKSPACE_PIPELINE],
      selectedIndex: 0,
      trusted: false,
      savePending: true,
      mutationActive: true
    });
    expect((getByTestId('pipelines-export') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the Pipeline it belongs to and points at the reason it rendered', () => {
    const enabled = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    expect(enabled.getByTestId('pipelines-export').getAttribute('aria-label')).toBe(
      'Export custom-flow'
    );
    cleanup();

    const disabled = mount({ pipelines: [draftRow()], selectedIndex: 0 });
    const describedBy = disabled.getByTestId('pipelines-export').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(disabled.getByTestId('pipelines-export-disabled-reason').id).toBe(describedBy);
  });

  // T027 (FR-012) — the operator chooses what the document carries before it is
  // produced. The choice reaches the host as the inclusion argument and nothing
  // else about the request changes.
  it('defaults to the reference package and offers the choice unchecked (FR-013)', () => {
    const { getByTestId } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    const toggle = getByTestId('pipelines-export-inclusion') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  it('asks for the referenced definitions once the operator opts in (FR-012)', async () => {
    const { getByTestId } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    await fireEvent.click(getByTestId('pipelines-export-inclusion'));
    await fireEvent.click(getByTestId('pipelines-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('custom-flow', 'include-referenced');
  });

  it('returns to the reference package when the choice is taken back', async () => {
    const { getByTestId } = mount({ pipelines: [WORKSPACE_PIPELINE], selectedIndex: 0 });
    await fireEvent.click(getByTestId('pipelines-export-inclusion'));
    await fireEvent.click(getByTestId('pipelines-export-inclusion'));
    await fireEvent.click(getByTestId('pipelines-export'));

    expect(exportSpy).toHaveBeenCalledWith('custom-flow', 'references-only');
  });

  it('stays available for a row whose referenced Phases do not resolve (FR-017)', async () => {
    // Whether the references resolve is the host's call — it reads the effective
    // catalog and this surface does not. Pre-checking here would refuse the
    // export before the host could name which Phase was missing.
    const { getByTestId } = mount({ pipelines: [UNRESOLVED_ROW], selectedIndex: 0 });
    expect((getByTestId('pipelines-export-inclusion') as HTMLInputElement).disabled).toBe(false);

    await fireEvent.click(getByTestId('pipelines-export-inclusion'));
    await fireEvent.click(getByTestId('pipelines-export'));
    expect(exportSpy).toHaveBeenCalledWith('custom-flow', 'include-referenced');
  });

  it('offers no choice on an unsaved draft, because there is nothing to export', () => {
    const { getByTestId } = mount({ pipelines: [draftRow()], selectedIndex: 0 });
    expect((getByTestId('pipelines-export-inclusion') as HTMLInputElement).disabled).toBe(true);
  });
});
