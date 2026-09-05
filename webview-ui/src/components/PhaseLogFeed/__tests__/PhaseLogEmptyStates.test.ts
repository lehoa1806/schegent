// Feature 020 T022 — PhaseLogEmptyStates: no-log card vs.
// verbose-off guidance card; "Open Settings" button posts via the
// shared helper (no inline `postCommand`).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseLogEmptyStates from '../PhaseLogEmptyStates.svelte';
// Feature 203 (D1) — the enumeration is imported as a RUNTIME array, not restated.
// A test written against the erased union would have to name the members itself,
// and that copy is the one deciding whether the others are checked. The value
// import is allowed here because `webview-host-import-direction.test.ts` exempts
// test files from its bundle rule (tests are not bundled) while still requiring
// the module to be on its allowlist, which `src/services/phase-log/types` is.
import {
  PHASE_LOG_EMPTY_KINDS,
  type PhaseLogEmptyKind,
  type VerboseDiagnosticsBanner
} from '../../../../../src/services/phase-log/types';

const openVerboseSettingSpy = vi.fn();
vi.mock('../../../lib/phase-log-ipc', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/phase-log-ipc')>(
    '../../../lib/phase-log-ipc'
  );
  return {
    ...actual,
    openVerboseSetting: (...args: unknown[]) => openVerboseSettingSpy(...args)
  };
});

afterEach(() => {
  cleanup();
  openVerboseSettingSpy.mockReset();
});

describe('Feature 020 T022 — PhaseLogEmptyStates', () => {
  it('renders the no-log card when banner.kind === phase-not-recorded', () => {
    const banner: VerboseDiagnosticsBanner = { kind: 'phase-not-recorded' };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(getByTestId('phase-log-empty-phase-not-recorded')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-diagnostics-disabled')).toBeNull();
    expect(queryByTestId('phase-log-empty-open-settings')).toBeNull();
  });

  it('renders the diagnostics-disabled guidance card with "Open Settings" CTA', () => {
    const banner: VerboseDiagnosticsBanner = {
      kind: 'diagnostics-disabled',
      settingKey: 'schegent.logging.verbose'
    };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(getByTestId('phase-log-empty-diagnostics-disabled')).toBeTruthy();
    expect(getByTestId('phase-log-empty-open-settings')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-phase-not-recorded')).toBeNull();
  });

  it('calls the shared phase-log-ipc.openVerboseSetting helper on Open Settings click', async () => {
    const banner: VerboseDiagnosticsBanner = {
      kind: 'diagnostics-disabled',
      settingKey: 'schegent.logging.verbose'
    };
    const { getByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    await fireEvent.click(getByTestId('phase-log-empty-open-settings'));
    expect(openVerboseSettingSpy).toHaveBeenCalledTimes(1);
  });

  it('renders no empty card when banner.kind === entries-present', () => {
    const banner: VerboseDiagnosticsBanner = { kind: 'entries-present' };
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(queryByTestId('phase-log-empty-phase-not-recorded')).toBeNull();
    expect(queryByTestId('phase-log-empty-diagnostics-disabled')).toBeNull();
  });
});

// Bug "the phase log that asked for a phase named done" (2026-09-02), second
// finding — the hole between two components that each defer to the other.
//
// Both cards above are driven by `banner`, and the host only sends a banner in
// answer to a COMPLETE tuple. A selection that names a task but no phase reads
// nothing, so `banner` stays null, so this component renders nothing — while
// `PhaseLogReadingPane` renders nothing of its own on zero entries and says so
// in a comment: "the empty-state guidance can sit in its place." Neither side
// is wrong on its own; between them the operator gets a blank pane.
//
// That state is reachable and normal: `RunDetailTier` pins a settled Run with
// `phaseId: null` by design (pinning is what keeps the workspace-wide cold-start
// fallback from redirecting the tier at another queue's task), and the Activity
// Feed reaches it whenever a task is picked without a phase.
describe('no phase selected — the third empty state', () => {
  it('names the action when a task is selected but no phase is', () => {
    const { getByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null, noPhaseSelected: true }
    });
    const card = getByTestId('phase-log-empty-no-phase');
    expect(card).toBeTruthy();
    // The card has to say what to do, not merely that nothing is here. The
    // phase strip is already on screen beside it; the gap was that nothing
    // connected the blank pane to it.
    expect(card.textContent).toMatch(/phase/i);
  });

  it('does not render when a phase IS selected and the host simply sent no banner', () => {
    // The pre-existing pass-through: a complete tuple that is still loading has
    // a null banner too, and must keep showing the reading pane rather than
    // telling the operator to pick something they have already picked.
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null, noPhaseSelected: false }
    });
    expect(queryByTestId('phase-log-empty-no-phase')).toBeNull();
  });

  it('defaults to off, so every existing caller renders exactly as before', () => {
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null }
    });
    expect(queryByTestId('phase-log-empty-no-phase')).toBeNull();
  });

  it('wins over a stale banner, because the tuple it described is gone', () => {
    // Deselecting a phase can leave the previous tuple's banner in state for a
    // frame. "Pick a phase" is true then; "no log for this phase yet" is not,
    // because there is no this-phase.
    const banner: VerboseDiagnosticsBanner = { kind: 'phase-not-recorded' };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner, noPhaseSelected: true }
    });
    expect(getByTestId('phase-log-empty-no-phase')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-phase-not-recorded')).toBeNull();
  });
});

// Feature 203 Phase 5 (US2) — each kind of nothing is named, not hedged.
//
// The population is the copy this component renders: the seven members that have
// a card, plus the no-phase-selected card. That last one is NOT a member of the
// enumeration (`V5`, `X6`), but it is a sentence an operator reads, and holding it
// to the same rule costs nothing and keeps the population the same one `SC-002`
// measured its baseline of 1 over. `entries-present` renders the reading pane and
// no card, so it is absent by construction rather than by omission.

const SETTING_KEY = 'schegent.logging.verbose';

type CardKind = Exclude<PhaseLogEmptyKind, 'entries-present'>;

const CARD_KINDS: readonly CardKind[] = PHASE_LOG_EMPTY_KINDS.filter(
  (kind): kind is CardKind => kind !== 'entries-present'
);

function bannerFor(kind: CardKind): VerboseDiagnosticsBanner {
  return kind === 'diagnostics-disabled' ? { kind, settingKey: SETTING_KEY } : { kind };
}

/** The card's visible text, whitespace collapsed so markup wrapping cannot hide a phrase. */
function cardText(kind: CardKind): string {
  const { getByTestId } = render(PhaseLogEmptyStates, { props: { banner: bannerFor(kind) } });
  return (getByTestId(`phase-log-empty-${kind}`).textContent ?? '').replace(/\s+/g, ' ').trim();
}

function noPhaseCardText(): string {
  const { getByTestId } = render(PhaseLogEmptyStates, {
    props: { banner: null, noPhaseSelected: true }
  });
  return (getByTestId('phase-log-empty-no-phase').textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * `FR-013`: a card offers more than one explanation when it declines to say which
 * of several things happened. What that reads like is epistemic hedging, so that
 * is what this matches — `may`, `might`, `possibly`, `perhaps`, `either`, and the
 * `or it …` construction that joins two candidate causes.
 *
 * Deliberately NOT the bare word "or". `phase-not-recorded` offers two ACTIONS
 * over one explanation ("pick a phase that has run, or start this one"), and
 * `FR-013` is about explanations. A detector keyed on "or" would report a card as
 * hedged for telling the operator what to do next, which is the opposite of what
 * this story asks for — `data-model.md` §1.1 gives each member an action.
 */
const HEDGE = /\b(?:may|might|maybe|possibly|perhaps|either)\b|\bor it\b/i;

describe('Feature 203 T053 — no card offers more than one explanation', () => {
  it('SC-002: the count of hedging cards is 0, over all eight rendered cards', () => {
    // Non-vacuity: the sweep must actually visit seven members plus the extra
    // card. An empty CARD_KINDS would satisfy the filter below without reading a
    // single word of copy.
    expect(CARD_KINDS, 'the enumeration lost a member, or gained entries-present').toHaveLength(7);

    const hedged = CARD_KINDS.filter((kind) => HEDGE.test(cardText(kind)));
    if (HEDGE.test(noPhaseCardText())) hedged.push('no-phase-selected' as CardKind);

    expect(
      hedged,
      `these cards decline to say which of several things happened: ${hedged.join(', ')}`
    ).toEqual([]);
  });

  it('the detector is live: the copy this story retired trips it', () => {
    // Verbatim from the card that rendered before this feature — the
    // `enabled-no-sessions-for-tuple` hint at HEAD of PhaseLogEmptyStates.svelte.
    // It is the single card behind `SC-002`'s baseline of 1, and it is quoted
    // here rather than re-derived because after this feature it cannot be
    // rendered again.
    const RETIRED_COPY =
      "The phase hasn't emitted any output for this iteration. It may not have started, or it " +
      'may have completed without producing any observable activity.';
    expect(HEDGE.test(RETIRED_COPY), 'the baseline of 1 must be reproducible').toBe(true);
  });

  it('the detector is narrow: offering two actions is not offering two explanations', () => {
    // The control for the narrowing above. Without it the detector could be the
    // bare word "or" and still pass every assertion in this block, while banning
    // the one thing `data-model.md` §1.1 asks each card to do.
    expect(HEDGE.test('Pick a phase that has run, or start this one.')).toBe(false);
    expect(cardText('phase-not-recorded')).toMatch(/\bor\b/);
  });
});

describe('Feature 203 T054 — the setting is named when, and only when, it is the cause', () => {
  it('FR-018: exactly one card names the setting, and it is diagnostics-disabled', () => {
    const naming = CARD_KINDS.filter((kind) => cardText(kind).includes(SETTING_KEY));
    expect(naming, 'the setting key belongs to exactly one card').toEqual(['diagnostics-disabled']);
  });

  it('no other card so much as mentions a setting', () => {
    // Stricter than the key itself: naming "the verbose setting" without the key
    // is the same hedge in different words.
    const mentioning = CARD_KINDS.filter((kind) => /\bsettings?\b|\bverbose\b|\bdiagnostics\b/i.test(cardText(kind)));
    expect(mentioning).toEqual(['diagnostics-disabled']);
    expect(/\bsettings?\b|\bverbose\b|\bdiagnostics\b/i.test(noPhaseCardText())).toBe(false);
  });
});

describe('Feature 203 T055 — a phase that has not run is not blamed on the setting', () => {
  it('US2 scenario 1: the phase-not-recorded card offers no alternative cause', () => {
    const text = cardText('phase-not-recorded');
    // Non-vacuity first: the card must be saying its own thing, or the negative
    // below is satisfied by a card that says nothing at all.
    expect(text).toMatch(/has not run/i);
    expect(text).toMatch(/nothing has been recorded/i);
    expect(text).not.toMatch(/verbose|diagnostic|setting/i);
    expect(HEDGE.test(text)).toBe(false);
  });
});

describe('Feature 203 T056 — each member is named after what it is keyed on', () => {
  /**
   * A member's name is a claim about the evidence that produced it (`FR-009`,
   * `C2`, `data-model.md` §1.1). The card is where that claim reaches an
   * operator, so this is where the two are held together: if a name and its copy
   * drift apart, one of them is lying and the operator gets the lie.
   */
  const NAME_KEEPS_ITS_PROMISE: ReadonlyArray<readonly [CardKind, readonly RegExp[]]> = [
    ['phase-running-no-output', [/\brunning\b/i, /not written anything yet/i]],
    ['phase-not-recorded', [/has not run/i, /nothing has been recorded/i]],
    ['diagnostics-disabled', [/is off/i, /nothing is being recorded/i]],
    ['no-iteration-recorded', [/recorded nothing/i, /holds no iteration/i]],
    ['record-path-refused', [/not a readable file/i, /is not a log/i]],
    ['record-vanished', [/was removed/i, /no longer there/i]],
    ['nothing-displayable', [/nothing this view can show/i, /none of it could be displayed/i]]
  ];

  it('the table covers the enumeration exactly, in both directions', () => {
    const tabulated = NAME_KEEPS_ITS_PROMISE.map(([kind]) => kind);
    expect(
      CARD_KINDS.filter((kind) => !tabulated.includes(kind)),
      'a member has a card but no claim about its own name'
    ).toEqual([]);
    expect(
      tabulated.filter((kind) => !CARD_KINDS.includes(kind)),
      'the table names something the enumeration does not'
    ).toEqual([]);
  });

  for (const [kind, promises] of NAME_KEEPS_ITS_PROMISE) {
    it(`${kind}'s copy is about ${kind}`, () => {
      const text = cardText(kind);
      for (const promise of promises) {
        expect(text, `${kind} does not say what its name claims`).toMatch(promise);
      }
    });
  }

  it('the old names are retired, not narrowed', () => {
    // `F1`: `enabled-with-sessions` asserted two conditions that were never both
    // checked — it came out of a single `stat`, so "with sessions" was never
    // observed at all. A name that reports on evidence nobody gathered cannot be
    // narrowed into truth; it can only be replaced by names that say what was
    // actually seen. The same goes for its two siblings, both of which described
    // the setting's state rather than the record's.
    const members: readonly string[] = PHASE_LOG_EMPTY_KINDS;
    for (const retired of [
      'enabled-with-sessions',
      'enabled-no-sessions-for-tuple',
      'disabled-no-sessions'
    ]) {
      expect(members, `${retired} survived the vocabulary change`).not.toContain(retired);
    }
    // Non-vacuity: the same list does contain what replaced them.
    expect(members).toContain('diagnostics-disabled');
    expect(members).toContain('phase-not-recorded');
  });
});

// Feature 203 Phase 6 (US3) — a card tells the operator to wait only when it is
// entitled to (`FR-016`, `FR-017`, `SC-014`).
//
// The host half lives in `tests/unit/services/phase-log/phase-log-service.test.ts`
// (T058-T060): a task in flight whose run has moved past the selected phase
// reaches `phase-not-recorded` or `nothing-displayable`, never the running
// member, and so does a task whose snapshot names no phase at all. This is the
// other half: those two cards must not SAY the phase is running either, or the
// classifier's honesty stops one component short of the operator.

/**
 * What "telling the operator to wait" reads like: a present-tense claim that the
 * phase is going, or that output is on its way. `has not run` is deliberately
 * outside it — that is a claim about the record, and `\brunning\b` does not
 * match `run`.
 */
const CLAIMS_IN_PROGRESS =
  /\b(?:is|still) running\b|\bin progress\b|\bstill (?:coming|going|producing)\b|appears here as it arrives/i;

/**
 * The members the service reaches when the containing task is in flight but the
 * selected phase is not the executing one (T058), or when the executing phase is
 * not known (T060). Listed because a webview test cannot import the service that
 * produces them; the service test names the same two members.
 */
const NOT_ENTITLED_TO_WAIT: readonly CardKind[] = ['phase-not-recorded', 'nothing-displayable'];

describe('Feature 203 T058 — only the running card tells the operator to wait', () => {
  it('SC-014: exactly one card claims the phase is in progress, and it is phase-running-no-output', () => {
    const claiming = CARD_KINDS.filter((kind) => CLAIMS_IN_PROGRESS.test(cardText(kind)));
    // Both halves at once: the detector is live (the running card trips it), and
    // no other card does — including the two a stale phase actually reaches.
    expect(claiming).toEqual(['phase-running-no-output']);
    expect(CLAIMS_IN_PROGRESS.test(noPhaseCardText())).toBe(false);
  });

  it('US3 scenario 1: the cards a moved-past phase reaches do not say it is running', () => {
    for (const kind of NOT_ENTITLED_TO_WAIT) {
      const text = cardText(kind);
      // Non-vacuity: the card is saying something of its own.
      expect(text.length).toBeGreaterThan(0);
      expect(text, `${kind} tells the operator to wait for a phase that is not running`).not.toMatch(
        CLAIMS_IN_PROGRESS
      );
    }
  });
});

describe('Feature 203 T059 — the running card says both halves', () => {
  it('US3 scenario 2: running, and nothing written yet', () => {
    const text = cardText('phase-running-no-output');
    expect(text).toMatch(/\bis running\b/i);
    expect(text).toMatch(/not written anything yet/i);
    // The wait is earned, so the card may say what waiting will produce.
    expect(text).toMatch(/appears here as it arrives/i);
  });
});

describe('Feature 203 T060 — an unknown progress is stated, not guessed', () => {
  it('FR-017: the cards an unknown progress reaches state what was observed and claim no progress', () => {
    // What each card is entitled to say is the observation that produced it —
    // an absent record, or a record read to nothing. Neither observation says
    // anything about whether the phase is still going, and neither card does.
    const OBSERVED: ReadonlyArray<readonly [CardKind, RegExp]> = [
      ['phase-not-recorded', /nothing has been recorded/i],
      ['nothing-displayable', /the stream was read/i]
    ];
    expect(OBSERVED.map(([kind]) => kind)).toEqual(NOT_ENTITLED_TO_WAIT);
    for (const [kind, observation] of OBSERVED) {
      const text = cardText(kind);
      expect(text, `${kind} does not state what it observed`).toMatch(observation);
      expect(text, `${kind} guesses at progress`).not.toMatch(CLAIMS_IN_PROGRESS);
    }
  });
});
