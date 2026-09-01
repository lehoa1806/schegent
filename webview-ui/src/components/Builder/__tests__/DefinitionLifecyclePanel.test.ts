// Feature 186 (US1, T002) — what the open-definition lifecycle panel renders.
//
// Re-pointed from `DefinitionLifecycleRow.test.ts`'s cell/summary/defect/action/
// history assertions (feature 101, T033/T042/T057): the behaviour under test has
// not changed, only which component renders it. The row's own remaining test
// file keeps the state-badge and validity-badge assertions this file does not
// need — validity is not a prop of this panel (D-1).

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DefinitionLifecyclePanel from '../DefinitionLifecyclePanel.svelte';
import type { BuilderLifecycle, DefinitionState } from '../../../lib/snapshot-types';

const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');
const UPDATED_AT = Date.parse('2026-03-04T18:42:30.000Z');

afterEach(() => cleanup());

function lifecycle(overrides: Partial<BuilderLifecycle> = {}): BuilderLifecycle {
  return Object.freeze({
    state: 'active' as DefinitionState,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    activeVersionId: 'ver-7',
    expectedDraftVersion: 'no-draft',
    versions: Object.freeze([]),
    ...overrides
  });
}

interface PanelOpts {
  definitionId?: string;
  lifecycle?: BuilderLifecycle;
  defects?: readonly { field: string; code: string; message: string }[];
}

function renderPanel(opts: PanelOpts = {}) {
  return render(DefinitionLifecyclePanel, {
    props: {
      kind: 'phase' as const,
      definitionId: opts.definitionId ?? 'speckit-specify',
      definitionName: 'Specify',
      lifecycle: 'lifecycle' in opts ? opts.lifecycle : lifecycle(),
      defects: opts.defects ?? []
    }
  });
}

function cell(container: HTMLElement, part: string, id = 'speckit-specify'): string {
  const node = container.querySelector(`[data-testid="definition-row-${part}-${id}"]`);
  expect(node, `expected a ${part} cell for ${id}`).not.toBeNull();
  return node?.textContent?.trim() ?? '';
}

describe('DefinitionLifecyclePanel — the timestamp cells (US1, T033)', () => {
  it('renders both instants, labelled, and as an absolute time', () => {
    const { container, getByText } = renderPanel();
    expect(cell(container, 'created')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cell(container, 'modified')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The labels are the panel's, not the derivation's — a cell holding a bare
    // timestamp beside another bare timestamp says nothing.
    expect(getByText('Created')).toBeTruthy();
    expect(getByText('Modified')).toBeTruthy();
  });

  it('shows Modified standing still when a save changed nothing', () => {
    // quickstart.md §2 — saving an unchanged body must not move Modified. The
    // store's content-hash short-circuit is what holds that, and this panel is
    // where a bypass would first become visible: two equal instants render as
    // two equal cells, not as one cell or an "unmodified" collapse.
    const { container } = renderPanel({ lifecycle: lifecycle({ updatedAt: CREATED_AT }) });
    expect(cell(container, 'modified')).toBe(cell(container, 'created'));
  });
});

describe('DefinitionLifecyclePanel — the active-version cell (US1, T033, FR-014)', () => {
  it('shows the active version id when one is published', () => {
    const { container } = renderPanel({ lifecycle: lifecycle({ activeVersionId: 'ver-7' }) });
    expect(cell(container, 'active-version')).toBe('ver-7');
  });

  it('renders an em dash — never "null", never "undefined" — when nothing is published', () => {
    const { container } = renderPanel({
      definitionId: 'never-published',
      lifecycle: lifecycle({ state: 'draft', activeVersionId: undefined })
    });
    const rendered = cell(container, 'active-version', 'never-published');
    expect(rendered).toBe('—');
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('null');
    expect(container.textContent).not.toContain('NaN');
  });
});

describe('DefinitionLifecyclePanel — a host with no catalog store wired (US1, T033)', () => {
  it('renders nothing at all rather than inventing values', () => {
    // `lifecycle` is optional on all three record shapes precisely so a host
    // without the store has nothing to invent (snapshot-types.ts, T018). An
    // absent projection must read as absent chrome, not as two epoch-zero
    // timestamps.
    const { container } = renderPanel({ lifecycle: undefined });
    expect(
      container.querySelector('[data-testid="definition-row-created-speckit-specify"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-active-version-speckit-specify"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-speckit-specify"]')
    ).toBeNull();
  });
});

describe('DefinitionLifecyclePanel — the defect list (US1, T034a, FR-015)', () => {
  it('keeps the defects reachable from the panel', () => {
    const { container } = renderPanel({
      defects: [
        { field: 'instruction', code: 'required', message: 'Instruction must not be empty.' },
        { field: 'runner', code: 'unknown', message: 'Runner "agy2" is not a known backend.' }
      ]
    });
    const defects = container.querySelector('[data-testid="definition-row-defects-speckit-specify"]');
    expect(defects).not.toBeNull();
    // Every defect, not the first one: FR-023's all-at-once reporting is the same
    // principle, and a panel that showed only the head defect would send the
    // operator round the fix-one-republish loop it exists to prevent.
    expect(defects?.textContent).toContain('Instruction must not be empty.');
    expect(defects?.textContent).toContain('Runner "agy2" is not a known backend.');
    expect(defects?.textContent).toContain('instruction');
    expect(defects?.textContent).toContain('runner');
  });

  it('renders no defects region when there are none', () => {
    const { container } = renderPanel({ defects: [] });
    expect(
      container.querySelector('[data-testid="definition-row-defects-speckit-specify"]')
    ).toBeNull();
  });
});

describe('DefinitionLifecyclePanel — operator-authored text is text (US1, T033, FR-038)', () => {
  it('interpolates a version id carrying markup rather than parsing it', () => {
    const { container } = renderPanel({
      lifecycle: lifecycle({ activeVersionId: '<img src=x onerror="alert(1)">' })
    });
    expect(container.querySelector('img')).toBeNull();
    expect(cell(container, 'active-version')).toBe('<img src=x onerror="alert(1)">');
  });

  it('interpolates a defect message carrying markup rather than parsing it', () => {
    const { container } = renderPanel({
      defects: [{ field: 'name', code: 'invalid', message: '<script>alert(1)</script>' }]
    });
    expect(container.querySelector('script')).toBeNull();
    const defects = container.querySelector('[data-testid="definition-row-defects-speckit-specify"]');
    expect(defects?.textContent).toContain('<script>alert(1)</script>');
  });

  it('uses no {@html} anywhere in the component', () => {
    // The two cases above pin the values this panel renders today. This one pins
    // the rule for the values it renders next: FR-038 is a property of the
    // component, and a later cell added with `{@html}` would pass both of them.
    const source = readFileSync(resolve(__dirname, '../DefinitionLifecyclePanel.svelte'), 'utf8');
    expect(source).not.toContain('{@html');
  });
});

describe('DefinitionLifecyclePanel — the history expands in place (US4, T057, FR-030a)', () => {
  it('offers a history toggle on a panel that has a lifecycle', () => {
    const { container } = renderPanel();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-speckit-specify"]')
    ).not.toBeNull();
  });

  it('withholds the toggle when the host projected no lifecycle', () => {
    // Same rule as the actions (T042): a host with no catalog store behind it
    // has no history to show, and a control that can only fail is worse than none.
    const { container } = renderPanel({ lifecycle: undefined });
    expect(
      container.querySelector('[data-testid="definition-history-toggle-speckit-specify"]')
    ).toBeNull();
  });

  it('mounts the panel inline, never as a modal', async () => {
    const { container } = renderPanel();
    const toggle = container.querySelector(
      '[data-testid="definition-history-toggle-speckit-specify"]'
    ) as HTMLElement;
    expect(container.querySelector('[data-testid="definition-history-speckit-specify"]')).toBeNull();

    await fireEvent.click(toggle);

    const panel = container.querySelector('[data-testid="definition-history-speckit-specify"]');
    expect(panel).not.toBeNull();
    const root = container.querySelector(
      '[data-testid="definition-lifecycle-panel-speckit-specify"]'
    );
    expect(root?.contains(panel as Node)).toBe(true);
    // FR-030a is "inline expansion", and the enforceable half of that is the
    // absence of the modal affordances: nothing here traps the operator away
    // from the catalog they opened the history to compare against.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[aria-modal]')).toBeNull();
  });

  it('reports its expanded state on the toggle', async () => {
    const { container } = renderPanel();
    const toggle = container.querySelector(
      '[data-testid="definition-history-toggle-speckit-specify"]'
    ) as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('definition-history-speckit-specify');
  });

  it('returns focus to the toggle when the panel closes (FR-030b)', async () => {
    // The history panel owns the focus call and its own test pins it against an
    // injected opener. This is the wiring: that this panel actually hands itself
    // over, so the two halves are connected and not merely each correct alone.
    const { container } = renderPanel();
    const toggle = container.querySelector(
      '[data-testid="definition-history-toggle-speckit-specify"]'
    ) as HTMLElement;
    await fireEvent.click(toggle);
    await fireEvent.click(
      container.querySelector('[data-testid="definition-history-close-speckit-specify"]') as Element
    );
    expect(container.querySelector('[data-testid="definition-history-speckit-specify"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
