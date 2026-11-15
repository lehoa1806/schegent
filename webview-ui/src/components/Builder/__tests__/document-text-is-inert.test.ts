// Feature 101 (US7, T067, FR-038) — imported document text renders as characters.
//
// Every string this surface shows about a definition came from outside the
// host: a name and a purpose typed into a process document, a note written
// when a version was published, a defect message quoting a field of that same
// document. None of it is HTML, and none of it is trusted to be.
//
// T066 pins the mechanism — no `{@html}` token anywhere under `Builder/`. This
// file pins the consequence, which is the part an operator would notice: the
// characters `<img src=x onerror=...>` appear on screen as those characters,
// and no element by that name enters the document. The two assertions are
// worth keeping separate because the lint would still pass if a future render
// site reached for `innerHTML` directly, and a passing lint reads as safety.
//
// The name renders on the list item that owns the lifecycle row, so the
// Workflow library list is what gets mounted here rather than the row alone —
// mounting the row by itself would prove escaping for text the row does not
// actually show. The purpose and the port labels render on the open Workflow's
// inspector, which is mounted for them: a list row shows only the name, the id
// and the two badges (feature 186, FR-003).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type {
  BuilderLifecycle,
  BuilderVersionEntry,
  DefinitionState,
  WorkflowCatalogFieldErrorProjection
} from '../../../lib/snapshot-types';
import type { MutableWorkflow } from '../../PipelineBuilderEditors/types';

interface ReadRequest {
  readonly kind: string;
  readonly id: string;
  readonly versionId: string;
}
type ReadResult =
  | { readonly outcome: 'success'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'failure'; readonly reason: string };

/** The body the next `View` resolves with. A whole imported document, in miniature. */
let nextBody: Readonly<Record<string, unknown>> = Object.freeze({});

vi.mock('../../../lib/catalog-history-ipc', () => ({
  readDefinitionVersion(_req: ReadRequest): Promise<ReadResult> {
    return Promise.resolve({ outcome: 'success', body: nextBody });
  }
}));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-inert' }))
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => {}) }
}));

const WorkflowLibraryList = (await import('../../PipelineBuilderEditors/WorkflowLibraryList.svelte'))
  .default;
// Feature 186 (D-1) — the defect list and the history toggle moved off the row
// and onto the panel that mounts on the surface showing the open definition;
// mounted directly for the cases below that address them.
const DefinitionLifecyclePanel = (await import('../DefinitionLifecyclePanel.svelte')).default;
// Feature 186 (FR-003) — the purpose and the port summary moved off the row and
// onto the open Workflow's inspector.
const WorkflowSettingsInspector = (
  await import('../../PipelineBuilderEditors/WorkflowSettingsInspector.svelte')
).default;

// One payload per field, each carrying a different tag, so a failure names the
// field that leaked rather than "something rendered an image somewhere".
const MARKUP_NAME = '<img src=x onerror="alert(1)"> Design then Build';
const MARKUP_DESCRIPTION = '<iframe src="javascript:alert(2)"></iframe> Designs, then builds.';
const MARKUP_NOTE = '<svg onload="alert(3)"></svg> published by hand';
const MARKUP_DEFECT_FIELD = '<video onerror="alert(4)"></video>nodes[0]';
const MARKUP_DEFECT_MESSAGE = '<audio onerror="alert(5)"></audio> references an unknown Pipeline';
const MARKUP_BODY_VALUE = '<object data="x"></object> instruction text';
const MARKUP_PORT_LABEL = '<script>alert(6)</script> Goal';

/** Tags that must never exist as nodes. One per payload above. */
const INJECTED = 'img, iframe, svg, video, audio, object, script';

// Not markup, and deliberately so: version ids are minted by the catalog store,
// never carried in from a document. Making this one markup would test a value
// the surface cannot receive, and would say nothing about the fields it can.
const VERSION_ID = 'v2';

const WORKFLOW_ID = 'design-then-build';
const SOURCE_KEY = 'design-then-build::0';
const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');

afterEach(() => cleanup());

function version(overrides: Partial<BuilderVersionEntry> = {}): BuilderVersionEntry {
  return Object.freeze({
    versionId: VERSION_ID,
    createdAt: CREATED_AT,
    publishedAt: CREATED_AT,
    isActive: true,
    note: MARKUP_NOTE,
    ...overrides
  }) as BuilderVersionEntry;
}

function lifecycle(overrides: Partial<BuilderLifecycle> = {}): BuilderLifecycle {
  return Object.freeze({
    state: 'active' as DefinitionState,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    activeVersionId: VERSION_ID,
    expectedDraftVersion: 'no-draft',
    versions: Object.freeze([version()]),
    ...overrides
  }) as BuilderLifecycle;
}

interface ListOpts {
  defects?: readonly WorkflowCatalogFieldErrorProjection[];
  lifecycle?: BuilderLifecycle;
}

function workflowRow(opts: ListOpts): MutableWorkflow {
  return {
    workflowId: WORKFLOW_ID,
    name: MARKUP_NAME,
    description: MARKUP_DESCRIPTION,
    version: 1,
    nodes: [{ nodeId: 'design', pipelineId: 'design-review' }],
    connections: [],
    startNodeIds: ['design'],
    sourceKey: SOURCE_KEY,
    sourceStatus: opts.defects?.length ? 'invalid' : 'effective',
    sourceErrors: opts.defects ?? [],
    persisted: true,
    derivedInputs: [{ nodeId: 'design', portId: 'goal', label: MARKUP_PORT_LABEL, type: 'text' }],
    derivedOutputs: []
  } as MutableWorkflow;
}

/**
 * The Workflow library list, holding one row whose every document-sourced
 * string is markup.
 */
function renderList(opts: ListOpts = {}) {
  return render(WorkflowLibraryList, {
    props: {
      rows: [workflowRow(opts)],
      selectedKey: null,
      lifecycleByKey: new Map<string, BuilderLifecycle | undefined>([
        [SOURCE_KEY, opts.lifecycle ?? lifecycle()]
      ]),
      onselect: () => {}
    }
  });
}

/**
 * The panel, holding the same markup-laden defects and lifecycle as the row
 * fixture above — mounted directly, since the defect list and the history
 * toggle live here now, not on `WorkflowLibraryList`'s row.
 */
function renderPanel(opts: ListOpts = {}) {
  return render(DefinitionLifecyclePanel, {
    props: {
      kind: 'workflow' as const,
      definitionId: WORKFLOW_ID,
      definitionName: MARKUP_NAME,
      lifecycle: opts.lifecycle ?? lifecycle(),
      defects: opts.defects ?? []
    }
  });
}

/** The open Workflow's inspector, showing the same markup-laden row. */
function renderInspector(opts: ListOpts = {}) {
  return render(WorkflowSettingsInspector, {
    props: {
      row: workflowRow(opts),
      phases: [],
      dependentParents: [],
      defects: [],
      readonly: false,
      lifecycle: opts.lifecycle ?? lifecycle(),
      onworkflowpatch: () => {}
    }
  });
}

/** The id prefix every symbol in the webview's icon sprite carries. */
const SPRITE_HREF_PREFIX = '#i-';

/**
 * The surface's own icons, written in its templates: a reference into the
 * dashboard's one sprite, `<svg class="i" aria-hidden="true"><use href="#i-…">`.
 * The row's validity chip draws its check or warning mark this way. Set aside
 * by that exact shape and nothing looser, so an `svg` carrying any other
 * attribute or child (MARKUP_NOTE's `onload` among them) still counts. The
 * same test as `history-text-is-inert.test.ts` uses.
 */
function isSpriteIcon(el: Element): boolean {
  const use = el.firstElementChild;
  return (
    el.tagName.toLowerCase() === 'svg' &&
    el.getAttributeNames().every((name) => name === 'class' || name === 'aria-hidden') &&
    el.classList.contains('i') &&
    el.getAttribute('aria-hidden') === 'true' &&
    el.childElementCount === 1 &&
    use?.tagName.toLowerCase() === 'use' &&
    use.getAttributeNames().join() === 'href' &&
    (use.getAttribute('href') ?? '').startsWith(SPRITE_HREF_PREFIX)
  );
}

/** Every element name from INJECTED that actually made it into the DOM. */
function injectedTags(container: HTMLElement): string[] {
  return [...container.querySelectorAll(INJECTED)]
    .filter((node) => !isSpriteIcon(node))
    .map((node) => node.tagName.toLowerCase());
}

async function openHistory(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector(`[data-testid="definition-history-toggle-${WORKFLOW_ID}"]`);
  expect(toggle, 'expected a history toggle on the panel').not.toBeNull();
  await fireEvent.click(toggle as HTMLElement);
}

function text(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent?.trim() ?? '';
}

describe('imported text on the row (US7, T067, FR-038)', () => {
  it('renders a name that is markup as the characters of that markup', () => {
    const { container } = renderList();
    expect(container.textContent).toContain(MARKUP_NAME);
    expect(injectedTags(container)).toEqual([]);
  });

  it('escapes rather than strips, so the operator sees what the document says', () => {
    // A row that silently dropped the tag would also pass the assertion above
    // for the trailing words. The document says `<img …>`; the operator has to
    // be able to read that, because it is how they find it and fix it.
    const { container } = renderList();
    expect(container.innerHTML).toContain('&lt;img');
  });

  it('renders a defect field and message that are markup as characters', () => {
    const { container } = renderPanel({
      defects: [
        { field: MARKUP_DEFECT_FIELD, code: 'unknown-pipeline', message: MARKUP_DEFECT_MESSAGE }
      ]
    });
    const defects = container.querySelector(`[data-testid="definition-row-defects-${WORKFLOW_ID}"]`);
    expect(defects, 'expected the defect list on the panel').not.toBeNull();
    expect(defects?.textContent).toContain(MARKUP_DEFECT_FIELD);
    expect(defects?.textContent).toContain(MARKUP_DEFECT_MESSAGE);
    expect(injectedTags(container)).toEqual([]);
  });

});

describe('imported text on the open Workflow (US7, T067, FR-038)', () => {
  it('holds a purpose that is markup as the characters of that markup, nothing stripped', () => {
    const { container } = renderInspector();
    const purpose = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="workflow-field-description"]'
    );
    expect(purpose?.value).toBe(MARKUP_DESCRIPTION);
    expect(injectedTags(container)).toEqual([]);
  });

  it('renders a port label that is markup as characters', () => {
    const { container } = renderInspector();
    expect(text(container, 'workflow-port-summary-inputs')).toBe(MARKUP_PORT_LABEL);
    expect(container.innerHTML).toContain('&lt;script');
    expect(injectedTags(container)).toEqual([]);
  });
});

describe('imported text in the history panel (US7, T067, FR-038)', () => {
  it('renders a version note that is markup as characters', async () => {
    const { container } = renderPanel();
    await openHistory(container);
    expect(text(container, `definition-history-note-${WORKFLOW_ID}-${VERSION_ID}`)).toBe(
      MARKUP_NOTE
    );
    expect(injectedTags(container)).toEqual([]);
  });

  it('escapes the note inside the entry rather than dropping the tag', async () => {
    const { container } = renderPanel();
    await openHistory(container);
    const entry = container.querySelector(
      `[data-testid="definition-history-entry-${WORKFLOW_ID}-${VERSION_ID}"]`
    );
    expect(entry, 'expected an entry for the version').not.toBeNull();
    expect(entry?.innerHTML).toContain('&lt;svg');
    expect(injectedTags(container)).toEqual([]);
  });

  it('renders a version body full of markup as characters', async () => {
    // The body is the largest slab of document text on the surface and the one
    // with no fixed shape — whatever the imported file held, verbatim.
    nextBody = Object.freeze({
      name: MARKUP_NAME,
      instruction: MARKUP_BODY_VALUE,
      nested: Object.freeze({ note: MARKUP_NOTE })
    });
    const { container } = renderPanel();
    await openHistory(container);
    const view = container.querySelector(
      `[data-testid="definition-history-open-${WORKFLOW_ID}-${VERSION_ID}"]`
    );
    expect(view, 'expected a View button on the entry').not.toBeNull();
    await fireEvent.click(view as HTMLElement);

    // Verbatim, down to JSON's own escaping of the inner quotes — the panel
    // shows the stored document, not a cleaned-up rendering of it.
    const body = text(container, `definition-history-body-ready-${WORKFLOW_ID}`);
    expect(body).toBe(JSON.stringify(nextBody, null, 2));
    expect(body).toContain('<object');
    expect(body).toContain('<img src=x');
    expect(injectedTags(container)).toEqual([]);
  });

  it('leaves nothing behind on the page once the panel closes', async () => {
    // A node that escaped into the document would outlive the panel that made
    // it, and the row is what stays on screen.
    const { container } = renderPanel();
    await openHistory(container);
    await fireEvent.click(
      container.querySelector(`[data-testid="definition-history-close-${WORKFLOW_ID}"]`) as HTMLElement
    );
    expect(
      container.querySelector(`[data-testid="definition-history-${WORKFLOW_ID}"]`)
    ).toBeNull();
    expect(injectedTags(container)).toEqual([]);
  });
});
