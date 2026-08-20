// Feature 101 (US1, T033/T034a) — what a definition row renders.
//
// One row component serves all three lifecycle kinds. Phases, Pipelines, and
// Workflows each grew their own list chrome, and three copies of a state badge
// would be three chances for one of them to render "undefined" in a cell nobody
// looked at. The kind-specific parts — name, id, the selection button — stay
// with each editor; what this row owns is the part that is the same everywhere.
//
// T034a is the second half of this file: the validity indicator predates the
// feature and this row is what replaces the chrome it lived in, so FR-015 is a
// preservation requirement with no assertion unless one is written here.
//
// The companion is `definition-row-state.test.ts`, which pins the derivation.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DefinitionLifecycleRow from '../DefinitionLifecycleRow.svelte';
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

interface RowOpts {
  definitionId?: string;
  lifecycle?: BuilderLifecycle;
  validity?: 'effective' | 'invalid';
  defects?: readonly { field: string; code: string; message: string }[];
}

function renderRow(opts: RowOpts = {}) {
  return render(DefinitionLifecycleRow, {
    props: {
      // The kind and the name are what the lifecycle actions need (T042); the
      // cells this file is about read neither, so one pair serves every case.
      kind: 'phase' as const,
      definitionId: opts.definitionId ?? 'speckit-specify',
      definitionName: 'Specify',
      lifecycle: 'lifecycle' in opts ? opts.lifecycle : lifecycle(),
      validity: opts.validity ?? 'effective',
      defects: opts.defects ?? []
    }
  });
}

function cell(container: HTMLElement, part: string, id = 'speckit-specify'): string {
  const node = container.querySelector(`[data-testid="definition-row-${part}-${id}"]`);
  expect(node, `expected a ${part} cell for ${id}`).not.toBeNull();
  return node?.textContent?.trim() ?? '';
}

describe('DefinitionLifecycleRow — the three state badges (US1, T033)', () => {
  it('reads Draft on a definition that has never been published', () => {
    const { container } = renderRow({
      lifecycle: lifecycle({ state: 'draft', activeVersionId: undefined })
    });
    expect(cell(container, 'state')).toBe('Draft');
  });

  it('reads Active on a published definition with no draft', () => {
    const { container } = renderRow({ lifecycle: lifecycle({ state: 'active' }) });
    expect(cell(container, 'state')).toBe('Active');
  });

  it('reads Active with draft when both exist', () => {
    const { container } = renderRow({
      lifecycle: lifecycle({ state: 'active-with-draft', expectedDraftVersion: 'draft-3' })
    });
    expect(cell(container, 'state')).toBe('Active with draft');
  });
});

describe('DefinitionLifecycleRow — the timestamp cells (US1, T033)', () => {
  it('renders both instants, labelled, and as an absolute time', () => {
    const { container, getByText } = renderRow();
    expect(cell(container, 'created')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cell(container, 'modified')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The labels are the row's, not the derivation's — a cell holding a bare
    // timestamp beside another bare timestamp says nothing.
    expect(getByText('Created')).toBeTruthy();
    expect(getByText('Modified')).toBeTruthy();
  });

  it('shows Modified standing still when a save changed nothing', () => {
    // quickstart.md §2 — saving an unchanged body must not move Modified. The
    // store's content-hash short-circuit is what holds that, and this row is
    // where a bypass would first become visible: two equal instants render as
    // two equal cells, not as one cell or an "unmodified" collapse.
    const { container } = renderRow({ lifecycle: lifecycle({ updatedAt: CREATED_AT }) });
    expect(cell(container, 'modified')).toBe(cell(container, 'created'));
  });
});

describe('DefinitionLifecycleRow — the active-version cell (US1, T033, FR-014)', () => {
  it('shows the active version id when one is published', () => {
    const { container } = renderRow({ lifecycle: lifecycle({ activeVersionId: 'ver-7' }) });
    expect(cell(container, 'active-version')).toBe('ver-7');
  });

  it('renders an em dash — never "null", never "undefined" — when nothing is published', () => {
    const { container } = renderRow({
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

describe('DefinitionLifecycleRow — a host with no catalog store wired (US1, T033)', () => {
  it('renders no lifecycle cells at all rather than inventing values', () => {
    // `lifecycle` is optional on all three record shapes precisely so a host
    // without the store has nothing to invent (snapshot-types.ts, T018). An
    // absent projection must read as absent chrome, not as a Draft badge and
    // two epoch-zero timestamps.
    const { container } = renderRow({ lifecycle: undefined });
    expect(container.querySelector('[data-testid="definition-row-state-speckit-specify"]')).toBeNull();
    expect(container.querySelector('[data-testid="definition-row-created-speckit-specify"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-active-version-speckit-specify"]')
    ).toBeNull();
  });

  it('still renders validity, which does not come from the lifecycle projection', () => {
    const { container } = renderRow({ lifecycle: undefined, validity: 'invalid' });
    expect(cell(container, 'validity')).toBe('invalid');
  });
});

describe('DefinitionLifecycleRow — validity survives the rewrite (US1, T034a, FR-015)', () => {
  it('renders effective on a definition the host resolved', () => {
    const { container } = renderRow({ validity: 'effective' });
    expect(cell(container, 'validity')).toBe('effective');
    expect(
      container.querySelector('[data-testid="definition-row-defects-speckit-specify"]')
    ).toBeNull();
  });

  it('renders invalid, and keeps the defects reachable from the row', () => {
    const { container } = renderRow({
      validity: 'invalid',
      defects: [
        { field: 'instruction', code: 'required', message: 'Instruction must not be empty.' },
        { field: 'runner', code: 'unknown', message: 'Runner "agy2" is not a known backend.' }
      ]
    });
    expect(cell(container, 'validity')).toBe('invalid');
    const defects = container.querySelector('[data-testid="definition-row-defects-speckit-specify"]');
    expect(defects).not.toBeNull();
    // Every defect, not the first one: FR-023's all-at-once reporting is the same
    // principle, and a row that showed only the head defect would send the
    // operator round the fix-one-republish loop it exists to prevent.
    expect(defects?.textContent).toContain('Instruction must not be empty.');
    expect(defects?.textContent).toContain('Runner "agy2" is not a known backend.');
    expect(defects?.textContent).toContain('instruction');
    expect(defects?.textContent).toContain('runner');
  });

  it('keeps the validity badge keyed to its status class, as the list chrome had it', () => {
    const { container } = renderRow({ validity: 'invalid' });
    const badge = container.querySelector('[data-testid="definition-row-validity-speckit-specify"]');
    expect(badge?.className).toContain('status-invalid');
  });
});

describe('DefinitionLifecycleRow — operator-authored text is text (US1, T033, FR-038)', () => {
  it('interpolates a version id carrying markup rather than parsing it', () => {
    const { container } = renderRow({
      lifecycle: lifecycle({ activeVersionId: '<img src=x onerror="alert(1)">' })
    });
    expect(container.querySelector('img')).toBeNull();
    expect(cell(container, 'active-version')).toBe('<img src=x onerror="alert(1)">');
  });

  it('interpolates a defect message carrying markup rather than parsing it', () => {
    const { container } = renderRow({
      validity: 'invalid',
      defects: [{ field: 'name', code: 'invalid', message: '<script>alert(1)</script>' }]
    });
    expect(container.querySelector('script')).toBeNull();
    const defects = container.querySelector('[data-testid="definition-row-defects-speckit-specify"]');
    expect(defects?.textContent).toContain('<script>alert(1)</script>');
  });

  it('uses no {@html} anywhere in the component', () => {
    // The two cases above pin the values this row renders today. This one pins
    // the rule for the values it renders next: FR-038 is a property of the
    // component, and a later cell added with `{@html}` would pass both of them.
    const source = readFileSync(resolve(__dirname, '../DefinitionLifecycleRow.svelte'), 'utf8');
    expect(source).not.toContain('{@html');
  });
});

describe('DefinitionLifecycleRow — the history expands the row (US4, T057, FR-030a)', () => {
  it('offers a history toggle on a row that has a lifecycle', () => {
    const { container } = renderRow();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-speckit-specify"]')
    ).not.toBeNull();
  });

  it('withholds the toggle when the host projected no lifecycle', () => {
    // Same rule as the actions (T042): a host with no catalog store behind it
    // has no history to show, and a control that can only fail is worse than none.
    const { container } = renderRow({ lifecycle: undefined });
    expect(
      container.querySelector('[data-testid="definition-history-toggle-speckit-specify"]')
    ).toBeNull();
  });

  it('mounts the panel inside the row itself, never as a modal', async () => {
    const { container } = renderRow();
    const toggle = container.querySelector(
      '[data-testid="definition-history-toggle-speckit-specify"]'
    ) as HTMLElement;
    expect(container.querySelector('[data-testid="definition-history-speckit-specify"]')).toBeNull();

    await fireEvent.click(toggle);

    const panel = container.querySelector('[data-testid="definition-history-speckit-specify"]');
    expect(panel).not.toBeNull();
    const row = container.querySelector('[data-testid="definition-row-speckit-specify"]');
    expect(row?.contains(panel as Node)).toBe(true);
    // FR-030a is "inline expansion", and the enforceable half of that is the
    // absence of the modal affordances: nothing here traps the operator away
    // from the catalog they opened the history to compare against.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[aria-modal]')).toBeNull();
  });

  it('reports its expanded state on the toggle', async () => {
    const { container } = renderRow();
    const toggle = container.querySelector(
      '[data-testid="definition-history-toggle-speckit-specify"]'
    ) as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('definition-history-speckit-specify');
  });

  it('returns focus to the toggle when the panel closes (FR-030b)', async () => {
    // The panel owns the focus call and its own test pins it against an injected
    // opener. This is the wiring: that the row actually hands itself over, so
    // the two halves are connected and not merely each correct alone.
    const { container } = renderRow();
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
