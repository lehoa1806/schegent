// Feature 101 (US4, T046/T047/T048) — the version history panel.
//
// The panel lists what it is given and reads one body at a time. Both halves
// have a failure mode worth pinning:
//
//   - the list can start reasoning about its own contents (sorting it,
//     trimming it, explaining what retention pruned), and the moment it does,
//     what the operator sees stops being what the store holds (data-model.md §7);
//   - the body can fall back to empty on a failed read, which renders
//     identically to a definition with no content (FR-012b). That is the one
//     failure this surface must never have, because the operator cannot see it.
//
// The seam is `lib/catalog-history-ipc.ts` — mocked here so a read can be held
// open, resolved out of order, or failed. Everything below the mock (the
// validator, the correlation, the timeout) is covered where it lives.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BuilderLifecycle, BuilderVersionEntry, DefinitionState } from '../../../lib/snapshot-types';

interface ReadRequest {
  readonly kind: string;
  readonly id: string;
  readonly versionId: string;
}

type ReadResult =
  | { readonly outcome: 'success'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'failure'; readonly reason: string };

let reads: { req: ReadRequest; settle: (result: ReadResult) => void }[] = [];
let posted: { type: string; payload: Record<string, unknown> }[] = [];

vi.mock('../../../lib/catalog-history-ipc', () => ({
  readDefinitionVersion(req: ReadRequest): Promise<ReadResult> {
    return new Promise<ReadResult>((resolvePromise) => {
      reads.push({ req, settle: resolvePromise });
    });
  }
}));

// Restore is a lifecycle write, so it goes through the shared helper like every
// other one (FR-025). Mocked below that helper, at the wire, so "Restore posted
// a restore and nothing else" is literally what is asserted.
vi.mock('../../../lib/vscode-api', () => ({
  postCommand(type: string, payload: Record<string, unknown>): { correlationId: string } {
    posted.push({ type, payload });
    return { correlationId: `corr-${posted.length}` };
  }
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(): () => void {
      return () => {};
    }
  }
}));

const DefinitionHistoryPanel = (await import('../DefinitionHistoryPanel.svelte')).default;
const DefinitionLifecycleRow = (await import('../DefinitionLifecycleRow.svelte')).default;
// Feature 186 (D-1) — the active-version cell moved off the row and onto the
// panel that mounts on the surface showing the open definition.
const DefinitionLifecyclePanel = (await import('../DefinitionLifecyclePanel.svelte')).default;

const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');
const PUBLISHED_AT = Date.parse('2026-03-02T11:00:00.000Z');

function version(overrides: Partial<BuilderVersionEntry> = {}): BuilderVersionEntry {
  return {
    versionId: 'v1',
    createdAt: CREATED_AT,
    publishedAt: PUBLISHED_AT,
    isActive: false,
    note: null,
    ...overrides
  };
}

function lifecycle(overrides: Partial<BuilderLifecycle> = {}): BuilderLifecycle {
  return {
    state: 'active' as DefinitionState,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    activeVersionId: 'v3',
    expectedDraftVersion: 'no-draft',
    versions: [version({ versionId: 'v3', isActive: true }), version({ versionId: 'v2' })],
    ...overrides
  };
}

function renderPanel(
  opts: { lifecycle?: BuilderLifecycle; definitionId?: string; opener?: HTMLElement; onclose?: () => void } = {}
) {
  return render(DefinitionHistoryPanel, {
    props: {
      kind: 'phase' as const,
      definitionId: opts.definitionId ?? 'speckit-specify',
      definitionName: 'Specify',
      lifecycle: opts.lifecycle ?? lifecycle(),
      opener: opts.opener ?? null,
      onclose: opts.onclose ?? ((): void => {})
    }
  });
}

function entryIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="definition-history-entry-"]')].map(
    (node) => node.getAttribute('data-version-id') ?? ''
  );
}

function cell(container: HTMLElement, part: string, versionId: string, id = 'speckit-specify'): string {
  const node = container.querySelector(`[data-testid="definition-history-${part}-${id}-${versionId}"]`);
  expect(node, `expected a ${part} cell for ${versionId}`).not.toBeNull();
  return node?.textContent?.trim() ?? '';
}

async function openVersion(container: HTMLElement, versionId: string, id = 'speckit-specify'): Promise<void> {
  const button = container.querySelector(`[data-testid="definition-history-open-${id}-${versionId}"]`);
  expect(button, `expected a view control for ${versionId}`).not.toBeNull();
  await fireEvent.click(button as Element);
}

beforeEach(() => {
  reads = [];
  posted = [];
});

afterEach(() => cleanup());

describe('DefinitionHistoryPanel — the list is what it was given (US4, T046, FR-027)', () => {
  it('renders the entries in the order supplied and does not sort them', () => {
    // The host orders newest-first (snapshot-types.ts: "Newest first, already
    // ordered by the host"). Supplying a deliberately unsorted list is the only
    // way to tell "rendered as given" apart from "sorted and happened to match".
    const { container } = renderPanel({
      lifecycle: lifecycle({
        versions: [version({ versionId: 'v2' }), version({ versionId: 'v9' }), version({ versionId: 'v5' })]
      })
    });
    expect(entryIds(container)).toEqual(['v2', 'v9', 'v5']);
  });

  it('renders exactly one entry for a definition with one version (SC-004)', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v1', isActive: true })] })
    });
    expect(entryIds(container)).toHaveLength(1);
  });

  it('renders exactly fifty entries for a definition with fifty (SC-004)', () => {
    const fifty = Array.from({ length: 50 }, (_unused, index) =>
      version({ versionId: `v${50 - index}`, isActive: index === 0 })
    );
    const { container } = renderPanel({ lifecycle: lifecycle({ versions: fifty }) });
    expect(entryIds(container)).toHaveLength(50);
  });

  it('says nothing about what retention pruned', () => {
    // data-model.md §7 — the surface lists what it is given. A count, an
    // ellipsis, or a "older versions were removed" line would all be the panel
    // reasoning about a corpus it cannot see.
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v50', isActive: true })] })
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/prun/i);
    expect(text).not.toMatch(/retain/i);
    expect(text).not.toMatch(/older/i);
  });

  it('renders an empty history without inventing a row', () => {
    const { container } = renderPanel({ lifecycle: lifecycle({ versions: [] }) });
    expect(entryIds(container)).toEqual([]);
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('null');
  });
});

describe('DefinitionHistoryPanel — what each entry says (US4, T046)', () => {
  it('marks the active version and only the active version (FR-029)', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({
        versions: [version({ versionId: 'v3', isActive: true }), version({ versionId: 'v2' })]
      })
    });
    expect(
      container.querySelector('[data-testid="definition-history-active-speckit-specify-v3"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-active-speckit-specify-v2"]')
    ).toBeNull();
  });

  it('renders a dash in the published cell of a version never published (FR-028)', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v4', publishedAt: null })] })
    });
    expect(cell(container, 'published', 'v4')).toBe('—');
  });

  it('renders an absolute time in the published cell of a version that was published', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v3', publishedAt: PUBLISHED_AT })] })
    });
    expect(cell(container, 'published', 'v3')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('renders an empty note cell — never the text "null" (US4, T046)', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v4', note: null })] })
    });
    expect(cell(container, 'note', 'v4')).toBe('');
    expect(container.textContent).not.toContain('null');
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders the operator\'s note when there is one', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ versions: [version({ versionId: 'v4', note: 'tightened the wording' })] })
    });
    expect(cell(container, 'note', 'v4')).toBe('tightened the wording');
  });

  it('interpolates a note carrying markup rather than parsing it (FR-038)', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({
        versions: [version({ versionId: 'v4', note: '<img src=x onerror="alert(1)">' })]
      })
    });
    expect(container.querySelector('img')).toBeNull();
    expect(cell(container, 'note', 'v4')).toBe('<img src=x onerror="alert(1)">');
  });
});

describe('DefinitionHistoryPanel — reading a body (US4, T046, FR-012b)', () => {
  it('shows an explicit pending state while the read is in flight', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    expect(
      container.querySelector('[data-testid="definition-history-body-pending-speckit-specify"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-body-error-speckit-specify"]')
    ).toBeNull();
  });

  it('requests the body by coordinate — kind, id, versionId (FR-034)', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    expect(reads).toHaveLength(1);
    expect(reads[0].req).toEqual({ kind: 'phase', id: 'speckit-specify', versionId: 'v2' });
  });

  it('renders the body once it arrives', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    reads[0].settle({ outcome: 'success', body: { instruction: 'Write the spec.' } });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Write the spec.');
    });
    expect(
      container.querySelector('[data-testid="definition-history-body-pending-speckit-specify"]')
    ).toBeNull();
  });

  it('reports a failed read as an error and renders no body at all', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    reads[0].settle({ outcome: 'failure', reason: 'record-missing' });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="definition-history-body-error-speckit-specify"]')
      ).not.toBeNull();
    });
    // The failure this surface must never have: an empty body region reads
    // exactly like a definition with no content, so a failed read has to be
    // visibly a failure and not visibly an empty definition.
    expect(
      container.querySelector('[data-testid="definition-history-body-ready-speckit-specify"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-body-pending-speckit-specify"]')
    ).toBeNull();
  });

  it('never renders an empty body on failure, even when the reason is empty', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    reads[0].settle({ outcome: 'failure', reason: '' });
    await vi.waitFor(() => {
      const error = container.querySelector(
        '[data-testid="definition-history-body-error-speckit-specify"]'
      );
      expect(error).not.toBeNull();
      // An error state with no words in it is an empty body by another name.
      expect((error?.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  });
});

describe('DefinitionHistoryPanel — a late response is discarded (US4, T046)', () => {
  it('keeps the body of the version currently selected when an older read lands', async () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({
        versions: [version({ versionId: 'v3', isActive: true }), version({ versionId: 'v2' })]
      })
    });
    await openVersion(container, 'v3');
    await openVersion(container, 'v2');
    expect(reads).toHaveLength(2);

    reads[1].settle({ outcome: 'success', body: { instruction: 'the v2 body' } });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('the v2 body');
    });

    // v3's read finally lands, for a version the panel is no longer showing.
    reads[0].settle({ outcome: 'success', body: { instruction: 'the v3 body' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.textContent).toContain('the v2 body');
    expect(container.textContent).not.toContain('the v3 body');
  });

  it('does not let a late failure overwrite a body that did arrive', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v3');
    await openVersion(container, 'v2');
    reads[1].settle({ outcome: 'success', body: { instruction: 'the v2 body' } });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('the v2 body');
    });
    reads[0].settle({ outcome: 'failure', reason: 'read-failed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      container.querySelector('[data-testid="definition-history-body-error-speckit-specify"]')
    ).toBeNull();
    expect(container.textContent).toContain('the v2 body');
  });
});

describe('DefinitionHistoryPanel — the body is read-only (US4, T048, FR-030)', () => {
  it('renders no editable control anywhere in the body', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    reads[0].settle({
      outcome: 'success',
      body: { id: 'speckit-specify', instruction: 'Write the spec.', runner: 'claude' }
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Write the spec.');
    });
    const body = container.querySelector('[data-testid="definition-history-body-speckit-specify"]');
    expect(body).not.toBeNull();
    expect(body?.querySelectorAll('input')).toHaveLength(0);
    expect(body?.querySelectorAll('textarea')).toHaveLength(0);
    expect(body?.querySelectorAll('select')).toHaveLength(0);
    expect(body?.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('uses no {@html} anywhere in the component', () => {
    // A body is operator-authored JSON. The two assertions above pin what it
    // renders today; this one pins the rule for whatever it renders next.
    const source = readFileSync(resolve(__dirname, '../DefinitionHistoryPanel.svelte'), 'utf8');
    expect(source).not.toContain('{@html');
  });

  // Feature 186 (US3, T023, FR-004, D-4) — `.body-content` carries no inline
  // max-height or overflow: every host that mounts this panel already supplies
  // one scroll region of its own (`.pane-right` on Phases, `.wf-inspector` on
  // Pipelines and Workflows), and a version body capped at its own height
  // inside any of those is a scroll region nested inside another one, which is
  // exactly what FR-004 forbids.
  it('lets the version body flow inside its host’s scroll region rather than carrying its own', async () => {
    const { container } = renderPanel();
    await openVersion(container, 'v2');
    reads[0].settle({
      outcome: 'success',
      body: { id: 'speckit-specify', instruction: 'Write the spec.', runner: 'claude' }
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Write the spec.');
    });
    const content = container.querySelector(
      '[data-testid="definition-history-body-ready-speckit-specify"]'
    ) as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.style.maxHeight).toBe('');
    expect(content.style.overflow).toBe('');

    const source = readFileSync(resolve(__dirname, '../DefinitionHistoryPanel.svelte'), 'utf8');
    const rule = source.match(/\.body-content\s*\{([^}]*)\}/);
    expect(rule, 'expected a .body-content rule').not.toBeNull();
    expect(rule?.[1]).not.toContain('max-height');
    expect(rule?.[1]).not.toContain('overflow');
  });
});

describe('DefinitionHistoryPanel — closing returns focus (US4, T048, FR-030b)', () => {
  it('focuses the element that opened the panel', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'History';
    document.body.appendChild(opener);
    const { container } = renderPanel({ opener });

    const close = container.querySelector('[data-testid="definition-history-close-speckit-specify"]');
    expect(close).not.toBeNull();
    await fireEvent.click(close as Element);

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('tells its parent to close, so the panel is not the thing deciding it is gone', async () => {
    let closed = 0;
    const { container } = renderPanel({ onclose: () => (closed += 1) });
    await fireEvent.click(
      container.querySelector('[data-testid="definition-history-close-speckit-specify"]') as Element
    );
    expect(closed).toBe(1);
  });

  it('survives an opener that is no longer in the document', async () => {
    // The row can re-render out from under the panel between opening and
    // closing. A detached opener must not throw on the way out.
    const opener = document.createElement('button');
    const { container } = renderPanel({ opener });
    await fireEvent.click(
      container.querySelector('[data-testid="definition-history-close-speckit-specify"]') as Element
    );
    expect(container.querySelector('[data-testid="definition-history-close-speckit-specify"]')).not.toBeNull();
  });
});

describe('DefinitionHistoryPanel — Restore lands in Draft (US4, T047, FR-024)', () => {
  it('offers Restore on every entry, and posts a restore naming that version', async () => {
    const { container } = renderPanel();
    const restore = container.querySelector('[data-testid="definition-action-restore-speckit-specify-v2"]');
    expect(restore).not.toBeNull();
    await fireEvent.click(restore as Element);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('CMD_RESTORE_DEFINITION_VERSION');
    expect(posted[0].payload).toEqual({
      kind: 'phase',
      id: 'speckit-specify',
      expectedDraftVersion: 'no-draft',
      fromVersionId: 'v2'
    });
  });

  it('does not move the active marker in the list it is showing', async () => {
    // Restore writes a draft. The active pointer does not move, so nothing in
    // this list may move either until the host says otherwise — an optimistic
    // re-mark here would tell the operator they had published.
    const { container } = renderPanel();
    await fireEvent.click(
      container.querySelector('[data-testid="definition-action-restore-speckit-specify-v2"]') as Element
    );
    await Promise.resolve();
    expect(
      container.querySelector('[data-testid="definition-history-active-speckit-specify-v3"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-active-speckit-specify-v2"]')
    ).toBeNull();
  });

  it('leaves the row and panel reading Active with draft at the unchanged active version', () => {
    // What the host's next snapshot looks like after a restore: state moved to
    // `active-with-draft`, `activeVersionId` did not move. The row and the panel
    // must render exactly that — Draft would be wrong, and a moved active cell
    // worse. Two components now, since the badge and the cell split across the
    // row (D-1) and the panel it grew out of.
    const restoredLifecycle = lifecycle({
      state: 'active-with-draft',
      activeVersionId: 'v3',
      expectedDraftVersion: 'v4'
    });
    const row = render(DefinitionLifecycleRow, {
      props: {
        definitionId: 'speckit-specify',
        lifecycle: restoredLifecycle,
        validity: 'effective' as const
      }
    });
    expect(
      row.container
        .querySelector('[data-testid="definition-row-state-speckit-specify"]')
        ?.textContent?.trim()
    ).toBe('Active with draft');

    const panel = render(DefinitionLifecyclePanel, {
      props: {
        kind: 'phase' as const,
        definitionId: 'speckit-specify',
        definitionName: 'Specify',
        lifecycle: restoredLifecycle,
        defects: []
      }
    });
    expect(
      panel.container
        .querySelector('[data-testid="definition-row-active-version-speckit-specify"]')
        ?.textContent?.trim()
    ).toBe('v3');
  });

  it('routes Restore through the shared lifecycle helper, never inline (FR-025)', () => {
    const source = readFileSync(resolve(__dirname, '../DefinitionHistoryPanel.svelte'), 'utf8');
    expect(source).not.toContain('postCommand(');
    expect(source).toContain('DefinitionActions');
  });
});
