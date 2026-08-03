// Feature 083 (US5, T055) — the Workflow Library as an operator reads it.
//
// Drives the T056 rework of `WorkflowCatalogEditor.svelte` from the T037 first
// cut (name, id, scope badge, node count) into a source-aware Library. The
// question each row has to answer without being opened is "what is this, where
// does it come from, what does it run, what does it need, and can I trust it?":
//
//   - scope and validation state, so a shadowed or invalid row is obvious
//     before it is selected (FR-036);
//   - purpose, so the list is readable by someone who did not author it;
//   - the Pipeline sequence in **authored node order**, never sorted — that
//     order is the operator's and carries no execution semantics (FR-049);
//   - the derived inputs and outputs, which are projection-only and exist on no
//     persisted row (FR-048).
//
// Built-in rows are read-only with duplicate as the only action (FR-026). The
// built-in layer ships empty, so those assertions run against an **injected
// fixture layer** — testing against shipped content would make the test a
// tautology today and a false negative the day content is added.
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
  const scope = overrides.scope ?? 'workspace';
  return {
    key: `${scope}::${workflowId}::0`,
    workflowId,
    scope,
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
      revisions: { user: 'u', workspace: 'w' },
      warnings: []
    },
    workflowCatalog: {
      state: 'ready',
      records,
      effective: [],
      revisions: { user: 'u', workspace: 'w' },
      warnings: []
    }
  } as unknown as WorkflowSnapshot;
}

const mount = (records: readonly WorkflowCatalogSourceProjection[], trusted = true) =>
  render(WorkflowCatalogEditor, { snapshot: snapshot(records), trusted });

const rowFor = (container: HTMLElement, scope: string, workflowId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="workflows-list-item-${scope}-${workflowId}"]`
  );
  expect(row, `row for ${scope}/${workflowId} must render`).not.toBeNull();
  return row as HTMLElement;
};

// ── Row content (FR-036, FR-048, FR-049, US5 scenario 2) ────────────────────

describe('WorkflowCatalogEditor row content (US5, T055)', () => {
  it('reports scope and validation state on every row', () => {
    const { container } = mount([
      record(),
      record({ workflowId: 'shadowed-one', scope: 'user', status: 'shadowed' }),
      record({ workflowId: 'broken-one', scope: 'user', status: 'invalid' })
    ]);

    expect(rowFor(container, 'workspace', 'design-then-build').textContent).toContain('workspace');
    expect(rowFor(container, 'workspace', 'design-then-build').textContent).toContain('effective');
    expect(rowFor(container, 'user', 'shadowed-one').textContent).toContain('shadowed');
    expect(rowFor(container, 'user', 'broken-one').textContent).toContain('invalid');
  });

  it('shows the purpose, so the list is readable by someone who did not author it', () => {
    const { container } = mount([record()]);

    expect(rowFor(container, 'workspace', 'design-then-build').textContent).toContain(
      'Review the design, then build it.'
    );
  });

  it('shows the Pipeline sequence in authored node order, not sorted (FR-049)', () => {
    const { container } = mount([record()]);
    const sequence = rowFor(container, 'workspace', 'design-then-build').querySelector(
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
    const row = rowFor(container, 'workspace', 'design-then-build');
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

    const row = rowFor(container, 'workspace', 'broken-one');
    expect(row.textContent).toContain('invalid');
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).not.toContain('null');
  });
});

// ── Built-in rows (FR-026, US5 scenario 3) ─────────────────────────────────

describe('WorkflowCatalogEditor built-in rows (US5, T055)', () => {
  // The shipped built-in layer is empty, so this fixture is injected. Asserting
  // against shipped content would pass vacuously today and stop testing FR-026
  // the moment content is added.
  const BUILT_IN = record({ workflowId: 'shipped-flow', scope: 'built-in' });

  it('renders a built-in row read-only — no editable field', async () => {
    const { container } = mount([BUILT_IN]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));

    for (const field of ['workflowId', 'name', 'description']) {
      const control = container.querySelector<HTMLInputElement>(
        `[data-testid="workflow-field-${field}"]`
      );
      expect(control, `${field} must render`).not.toBeNull();
      const locked = control?.readOnly === true || control?.disabled === true;
      expect(locked, `${field} must not be editable on a built-in row`).toBe(true);
    }
  });

  it('offers duplicate as the only action on a built-in row (FR-026)', async () => {
    const { container } = mount([BUILT_IN]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));

    expect(container.querySelector('[data-testid="workflows-duplicate"]')).not.toBeNull();
    // Save and remove would each be a write to a layer the host refuses.
    const save = container.querySelector<HTMLButtonElement>('[data-testid="workflows-save-all"]');
    expect(save?.disabled).toBe(true);
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="workflows-remove"]');
    expect(remove === null || remove.disabled).toBeTruthy();
  });

  it('keeps duplicate available on a built-in row even though every other action is not', async () => {
    const { container } = mount([BUILT_IN]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));

    const duplicate = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflows-duplicate"]'
    );
    expect(duplicate?.disabled).toBe(false);
  });
});

// ── Duplicate (US5 scenario 5) ─────────────────────────────────────────────

describe('WorkflowCatalogEditor duplicate (US5, T055)', () => {
  it('lands the copy in a writable scope under a distinct identifier', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow', scope: 'built-in' })]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );

    // A copy that reused the identifier would collide on save; one that stayed
    // in `built-in` could never be written at all.
    const copy = container.querySelector('[data-testid="workflows-list-item-workspace-shipped-flow-copy"]');
    expect(copy, 'the copy must appear in the writable scope').not.toBeNull();
  });

  it('leaves the original untouched', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow', scope: 'built-in' })]);
    const before = rowFor(container, 'built-in', 'shipped-flow').textContent;
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );

    const original = rowFor(container, 'built-in', 'shipped-flow');
    expect(original.textContent).toBe(before);
  });

  it('makes the copy editable, which the built-in original is not', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow', scope: 'built-in' })]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );
    await fireEvent.click(
      rowFor(container, 'workspace', 'shipped-flow-copy')
    );

    const name = container.querySelector<HTMLInputElement>('[data-testid="workflow-field-name"]');
    expect(name?.disabled).toBe(false);
    expect(name?.readOnly).toBe(false);
  });

  it('withholds duplicate while the operator is untrusted', async () => {
    // Rendered-but-disabled, not absent. Asserting only "not clickable" would
    // pass on a build that ships no duplicate control at all.
    const untrusted = mount([record()], false);
    await fireEvent.click(rowFor(untrusted.container, 'workspace', 'design-then-build'));
    const withheld = untrusted.container.querySelector<HTMLButtonElement>(
      '[data-testid="workflows-duplicate"]'
    );
    expect(withheld, 'duplicate must render even while untrusted').not.toBeNull();
    expect(withheld?.disabled).toBe(true);

    cleanup();

    const trusted = mount([record()], true);
    await fireEvent.click(rowFor(trusted.container, 'workspace', 'design-then-build'));
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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));

    const nodeRow = container.querySelector('[data-testid="workflow-node-1"]');
    const connectionRow = container.querySelector('[data-testid="workflow-connection-0"]');
    expect(nodeRow, 'the defective node row must render').not.toBeNull();
    expect(connectionRow, 'the defective connection row must render').not.toBeNull();
    expect(nodeRow?.textContent).toContain('names no Pipeline');
    expect(connectionRow?.textContent).toContain('names no port');
  });

  it('carries the association in text, not color alone (FR-044)', async () => {
    const { container } = mount([DEFECTIVE]);
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));

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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));

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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));

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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
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
    // An unsaved draft in the same scope, created before the removal.
    await fireEvent.click(getByTestId('workflows-add'));
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
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
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
    const trigger = getByTestId('workflows-remove');
    await fireEvent.click(trigger);

    const options = useConfirmMock.mock.calls[0][1];
    expect(options.context).toEqual({
      workflowName: 'Design then Build',
      workflowId: 'design-then-build',
      scope: 'workspace'
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
    expect(useConfirmMock.mock.calls[0][1].context).toEqual({ scope: 'workspace', workflowCount: 1 });
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

    // The draft is not a definition in the scope yet — reset deletes what the
    // host holds, and naming a number the operator cannot see would misstate it.
    expect(useConfirmMock.mock.calls[0][1].context).toEqual({
      scope: 'workspace',
      workflowCount: 1
    });
  });

  it('leaves the layer alone when the reset is declined', async () => {
    const saveWorkflows = await saved();
    saveWorkflows.mockClear();
    useConfirmMock.mockClear();
    useConfirmMock.mockResolvedValueOnce(false);

    const { getByTestId } = mount([record()]);
    await fireEvent.click(getByTestId('workflows-reset'));

    expect(saveWorkflows).not.toHaveBeenCalled();
  });

  it('offers neither control against a built-in row, which is read-only (FR-026)', async () => {
    const { container, getByTestId } = mount([record({ scope: 'built-in', workflowId: 'shipped' })]);
    await fireEvent.click(rowFor(container, 'built-in', 'shipped'));
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers neither control in an untrusted workspace (FR-029)', async () => {
    const { container, getByTestId } = mount([record()], false);
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
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
  const EMPTY = { state: 'ready', records: [], effective: [], revisions: { user: 'u', workspace: 'w' }, warnings: [] };

  /** Resolved, holding rows — every one of which failed validation. */
  const ALL_INVALID = {
    ...EMPTY,
    records: [
      { key: 'workspace::broken::0', pipelineId: 'broken', scope: 'workspace', status: 'invalid', definition: null, display: {}, errors: [{ field: 'phaseIds', code: 'unresolved', message: 'no such Phase' }] }
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
    expect(rowFor(container, 'workspace', 'design-then-build')).not.toBeNull();
  });

  // The one case the pre-existing draft validation does not already cover: a
  // duplicate carries nodes and a start set, so it has no advisory defect and
  // would save cleanly into a catalog that resolves none of the Pipelines its
  // nodes name. Without an explicit gate this is enabled.
  it('refuses to save a duplicate whose nodes no Pipeline resolves', async () => {
    const { container, getByTestId } = mountWith(EMPTY, [record()]);
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-duplicate'));

    expect(getByTestId('workflow-field-workflowId')).toBeTruthy();
    expect(saveIn(container).disabled).toBe(true);
  });

  it('becomes usable when a refreshed snapshot carries a valid Pipeline, with no reload', async () => {
    const { container, getByTestId, rerender } = mountWith(EMPTY, [record()]);
    await fireEvent.click(rowFor(container, 'workspace', 'design-then-build'));
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
