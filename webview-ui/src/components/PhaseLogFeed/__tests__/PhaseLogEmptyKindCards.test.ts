// Feature 203 (T071, D9, V4, V5, FR-024, FR-037, SC-003, SC-009, SC-018) — the
// card set corresponds to the vocabulary, asserted as a set difference in BOTH
// directions.
//
// WHY BOTH DIRECTIONS. A member with no card is an operator staring at a blank
// region — the defect this feature exists to remove, measured at 4 of 5 before
// it (T006). A card with no member is copy that will be maintained forever and
// never shown, and `FR-037` requires such a member be removed rather than left
// with a card nobody can reach. Neither direction implies the other, and equal
// counts imply neither: seven equals seven is satisfied by two sets that
// disagree about one member each way.
//
// THE TWO DIRECTIONS ARE ASKED DIFFERENTLY, on purpose.
//
//   Member -> card is asked by RENDERING. `V4` records why: the card set is
//   component behaviour, not a textual copy of the vocabulary, and rendering the
//   component with a member and finding its card is a stronger claim than
//   finding a string in markup.
//
//   Card -> member is asked of the component's OWN inventory, because rendering
//   cannot answer it. A card nothing can reach renders in no test, so a
//   render-only gate reports green about precisely the card it exists to find.
//   The inventory is the `data-empty-kind` attribute, which the component
//   carries for this purpose and which is the member's own spelling — so the
//   correspondence stays derivable instead of tabulated in a table that would be
//   one more hand-maintained copy of the enumeration.
//
// `entries-present` IS A MEMBER WITH NO CARD, by construction: the reading pane
// is its rendering. It is excluded from the member->card direction by name and
// asserted separately to render nothing at all — eight members, seven cards.
//
// THE NO-PHASE CARD IS OUTSIDE THE CORRESPONDENCE (`V5`). It is reached before
// any read happens, so no member is produced and none should be. It therefore
// carries no `data-empty-kind`, which makes the exception structural rather than
// a name on an exemption list: it is not in the inventory because it is not that
// kind of card. That absence is measured below, not assumed — an exception
// nobody checks is how a card quietly leaves the correspondence.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import PhaseLogEmptyStates from '../PhaseLogEmptyStates.svelte';
// The RUNTIME array (D1). A test written against the erased union would restate
// the members, and that copy is the one that decides whether the others are
// checked. `webview-host-import-direction.test.ts` exempts test files from its
// bundle rule while requiring the module to be on its allowlist, which
// `src/services/phase-log/types` is.
import {
  PHASE_LOG_EMPTY_KINDS,
  type PhaseLogEmptyKind,
  type VerboseDiagnosticsBanner
} from '../../../../../src/services/phase-log/types';

vi.mock('../../../lib/phase-log-ipc', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/phase-log-ipc')>(
    '../../../lib/phase-log-ipc'
  );
  return { ...actual, openVerboseSetting: vi.fn() };
});

afterEach(cleanup);

const COMPONENT_SOURCE = resolve(__dirname, '../PhaseLogEmptyStates.svelte');
const SETTING_KEY = 'schegent.logging.verbose';

/** The one member the reading pane renders, so the card set is seven and not eight. */
const RENDERS_THE_READING_PANE = 'entries-present';

/** The `V5` card, identified by the test id it renders under rather than by a member. */
const NO_PHASE_CARD = 'phase-log-empty-no-phase';

/**
 * A floor under the inventory parse. Seven cards today; a parse returning fewer
 * than five found a reformatted component, not a smaller card set — and every
 * assertion here is a set difference, which is green against nothing.
 */
const MIN_CARDS = 5;

type CardKind = Exclude<PhaseLogEmptyKind, typeof RENDERS_THE_READING_PANE>;

const CARD_MEMBERS: readonly CardKind[] = PHASE_LOG_EMPTY_KINDS.filter(
  (kind): kind is CardKind => kind !== RENDERS_THE_READING_PANE
);

function bannerFor(kind: PhaseLogEmptyKind): VerboseDiagnosticsBanner {
  return kind === 'diagnostics-disabled'
    ? { kind, settingKey: SETTING_KEY }
    : ({ kind } as VerboseDiagnosticsBanner);
}

/** Every `data-empty-kind` the component declares — its own inventory of cards. */
function cardInventory(): readonly string[] {
  const source = readFileSync(COMPONENT_SOURCE, 'utf8');
  return [...source.matchAll(/data-empty-kind="([a-z][a-z0-9-]*)"/g)].map(
    (match) => match.at(1) ?? ''
  );
}

/** The `data-empty-kind` values actually rendered for a banner. */
function renderedKinds(banner: VerboseDiagnosticsBanner | null, noPhaseSelected = false): string[] {
  const { container } = render(PhaseLogEmptyStates, { props: { banner, noPhaseSelected } });
  return [...container.querySelectorAll('[data-empty-kind]')].map(
    (element) => element.getAttribute('data-empty-kind') ?? ''
  );
}

describe('feature 203 — every kind of nothing has exactly one card, and every card a kind', () => {
  it('reaches a card inventory to compare against', () => {
    // Vacuity control for the direction that is a set difference over the
    // inventory. If the attribute is renamed or dropped, this says so rather
    // than reporting an empty disagreement.
    expect(
      cardInventory().length,
      'PhaseLogEmptyStates.svelte declares fewer data-empty-kind cards than it can ' +
        'possibly have — the attribute was renamed, and this gate is reading nothing'
    ).toBeGreaterThanOrEqual(MIN_CARDS);
    expect(
      CARD_MEMBERS.length,
      'the enumeration lost members, or gained entries-present'
    ).toBeGreaterThanOrEqual(MIN_CARDS);
  });

  it('every member that is not the reading pane renders exactly one card, its own', () => {
    const wrong: string[] = [];
    for (const kind of CARD_MEMBERS) {
      const rendered = renderedKinds(bannerFor(kind));
      cleanup();
      if (rendered.length !== 1 || rendered[0] !== kind) {
        wrong.push(`${kind} -> [${rendered.join(', ')}]`);
      }
    }
    expect(
      wrong,
      'SC-003 / FR-024: each of these members reports a kind of nothing the operator is ' +
        'shown nothing about, or is shown the wrong card for. A member with no card is the ' +
        'blank region this feature exists to remove.'
    ).toEqual([]);
  });

  it('every card the component declares is reachable from a member', () => {
    const enumerated = new Set<string>(PHASE_LOG_EMPTY_KINDS);
    const unreachable = cardInventory().filter((kind) => !enumerated.has(kind));
    expect(
      unreachable,
      'SC-009 / FR-037: these cards can never be shown, because no member of ' +
        'PHASE_LOG_EMPTY_KINDS produces them. Dead copy is maintained forever and read by ' +
        'nobody; delete the card, or add the member with a production site that reaches it.'
    ).toEqual([]);
  });

  it('no card is declared twice, so the correspondence is one-to-one', () => {
    const inventory = cardInventory();
    const duplicated = inventory.filter((kind, index) => inventory.indexOf(kind) !== index);
    expect(
      duplicated,
      'two cards share a data-empty-kind, so one of them is unreachable behind the other ' +
        'in the branch chain and the direction above would report green about it'
    ).toEqual([]);
  });

  it('entries-present renders the reading pane and no card at all', () => {
    expect(
      renderedKinds(bannerFor(RENDERS_THE_READING_PANE)),
      'eight members, seven cards: entries-present is the one the reading pane renders'
    ).toEqual([]);
  });

  it('V5: the no-phase card is outside the correspondence, and structurally so', () => {
    // It renders — so it is not dead copy — and it carries no member spelling,
    // which is why the direction above does not report it as an unreachable card.
    const { getByTestId, container } = render(PhaseLogEmptyStates, {
      props: { banner: null, noPhaseSelected: true }
    });
    expect(getByTestId(NO_PHASE_CARD)).toBeTruthy();
    expect(
      container.querySelectorAll('[data-empty-kind]').length,
      'the no-phase card acquired a member spelling. It is reached before any read happens, ' +
        'so no member is produced and none should be (V5, FR-019).'
    ).toBe(0);
  });
});
