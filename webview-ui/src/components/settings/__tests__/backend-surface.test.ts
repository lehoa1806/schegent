// FR-R3-144 (T029-T037) — the settings tab's backend surface.
//
// WHAT IS BEING TESTED. Before this feature the tab named `Claude` in three
// labels, drew three CLI-path rows from an array paired with a runner list by
// INDEX, offered no way to choose a backend, and offered no per-run spend bound
// at all. An operator running Codex read a form describing a product they were
// not running. Every assertion below is about the tab stating which backend a
// thing applies to, and stating it from the projection rather than from a
// literal written next to the markup.
//
// WHAT IS DELIBERATELY NOT TESTED HERE. That the refusal sentence is the
// enforcement's own is proved one layer down, in
// `tests/unit/ui/sidebar/backend-posture-projection.test.ts`, which asserts the
// projected string is `judgeBackendContainment(...).message` verbatim for every
// backend. This file asserts the other half of that chain: whatever the
// projection carries reaches the section and the confirmation UNCHANGED. Neither
// half alone is worth much; together they are the claim T033 asks for — changing
// the policy's message changes what the operator is asked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import type {
  BackendPosture,
  BackendRunnerKind,
  GeneralSettings,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import { SUPPORTED_BACKENDS } from '../../../../../src/contracts/backend-kinds';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';
import { setUncontainedBackendGrant } from '../../../lib/uncontained-grant-ipc';
import { useConfirm } from '../../../lib/use-confirm';

vi.mock('../../../lib/vscode-api', () => ({
  postCommand: () => ({ correlationId: 'corr-test' })
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => undefined) }
}));
vi.mock('../../../lib/uncontained-grant-ipc', () => ({
  setUncontainedBackendGrant: vi.fn()
}));
vi.mock('../../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

const confirmMock = vi.mocked(useConfirm);
const grantMock = vi.mocked(setUncontainedBackendGrant);

beforeEach(() => {
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  grantMock.mockReset();
});
afterEach(() => cleanup());

// A refusal string no policy would ever produce, so an assertion that finds it on
// screen can only have got it from the projection this fixture supplied. A
// realistic sentence would also match a copy hardcoded in the component, which is
// exactly the defect these tests exist to catch.
//
// It deliberately does NOT quote the real grant-setting key, even as fixture
// prose: `tests/lint/webview-posture-derivation.test.ts` (T024) forbids that
// string anywhere under `webview-ui/src`, tests included, because a webview that
// read the raw list could derive the containment answer without ever naming a
// classification. A fixture is not an exception the gate makes, and the sentinel
// does not need the real key to be a sentinel.
const SENTINEL_REFUSAL =
  'SENTINEL-REFUSAL: this exact sentence comes from the projection and nowhere ' +
  'else; a component that composed its own would never produce it.';

function posture(
  kind: BackendRunnerKind,
  grant: BackendPosture['grant'],
  refusal?: string
): BackendPosture {
  const contained = kind === 'codex';
  return Object.freeze({
    kind,
    containment: contained ? 'os-enforced' : 'none',
    mechanism: contained ? 'codex-sandbox-workspace-write' : 'none',
    grant,
    ...(refusal === undefined ? {} : { refusal })
  }) as unknown as BackendPosture;
}

/** Every backend ungranted — the shipped state of a fresh installation. */
const UNGRANTED_POSTURES: readonly BackendPosture[] = Object.freeze([
  posture('claude', 'not-granted', SENTINEL_REFUSAL),
  posture('codex', 'not-required'),
  posture('agy', 'not-granted', "SENTINEL-REFUSAL: 'agy' has no bound.")
]);

interface Overrides {
  readonly runner?: BackendRunnerKind;
  readonly postures?: readonly BackendPosture[];
  /** Which backends the host discovered on this machine (T045). */
  readonly available?: readonly BackendRunnerKind[];
}

function buildSnapshot(overrides: Overrides = {}): WorkflowSnapshot {
  const generalSettings = Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    backendRunner: overrides.runner ?? 'claude'
  }) as unknown as GeneralSettings;
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
        summary: null,
        category: null,
        lastEventAt: null,
        freshness: 'idle',
        staleSeconds: null
      }),
      workflowElapsedMs: null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-30T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    availableBackends: overrides.available ?? Object.freeze(['claude', 'codex', 'agy']),
    backendPostures: overrides.postures ?? UNGRANTED_POSTURES,
    generalSettings
  }) as unknown as WorkflowSnapshot;
}

function mount(overrides: Overrides = {}) {
  return render(GeneralSettingsTab, { props: { snapshot: buildSnapshot(overrides) } });
}

function collapse(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** The row component's own test id, so a selector change is one edit here. */
function inputFor(key: string): string {
  return `[data-testid="general-settings-input-${key}"]`;
}

const AUTO_COMPACT_INPUT = inputFor('claudeAutoCompactPctOverride');
const RUNNER_INPUT = inputFor('backendRunner');
const USD_INPUT = inputFor('spendMaxUsdPerRun');
const TOKENS_INPUT = inputFor('spendMaxTokensPerRun');

describe('FR-R3-144 T029/T030 — backend-specific settings are sited by backend', () => {
  it('renders the Claude auto-compaction control inside the Claude section and nowhere else', () => {
    const { container } = mount();
    const claudeSection = container.querySelector('[data-testid="backend-health-claude"]');
    expect(claudeSection, 'the Claude section must exist').not.toBeNull();

    const control = container.querySelector(AUTO_COMPACT_INPUT);
    expect(control, 'the auto-compaction control must be rendered').not.toBeNull();
    expect(
      claudeSection?.contains(control as Node),
      'the setting only Claude honours belongs in Claude’s section — its label was ' +
        'previously the only signal that it applies to one backend out of three'
    ).toBe(true);

    // And in exactly one place: a second copy would leave two draft-bound inputs
    // writing the same key, with the one an operator edited not necessarily the
    // one Save posted.
    expect(container.querySelectorAll(AUTO_COMPACT_INPUT)).toHaveLength(1);
    for (const other of ['codex', 'agy'] as const) {
      const section = container.querySelector(`[data-testid="backend-health-${other}"]`);
      expect(section?.querySelector(AUTO_COMPACT_INPUT)).toBeNull();
    }
  });

  it('says in words that Codex and Agy carry no backend-specific settings', () => {
    const { getByTestId, queryByTestId } = mount();
    // The assertion is on the SENTENCE, not on the region being empty. An empty
    // region under a heading reads as a surface that failed to load, and an
    // operator who concludes that goes looking for the Codex equivalent of the
    // Claude control two sections up.
    for (const kind of ['codex', 'agy'] as const) {
      const node = getByTestId(`backend-no-specific-settings-${kind}`);
      expect(collapse(node.textContent)).toMatch(/has no backend-specific settings/);
    }
    expect(
      queryByTestId('backend-no-specific-settings-claude'),
      'Claude has one, so the sentence would be false there'
    ).toBeNull();
  });

  it('mounts one section per enumerated backend, in the enumeration’s order', () => {
    const { container } = mount();
    const rendered = [...container.querySelectorAll('[data-testid^="backend-health-"]')].map(
      (node) => (node as HTMLElement).dataset.testid?.replace('backend-health-', '')
    );
    // Membership AND order, both read out of `SUPPORTED_BACKENDS` rather than
    // written here: the tab has no ordering of its own left to drift from. The
    // compile-time half of this — that a backend cannot be missing from the
    // record the sections are drawn from — is in `backend-record-exhaustiveness`.
    expect(rendered).toEqual([...SUPPORTED_BACKENDS]);
  });
});

describe('FR-R3-144 T031/T032 — choosing a backend, and saying which one is in use', () => {
  it('offers exactly one control for backend.runner, listing every supported backend', () => {
    const { container } = mount();
    const selects = container.querySelectorAll(RUNNER_INPUT);
    expect(selects, 'one setting, one control').toHaveLength(1);
    const options = [...(selects[0] as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['claude', 'codex', 'agy']);
    expect((selects[0] as HTMLSelectElement).value).toBe('claude');
  });

  it('moves the in-use marker when the selection changes, with no second source of truth', async () => {
    const { container, getByTestId, queryByTestId } = mount();
    expect(getByTestId('backend-in-use-claude')).toBeTruthy();
    expect(queryByTestId('backend-in-use-codex')).toBeNull();

    const select = container.querySelector(RUNNER_INPUT) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'codex' } });

    // The marker follows the DRAFT, before any save: the operator sees what their
    // pending edit will do. Nothing else stores "which backend is active".
    expect(queryByTestId('backend-in-use-claude')).toBeNull();
    expect(getByTestId('backend-in-use-codex')).toBeTruthy();
  });
});

describe('FR-R3-144 T035 — posture and refusal, before a run rather than after one', () => {
  it('shows the containment, the mechanism and the refusal for an ungranted backend', () => {
    const { getByTestId } = mount();
    expect(collapse(getByTestId('backend-posture-claude').textContent)).toContain('none');
    expect(collapse(getByTestId('backend-mechanism-claude').textContent)).toBe('none');
    // Verbatim, and the sentinel proves it was carried rather than composed here.
    expect(getByTestId('backend-refusal-claude').textContent).toBe(SENTINEL_REFUSAL);
  });

  it('shows no refusal and no grant control for a backend the platform contains', () => {
    const { getByTestId, queryByTestId } = mount();
    expect(collapse(getByTestId('backend-mechanism-codex').textContent)).toBe(
      'codex-sandbox-workspace-write'
    );
    expect(queryByTestId('backend-refusal-codex')).toBeNull();
    // Absent, not disabled: a disabled control sends an operator looking for the
    // permission that would enable it, and for `not-required` there is none.
    expect(queryByTestId('backend-grant-codex')).toBeNull();
  });

  it('drops the refusal once the grant is in force', () => {
    const { queryByTestId, getByTestId } = mount({
      postures: [
        posture('claude', 'granted'),
        posture('codex', 'not-required'),
        posture('agy', 'not-granted', 'SENTINEL-REFUSAL: agy.')
      ]
    });
    expect(queryByTestId('backend-refusal-claude')).toBeNull();
    expect(getByTestId('backend-grant-claude').textContent).toContain('Revoke');
  });

  it('renders no posture block at all when the host sends no projection', () => {
    // A webview newer than the host it is loaded into. Omitting the block is the
    // point: a surface that invented a containment answer for an unknown host
    // would be the exact defect this section exists to remove.
    const { queryByTestId } = mount({ postures: [] });
    for (const kind of ['claude', 'codex', 'agy'] as const) {
      expect(queryByTestId(`backend-posture-${kind}`)).toBeNull();
      expect(queryByTestId(`backend-grant-${kind}`)).toBeNull();
    }
  });
});

describe('FR-R3-144 T033/T034 — granting is confirmed, revoking is not', () => {
  it('asks with the policy’s own sentence and writes only after the operator accepts', async () => {
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId('backend-grant-claude'));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const [actionKey, options] = confirmMock.mock.calls[0] as [
      string,
      { context: { label: string; refusal: string } }
    ];
    expect(actionKey).toBe('backend.grant-uncontained');
    // The confirmation carries the projected refusal UNCHANGED. This is the half
    // of T033 that lives in the component: the other half — that the projection's
    // string is `judgeBackendContainment`'s own `message` — is asserted in the
    // projector's test. Neither is a copy, so changing the policy's message
    // changes what the operator is asked.
    expect(options.context.refusal).toBe(SENTINEL_REFUSAL);
    expect(options.context.label).toBe('Claude');
    expect(grantMock).toHaveBeenCalledWith('claude', true);
  });

  it('writes nothing when the operator declines', async () => {
    confirmMock.mockResolvedValue(false);
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId('backend-grant-agy'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(grantMock, 'declining must leave the configuration untouched').not.toHaveBeenCalled();
  });

  it('revokes immediately, with no dialog, and keeps showing the refusal state', async () => {
    const { getByTestId } = mount({
      postures: [
        posture('claude', 'granted'),
        posture('codex', 'not-required'),
        posture('agy', 'not-granted', 'SENTINEL-REFUSAL: agy.')
      ]
    });
    await fireEvent.click(getByTestId('backend-grant-claude'));

    // C7-3 — a prompt before NARROWING a permission trains operators to click
    // through the prompt that matters.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(grantMock).toHaveBeenCalledWith('claude', false);

    // And the section still states the refusal for a backend that has none: `agy`
    // is ungranted throughout, so its sentence is on screen before and after. The
    // section does not remember a refusal; it renders the one currently true, and
    // Claude's returns when the host projects the revoked posture back.
    expect(getByTestId('backend-refusal-agy').textContent).toContain('SENTINEL-REFUSAL');
  });
});

describe('FR-R3-144 T036/T037 — denomination and backend-conditional labels', () => {
  it('offers the USD bound for a backend that reports cost, and only that one', () => {
    const { container, getByTestId } = mount({ runner: 'claude' });
    expect(container.querySelector(USD_INPUT)).not.toBeNull();
    expect(
      container.querySelector(TOKENS_INPUT),
      'a token bound under Claude would be a bound the operator set and the run ignores'
    ).toBeNull();
    expect(collapse(getByTestId('spend-denomination').textContent)).toContain('US dollars');
  });

  it('offers the token bound for a backend that reports no cost, and only that one', () => {
    const { container, getByTestId } = mount({ runner: 'codex' });
    expect(container.querySelector(TOKENS_INPUT)).not.toBeNull();
    expect(container.querySelector(USD_INPUT)).toBeNull();
    expect(collapse(getByTestId('spend-denomination').textContent)).toContain('tokens');
  });

  it('swaps the bound when the selection changes, without a save', async () => {
    const { container } = mount({ runner: 'claude' });
    const select = container.querySelector(RUNNER_INPUT) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'agy' } });
    expect(container.querySelector(TOKENS_INPUT)).not.toBeNull();
    expect(container.querySelector(USD_INPUT)).toBeNull();
  });

  it('states which backends honour logging.verbose, in the document’s own words', () => {
    const { container } = mount();
    const row = container.querySelector(inputFor('loggingVerbose'))?.closest('.field-row');
    const text = collapse(row?.textContent ?? '');
    // `docs/reference/settings.md` has carried this sentence all along; the
    // control did not, so an operator who turned verbose logging on while running
    // Codex got nothing and had no way to learn why.
    expect(text).toContain('Codex and Agy currently ignore this setting');
  });
});

describe('FR-R3-144 T045 — "not found" and "refused" are told apart', () => {
  // The two states have nothing to do with each other and their remedies are
  // opposites: one is fixed at the path field, the other by granting a permission
  // (or by choosing a backend that carries a bound). A surface that renders a
  // single badge for both sends an operator to correct a path that is already
  // right, and the badge that used to read `Unavailable` for a missing binary read
  // `Unavailable · <cause>` for a failed probe two words later.

  /** Discovered, no OS-enforced bound, no grant — refused, and nothing to fix in a path. */
  const REFUSED: readonly BackendRunnerKind[] = Object.freeze(['claude', 'codex', 'agy']);

  it('says a missing binary is a discovery problem, at the field that fixes it', () => {
    // `agy` is absent from the discovered list and present in the posture list:
    // the host looked for it and did not find it.
    const { getByTestId, queryByTestId } = mount({ available: ['claude', 'codex'] });

    const notFound = collapse(getByTestId('backend-not-found-agy').textContent);
    expect(notFound).toMatch(/No Agy .*binary was found/);
    expect(notFound, 'the remedy must be the path, named as such').toMatch(/Correct the path/);
    expect(
      notFound,
      'and it must say what will NOT fix it, because the section below offers a permission'
    ).toMatch(/no permission granted here will change it/);

    expect(collapse(getByTestId('backend-discovery-agy').textContent)).toBe('Not found');
    for (const found of ['claude', 'codex'] as const) {
      expect(queryByTestId(`backend-not-found-${found}`)).toBeNull();
      expect(collapse(getByTestId(`backend-discovery-${found}`).textContent)).toBe('Discovered');
    }
  });

  it('says a refusal is a permission problem, in the enforcement’s own words', () => {
    const { getByTestId, queryByTestId } = mount({ available: REFUSED });

    // Found, and refused anyway. Nothing about the path is wrong.
    expect(queryByTestId('backend-not-found-claude')).toBeNull();
    expect(collapse(getByTestId('backend-discovery-claude').textContent)).toBe('Discovered');

    expect(getByTestId('backend-refusal-claude').textContent).toContain('SENTINEL-REFUSAL');
    expect(
      getByTestId('backend-grant-claude').textContent,
      'and the remedy is the grant, offered right there'
    ).toContain('Allow uncontained');
  });

  it('renders both, separately, for a backend that is neither found nor granted', () => {
    // The states are independent, so a backend can be in both. The section says
    // both things rather than choosing one — and the two sentences must not be the
    // same node, or an assertion that one is present is satisfied by the other.
    const { getByTestId } = mount({ available: ['codex'] });

    const notFound = getByTestId('backend-not-found-claude');
    const refusal = getByTestId('backend-refusal-claude');
    expect(notFound).not.toBe(refusal);
    expect(collapse(notFound.textContent)).not.toEqual(collapse(refusal.textContent));
    expect(collapse(notFound.textContent)).toMatch(/Correct the path/);
    expect(refusal.textContent).toContain('SENTINEL-REFUSAL');

    // Order matters: finding the binary is the prerequisite, so it is stated first.
    expect(
      notFound.compareDocumentPosition(refusal) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('says nothing about discovery for a backend that was found', () => {
    // A vacuity guard. Every assertion above about the sentence being absent is
    // worthless if the element is never rendered at all.
    const { queryByTestId } = mount();
    for (const kind of SUPPORTED_BACKENDS) {
      expect(queryByTestId(`backend-not-found-${kind}`)).toBeNull();
    }
  });
});

describe('FR-R3-144 T046 — projected posture strings are text, never markup', () => {
  // The grant setting is operator-supplied and its contents reach this surface as
  // sentences: `problem` quotes the entry that named nothing, `refusal` is the
  // policy's message. Neither is HTML, and Svelte's `{...}` interpolation escapes
  // by construction — but "by construction" is exactly the property that a later
  // `{@html ...}` would silently remove, so it is asserted rather than assumed.
  const MARKUP = '<img src=x onerror="alert(1)">';

  function withMarkup(kind: BackendRunnerKind): readonly BackendPosture[] {
    return Object.freeze(
      UNGRANTED_POSTURES.map((row) =>
        row.kind === kind
          ? (Object.freeze({
              ...row,
              problem: `Entry ${MARKUP} names no backend.`,
              refusal: `Refused. ${MARKUP}`
            }) as unknown as BackendPosture)
          : row
      )
    );
  }

  it('renders a grant-list entry containing markup as the literal characters', () => {
    const { getByTestId } = mount({ postures: withMarkup('claude') });

    const problem = getByTestId('backend-grant-problem-claude');
    expect(problem.textContent).toContain(MARKUP);
    expect(
      problem.querySelector('img'),
      'an <img> here would be an element the operator’s settings file created'
    ).toBeNull();
    expect(problem.innerHTML).not.toContain('<img');
    expect(problem.innerHTML).toContain('&lt;img');
  });

  it('renders a refusal containing markup as the literal characters', () => {
    const { getByTestId, container } = mount({ postures: withMarkup('claude') });

    const refusal = getByTestId('backend-refusal-claude');
    expect(refusal.textContent).toContain(MARKUP);
    expect(refusal.querySelector('img')).toBeNull();
    expect(
      container.querySelectorAll('img'),
      'and nowhere else on the tab either — the string is passed to the confirmation too'
    ).toHaveLength(0);
  });
});
