// Feature 101 (US5, T059, FR-008 – FR-011, FR-026) — what publishing would change.
//
// The component renders a projection and computes nothing (FR-011). That is the
// invariant worth guarding, because the tempting shortcut is exactly the one the
// spec forbids: a first publish has no prior version, and a summary that diffed
// locally would render every field of it as an addition (FR-009). The operator
// would then scroll a list of forty "additions" looking for the change they made,
// on a publish where there was nothing to review at all.
//
// The second invariant is that it never blocks (FR-026). A summary the operator
// must dismiss before publishing is a confirmation dialog with extra reading, and
// publish is one click by design.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ChangedFieldSummary from '../ChangedFieldSummary.svelte';
import DefinitionLifecycleRow from '../DefinitionLifecycleRow.svelte';
import type {
  BuilderLifecycle,
  ChangedCollectionField,
  ChangedField,
  ChangedFieldSummary as Summary,
  DefinitionState
} from '../../../lib/snapshot-types';

const DEFINITION_ID = 'speckit-specify';
const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');

afterEach(() => cleanup());

function renderSummary(summary: Summary) {
  return render(ChangedFieldSummary, { props: { definitionId: DEFINITION_ID, summary } });
}

function scalar(field: string): ChangedField {
  return { field, change: 'differs' };
}

/** Every bucket empty by default, so a case names only the bucket it is about. */
function collection(
  field: string,
  parts: Partial<Omit<ChangedCollectionField, 'field' | 'change'>> = {}
): ChangedCollectionField {
  return { field, change: 'collection', added: [], removed: [], reordered: [], ...parts };
}

function fieldNode(container: HTMLElement, field: string): Element | null {
  return container.querySelector(`[data-testid="changed-field-${DEFINITION_ID}-${field}"]`);
}

function fieldNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="changed-field-' + DEFINITION_ID + '-"]')].map(
    (node) => node.getAttribute('data-field') ?? ''
  );
}

describe('ChangedFieldSummary — the changed arm (US5, T059, FR-008)', () => {
  it('names every changed field, in the order projected', () => {
    const { container } = renderSummary({
      kind: 'changed',
      fields: [scalar('instruction'), collection('bindings', { reordered: ['plan', 'tasks'] }), scalar('runner')]
    });
    expect(fieldNames(container)).toEqual(['instruction', 'bindings', 'runner']);
  });

  it('says a scalar field differs without quoting either value', () => {
    // The summary's job is to say which field to look at, not to diff it. A
    // before/after here would put a definition body's content into a one-line
    // panel beside a button.
    const { container } = renderSummary({ kind: 'changed', fields: [scalar('instruction')] });
    const node = fieldNode(container, 'instruction');
    expect(node?.textContent).toContain('instruction');
    expect(node?.textContent).toContain('differs');
  });

  it('names what moved into, out of, and around a collection', () => {
    const { container } = renderSummary({
      kind: 'changed',
      fields: [
        collection('phases', { added: ['analyze'], removed: ['legacy-audit'], reordered: ['plan', 'tasks'] })
      ]
    });
    const node = fieldNode(container, 'phases');
    expect(node?.textContent).toContain('analyze');
    expect(node?.textContent).toContain('legacy-audit');
    expect(node?.textContent).toContain('plan');
    expect(node?.textContent).toContain('tasks');
  });

  it('omits a bucket that is empty rather than printing "0 added"', () => {
    const { container } = renderSummary({
      kind: 'changed',
      fields: [collection('phases', { added: ['analyze'] })]
    });
    const text = fieldNode(container, 'phases')?.textContent ?? '';
    expect(text).toContain('Added');
    expect(text).not.toContain('Removed');
    expect(text).not.toContain('Reordered');
  });

  it('reports a collection whose entries changed in place, with all three buckets empty', () => {
    // Per the projected type: all three lists empty means an entry was edited.
    // Rendering nothing at all would name a field and then say nothing about it.
    const { container } = renderSummary({ kind: 'changed', fields: [collection('bindings')] });
    const text = fieldNode(container, 'bindings')?.textContent ?? '';
    expect(text).toContain('bindings');
    expect(text.replace('bindings', '').trim().length).toBeGreaterThan(0);
  });

  it('renders no field row for a changed arm that projected an empty list', () => {
    const { container } = renderSummary({ kind: 'changed', fields: [] });
    expect(fieldNames(container)).toEqual([]);
    expect(container.textContent).not.toContain('undefined');
  });

  it('still says the definition would change when the projection named no fields', () => {
    // Found in review: this rendered an empty div. `changed` with no fields is a
    // real projection, not a host bug — `compareForPublish` returns it when
    // neither body is an object and the two differ, which the store permits
    // because it never validates a body (099 FR-010). A row reading "Active with
    // draft" beside a blank panel is the indistinguishable blank FR-012b refuses
    // one panel over; the honest report is that it differs.
    const { container } = renderSummary({ kind: 'changed', fields: [] });
    const text = container.textContent ?? '';
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/would change/i);
    // Still not the first-publish arm, and still not "nothing changed".
    expect(text).not.toMatch(/first published version/i);
    expect(text).not.toMatch(/no changes/i);
  });

  it('interpolates a field name carrying markup rather than parsing it (FR-038)', () => {
    const { container } = renderSummary({
      kind: 'changed',
      fields: [collection('<img src=x onerror="alert(1)">', { added: ['<script>alert(1)</script>'] })]
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});

describe('ChangedFieldSummary — the two arms with no fields (US5, T059, FR-009)', () => {
  it('says there is no prior version rather than listing every field as an addition', () => {
    const { container } = renderSummary({ kind: 'no-prior-version' });
    expect(fieldNames(container)).toEqual([]);
    const text = container.textContent ?? '';
    expect(text).toMatch(/first/i);
    // The failure mode this arm exists to prevent, asserted as an absence: a
    // locally computed diff against nothing produces exactly these words.
    expect(text).not.toMatch(/added/i);
    expect(text).not.toMatch(/changed:/i);
  });

  it('names nothing when the draft matches the active version', () => {
    const { container } = renderSummary({ kind: 'unchanged' });
    expect(fieldNames(container)).toEqual([]);
    expect(container.textContent ?? '').toMatch(/no changes|matches/i);
  });

  it('renders no arm it was not given — the three are exhaustive', () => {
    // A default branch would render the `changed` chrome for a kind the host
    // added later, which is the one arm that implies "review this before you
    // publish". Silence is the safe default; a wrong prompt is not.
    const source = readFileSync(resolve(__dirname, '../ChangedFieldSummary.svelte'), 'utf8');
    expect(source).not.toContain('{@html');
  });
});

describe('ChangedFieldSummary — it never blocks the publish (US5, T059, FR-026)', () => {
  it('carries none of the affordances that make a panel modal', () => {
    const { container } = renderSummary({ kind: 'changed', fields: [scalar('instruction')] });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(container.querySelector('dialog')).toBeNull();
    // Nothing to dismiss, so nothing that has to be dismissed first.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('leaves Publish present and enabled on the row it is mounted beside', () => {
    const { container } = render(DefinitionLifecycleRow, {
      props: {
        kind: 'phase' as const,
        definitionId: DEFINITION_ID,
        definitionName: 'Specify',
        lifecycle: lifecycleWithSummary({ kind: 'changed', fields: [scalar('instruction')] }),
        validity: 'effective' as const,
        defects: []
      }
    });
    expect(
      container.querySelector(`[data-testid="changed-field-summary-${DEFINITION_ID}"]`)
    ).not.toBeNull();
    const publish = container.querySelector(
      `[data-testid="definition-action-publish-${DEFINITION_ID}"]`
    ) as HTMLButtonElement | null;
    expect(publish).not.toBeNull();
    expect(publish?.disabled).toBe(false);
  });
});

describe('ChangedFieldSummary — where the row mounts it (US5, T061)', () => {
  it('shows it on a definition whose draft has a projected summary', () => {
    const { container } = renderRow(lifecycleWithSummary({ kind: 'unchanged' }));
    expect(
      container.querySelector(`[data-testid="changed-field-summary-${DEFINITION_ID}"]`)
    ).not.toBeNull();
  });

  it('shows nothing on a definition the host projected no summary for', () => {
    // `changedFields` is present only for `active-with-draft`. The row honours
    // that presence rather than re-deriving the state from `state`, so a host
    // that stopped sending it renders nothing instead of an empty panel.
    const { container } = renderRow(
      lifecycleWithSummary(undefined, { state: 'active', expectedDraftVersion: 'no-draft' })
    );
    expect(
      container.querySelector(`[data-testid="changed-field-summary-${DEFINITION_ID}"]`)
    ).toBeNull();
  });

  it('does not follow the definition into its history panel', () => {
    // The summary is about the pending publish. A version from 2024 has no
    // pending publish, and repeating the panel under every entry would say it
    // did.
    const { container } = renderRow(lifecycleWithSummary({ kind: 'unchanged' }));
    const summaries = container.querySelectorAll(
      `[data-testid="changed-field-summary-${DEFINITION_ID}"]`
    );
    expect(summaries).toHaveLength(1);
  });
});

function lifecycleWithSummary(
  changedFields: Summary | undefined,
  overrides: Partial<BuilderLifecycle> = {}
): BuilderLifecycle {
  return {
    state: 'active-with-draft' as DefinitionState,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    activeVersionId: 'v3',
    expectedDraftVersion: 'v4',
    versions: [],
    ...(changedFields ? { changedFields } : {}),
    ...overrides
  };
}

function renderRow(lifecycle: BuilderLifecycle) {
  return render(DefinitionLifecycleRow, {
    props: {
      kind: 'phase' as const,
      definitionId: DEFINITION_ID,
      definitionName: 'Specify',
      lifecycle,
      validity: 'effective' as const,
      defects: []
    }
  });
}
