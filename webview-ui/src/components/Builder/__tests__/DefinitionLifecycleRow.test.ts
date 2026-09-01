// Feature 101 (US1, T033/T034a) — what a definition row renders.
//
// Feature 186 (US1, T004, D-1) — trimmed to the state-badge and validity-badge
// assertions only. Everything else this file used to cover (cells, defects,
// summary, actions, history) moved to `DefinitionLifecyclePanel.test.ts` in the
// same phase that moved the markup it addresses out of this component.
//
// The companion is `definition-row-state.test.ts`, which pins the derivation.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
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
}

function renderRow(opts: RowOpts = {}) {
  return render(DefinitionLifecycleRow, {
    props: {
      definitionId: opts.definitionId ?? 'speckit-specify',
      lifecycle: 'lifecycle' in opts ? opts.lifecycle : lifecycle(),
      validity: opts.validity ?? 'effective'
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

describe('DefinitionLifecycleRow — a host with no catalog store wired (US1, T033)', () => {
  it('renders no state badge at all rather than inventing a value', () => {
    // `lifecycle` is optional on all three record shapes precisely so a host
    // without the store has nothing to invent (snapshot-types.ts, T018). An
    // absent projection must read as absent chrome, not as a Draft badge.
    const { container } = renderRow({ lifecycle: undefined });
    expect(container.querySelector('[data-testid="definition-row-state-speckit-specify"]')).toBeNull();
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
  });

  it('renders invalid on a definition the host could not resolve', () => {
    const { container } = renderRow({ validity: 'invalid' });
    expect(cell(container, 'validity')).toBe('invalid');
  });

  it('keeps the validity badge keyed to its status class, as the list chrome had it', () => {
    const { container } = renderRow({ validity: 'invalid' });
    const badge = container.querySelector('[data-testid="definition-row-validity-speckit-specify"]');
    expect(badge?.className).toContain('status-invalid');
  });
});
