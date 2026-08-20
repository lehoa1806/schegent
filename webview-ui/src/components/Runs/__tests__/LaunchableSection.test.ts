// Feature 102 (FR-R3-018) T009 — one section of the launch surface.
//
// The section is what an operator reads to answer "what can I start, and is it
// the published version?". Three of its four states show no entries, so the
// arm it picks is the whole message: a workspace of unpublished drafts told to
// import is a wrong answer, and so is a still-loading host told the same. That
// is why the arms are asserted apart from one another rather than by their
// text.
//
// The FR-036 vocabulary assertions run over the component *source*, not only
// the rendered output. A second word for Active reaches the operator through
// whichever arm happens to render it, and the arm that regresses is rarely the
// one a rendering test mounted.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import LaunchableSection from '../LaunchableSection.svelte';
import type { Launchable, LaunchSection } from '../../../lib/snapshot-types';

const SECTION_SOURCE = resolve(__dirname, '../LaunchableSection.svelte');
const ROW_SOURCE = resolve(__dirname, '../LaunchableRow.svelte');

afterEach(() => cleanup());

const SHIP_IT: Launchable = {
  kind: 'pipeline',
  id: 'ship-it',
  name: 'Ship It',
  description: 'Cuts a release and files the notes.',
  activeVersionId: 'v4',
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }]
};

const TIDY_UP: Launchable = {
  kind: 'pipeline',
  id: 'tidy-up',
  name: 'Tidy Up',
  activeVersionId: 'v1',
  inputs: []
};

function renderSection(section: LaunchSection | undefined, name = 'Pipelines') {
  return render(LaunchableSection, {
    props: { name, kind: 'pipeline' as const, section, selection: null, onSelect: () => {} }
  });
}

function entries(...items: readonly Launchable[]): LaunchSection {
  return { state: 'entries', entries: items };
}

function testid(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function visibleText(container: HTMLElement): string {
  return container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// ---------------------------------------------------------------------------
// FR-035 — a labelled region, and a list that is a list
// ---------------------------------------------------------------------------

describe('LaunchableSection — the region is labelled (FR-035)', () => {
  it('is a region whose accessible name is the section heading', () => {
    const { container } = renderSection(entries(SHIP_IT), 'Pipelines');
    const region = testid(container, 'launch-section-pipeline');

    expect(region).not.toBeNull();
    const labelledBy = region!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`#${labelledBy}`)?.textContent?.trim()).toBe('Pipelines');
  });

  it('takes the accessible name from the name it is given, not a hardcoded one', () => {
    const { container } = renderSection(entries(SHIP_IT), 'Workflows');
    const region = testid(container, 'launch-section-pipeline');
    const labelledBy = region!.getAttribute('aria-labelledby');

    expect(container.querySelector(`#${labelledBy}`)?.textContent?.trim()).toBe('Workflows');
  });

  it('names the kind in its handles so the two sections do not share one', () => {
    const { container } = render(LaunchableSection, {
      props: {
        name: 'Workflows',
        kind: 'workflow' as const,
        section: entries(SHIP_IT),
        selection: null,
        onSelect: () => {}
      }
    });

    expect(testid(container, 'launch-section-workflow')).not.toBeNull();
    expect(testid(container, 'launch-section-pipeline')).toBeNull();
  });

  it('exposes the entries as a list, one item per entry', () => {
    const { container } = renderSection(entries(SHIP_IT, TIDY_UP));
    const list = testid(container, 'launch-section-list-pipeline');

    expect(list).not.toBeNull();
    expect(list!.getAttribute('role') ?? list!.tagName.toLowerCase()).toMatch(/^(list|ul)$/);
    expect(list!.querySelectorAll('li')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// One row per entry
// ---------------------------------------------------------------------------

describe('LaunchableSection — one row per entry', () => {
  it('shows the name, the description, and the active version', () => {
    const { container } = renderSection(entries(SHIP_IT));
    const row = testid(container, 'launchable-row-pipeline-ship-it');

    expect(row).not.toBeNull();
    expect(visibleText(row!)).toContain('Ship It');
    expect(visibleText(row!)).toContain('Cuts a release and files the notes.');
    expect(visibleText(row!)).toContain('v4');
  });

  it('renders a row for an entry with no description', () => {
    // `description` is optional on the projection. An entry without one is a
    // definition whose author wrote none, not a broken row.
    const { container } = renderSection(entries(TIDY_UP));
    const row = testid(container, 'launchable-row-pipeline-tidy-up');

    expect(row).not.toBeNull();
    expect(visibleText(row!)).toContain('Tidy Up');
    expect(visibleText(row!)).toContain('v1');
  });

  it('keeps the projection order', () => {
    // The projection sorts (FR-001). A component that sorted again would be a
    // second ordering to keep in step with the first.
    const { container } = renderSection(entries(TIDY_UP, SHIP_IT));
    const rows = [...container.querySelectorAll('[data-testid^="launchable-row-"]')];

    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'launchable-row-pipeline-tidy-up',
      'launchable-row-pipeline-ship-it'
    ]);
  });
});

// ---------------------------------------------------------------------------
// FR-006 — the loading arm is not an empty arm
// ---------------------------------------------------------------------------

describe('LaunchableSection — the four arms are four (FR-006)', () => {
  it('renders a loading arm when the section is absent', () => {
    const { container } = renderSection(undefined);

    expect(testid(container, 'launch-section-loading-pipeline')).not.toBeNull();
    expect(testid(container, 'launch-section-list-pipeline')).toBeNull();
  });

  it('renders the loading arm distinctly from the no-definitions arm', () => {
    const { container: loading } = renderSection(undefined);
    const { container: empty } = renderSection({ state: 'no-definitions' });

    expect(testid(loading, 'launch-section-loading-pipeline')).not.toBeNull();
    expect(testid(empty, 'launch-section-loading-pipeline')).toBeNull();
    expect(visibleText(loading)).not.toBe(visibleText(empty));
  });

  it('renders the loading arm distinctly from the none-active arm', () => {
    const { container: loading } = renderSection(undefined);
    const { container: empty } = renderSection({ state: 'none-active' });

    expect(testid(loading, 'launch-section-loading-pipeline')).not.toBeNull();
    expect(testid(empty, 'launch-section-loading-pipeline')).toBeNull();
    expect(visibleText(loading)).not.toBe(visibleText(empty));
  });

  it('renders no entry list in any of the three empty states', () => {
    for (const section of [undefined, { state: 'no-definitions' } as const, { state: 'none-active' } as const]) {
      const { container } = renderSection(section);
      expect(testid(container, 'launch-section-list-pipeline')).toBeNull();
      cleanup();
    }
  });

  it('keeps the labelled region in every arm', () => {
    // The heading is what tells an operator which section is loading or empty.
    for (const section of [undefined, { state: 'no-definitions' } as const, { state: 'none-active' } as const]) {
      const { container } = renderSection(section);
      expect(testid(container, 'launch-section-pipeline')).not.toBeNull();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// FR-036 — one word for the state, one for the action
// ---------------------------------------------------------------------------

describe('LaunchableSection — the vocabulary is the Builder\'s (FR-036)', () => {
  it('calls the state Active', () => {
    const { container } = renderSection(entries(SHIP_IT));
    const row = testid(container, 'launchable-row-pipeline-ship-it');

    expect(visibleText(row!)).toContain('Active');
  });

  it('introduces no second word for the state', () => {
    // Source, not rendered output: a synonym reaches the operator through
    // whichever arm renders it, and no single mount covers all four.
    const source = readFileSync(SECTION_SOURCE, 'utf8') + readFileSync(ROW_SOURCE, 'utf8');

    for (const forbidden of ['withdrawn', 'enabled', 'live version', 'current version']) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('introduces no second word for the action', () => {
    // "Publish" is asserted positively in T045, on the none-Active arm, which is
    // the one place this surface names the action at all — FR-004 keeps Runs
    // from offering it. What is checkable here is that no synonym appears in
    // its place.
    const source = readFileSync(SECTION_SOURCE, 'utf8') + readFileSync(ROW_SOURCE, 'utf8');

    for (const forbidden of ['activate', 'make live', 'go live', 'release it']) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
  });
});
