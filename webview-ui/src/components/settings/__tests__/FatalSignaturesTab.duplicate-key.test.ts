/**
 * The `{#each}` key on the operator-defined list, pinned.
 *
 * `StringListField` learned this the hard way: keying rows by their VALUE
 * throws `each_key_duplicate` the moment two rows hold the same string, and
 * that error takes the whole Settings tab down rather than the one list. The
 * fix there is keyed by index and pinned by
 * `environment-policy-line.test.ts:145`. This tab has the same `(i)` key and,
 * until this file, no such test — while being the more exposed of the two.
 *
 * More exposed because the duplicate does not need a hand-edited
 * `settings.json` to arrive. This tab permits duplicates by design: it warns
 * about them (`intraOperatorDupes`) and saves anyway, because the host merger
 * dedupes. Two clicks of Add and the same text twice is enough. So a
 * maintainer who "corrects" `(i)` to `(entry)` — the change that looks right,
 * and the one somebody already made in the other file — reintroduces a crash
 * that no other test in the suite would catch.
 *
 * Recorded from `FR-R3-143` (T045); see
 * `docs/features/bugs/DONE_two-list-editors-diverge-on-one-settings-surface.md`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import FatalSignaturesTab from '../FatalSignaturesTab.svelte';
import type { GeneralSettings, WorkflowSnapshot } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';

afterEach(cleanup);

/**
 * The tab reads `snapshot.generalSettings` and nothing else, so the fixture
 * carries that and is cast rather than built whole — the same shape the other
 * settings tests use.
 */
function snapshotWithSignatures(fatalSignatures: readonly string[]): WorkflowSnapshot {
  const generalSettings: GeneralSettings = {
    ...IDLE_GENERAL_SETTINGS,
    fatalSignatures: Object.freeze([...fatalSignatures]) as readonly string[]
  };
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    generalSettings
  }) as unknown as WorkflowSnapshot;
}

function operatorRows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('[data-testid^="fatal-operator-input-"]');
}

describe('FatalSignaturesTab — the operator list survives a duplicate (FR-R3-143 T045)', () => {
  it('renders both rows when the projected list carries the same signature twice', () => {
    const { container } = render(FatalSignaturesTab, {
      props: { snapshot: snapshotWithSignatures(['SIGSEGV', 'SIGSEGV']) }
    });

    expect(operatorRows(container).length, 'both rows render; neither is dropped or merged').toBe(2);
  });

  it('keeps each duplicate row independently addressable and removable', () => {
    // The crash is the headline, but a key that merged rows instead of throwing
    // would be just as wrong and would leave the count above passing. Row 1 and
    // row 2 have to be two different controls.
    const { container } = render(FatalSignaturesTab, {
      props: { snapshot: snapshotWithSignatures(['SIGSEGV', 'SIGSEGV']) }
    });

    const first = container.querySelector('[data-testid="fatal-operator-input-0"]');
    const second = container.querySelector('[data-testid="fatal-operator-input-1"]');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(container.querySelector('[data-testid="fatal-operator-remove-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fatal-operator-remove-1"]')).not.toBeNull();
  });

  it('warns about the duplicate rather than silently rendering it as one row', () => {
    // The warning is what makes the duplicate a supported state rather than an
    // accident, and it is why keying by value is wrong here on purpose and not
    // merely by accident of a hand-edited file.
    const { container } = render(FatalSignaturesTab, {
      props: { snapshot: snapshotWithSignatures(['SIGSEGV', 'SIGSEGV']) }
    });

    const warning = container.querySelector('[data-testid="fatal-operator-warning-dupes"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent ?? '').toContain('SIGSEGV');
  });

  it('renders three rows when the same signature arrives three times', () => {
    const { container } = render(FatalSignaturesTab, {
      props: { snapshot: snapshotWithSignatures(['OOM', 'OOM', 'OOM']) }
    });

    expect(operatorRows(container).length).toBe(3);
  });

  it('still renders a list with no duplicates in it', () => {
    // The non-vacuity half: a key change that broke every row would fail the
    // cases above for the wrong reason, so pin the ordinary list too.
    const { container } = render(FatalSignaturesTab, {
      props: { snapshot: snapshotWithSignatures(['SIGSEGV', 'OOM']) }
    });

    expect(operatorRows(container).length).toBe(2);
    expect(container.querySelector('[data-testid="fatal-operator-warning-dupes"]')).toBeNull();
  });
});
