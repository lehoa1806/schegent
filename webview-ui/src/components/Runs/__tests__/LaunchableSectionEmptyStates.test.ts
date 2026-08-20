// Feature 102 (T043, US5) — the four things a section can show when it lists nothing.
//
// Three of the four produce an empty list: still loading, no definitions of that
// kind, and definitions of which none are Active. The fourth — an untrusted
// workspace — produces an empty list for a reason that is not about the catalog at
// all, because no catalog activated. Length cannot separate any of them, so the
// arm is chosen from state, and this file is what holds that.
//
// The distinctions are asserted as *instructions*, not as tokens. Two messages
// differing by one word are two messages an operator reads as the same one, and
// the whole of FR-028 is that a workspace of unpublished drafts must be told
// something different from a workspace with nothing in it — different enough to
// act on differently.
//
// Feature 101's rule is inherited: neither component's source carries the headline
// text. It comes from `src/contracts/empty-catalog-guidance.ts`, which is what
// makes "the two surfaces cannot drift" a property of the code rather than of
// whoever edits it next.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EMPTY_CATALOG_GUIDANCE,
  NONE_ACTIVE_GUIDANCE
} from '../../../../../src/contracts/empty-catalog-guidance';
import LaunchableSection from '../LaunchableSection.svelte';
import RunsSurface from '../../RunsSurface.svelte';
import { ANALYSIS, buildSnapshot, entries, projection } from './launch-fixture';
import type { LaunchSection } from '../../../lib/snapshot-types';

const SECTION_SOURCE = resolve(__dirname, '../LaunchableSection.svelte');
const SURFACE_SOURCE = resolve(__dirname, '../../RunsSurface.svelte');

afterEach(() => cleanup());

function renderSection(section: LaunchSection | undefined, kind: 'pipeline' | 'workflow' = 'pipeline') {
  return render(LaunchableSection, {
    props: {
      name: kind === 'pipeline' ? 'Pipelines' : 'Workflows',
      kind,
      section,
      selection: null,
      onSelect: () => {}
    }
  });
}

function testid(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function visibleText(container: HTMLElement): string {
  return container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// ---------------------------------------------------------------------------
// FR-028 — the two empty arms say different things
// ---------------------------------------------------------------------------

describe('LaunchableSection — no definitions and none Active are different messages (FR-028)', () => {
  it('shows the shared import guidance when there are no definitions of the kind', () => {
    const { container } = renderSection({ state: 'no-definitions' });

    const arm = testid(container, 'launch-section-no-definitions-pipeline');
    expect(arm).not.toBeNull();
    expect(visibleText(arm!)).toContain(EMPTY_CATALOG_GUIDANCE.headline);
    expect(visibleText(arm!)).toContain(EMPTY_CATALOG_GUIDANCE.body);
  });

  it('shows the publish guidance when definitions exist but none are Active', () => {
    const { container } = renderSection({ state: 'none-active' });

    const arm = testid(container, 'launch-section-none-active-pipeline');
    expect(arm).not.toBeNull();
    expect(visibleText(arm!)).toContain(NONE_ACTIVE_GUIDANCE.headline);
    expect(visibleText(arm!)).toContain(NONE_ACTIVE_GUIDANCE.body);
  });

  it('never shows one arm in the other one\'s state', () => {
    const { container: noneActive } = renderSection({ state: 'none-active' });
    expect(testid(noneActive, 'launch-section-no-definitions-pipeline')).toBeNull();
    expect(visibleText(noneActive)).not.toContain(EMPTY_CATALOG_GUIDANCE.headline);

    cleanup();

    const { container: noDefinitions } = renderSection({ state: 'no-definitions' });
    expect(testid(noDefinitions, 'launch-section-none-active-pipeline')).toBeNull();
    expect(visibleText(noDefinitions)).not.toContain(NONE_ACTIVE_GUIDANCE.headline);
  });

  it('differs in what it instructs, not in a single token', () => {
    // The specific wrong answer FR-028 rules out: telling a workspace of drafts to
    // import. It can import all day and Runs will still offer nothing.
    const { container } = renderSection({ state: 'none-active' });

    expect(visibleText(container).toLowerCase()).not.toContain('import');
    expect(visibleText(container)).toContain('Publish');
  });
});

// ---------------------------------------------------------------------------
// FR-006 — loading is a fourth state, not a flavour of empty
// ---------------------------------------------------------------------------

describe('LaunchableSection — loading is neither empty arm (FR-006)', () => {
  it('renders the loading arm and neither guidance while the host has not resolved', () => {
    const { container } = renderSection(undefined);

    expect(testid(container, 'launch-section-loading-pipeline')).not.toBeNull();
    expect(testid(container, 'launch-section-no-definitions-pipeline')).toBeNull();
    expect(testid(container, 'launch-section-none-active-pipeline')).toBeNull();
    expect(visibleText(container)).not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
    expect(visibleText(container)).not.toContain(NONE_ACTIVE_GUIDANCE.headline);
  });

  it('renders all three empty states as three distinct texts', () => {
    const texts = [undefined, { state: 'no-definitions' } as const, { state: 'none-active' } as const].map(
      (section) => {
        const { container } = renderSection(section);
        const text = visibleText(container);
        cleanup();
        return text;
      }
    );

    expect(new Set(texts).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// FR-031 — the two sections conclude independently
// ---------------------------------------------------------------------------

describe('RunsSurface — one section may list while the other explains (FR-031)', () => {
  it('lists Pipelines while Workflows shows the publish guidance', () => {
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({
        launchables: projection(entries(ANALYSIS), { state: 'none-active' })
      })
    });

    expect(testid(container, 'launch-section-list-pipeline')).not.toBeNull();
    expect(testid(container, 'launch-section-none-active-workflow')).not.toBeNull();
    expect(testid(container, 'launch-section-none-active-pipeline')).toBeNull();
  });

  it('lists Workflows while Pipelines shows the import guidance', () => {
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({
        launchables: projection({ state: 'no-definitions' }, entries({ ...ANALYSIS, kind: 'workflow' }))
      })
    });

    expect(testid(container, 'launch-section-list-workflow')).not.toBeNull();
    expect(testid(container, 'launch-section-no-definitions-pipeline')).not.toBeNull();
    expect(testid(container, 'launch-section-no-definitions-workflow')).toBeNull();
  });

  it('lets the two sections show different empty reasons at the same time', () => {
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({
        launchables: projection({ state: 'no-definitions' }, { state: 'none-active' })
      })
    });

    expect(testid(container, 'launch-section-no-definitions-pipeline')).not.toBeNull();
    expect(testid(container, 'launch-section-none-active-workflow')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-032 — an untrusted workspace is told about trust, not about the catalog
// ---------------------------------------------------------------------------

describe('RunsSurface — an untrusted workspace gets the trust explanation (FR-032)', () => {
  it('shows the trust explanation instead of either guidance', () => {
    // No catalog activates in an untrusted workspace, so "import a process
    // document" names an action that cannot succeed and "publish one" names a
    // surface that will refuse. Neither is the operator's next step; granting
    // trust is.
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({
        workspaceTrust: false,
        launchables: projection({ state: 'no-definitions' }, { state: 'no-definitions' })
      })
    });

    expect(testid(container, 'trust-banner-workspace-trust')).not.toBeNull();
    expect(visibleText(container)).not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
    expect(visibleText(container)).not.toContain(NONE_ACTIVE_GUIDANCE.headline);
  });

  it('suppresses the sections rather than leaving them empty beneath the banner', () => {
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({
        workspaceTrust: false,
        launchables: projection({ state: 'none-active' }, { state: 'none-active' })
      })
    });

    expect(testid(container, 'launch-section-pipeline')).toBeNull();
    expect(testid(container, 'launch-section-workflow')).toBeNull();
  });

  it('leaves a trusted workspace alone', () => {
    const { container } = render(RunsSurface, { snapshot: buildSnapshot({ workspaceTrust: true }) });

    expect(testid(container, 'trust-banner-workspace-trust')).toBeNull();
    expect(testid(container, 'launch-section-pipeline')).not.toBeNull();
  });

  it('treats an absent trust field as trusted, not as untrusted', () => {
    // `workspaceTrust` is optional on the projection for legacy hosts. Reading it
    // as falsy would hide the launch surface from every host that predates the
    // field — a fail-closed default in the one place it is wrong, since the host
    // gate, not this banner, is what actually refuses a launch.
    const snapshot = buildSnapshot();
    delete (snapshot as { workspaceTrust?: boolean }).workspaceTrust;

    const { container } = render(RunsSurface, { snapshot });

    expect(testid(container, 'trust-banner-workspace-trust')).toBeNull();
    expect(testid(container, 'launch-section-pipeline')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One shared source for the wording (feature 101's rule, inherited)
// ---------------------------------------------------------------------------

describe('the guidance text lives in the contract module, not in a component', () => {
  it('appears in neither component source', () => {
    const sources = readFileSync(SECTION_SOURCE, 'utf8') + readFileSync(SURFACE_SOURCE, 'utf8');

    for (const text of [
      EMPTY_CATALOG_GUIDANCE.headline,
      EMPTY_CATALOG_GUIDANCE.body,
      NONE_ACTIVE_GUIDANCE.headline,
      NONE_ACTIVE_GUIDANCE.body
    ]) {
      expect(sources).not.toContain(text);
    }
  });
});
