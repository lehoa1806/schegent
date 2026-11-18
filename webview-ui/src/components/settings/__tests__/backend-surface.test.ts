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
  refusal?: string,
  notice?: string
): BackendPosture {
  const contained = kind === 'codex';
  return Object.freeze({
    kind,
    containment: contained ? 'os-enforced' : 'none',
    mechanism: contained ? 'codex-sandbox-workspace-write' : 'none',
    grant,
    ...(refusal === undefined ? {} : { refusal }),
    ...(notice === undefined ? {} : { notice })
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
  /** Claude's saved path, when it is not the default one. */
  readonly cliPath?: string;
}

function buildSnapshot(overrides: Overrides = {}): WorkflowSnapshot {
  const generalSettings = Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    backendRunner: overrides.runner ?? 'claude',
    ...(overrides.cliPath === undefined ? {} : { cliPath: overrides.cliPath })
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

  /** Found, no OS-enforced bound, no grant — refused, and nothing to fix in a path. */
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
    }
    // One tag where one says it all, as the redesign draws the card: Claude is the backend in
    // use and was found, so "In use" stands alone; Codex was found and is not in use.
    expect(collapse(getByTestId('backend-in-use-claude').textContent)).toBe('In use');
    expect(queryByTestId('backend-discovery-claude')).toBeNull();
    expect(collapse(getByTestId('backend-discovery-codex').textContent)).toBe('Found');
  });

  it('says a refusal is a permission problem, in the enforcement’s own words', () => {
    const { getByTestId, queryByTestId } = mount({ available: REFUSED });

    // Found, and refused anyway. Nothing about the path is wrong.
    expect(queryByTestId('backend-not-found-claude')).toBeNull();
    expect(queryByTestId('backend-discovery-claude'), 'no "Not found" tag').toBeNull();
    expect(collapse(getByTestId('backend-discovery-agy').textContent)).toBe('Found');

    expect(getByTestId('backend-refusal-claude').textContent).toContain('SENTINEL-REFUSAL');
    expect(
      getByTestId('backend-grant-claude').textContent,
      'and the remedy is the grant, offered in that card’s menu'
    ).toContain('Allow running unsandboxed…');
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

// The Settings redesign draws a backend as a short card: its id, one tag, a result chip, the path
// it starts from, one line on its sandbox with a Details link, and at the right a "Test" (or "Set
// path…") button and an actions menu. Everything FR-R3-144 puts on the tab is still there, with
// the same test ids; the long parts moved into a Details region the card opens by itself when the
// backend that will run cannot.
describe('Settings redesign — the backend card', () => {
  /** What the projection sends with a grant that is in force on a backend with no bound. */
  const NOTICE = 'SENTINEL-NOTICE: this grant is in force.';

  /** Claude granted; the other two as a fresh installation has them. */
  const GRANTED_CLAUDE: readonly BackendPosture[] = Object.freeze([
    posture('claude', 'granted', undefined, NOTICE),
    posture('codex', 'not-required'),
    posture('agy', 'not-granted', 'SENTINEL-REFUSAL: agy.')
  ]);

  function menuItems(trigger: HTMLElement): HTMLElement[] {
    const menu = trigger.parentElement?.querySelector('[role="menu"]');
    if (menu === null || menu === undefined) throw new Error('the button has no menu beside it');
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  }

  function itemTexts(trigger: HTMLElement): string[] {
    return menuItems(trigger).map((item) => collapse(item.textContent));
  }

  describe('what a card says at a glance', () => {
    it('names each backend by its id', () => {
      const { getByTestId } = mount();
      for (const kind of SUPPORTED_BACKENDS) {
        const name = getByTestId(`backend-health-${kind}`).querySelector('.titlerow b');
        expect(name?.textContent.trim()).toBe(kind);
      }
    });

    it('says both when the backend in use was not found', () => {
      const { getByTestId } = mount({ available: ['codex'] });
      expect(collapse(getByTestId('backend-in-use-claude').textContent)).toBe('In use');
      expect(collapse(getByTestId('backend-discovery-claude').textContent)).toBe('Not found');
    });

    it('marks a backend that was not found as not installed', () => {
      const { getByTestId, queryByTestId } = mount({ available: ['claude', 'codex'] });
      const chip = getByTestId('backend-not-installed-agy');
      expect(collapse(chip.textContent)).toBe('Not installed');
      // Drawn with the card, so not a live region: a status region would announce it on load,
      // and the one status region on the tab is the last test's result.
      expect(chip.getAttribute('role')).toBeNull();
      expect(chip.getAttribute('aria-live')).toBeNull();
      expect(queryByTestId('backend-not-installed-claude')).toBeNull();
      expect(queryByTestId('backend-not-installed-codex')).toBeNull();
    });

    it('shows the saved path a found backend starts from, and how to give one that was not found', async () => {
      const view = mount({ available: ['claude', 'codex'] });
      const path = view.getByTestId('backend-path-claude');
      expect(collapse(path.textContent)).toBe(IDLE_GENERAL_SETTINGS.cliPath);
      expect(collapse(view.getByTestId('backend-path-agy').textContent)).toBe(
        'Set a path to use this backend'
      );

      // The saved path, the one the card's "Found" and its last test speak of. An edit shows in
      // the path field and in the page's unsaved count, and the card says nothing of it until the
      // host has it.
      const input = view.container.querySelector(inputFor('cliPath')) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: '/opt/tools/claude' } });
      expect(collapse(path.textContent)).toBe(IDLE_GENERAL_SETTINGS.cliPath);
      await fireEvent.input(input, { target: { value: '' } });
      expect(collapse(path.textContent)).toBe(IDLE_GENERAL_SETTINGS.cliPath);

      // Saved: the host's next snapshot carries the path, and the line follows it.
      await view.rerender({
        snapshot: buildSnapshot({ available: ['claude', 'codex'], cliPath: '/opt/tools/claude' })
      });
      expect(collapse(view.getByTestId('backend-path-claude').textContent)).toBe(
        '/opt/tools/claude'
      );
    });

    it('says in plain words what each backend runs under', () => {
      const { getByTestId } = mount();
      expect(collapse(getByTestId('backend-sandbox-claude').textContent)).toBe(
        'Not allowed to run unsandboxed'
      );
      expect(collapse(getByTestId('backend-sandbox-codex').textContent)).toBe('Sandboxed');
      expect(collapse(getByTestId('backend-sandbox-agy').textContent)).toBe(
        'Not allowed to run unsandboxed'
      );
      // The whole line as the mockup writes it: the phrase, a dot with a space each side, the link.
      const line = getByTestId('backend-sandbox-codex').parentElement;
      expect(collapse(line?.textContent ?? null)).toBe('Sandboxed · Details');
    });

    it('calls a backend unsandboxed only when the host says its grant is in force', () => {
      // A listed Codex is granted and still runs in its sandbox (FR-R6-F09). The projection sends
      // a notice only with a grant in force on a backend that has no bound, and the card reads
      // that; the grant state alone would call a sandboxed Codex unsandboxed.
      const { getByTestId } = mount({
        postures: [
          posture('claude', 'granted', undefined, NOTICE),
          posture('codex', 'granted'),
          posture('agy', 'not-granted', 'SENTINEL-REFUSAL: agy.')
        ]
      });
      expect(collapse(getByTestId('backend-sandbox-claude').textContent)).toBe(
        'Allowed to run unsandboxed'
      );
      expect(collapse(getByTestId('backend-sandbox-codex').textContent)).toBe('Sandboxed');
    });

    it('claims nothing about the sandbox when the host projects no posture', () => {
      const { getByTestId, queryByTestId } = mount({ postures: [] });
      for (const kind of SUPPORTED_BACKENDS) {
        expect(queryByTestId(`backend-sandbox-${kind}`)).toBeNull();
        expect(collapse(getByTestId(`backend-details-toggle-${kind}`).textContent)).toBe('Details');
      }
    });
  });

  describe('Details', () => {
    it('opens by itself for the backend in use when it cannot run, and for no other', () => {
      const { getByTestId } = mount();
      const toggle = getByTestId('backend-details-toggle-claude');
      const details = getByTestId('backend-details-claude');
      expect(details.hidden, 'the refusal of the backend that will run is on screen').toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(details.id).not.toBe('');
      expect(toggle.getAttribute('aria-controls')).toBe(details.id);
      expect(toggle.getAttribute('aria-label')).toBe('Details for claude');

      for (const other of ['codex', 'agy'] as const) {
        expect(getByTestId(`backend-details-${other}`).hidden).toBe(true);
        expect(getByTestId(`backend-details-toggle-${other}`).getAttribute('aria-expanded')).toBe(
          'false'
        );
      }
    });

    it('opens by itself for the backend in use when it was not found', () => {
      const { getByTestId } = mount({ runner: 'codex', available: ['claude'] });
      expect(getByTestId('backend-details-codex').hidden).toBe(false);
      expect(getByTestId('backend-details-claude').hidden).toBe(true);
    });

    it('opens and closes on its link', async () => {
      const { getByTestId } = mount();
      const toggle = getByTestId('backend-details-toggle-codex');
      const details = getByTestId('backend-details-codex');

      await fireEvent.click(toggle);
      expect(details.hidden).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      await fireEvent.click(toggle);
      expect(details.hidden).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('lets the user close details that opened by themselves', async () => {
      const { getByTestId } = mount();
      await fireEvent.click(getByTestId('backend-details-toggle-claude'));
      expect(getByTestId('backend-details-claude').hidden).toBe(true);
    });

    it('follows the selection, before any save', async () => {
      const { container, getByTestId } = mount({ available: ['claude', 'codex'] });
      const select = container.querySelector(RUNNER_INPUT) as HTMLSelectElement;

      // Codex is found and sandboxed, and Claude is no longer the one that will run.
      await fireEvent.change(select, { target: { value: 'codex' } });
      expect(getByTestId('backend-details-claude').hidden).toBe(true);
      expect(getByTestId('backend-details-codex').hidden).toBe(true);

      // Agy is neither found nor allowed.
      await fireEvent.change(select, { target: { value: 'agy' } });
      expect(getByTestId('backend-details-agy').hidden).toBe(false);
    });

    it('puts the refusal back in view after a revoke, even where the user had closed them', async () => {
      // C7-3 — when the revoked backend is the selected one, the refusal must be what the eye
      // lands on. The revoke arrives as a new projection.
      const view = mount({ postures: GRANTED_CLAUDE });
      const toggle = view.getByTestId('backend-details-toggle-claude');
      const details = view.getByTestId('backend-details-claude');
      expect(details.hidden, 'granted: nothing to read').toBe(true);
      await fireEvent.click(toggle);
      await fireEvent.click(toggle);
      expect(details.hidden, 'opened and closed by hand').toBe(true);

      await view.rerender({ snapshot: buildSnapshot() });
      expect(details.hidden).toBe(false);
      expect(view.getByTestId('backend-refusal-claude').textContent).toBe(SENTINEL_REFUSAL);
    });

    it('keeps details the user opened when the reason to show them goes', async () => {
      const view = mount();
      const toggle = view.getByTestId('backend-details-toggle-claude');
      const details = view.getByTestId('backend-details-claude');
      await fireEvent.click(toggle);
      await fireEvent.click(toggle);
      expect(details.hidden, 'closed and opened by hand').toBe(false);

      await view.rerender({ snapshot: buildSnapshot({ postures: GRANTED_CLAUDE }) });
      expect(details.hidden).toBe(false);
    });

    it('closes details that opened by themselves once the backend can run', async () => {
      const view = mount();
      const details = view.getByTestId('backend-details-claude');
      expect(details.hidden).toBe(false);
      await view.rerender({ snapshot: buildSnapshot({ postures: GRANTED_CLAUDE }) });
      expect(details.hidden).toBe(true);
    });

    it('never hides an unsaved edit', async () => {
      const { container, getByTestId } = mount();
      const input = container.querySelector(inputFor('cliPath')) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: '/opt/tools/claude' } });

      // Claude stops being the backend in use, which alone would close its details.
      const select = container.querySelector(RUNNER_INPUT) as HTMLSelectElement;
      await fireEvent.change(select, { target: { value: 'codex' } });
      expect(getByTestId('backend-details-claude').hidden).toBe(false);
    });

    it('holds everything the card used to show in the open', () => {
      const { getByTestId, container } = mount({ available: ['claude', 'codex'] });
      const parts: readonly (readonly [BackendRunnerKind, string])[] = [
        ['claude', 'backend-posture-claude'],
        ['claude', 'backend-refusal-claude'],
        ['claude', 'backend-grant-pointer-claude'],
        ['codex', 'backend-no-specific-settings-codex'],
        ['agy', 'backend-not-found-agy']
      ];
      for (const [kind, part] of parts) {
        expect(getByTestId(`backend-details-${kind}`).contains(getByTestId(part)), part).toBe(true);
      }
      for (const [kind, key] of [
        ['claude', 'cliPath'],
        ['claude', 'claudeAutoCompactPctOverride'],
        ['codex', 'codexPath'],
        ['agy', 'agyPath']
      ] as const) {
        const input = container.querySelector(inputFor(key));
        expect(getByTestId(`backend-details-${kind}`).contains(input), key).toBe(true);
      }
    });

    it('points from the refusal to the control that lifts it', () => {
      const { getByTestId, queryByTestId } = mount();
      const refusal = getByTestId('backend-refusal-claude');
      const pointer = getByTestId('backend-grant-pointer-claude');
      expect(collapse(pointer.textContent)).toContain('“Allow running unsandboxed…”');
      expect(
        refusal.compareDocumentPosition(pointer) & Node.DOCUMENT_POSITION_FOLLOWING,
        'the reason first, then the way out'
      ).toBeTruthy();
      // Codex needs no permission, so nothing points at one.
      expect(queryByTestId('backend-grant-pointer-codex')).toBeNull();
    });

    it('drops the pointer once the permission is given', () => {
      const { queryByTestId } = mount({ postures: GRANTED_CLAUDE });
      expect(queryByTestId('backend-grant-pointer-claude')).toBeNull();
    });
  });

  describe('the actions at the right of a card', () => {
    it('tests a found backend from its card and a missing one from its menu', () => {
      const { getByTestId, queryByTestId } = mount({ available: ['claude', 'codex'] });

      const found = getByTestId('ping-backend-claude');
      expect(found.tagName).toBe('BUTTON');
      expect(found.getAttribute('role')).toBeNull();
      expect(collapse(found.textContent)).toBe('Test');
      expect(found.getAttribute('aria-label')).toBe('Test claude');
      expect(queryByTestId('backend-set-path-claude')).toBeNull();

      // Not found: the card's own button gives the path, as the mockup has it, and the test moves
      // into the menu, since a test can find a backend the last scan missed.
      const missing = getByTestId('ping-backend-agy');
      expect(missing.getAttribute('role')).toBe('menuitem');
      expect(collapse(missing.textContent)).toBe('Test');
      const setPath = getByTestId('backend-set-path-agy');
      expect(collapse(setPath.textContent)).toBe('Set path…');
      expect(setPath.getAttribute('aria-label')).toBe('Set path for agy…');
    });

    it('names the menu after the backend and lists what applies to it', () => {
      const { getByTestId } = mount({ available: ['claude', 'codex'] });
      const trigger = getByTestId('backend-actions-agy');
      expect(trigger.getAttribute('aria-label')).toBe('Actions for agy');
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

      expect(itemTexts(trigger)).toEqual(['Test', 'Change path…', 'Allow running unsandboxed…']);
      expect(itemTexts(getByTestId('backend-actions-claude'))).toEqual([
        'Change path…',
        'Allow running unsandboxed…'
      ]);
      // FR-008 — a backend that needs no grant offers no grant control.
      expect(itemTexts(getByTestId('backend-actions-codex'))).toEqual(['Change path…']);
    });

    it('marks the grant as the dangerous choice and the revoke as an ordinary one', () => {
      const ungranted = mount();
      expect(ungranted.getByTestId('backend-grant-claude').classList.contains('danger')).toBe(true);
      ungranted.unmount();

      const granted = mount({ postures: GRANTED_CLAUDE });
      const revoke = granted.getByTestId('backend-grant-claude');
      expect(collapse(revoke.textContent)).toBe('Revoke permission to run unsandboxed');
      expect(revoke.classList.contains('danger')).toBe(false);
    });

    it('takes the user to the path field from "Set path…"', async () => {
      const { container, getByTestId } = mount({ available: ['claude', 'codex'] });
      const details = getByTestId('backend-details-agy');
      expect(details.hidden).toBe(true);

      await fireEvent.click(getByTestId('backend-set-path-agy'));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(container.querySelector(inputFor('agyPath')));
      });
      expect(details.hidden).toBe(false);
    });

    it('takes the user to the path field from the menu’s "Change path…"', async () => {
      const { container, getByTestId } = mount();
      const details = getByTestId('backend-details-codex');
      const change = getByTestId('backend-change-path-codex');
      expect(details.hidden).toBe(true);

      await fireEvent.click(getByTestId('backend-actions-codex'));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(change);
      });
      await fireEvent.click(change);
      // The menu hands focus back to its button as it closes; the path field takes it from there.
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(container.querySelector(inputFor('codexPath')));
      });
      expect(details.hidden).toBe(false);
    });

    it('moves focus to the menu item under a moving pointer', async () => {
      // Every item carries a description that opens the moment the item takes focus (spec 018),
      // and the menu focuses its first item as it opens. Focus following the pointer keeps one
      // description on screen, the one for the item the pointer is on.
      const { getByTestId } = mount();
      const change = getByTestId('backend-change-path-claude');
      const grant = getByTestId('backend-grant-claude');

      await fireEvent.click(getByTestId('backend-actions-claude'));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(change);
      });
      await fireEvent.pointerMove(grant);
      expect(document.activeElement).toBe(grant);
    });
  });
});
