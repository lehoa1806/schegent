// Feature 101 (US1, T034) — the row's derived view formats and gates. Nothing else.
//
// The whole point of this module is what it does *not* do. FR-010 puts lifecycle
// state, changed-field summaries, and validity entirely on the host, and the
// standing hazard is that a display helper quietly grows a second answer beside
// the authoritative one — a badge label inferred from timestamps, a "modified"
// cell suppressed because it looked equal to "created", an action hidden because
// the surface guessed the host would refuse it. Every case below pins one of
// those non-behaviours, so the drift is a failing test rather than a surface that
// disagrees with the store.
//
// The companion is `DefinitionLifecycleRow.test.ts`, which pins the rendering.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EM_DASH,
  deriveDefinitionRowView,
  formatDefinitionTimestamp
} from '../definition-row-state';
import { formatAbsoluteTime } from '../../../lib/format';
import type { BuilderLifecycle, DefinitionState } from '../../../lib/snapshot-types';

const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');
const UPDATED_AT = Date.parse('2026-03-04T18:42:30.000Z');

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

describe('definition-row-state — the state badge label (US1, T034)', () => {
  it('labels each of the three states the host can project', () => {
    expect(deriveDefinitionRowView(lifecycle({ state: 'draft' })).stateBadge).toBe('Draft');
    expect(deriveDefinitionRowView(lifecycle({ state: 'active' })).stateBadge).toBe('Active');
    expect(deriveDefinitionRowView(lifecycle({ state: 'active-with-draft' })).stateBadge).toBe(
      'Active with draft'
    );
  });

  it('reads the label off the projected state and nothing else', () => {
    // The two facts a second derivation would reach for: a draft token that says
    // a draft exists, and an absent active version. Both contradict `state:
    // 'active'` here, and the badge still reads Active — because the state is the
    // host's to compute (FR-005/FR-010) and this module only names it.
    const contradictory = lifecycle({
      state: 'active',
      expectedDraftVersion: 'draft-99',
      activeVersionId: undefined
    });
    expect(deriveDefinitionRowView(contradictory).stateBadge).toBe('Active');
  });
});

describe('definition-row-state — the timestamp cells (US1, T034)', () => {
  it('formats created and modified through the shared absolute formatter', () => {
    const view = deriveDefinitionRowView(lifecycle());
    // Equality against `formatAbsoluteTime` is the claim: one formatter for
    // absolute times in this webview, not a second one grown here. The regex
    // pins the shape without pinning the runner's timezone.
    expect(view.createdDisplay).toBe(formatAbsoluteTime(new Date(CREATED_AT).toISOString()));
    expect(view.modifiedDisplay).toBe(formatAbsoluteTime(new Date(UPDATED_AT).toISOString()));
    expect(view.createdDisplay).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(view.modifiedDisplay).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(view.createdDisplay).not.toBe(view.modifiedDisplay);
  });

  it('performs no comparison between the two instants', () => {
    // Both directions of the comparison a display helper is tempted to make:
    // equal instants collapsed to one cell, and an `updatedAt` behind
    // `createdAt` "corrected" by swapping them. Neither happens — the module
    // renders what it was given (data-model.md §6, right column).
    const equal = deriveDefinitionRowView(lifecycle({ updatedAt: CREATED_AT }));
    expect(equal.modifiedDisplay).toBe(equal.createdDisplay);
    expect(equal.modifiedDisplay).not.toBe('');

    const inverted = deriveDefinitionRowView(
      lifecycle({ createdAt: UPDATED_AT, updatedAt: CREATED_AT })
    );
    expect(inverted.createdDisplay).toBe(formatAbsoluteTime(new Date(UPDATED_AT).toISOString()));
    expect(inverted.modifiedDisplay).toBe(formatAbsoluteTime(new Date(CREATED_AT).toISOString()));
  });

  it('renders an em dash rather than NaN for an instant that will not parse', () => {
    // A broken projection is still not licence to print "NaN" into a cell. The
    // same em dash FR-014 spends on an absent active version does here, for the
    // same reason: a cell that reads as machinery leaking is worse than a cell
    // that reads as absent.
    expect(formatDefinitionTimestamp(Number.NaN)).toBe(EM_DASH);
    expect(formatDefinitionTimestamp(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
    const broken = deriveDefinitionRowView(lifecycle({ updatedAt: Number.NaN }));
    expect(broken.modifiedDisplay).toBe(EM_DASH);
  });

  it('renders an em dash for an instant past what a Date can hold, rather than throwing', () => {
    // Found in review. `Number.isFinite` alone let this through, and the failure
    // was not a bad cell: `new Date(9e15).toISOString()` throws a `RangeError`,
    // inside the row's derivation, so the whole tab stops rendering.
    //
    // Reachable because the manifest's own guard is `Number.isSafeInteger`,
    // whose ceiling sits ~367,000 years past the `Date` maximum. Every instant
    // in that gap parses out of a hand-edited manifest and reaches this line.
    const DATE_MAX = 8_640_000_000_000_000;
    expect(() => formatDefinitionTimestamp(DATE_MAX + 1)).not.toThrow();
    expect(formatDefinitionTimestamp(DATE_MAX + 1)).toBe(EM_DASH);
    expect(formatDefinitionTimestamp(Number.MAX_SAFE_INTEGER)).toBe(EM_DASH);
    expect(formatDefinitionTimestamp(-DATE_MAX - 1)).toBe(EM_DASH);
    const derived = deriveDefinitionRowView(lifecycle({ createdAt: Number.MAX_SAFE_INTEGER }));
    expect(derived.createdDisplay).toBe(EM_DASH);

    // The boundary itself is a real instant and still formats.
    expect(formatDefinitionTimestamp(DATE_MAX)).not.toBe(EM_DASH);
  });
});

describe('definition-row-state — the active-version cell (US1, T034)', () => {
  it('shows the id the host projected', () => {
    expect(deriveDefinitionRowView(lifecycle({ activeVersionId: 'ver-7' })).activeVersionCell).toBe(
      'ver-7'
    );
  });

  it('renders an em dash when nothing is published, never a stringified absence (FR-006, FR-014)', () => {
    const view = deriveDefinitionRowView(lifecycle({ state: 'draft', activeVersionId: undefined }));
    expect(view.activeVersionCell).toBe(EM_DASH);
    expect(view.activeVersionCell).not.toBe('null');
    expect(view.activeVersionCell).not.toBe('undefined');
    expect(view.activeVersionCell).not.toBe('');
  });

  it('keys on presence, not on which version is active', () => {
    // FR-006 makes the absent case *absent* so the surface never has to read a
    // sentinel. An empty string is what a host that missed FR-006 would send,
    // and it is the one value that must not render as a published version.
    expect(
      deriveDefinitionRowView(lifecycle({ activeVersionId: '' })).activeVersionCell
    ).toBe(EM_DASH);
  });
});

describe('definition-row-state — which actions to offer (US1, T034)', () => {
  it('offers Publish and Discard on a draft, and never Deactivate (quickstart §3)', () => {
    expect(deriveDefinitionRowView(lifecycle({ state: 'draft' })).actions).toEqual([
      'publish',
      'discard-draft'
    ]);
  });

  it('offers only Deactivate on an Active definition', () => {
    expect(deriveDefinitionRowView(lifecycle({ state: 'active' })).actions).toEqual(['deactivate']);
  });

  it('offers all three on Active with draft', () => {
    expect(deriveDefinitionRowView(lifecycle({ state: 'active-with-draft' })).actions).toEqual([
      'publish',
      'discard-draft',
      'deactivate'
    ]);
  });

  it('never offers Restore from a row, because Restore belongs to history (FR-019)', () => {
    const states: readonly DefinitionState[] = ['draft', 'active', 'active-with-draft'];
    for (const state of states) {
      expect(deriveDefinitionRowView(lifecycle({ state })).actions).not.toContain('restore');
    }
  });

  it('decides from the state alone, not from whether an action would succeed', () => {
    // An invalid definition would have its publish refused by the host gate
    // (FR-023), and a surface that pre-empted the refusal would hide the control
    // that produces the defect report. Validity is not an input here at all —
    // this shape has no field for it.
    const invalidLooking = lifecycle({ state: 'active-with-draft', versions: Object.freeze([]) });
    expect(deriveDefinitionRowView(invalidLooking).actions).toContain('publish');
  });
});

describe('definition-row-state — the view is inert (US1, T034, FR-010)', () => {
  it('mutates nothing it is handed', () => {
    const input = lifecycle();
    const before = JSON.stringify(input);
    deriveDefinitionRowView(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns the same view for the same record', () => {
    const input = lifecycle({ state: 'active-with-draft' });
    expect(deriveDefinitionRowView(input)).toEqual(deriveDefinitionRowView(input));
  });

  it('sends nothing back: the module reaches no IPC sender', () => {
    // FR-010's second half — no formatted string is ever sent back over IPC. The
    // enforceable form of that is a module with no way to send: an import of the
    // transport or of the lifecycle helper is the only route from here to the
    // host, so their absence from the source is the assertion.
    const source = readFileSync(resolve(__dirname, '../definition-row-state.ts'), 'utf8');
    expect(source).not.toMatch(/from '.*vscode-api'/);
    expect(source).not.toMatch(/from '.*catalog-lifecycle'/);
    expect(source).not.toContain('postCommand');
    expect(source).not.toContain('postMessage');
  });
});
