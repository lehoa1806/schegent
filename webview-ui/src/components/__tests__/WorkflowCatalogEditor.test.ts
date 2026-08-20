// Feature 083 (US5, T055) — the Workflow Library as an operator reads it.
//
// Drives the T056 rework of `WorkflowCatalogEditor.svelte` from the T037 first
// cut (name, id, node count) into a source-aware Library. The
// question each row has to answer without being opened is "what is this, where
// does it come from, what does it run, what does it need, and can I trust it?":
//
//   - validation state, so an invalid row is obvious before it is selected
//     (FR-036);
//   - purpose, so the list is readable by someone who did not author it;
//   - the Pipeline sequence in **authored node order**, never sorted — that
//     order is the operator's and carries no execution semantics (FR-049);
//   - the derived inputs and outputs, which are projection-only and exist on no
//     persisted row (FR-048).
//
// Feature 099 (T496f, FR-042, FR-043) — a paragraph stood here about built-in
// rows being read-only with duplicate as the only action, and about the injected
// fixture layer those assertions needed because the built-in layer ships empty.
// The layer is deleted: every stored row is writable, and the only gate left on
// the mutating controls is Workspace Trust.
//
// Defects anchor to the specific node or connection row they concern, and the
// association is carried by text, not by color alone (FR-044).

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveWorkflowsRequest } from '../../lib/save-workflows';
import type {
  WorkflowCatalogSourceProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import WorkflowCatalogEditor from '../PipelineBuilderEditors/WorkflowCatalogEditor.svelte';

vi.mock('../../lib/save-workflows', () => ({ saveWorkflows: vi.fn(async () => ({ status: 'accepted' })) }));

afterEach(cleanup);

/**
 * Two nodes authored "backwards" — `build` precedes `design` even though
 * `design` feeds it. Any sort on the render path would quietly repair this into
 * dependency order, which is exactly what FR-049 forbids, so the fixture is
 * only useful while it stays in this order.
 */
const NODES = [
  { nodeId: 'build', pipelineId: 'build-it' },
  { nodeId: 'design', pipelineId: 'design-review' }
];

const CONNECTIONS = [
  { from: { nodeId: 'design', portId: 'notes' }, to: { nodeId: 'build', portId: 'brief' } }
];

function record(
  overrides: Partial<WorkflowCatalogSourceProjection> = {}
): WorkflowCatalogSourceProjection {
  const workflowId = overrides.workflowId ?? 'design-then-build';
  return {
    key: `${workflowId}::0`,
    workflowId,
    status: 'effective',
    definition: {
      workflowId,
      name: 'Design then Build',
      description: 'Review the design, then build it.',
      version: 1,
      nodes: NODES,
      connections: CONNECTIONS,
      startNodeIds: ['design']
    },
    display: {},
    errors: [],
    derivedInputs: [{ nodeId: 'design', portId: 'goal', label: 'Goal', type: 'text' }],
    derivedOutputs: [
      { nodeId: 'build', portId: 'artifact', label: 'Artifact', type: 'markdown' }
    ],
    ...overrides
  } as WorkflowCatalogSourceProjection;
}

function snapshot(records: readonly WorkflowCatalogSourceProjection[]): WorkflowSnapshot {
  return {
    isPrimary: true,
    availableBackends: ['claude'],
    availableModels: { claude: ['model-a'], codex: [], agy: [] },
    availablePipelines: [
      { id: 'design-review', name: 'Design Review', phases: ['done'] },
      { id: 'build-it', name: 'Build It', phases: ['done'] }
    ],
    pipelineCatalog: {
      state: 'ready',
      records: [],
      effective: [
        { pipelineId: 'design-review', name: 'Design Review', version: 1, phaseIds: ['done'] },
        { pipelineId: 'build-it', name: 'Build It', version: 1, phaseIds: ['done'] }
      ],
      revision: 'w',
      warnings: []
    },
    workflowCatalog: {
      state: 'ready',
      records,
      effective: [],
      // Feature 099 (T496f, FR-042, FR-044) — a map of layer to revision stood
      // here, and a write picked its gate out of it by the scope the operator
      // had chosen. One catalog per kind leaves one revision per kind.
      revision: 'w',
      warnings: []
    }
  } as unknown as WorkflowSnapshot;
}

const mount = (records: readonly WorkflowCatalogSourceProjection[], trusted = true) =>
  render(WorkflowCatalogEditor, { snapshot: snapshot(records), trusted });

const rowFor = (container: HTMLElement, workflowId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="workflows-list-item-${workflowId}"]`
  );
  expect(row, `row for ${workflowId} must render`).not.toBeNull();
  return row as HTMLElement;
};

// ── Row content (FR-036, FR-048, FR-049, US5 scenario 2) ────────────────────

describe('WorkflowCatalogEditor row content (US5, T055)', () => {
  it('reports validation state on every row', () => {
    // Feature 099 (T496f, FR-042, FR-043) — the scope badge and the `shadowed`
    // status went together: one named the layer a row came from, the other named
    // a row a higher layer hid. Neither has a question left. `invalid` is the one
    // remaining way a stored row fails to resolve, and it is still what tells the
    // operator a row needs repair rather than use.
    const { container } = mount([
      record(),
      record({ workflowId: 'broken-one', status: 'invalid' })
    ]);

    expect(rowFor(container, 'design-then-build').textContent).toContain('effective');
    expect(rowFor(container, 'broken-one').textContent).toContain('invalid');
  });

  it('shows the purpose, so the list is readable by someone who did not author it', () => {
    const { container } = mount([record()]);

    expect(rowFor(container, 'design-then-build').textContent).toContain(
      'Review the design, then build it.'
    );
  });

  it('shows the Pipeline sequence in authored node order, not sorted (FR-049)', () => {
    const { container } = mount([record()]);
    const sequence = rowFor(container, 'design-then-build').querySelector(
      '[data-testid="workflow-row-sequence"]'
    );

    expect(sequence, 'each row must carry a Pipeline sequence').not.toBeNull();
    const text = sequence?.textContent ?? '';
    // Authored order is build-then-design. Position, not membership: a sorted
    // or dependency-ordered render would still contain both names.
    expect(text.indexOf('build-it')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('build-it')).toBeLessThan(text.indexOf('design-review'));
  });

  it('shows the derived inputs and outputs, which exist on no persisted row (FR-048)', () => {
    const { container } = mount([record()]);
    const row = rowFor(container, 'design-then-build');
    const inputs = row.querySelector('[data-testid="workflow-row-inputs"]');
    const outputs = row.querySelector('[data-testid="workflow-row-outputs"]');

    expect(inputs?.textContent).toContain('Goal');
    expect(outputs?.textContent).toContain('Artifact');
  });

  it('renders a row whose definition failed to parse without inventing content', () => {
    // An invalid record carries no `definition`, so every derived field is
    // absent. The row still has to appear — dropping it would hide the very row
    // the operator needs to go fix.
    const { container } = mount([
      record({
        workflowId: 'broken-one',
        status: 'invalid',
        definition: null,
        display: { id: 'broken-one', name: 'Broken One' },
        derivedInputs: [],
        derivedOutputs: [],
        errors: [{ field: 'nodes', code: 'array-required', message: 'nodes must be an array.' }]
      })
    ]);

    const row = rowFor(container, 'broken-one');
    expect(row.textContent).toContain('invalid');
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).not.toContain('null');
  });
});

// ── Every stored row is writable (FR-042, FR-043) ──────────────────────────

describe('WorkflowCatalogEditor stored rows (T496f)', () => {
  // Feature 099 (T496f, FR-042, FR-043) — three cases here seeded a `built-in`
  // row and pinned what it withheld: no editable field, no save, no remove, and
  // duplicate as the one way out. Two of those four were the tier's doing and
  // two were not, and deleting the tier is precisely what separates them:
  //
  //   - remove was withheld because the row sat in a layer nothing could write.
  //     That reason is gone, and the inversion below is the claim.
  //   - the fields are read-only on EVERY stored row, and always were: a
  //     Workflow has no `edit` mutation, so a change is made by duplicating
  //     (FR-026, feature 083). The tier collapse does not reach that rule.
  //
  // Both are pinned here, with their reasons kept apart, so that a build which
  // re-locks the whole row cannot pass by borrowing the surviving reason.
  it('holds every field of a stored row read-only, a Workflow having no edit mutation', async () => {
    const { container } = mount([record({ workflowId: 'stored-flow' })]);
    await fireEvent.click(rowFor(container, 'stored-flow'));

    for (const field of ['workflowId', 'name', 'description']) {
      const control = container.querySelector<HTMLInputElement>(
        `[data-testid="workflow-field-${field}"]`
      );
      expect(control, `${field} must render`).not.toBeNull();
      const locked = control?.readOnly === true || control?.disabled === true;
      expect(locked, `${field} must stay read-only on a stored row`).toBe(true);
    }
    // The counterpart is `makes the copy editable` below: the same three fields
    // on the duplicate of this row are open. Read together they say the gate is
    // persistence, not the row, and not where the row came from.
  });

  it('offers remove and duplicate alike on a stored row', async () => {
    const { container } = mount([record({ workflowId: 'stored-flow' })]);
    await fireEvent.click(rowFor(container, 'stored-flow'));

    const duplicate = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflows-duplicate"]'
    );
    expect(duplicate?.disabled).toBe(false);
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="workflows-remove"]');
    expect(remove?.disabled).toBe(false);
  });
});

// ── Duplicate (US5 scenario 5) ─────────────────────────────────────────────

describe('WorkflowCatalogEditor duplicate (US5, T055)', () => {
  it('lands the copy under a distinct identifier', async () => {
    // Feature 099 (T496f, FR-042) — the source was a `built-in` row and the
    // claim had two halves: a distinct id, and a destination the operator could
    // actually write. One layer settles the destination, so what remains is the
    // half a single catalog still has to decide — a copy that reused the
    // identifier would collide with its own original on save.
    const { container } = mount([record({ workflowId: 'shipped-flow' })]);
    await fireEvent.click(rowFor(container, 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );

    const copy = container.querySelector('[data-testid="workflows-list-item-shipped-flow-copy"]');
    expect(copy, 'the copy must appear under its own identifier').not.toBeNull();
  });

  it('leaves the original untouched', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow' })]);
    const before = rowFor(container, 'shipped-flow').textContent;
    await fireEvent.click(rowFor(container, 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );

    const original = rowFor(container, 'shipped-flow');
    expect(original.textContent).toBe(before);
  });

  it('makes the copy editable', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow' })]);
    await fireEvent.click(rowFor(container, 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );
    await fireEvent.click(
      rowFor(container, 'shipped-flow-copy')
    );

    const name = container.querySelector<HTMLInputElement>('[data-testid="workflow-field-name"]');
    expect(name?.disabled).toBe(false);
    expect(name?.readOnly).toBe(false);
  });

  it('withholds duplicate while the operator is untrusted', async () => {
    // Rendered-but-disabled, not absent. Asserting only "not clickable" would
    // pass on a build that ships no duplicate control at all.
    const untrusted = mount([record()], false);
    await fireEvent.click(rowFor(untrusted.container, 'design-then-build'));
    const withheld = untrusted.container.querySelector<HTMLButtonElement>(
      '[data-testid="workflows-duplicate"]'
    );
    expect(withheld, 'duplicate must render even while untrusted').not.toBeNull();
    expect(withheld?.disabled).toBe(true);

    cleanup();

    const trusted = mount([record()], true);
    await fireEvent.click(rowFor(trusted.container, 'design-then-build'));
    const offered = trusted.container.querySelector<HTMLButtonElement>(
      '[data-testid="workflows-duplicate"]'
    );
    expect(offered?.disabled, 'trust is what gates it, nothing else').toBe(false);
  });
});

// ── Defect anchoring (FR-044) ──────────────────────────────────────────────

describe('WorkflowCatalogEditor defect anchoring (US5, T055)', () => {
  const DEFECTIVE = record({
    errors: [
      {
        field: 'connections[0].to',
        code: 'unresolved-endpoint',
        message: 'connections[0].to names no port on that node.'
      },
      {
        field: 'nodes[1].pipelineId',
        code: 'unknown-pipeline',
        message: 'nodes[1].pipelineId names no Pipeline in the catalog.'
      }
    ]
  });

  it('anchors each host defect to the specific row it concerns (FR-044)', async () => {
    const { container } = mount([DEFECTIVE]);
    await fireEvent.click(rowFor(container, 'design-then-build'));

    const nodeRow = container.querySelector('[data-testid="workflow-node-1"]');
    const connectionRow = container.querySelector('[data-testid="workflow-connection-0"]');
    expect(nodeRow, 'the defective node row must render').not.toBeNull();
    expect(connectionRow, 'the defective connection row must render').not.toBeNull();
    expect(nodeRow?.textContent).toContain('names no Pipeline');
    expect(connectionRow?.textContent).toContain('names no port');
  });

  it('carries the association in text, not color alone (FR-044)', async () => {
    const { container } = mount([DEFECTIVE]);
    await fireEvent.click(rowFor(container, 'design-then-build'));

    const nodeRow = container.querySelector('[data-testid="workflow-node-1"]') as HTMLElement;
    // A sighted operator sees red; everyone else needs the row to say so. An
    // `aria-` association alone would not reach a magnifier user reading text.
    expect(nodeRow.textContent).toMatch(/error|invalid|problem|defect/i);
    // Not `aria-invalid`: that attribute is not supported on a `listitem`, and
    // the AT association is carried by `aria-describedby` plus the text cue.
    expect(nodeRow.getAttribute('data-invalid')).toBe('true');
  });

  it('associates the defect text with the control for assistive technology', async () => {
    const { container } = mount([DEFECTIVE]);
    await fireEvent.click(rowFor(container, 'design-then-build'));

    const nodeRow = container.querySelector('[data-testid="workflow-node-1"]') as HTMLElement;
    const describedBy = nodeRow.getAttribute('aria-describedby');
    expect(describedBy, 'the row must point at its own defect text').not.toBeNull();
    // Resolved the way assistive technology resolves it: every id token in the
    // list, in order, concatenated into the accessible description.
    const description = (describedBy ?? '')
      .split(/\s+/)
      .map((id) => container.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(description).toContain('names no Pipeline');
  });

  it('leaves a clean row unmarked, so the cue means something', async () => {
    const { container } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));

    const nodeRow = container.querySelector('[data-testid="workflow-node-1"]');
    // Without this, a build that renders no node rows at all would satisfy
    // "unmarked" trivially and the cue would be proven by nothing.
    expect(nodeRow, 'the clean node row must render').not.toBeNull();
    expect(nodeRow?.getAttribute('data-invalid')).not.toBe('true');
    expect(nodeRow?.getAttribute('aria-describedby')).toBeNull();
    expect(nodeRow?.textContent).not.toMatch(/error|invalid|problem|defect/i);
  });
});

// Feature 083 (US5, T059, FR-035, US5 scenario 4) — a removal asks first.
//
// The hard rule is that no destructive `postCommand` leaves the webview without
// an awaited `useConfirm`, and `tests/lint/destructive-actions.lint.test.ts`
// pins the shape of that gate statically. What a static scan cannot show is
// that declining actually stops the write, so that is what these assert: the
// same control, once confirmed and once declined, with `saveWorkflows` as the
// witness.
//
// `useConfirm` is mocked rather than driven through the real dialog because the
// dialog is Feature 063's contract and already has its own coverage; what is
// under test here is which mutation intent this Builder declares and whether it
// waits for the answer.

/**
 * Typed to `useConfirm`'s own shape so the assertions below read the call the
 * way the compiler does: an untyped `vi.fn` records `calls` as `[]` and every
 * `calls[0][1].context` read becomes an `any` no one is checking.
 */
type ConfirmCall = (
  actionKey: string,
  options: { originatingElement?: HTMLElement | null; context?: Record<string, unknown> }
) => Promise<boolean>;

const useConfirmMock = vi.hoisted(() => vi.fn<ConfirmCall>(async () => true));
vi.mock('../../lib/use-confirm', () => ({ useConfirm: useConfirmMock, isModalOpen: () => false }));

type SaveCall = (request: SaveWorkflowsRequest) => Promise<{ status: string }>;

const saved = async () =>
  (await import('../../lib/save-workflows')).saveWorkflows as unknown as ReturnType<
    typeof vi.fn<SaveCall>
  >;

describe('removal and reset are confirmation-gated (FR-035)', () => {
  it('sends a remove mutation for the selected row once confirmed', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(true);

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));

    expect(useConfirmMock).toHaveBeenCalledTimes(1);
    expect(useConfirmMock.mock.calls[0][0]).toBe('catalog.remove-workflow');
    expect(saveWorkflows).toHaveBeenCalledTimes(1);
    const request = saveWorkflows.mock.calls[0][0];
    expect(request.mutation).toEqual({ kind: 'remove', workflowId: 'design-then-build' });
    // The write is the whole layer minus the row: an omitted row is the removal.
    expect(request.workflows).toEqual([]);
    expect(request.expectedRevision).toBe('w');
  });

  it('sends nothing at all when the operator declines', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(false);

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));

    expect(useConfirmMock).toHaveBeenCalledTimes(1);
    expect(saveWorkflows).not.toHaveBeenCalled();
    // And the control is live again, not stuck behind a pending save that the
    // host was never asked to perform.
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes from the stored layer only, leaving unsaved drafts out of the write', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(true);

    const { container, getByTestId } = mount([record(), record({ workflowId: 'keeper' })]);
    // An unsaved draft, created before the removal.
    await fireEvent.click(getByTestId('workflows-add'));
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));

    // Exactly the stored layer minus the removed row. Including the draft would
    // declare two intents in one write — an add and a remove — which the host's
    // intent algebra refuses, so the removal would fail for a reason that has
    // nothing to do with the removal.
    const request = saveWorkflows.mock.calls[0][0];
    expect(request.workflows.map((row) => row.workflowId)).toEqual(['keeper']);
  });

  it('names the row in the prompt and hands back the triggering control for focus', async () => {
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(false);

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    const trigger = getByTestId('workflows-remove');
    await fireEvent.click(trigger);

    const options = useConfirmMock.mock.calls[0][1];
    // Feature 099 (T496f, FR-042) — a `scope` stood beside the two names.
    // `toEqual` is exact, so its absence is pinned by this assertion alone.
    expect(options.context).toEqual({
      workflowName: 'Design then Build',
      workflowId: 'design-then-build'
    });
    // FR-035's focus requirement is Feature 063's to honour; this Builder's part
    // is naming the element it must return focus to.
    expect(options.originatingElement).toBe(trigger);
  });

  it('sends a reset mutation with an empty layer once confirmed', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(true);

    const { getByTestId } = mount([record()]);
    await fireEvent.click(getByTestId('workflows-reset'));

    expect(useConfirmMock.mock.calls[0][0]).toBe('catalog.reset-workflows');
    expect(useConfirmMock.mock.calls[0][1].context).toEqual({ workflowCount: 1 });
    const request = saveWorkflows.mock.calls[0][0];
    expect(request.mutation).toEqual({ kind: 'reset' });
    expect(request.workflows).toEqual([]);
    expect(request.expectedRevision).toBe('w');
  });

  it('counts only stored definitions in the reset prompt', async () => {
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(false);

    const { getByTestId } = mount([record()]);
    await fireEvent.click(getByTestId('workflows-add'));
    await fireEvent.click(getByTestId('workflows-reset'));

    // The draft is not a stored definition yet — reset deletes what the host
    // holds, and naming a number the operator cannot see would misstate it.
    expect(useConfirmMock.mock.calls[0][1].context).toEqual({ workflowCount: 1 });
  });

  it('leaves the catalog alone when the reset is declined', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(false);

    const { getByTestId } = mount([record()]);
    await fireEvent.click(getByTestId('workflows-reset'));

    expect(saveWorkflows).not.toHaveBeenCalled();
  });

  it('offers both controls against any stored row, trust being the only gate', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this pinned remove DISABLED against
    // a `built-in` row. With the read-only tier gone, where a row came from
    // gates nothing, and the case below — the same two controls, disabled by
    // untrusted workspace — is what the pair now distinguishes it from.
    const { container, getByTestId } = mount([record({ workflowId: 'shipped' })]);
    await fireEvent.click(rowFor(container, 'shipped'));
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('workflows-reset') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers neither control in an untrusted workspace (FR-029)', async () => {
    const { container, getByTestId } = mount([record()], false);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('workflows-reset') as HTMLButtonElement).disabled).toBe(true);
  });
});

// Feature 083 (US7, T060, FR-045) — the missing-Pipeline prerequisite.
//
// A Workflow node runs a Pipeline, so with no Pipeline resolving there is
// nothing a Workflow could be composed of. This mirrors the shipped 082
// empty-Phase state on PipelineCatalogEditor: the Builder still opens, because
// the catalog resolved fine and existing rows are worth reading, but the reason
// has to be readable text rather than a disabled button left to interpret.
//
// The state is read from `pipelineCatalog.effective`, never from `records`.
// An invalid Pipeline never enters the effective layer host-side, so US7
// scenario 2 collapses into scenario 1 by construction — and the test below
// holds it there, because deriving from `records.length` instead would pass
// scenario 1 and quietly fail scenario 2.
describe('missing-Pipeline prerequisite (US7, FR-045)', () => {
  const withPipelines = (
    records: readonly WorkflowCatalogSourceProjection[],
    catalog: unknown
  ): WorkflowSnapshot =>
    ({ ...snapshot(records), pipelineCatalog: catalog }) as unknown as WorkflowSnapshot;

  /** Resolved cleanly, holding nothing. */
  const EMPTY = { state: 'ready', records: [], effective: [], revision: 'w', warnings: [] };

  /** Resolved, holding rows — every one of which failed validation. */
  const ALL_INVALID = {
    ...EMPTY,
    records: [
      { key: 'broken::0', pipelineId: 'broken', status: 'invalid', definition: null, display: {}, errors: [{ field: 'phaseIds', code: 'unresolved', message: 'no such Phase' }] }
    ]
  };

  const mountWith = (catalog: unknown, records: readonly WorkflowCatalogSourceProjection[] = []) =>
    render(WorkflowCatalogEditor, {
      props: { snapshot: withPipelines(records, catalog), trusted: true }
    });

  const noticeIn = (container: HTMLElement) =>
    container.querySelector('[data-testid="workflows-no-pipelines"]');

  const saveIn = (container: HTMLElement) =>
    container.querySelector('[data-testid="workflows-save-all"]') as HTMLButtonElement;

  it('explains the missing prerequisite as text, not as a bare disabled control', () => {
    const { container } = mountWith(EMPTY);
    const notice = noticeIn(container);
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent ?? '').toMatch(/Pipeline/i);
    expect((notice?.textContent ?? '').trim().length).toBeGreaterThan(20);
    expect(saveIn(container).disabled).toBe(true);
  });

  it('treats a catalog whose every Pipeline is invalid exactly like an empty one', () => {
    const { container } = mountWith(ALL_INVALID);
    expect(noticeIn(container)).not.toBeNull();
    expect(saveIn(container).disabled).toBe(true);
  });

  it('still renders the stored rows rather than hiding the Library', () => {
    const { container } = mountWith(EMPTY, [record()]);
    expect(rowFor(container, 'design-then-build')).not.toBeNull();
  });

  // The one case the pre-existing draft validation does not already cover: a
  // duplicate carries nodes and a start set, so it has no advisory defect and
  // would save cleanly into a catalog that resolves none of the Pipelines its
  // nodes name. Without an explicit gate this is enabled.
  it('refuses to save a duplicate whose nodes no Pipeline resolves', async () => {
    const { container, getByTestId } = mountWith(EMPTY, [record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-duplicate'));

    expect(getByTestId('workflow-field-workflowId')).toBeTruthy();
    expect(saveIn(container).disabled).toBe(true);
  });

  it('becomes usable when a refreshed snapshot carries a valid Pipeline, with no reload', async () => {
    const { container, getByTestId, rerender } = mountWith(EMPTY, [record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-duplicate'));
    expect(saveIn(container).disabled).toBe(true);

    // Same component instance, same in-progress draft — only the snapshot moved.
    await rerender({ snapshot: snapshot([record()]) });

    expect(noticeIn(container)).toBeNull();
    expect(saveIn(container).disabled).toBe(false);
  });

  it('says nothing about a missing Pipeline while the catalog is still loading', () => {
    // Absent is not empty. Nothing resolves yet, so save stays disabled, but
    // telling the operator to go create a Pipeline would be a false statement.
    const { container } = mountWith(undefined);
    expect(noticeIn(container)).toBeNull();
    expect(saveIn(container).disabled).toBe(true);
  });
});
