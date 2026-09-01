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
//
// Feature 101 (T030) — the transport moved. `saveWorkflows` posted the whole
// Workflow layer and encoded the operation in a `mutation` field; the lifecycle
// senders address one definition by id and encode the operation in the command
// they post. Every assertion about "the rows carried alongside" is gone with it,
// because a per-definition write carries no rows.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleConfirmOptions, LifecycleResult } from '../../lib/catalog-lifecycle';
import type { DeactivateRequest } from '../../../../src/contracts/catalog-lifecycle';
import type {
  WorkflowCatalogSourceProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import WorkflowCatalogEditor from '../PipelineBuilderEditors/WorkflowCatalogEditor.svelte';

// Feature 101 (T030) — `save-workflows.ts` folded into `catalog-lifecycle.ts`.
// Only the two senders this editor reaches are stubbed; everything else keeps
// its real body, `draftTokenOfRecord` above all: it is the derivation that turns
// a record's lifecycle block into the write token, and stubbing it would let the
// editor send any token at all while the assertions below still read 'no-draft'.
const deactivateSpy = vi.hoisted(() =>
  vi.fn<(request: DeactivateRequest, options: LifecycleConfirmOptions) => Promise<LifecycleResult>>(
    async () => ({ status: 'accepted' as const })
  )
);
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  deactivateDefinition: deactivateSpy
}));

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

/**
 * Reopen the top bar's picker. The Library list moved inside it when the canvas
 * replaced the split pane, and choosing a row closes it — so a test that selects
 * and then looks at the list again has to open it back up. What these assertions
 * are about is the row, not the disclosure.
 */
const openPicker = async (container: HTMLElement): Promise<void> => {
  if (container.querySelector('[data-testid="workflow-picker-list"]') !== null) return;
  const toggle = container.querySelector<HTMLElement>('[data-testid="workflow-picker-toggle"]');
  if (toggle) await fireEvent.click(toggle);
};

const rowFor = (container: HTMLElement, workflowId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="workflows-list-item-${workflowId}"]`
  );
  expect(row, `row for ${workflowId} must render`).not.toBeNull();
  return row as HTMLElement;
};

/**
 * The lifecycle chrome beside the selection button.
 *
 * Feature 101 (T037) — the validity badge used to sit inside the button
 * `rowFor` returns, and moved into `DefinitionLifecycleRow` next to it: T042
 * hangs interactive lifecycle actions off that row, and a control nested in a
 * button is invalid markup and unreachable by keyboard. `rowFor` stays pointed
 * at the button because half this file clicks it to select a row, so the chrome
 * gets its own handle rather than widening that one.
 */
const lifecycleRowFor = (container: HTMLElement, workflowId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-testid="definition-row-${workflowId}"]`);
  expect(row, `lifecycle chrome for ${workflowId} must render`).not.toBeNull();
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

    expect(lifecycleRowFor(container, 'design-then-build').textContent).toContain('effective');
    expect(lifecycleRowFor(container, 'broken-one').textContent).toContain('invalid');
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

    // Both halves of the row: the button, which is where the absent derived
    // fields would surface as a stringified `undefined`, and the lifecycle
    // chrome beside it, which is where the status now reads.
    const row = rowFor(container, 'broken-one');
    const chrome = lifecycleRowFor(container, 'broken-one');
    expect(chrome.textContent).toContain('invalid');
    for (const text of [row.textContent, chrome.textContent]) {
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
    }
  });

  // Feature 186 (US3, T018, FR-003) — the row keeps its identity summary and its
  // two badges; no lifecycle write control reaches it, even when a lifecycle is
  // projected. Written to pin the post-relocation state regardless of whether
  // such a control was still reachable before it.
  it('carries no lifecycle write control on any row, even with a lifecycle projected', () => {
    const { container } = mount([
      record({
        lifecycle: {
          state: 'active-with-draft',
          createdAt: 0,
          updatedAt: 0,
          activeVersionId: 'v1',
          expectedDraftVersion: 'v2',
          versions: []
        }
      })
    ]);
    const chrome = lifecycleRowFor(container, 'design-then-build');

    expect(
      chrome.querySelector('[data-testid="definition-row-created-design-then-build"]')
    ).toBeNull();
    expect(
      chrome.querySelector('[data-testid="definition-history-toggle-design-then-build"]')
    ).toBeNull();
    expect(
      chrome.querySelector('[data-testid="definition-action-publish-design-then-build"]')
    ).toBeNull();
    expect(
      chrome.querySelector('[data-testid="definition-row-state-design-then-build"]')
    ).not.toBeNull();
    expect(
      chrome.querySelector('[data-testid="definition-row-validity-design-then-build"]')
    ).not.toBeNull();
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

// Feature 186 (US3, T019, FR-001, FR-002, FR-006, D-2) — the inspector shows
// the open Workflow's lifecycle facts and actions in its resting state, and
// withholds them the moment a node or connection is selected instead: a
// selected node or connection is part of the Workflow, not the open
// definition itself.
describe('WorkflowCatalogEditor lifecycle relocation (US3, T019)', () => {
  const LIFECYCLE = {
    state: 'active-with-draft' as const,
    createdAt: Date.parse('2026-03-01T09:15:00.000Z'),
    updatedAt: Date.parse('2026-03-04T18:42:30.000Z'),
    activeVersionId: 'ver-7',
    expectedDraftVersion: 'draft-1',
    versions: []
  };

  it('shows the panel in the resting branch, once the Workflow is open', async () => {
    const { container } = mount([record({ workflowId: 'stored-flow', lifecycle: LIFECYCLE })]);
    await fireEvent.click(rowFor(container, 'stored-flow'));

    expect(
      container.querySelector('[data-testid="definition-row-created-stored-flow"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-active-version-stored-flow"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-stored-flow"]')
    ).not.toBeNull();
  });

  it('withholds the panel once a node is selected instead of resting on the Workflow', async () => {
    const { container } = mount([record({ workflowId: 'stored-flow', lifecycle: LIFECYCLE })]);
    await fireEvent.click(rowFor(container, 'stored-flow'));
    expect(
      container.querySelector('[data-testid="definition-row-created-stored-flow"]')
    ).not.toBeNull();

    await fireEvent.click(container.querySelector('[data-testid="workflow-node-0"]') as HTMLElement);

    expect(
      container.querySelector('[data-testid="definition-row-created-stored-flow"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-stored-flow"]')
    ).toBeNull();
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

    await openPicker(container);
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

    await openPicker(container);
    const original = rowFor(container, 'shipped-flow');
    expect(original.textContent).toBe(before);
  });

  it('makes the copy editable', async () => {
    const { container } = mount([record({ workflowId: 'shipped-flow' })]);
    await fireEvent.click(rowFor(container, 'shipped-flow'));
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-duplicate"]') as HTMLElement
    );
    await openPicker(container);
    await fireEvent.click(rowFor(container, 'shipped-flow-copy'));

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

  it('anchors each host defect to the specific thing it concerns (FR-044)', async () => {
    // The anchors changed with the surface: a node defect lands on that node's
    // card, and a connection defect on that arm's chip. What did NOT change is
    // that each one lands on the control that produced it rather than in one
    // undifferentiated list at the bottom.
    const { container } = mount([DEFECTIVE]);
    await fireEvent.click(rowFor(container, 'design-then-build'));

    const card = container.querySelector('[data-testid="workflow-node-1"]');
    const chip = container.querySelector('[data-testid="workflow-branch-0"]');
    expect(card, 'the defective node card must render').not.toBeNull();
    expect(chip, 'the defective branch chip must render').not.toBeNull();
    expect(card?.getAttribute('data-invalid')).toBe('true');
    expect(chip?.getAttribute('data-invalid')).toBe('true');

    // The node's message renders beside its card; the branch's renders in the
    // inspector, which is where that arm's controls now live.
    // `WorkflowRowDefects` exposes an `id`, because that is what the card's
    // `aria-describedby` has to name.
    const cardDefects = container.querySelector('#workflow-node-defects-1');
    expect(cardDefects?.textContent).toContain('names no Pipeline');

    await fireEvent.click(chip as HTMLElement);
    const branchDefects = container.querySelector('#workflow-connection-defects-0');
    expect(branchDefects?.textContent).toContain('names no port');
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
// same control, once confirmed and once declined, with `deactivateDefinition`
// as the witness.
//
// `useConfirm` is mocked rather than driven through the real dialog because the
// dialog is Feature 063's contract and already has its own coverage; what is
// under test here is which mutation intent this Builder declares and whether it
// waits for the answer.
//
// Feature 100 (T509b, FR-049) — the gate moved. It now lives inside
// `deactivateDefinition`, the one function that can post the command it
// authorises, so this editor no longer asks: it hands `removedName` and the
// triggering control to the helper as request fields and the helper prompts. The
// three cases that drove the local prompt are rewritten below onto that shape,
// and each of them additionally asserts `useConfirm` was NOT called here —
// because a prompt re-added at this call site would prompt twice for one
// removal and nothing else in the suite would notice.
//
// The three Reset cases are deleted rather than ported, and their tombstone is
// below. `useConfirm` stays mocked: the mock is now what proves the absence.

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

describe('removal is a deactivation, gated where it is posted (FR-049)', () => {
  it('sends one removal for the selected row, addressed by its own id', async () => {
    deactivateSpy.mockClear();
    useConfirmMock.mockClear();

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    const trigger = getByTestId('workflows-remove');
    await fireEvent.click(trigger);

    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    const [request, options] = deactivateSpy.mock.calls[0];
    // Feature 101 (T030) — `toEqual` is exact, and that is the point: the write
    // names one definition and carries no layer. The `mutation: { kind: 'remove' }`
    // and the whole-layer-minus-the-row `workflows: []` that stood here are both
    // gone, because the command posted is what says "deactivate" now.
    expect(request).toEqual({
      kind: 'workflow',
      id: 'design-then-build',
      // The fixture record carries no draft, so the staleness token is the
      // sentinel rather than a version id (FR-024).
      expectedDraftVersion: 'no-draft'
    });
    // What the prompt must say and where focus must return, handed to the helper
    // as options because the helper is what asks. Feature 099 (T496f, FR-042) — a
    // `scope` stood beside the name in the old prompt context; `toEqual` here is
    // exact, so its absence is pinned.
    expect(options).toEqual({ definitionName: 'Design then Build', originatingElement: trigger });
  });

  it('asks nothing itself, so one removal cannot prompt twice', async () => {
    deactivateSpy.mockClear();
    useConfirmMock.mockClear();

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));

    // The gate is `deactivateDefinition`'s, and it is mocked away here. A prompt
    // restored at this call site would still pass every other assertion in this
    // block while asking the operator twice for one removal.
    expect(useConfirmMock).not.toHaveBeenCalled();
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the operator declines, because nothing was sent', async () => {
    deactivateSpy.mockClear();
    useConfirmMock.mockClear();
    deactivateSpy.mockResolvedValueOnce({ status: 'rejected', reason: 'declined' });

    const { container, getByTestId } = mount([record()]);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));
    await tick();

    // A decline is neither a save nor a failure, and that is only observable in
    // the surface: no banner, the row still listed, the control live again
    // rather than stuck behind a pending save the host never performed.
    expect(container.querySelector('[data-testid="workflow-save-error-banner"]')).toBeNull();
    await openPicker(container);
    expect(rowFor(container, 'design-then-build')).not.toBeNull();
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names only the removed row, so an unsaved draft cannot ride along', async () => {
    deactivateSpy.mockClear();
    useConfirmMock.mockClear();

    const { container, getByTestId } = mount([record(), record({ workflowId: 'keeper' })]);
    // An unsaved draft, created before the removal.
    await fireEvent.click(getByTestId('workflows-add'));
    // Adding selects the new draft, which closes the picker the list lives in.
    await openPicker(container);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    await fireEvent.click(getByTestId('workflows-remove'));

    // Feature 101 (T030) — this used to assert the stored layer minus the removed
    // row, because the write was the layer and an unsaved draft riding along would
    // declare two intents in one write. Addressing one definition by id retires
    // that whole failure mode: the request names `design-then-build` and nothing
    // else, so `keeper` and the draft are unreachable from it by construction.
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(deactivateSpy.mock.calls[0][0].id).toBe('design-then-build');
  });

  // Feature 100 (T509b, FR-049) — three Reset cases stood here: the mutation and
  // its empty layer, the prompt counting only stored rows, and the declined
  // reset writing nothing. They are deleted rather than rewritten, because their
  // whole subject is gone: Reset was one atomic layer-wide write, and the
  // versioned store deactivates one definition at a time. A button whose
  // atomicity the store does not provide is a button that lies, so
  // `WorkflowToolbar` no longer offers one and `confirmWorkflowLayerReset` is
  // deleted. A bulk surface, if it is wanted, is FR-R3-017's to design against
  // per-definition writes. What those cases really encoded — that one prompt
  // names what it is about to destroy — survives above in `removedName`.

  it('offers removal against any stored row, trust being the only gate', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this pinned remove DISABLED against
    // a `built-in` row. With the read-only tier gone, where a row came from
    // gates nothing, and the case below — the same control, disabled by an
    // untrusted workspace — is what the pair now distinguishes it from.
    const { container, getByTestId } = mount([record({ workflowId: 'shipped' })]);
    await fireEvent.click(rowFor(container, 'shipped'));
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no removal in an untrusted workspace (FR-029)', async () => {
    const { container, getByTestId } = mount([record()], false);
    await fireEvent.click(rowFor(container, 'design-then-build'));
    expect((getByTestId('workflows-remove') as HTMLButtonElement).disabled).toBe(true);
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
