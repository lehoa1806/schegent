// Feature 101 (US6, T062, FR-032, FR-033, SC-008) — the empty Builder front door.
//
// SC-008 asks for the two surfaces to match "character for character". A test
// that spelled the expected words out would pass while agreeing with neither: it
// would pin this component to a third copy of the string. So the assertions
// compare against the shared constant itself, and a second pair of assertions
// pins the mechanism — that both surfaces *import* it — because equality against
// a constant is satisfiable by a literal that happens to match today.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import CatalogEmptyState from '../CatalogEmptyState.svelte';
import { EMPTY_CATALOG_GUIDANCE } from '../../../../../src/contracts/empty-catalog-guidance';

vi.mock('../../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-empty-state' }))
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => {}) }
}));

const COMPONENT = resolve(__dirname, '../CatalogEmptyState.svelte');
const RUNS_SURFACE = resolve(__dirname, '../../RunsSurface.svelte');

afterEach(() => cleanup());

function renderEmpty(opts: { kind?: 'phase' | 'pipeline' | 'workflow'; count?: number } = {}) {
  return render(CatalogEmptyState, {
    props: { kind: opts.kind ?? 'pipeline', count: opts.count ?? 0 }
  });
}

function text(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent?.trim() ?? '';
}

describe('CatalogEmptyState — the words are the shared ones (US6, T062, FR-032)', () => {
  it('renders the shared headline verbatim', () => {
    const { container } = renderEmpty();
    expect(text(container, 'catalog-empty-headline-pipeline')).toBe(EMPTY_CATALOG_GUIDANCE.headline);
  });

  it('renders the shared body verbatim', () => {
    const { container } = renderEmpty();
    expect(text(container, 'catalog-empty-body-pipeline')).toBe(EMPTY_CATALOG_GUIDANCE.body);
  });

  it('imports the constant rather than restating it', () => {
    // The assertion that actually holds SC-008. Equality above passes for a
    // literal that matches on the day it was typed; this one fails the moment
    // the words are copied into this file instead of imported.
    const source = readFileSync(COMPONENT, 'utf8');
    expect(source).toContain('empty-catalog-guidance');
    expect(source).not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
    expect(source).not.toContain('Import a process document');
  });

  it('shares that constant with the Runs surface (SC-008)', () => {
    // The other half of the contract. If the Runs surface ever inlines the
    // text, the two can drift without either file's own tests noticing.
    const runs = readFileSync(RUNS_SURFACE, 'utf8');
    expect(runs).toContain('empty-catalog-guidance');
    expect(runs).not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
  });

  it('asks the shared rule when to show, rather than testing the count itself', () => {
    // FR-032 is a claim about both surfaces. A zero check written here is a
    // second copy of a rule that has to change in one place. The grep is over
    // raw source, comments included — a comment that spells the check out reads
    // to the next author as permission to write it.
    const source = readFileSync(COMPONENT, 'utf8');
    expect(source).toContain('emptyCatalogGuidance(');
    expect(source).not.toContain('count === 0');
  });

  it('names the tab in its handle so three tabs do not share one', () => {
    const { container } = renderEmpty({ kind: 'workflow' });
    expect(container.querySelector('[data-testid="catalog-empty-state-workflow"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="catalog-empty-state-pipeline"]')).toBeNull();
  });
});

describe('CatalogEmptyState — it goes away once there is something (US6, T062, FR-033)', () => {
  it('renders nothing at all for a catalog with one definition', () => {
    const { container } = renderEmpty({ count: 1 });
    expect(container.querySelector('[data-testid="catalog-empty-state-pipeline"]')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('renders nothing for a catalog with many', () => {
    const { container } = renderEmpty({ count: 50 });
    expect(container.textContent?.trim()).toBe('');
  });

  it('does not leave the import affordance behind when the guidance goes', () => {
    // The import region is part of the front door, not a permanent fixture the
    // guidance sits on top of. The tabs mount their own once they have rows.
    const { container } = renderEmpty({ count: 1 });
    expect(container.querySelector('[data-testid="process-import-preflight"]')).toBeNull();
  });
});

describe('CatalogEmptyState — the remedy is reachable (US6, T064)', () => {
  it('offers the import action beside the guidance', () => {
    // "Import a process document to get started" beside no way to import one is
    // an instruction, not a front door. On the Pipelines and Workflows tabs this
    // is the only import entry that exists.
    const { container } = renderEmpty();
    expect(container.querySelector('[data-testid="process-import-preflight"]')).not.toBeNull();
  });

  it('passes the tab\'s reason through when an import cannot start', () => {
    const { container } = render(CatalogEmptyState, {
      props: { kind: 'pipeline' as const, count: 0, disabledReason: 'A save is in flight.' }
    });
    expect(text(container, 'process-import-unavailable')).toBe('A save is in flight.');
  });
});
