import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import PhaseCatalogEditor from '../PipelineBuilderEditors/PhaseCatalogEditor.svelte';
import { sourceRecordToMutable } from '../PipelineBuilderEditors/phase-catalog-state';
import type { MutablePhase } from '../PipelineBuilderEditors/types';
import { isMenuItemOff } from '../sg/__tests__/menu-item-state';

afterEach(cleanup);

const SNAPSHOT = {
  isPrimary: true,
  availableBackends: ['claude', 'codex', 'agy'],
  availableModels: { claude: ['model-a'], codex: [], agy: [] },
  phaseCatalog: {
    state: 'ready', records: [], effective: [],
    revisions: { user: 'u', workspace: 'w' }, warnings: []
  }
} as unknown as WorkflowSnapshot;

const STORED_PHASE: MutablePhase = {
  id: 'custom', name: 'Custom', version: 2, instruction: 'Run.',
  sourceKey: 'custom::0', sourceStatus: 'effective',
  sourceErrors: [], persisted: true
};

// Feature 186 (US1, T007) — a lifecycle projection keyed to STORED_PHASE's
// sourceKey, so the panel this feature mounts on the editor card has a draft
// token to quote.
const LIFECYCLE_SNAPSHOT = {
  ...SNAPSHOT,
  phaseCatalog: {
    state: 'ready',
    records: [
      {
        key: STORED_PHASE.sourceKey,
        phaseId: STORED_PHASE.id,
        status: 'effective',
        definition: null,
        display: {},
        errors: [],
        lifecycle: {
          state: 'active',
          createdAt: Date.parse('2026-03-01T09:15:00.000Z'),
          updatedAt: Date.parse('2026-03-04T18:42:30.000Z'),
          activeVersionId: 'ver-7',
          expectedDraftVersion: 'no-draft',
          versions: []
        }
      }
    ],
    effective: [],
    revisions: { user: 'u', workspace: 'w' }, warnings: []
  }
} as unknown as WorkflowSnapshot;

function mount(options: {
  snapshot?: WorkflowSnapshot;
  phases?: MutablePhase[];
  selectedIndex?: number | null;
  mutationActive?: boolean;
  editableSourceKey?: string | null;
  importDisabledReason?: string | null;
  onselect?: (index: number | null) => void;
  onphasechange?: (index: number, patch: Partial<MutablePhase>) => void;
  onduplicate?: (index: number) => void;
  onremove?: (index: number, originatingElement?: HTMLElement | null) => void;
  onopenimport?: (originatingElement: HTMLElement | null) => void;
} = {}) {
  const phases = options.phases ?? [];
  return render(PhaseCatalogEditor, {
    props: {
      snapshot: options.snapshot ?? SNAPSHOT,
      phases,
      editStateById: Object.fromEntries(phases.map((phase) => [phase.sourceKey, { rawJsonMode: false }])),
      selectedIndex: options.selectedIndex ?? null,
      historyIndex: 0, historyLength: 1, trusted: true,
      retryConditionsTrusted: true, showTrustBanner: false,
      showRetryTrustBanner: false, saveError: null, savePending: false,
      mutationActive: options.mutationActive ?? false,
      editableSourceKey: options.editableSourceKey ?? null,
      importDisabledReason: options.importDisabledReason ?? null,
      onselect: options.onselect ?? vi.fn(), onadd: vi.fn(),
      onremove: options.onremove ?? vi.fn(), onreset: vi.fn(),
      onphasechange: options.onphasechange ?? vi.fn(),
      onundo: vi.fn(), onredo: vi.fn(), onsave: vi.fn(),
      ondismisssaveerror: vi.fn(), ontoggleraw: vi.fn(), onrawsave: vi.fn(),
      ontoggleretry: vi.fn(), onretrychange: vi.fn(),
      onduplicate: options.onduplicate ?? vi.fn(),
      onopenimport: options.onopenimport ?? vi.fn()
    }
  });
}

describe('Phase catalog source editor states', () => {
  it('renders a non-authoritative loading state and no mutation toolbar', () => {
    const { container } = mount({ snapshot: { ...SNAPSHOT, phaseCatalog: undefined } as WorkflowSnapshot });
    expect(container.querySelector('[data-testid="phase-catalog-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="phases-add"]')).toBeNull();
  });

  it('renders the source status badge, and no scope beside it (T496f)', () => {
    // Feature 099 (T496f, FR-042, FR-043) — two badges stood on every row: which
    // layer the definition came from, and how it resolved. The first is deleted
    // with the tier, and a badge that can only ever read one value is not a
    // badge. The second is what the row still has to say, so it is asserted with
    // the first pinned absent — a scope badge left rendering a constant would
    // read as a choice the operator could have made differently.
    const { container } = mount({ phases: [STORED_PHASE] });
    expect(container.textContent).toContain('effective');
    expect(container.textContent).not.toContain('workspace');
    expect(container.textContent).not.toContain('built-in');
  });

  it('renders invalid source errors and associates them with fields', () => {
    const invalid: MutablePhase = {
      ...STORED_PHASE,
      sourceStatus: 'invalid',
      sourceErrors: [{ field: 'name', code: 'invalid-length', message: 'Name is invalid' }]
    };
    const { container } = mount({ phases: [invalid], selectedIndex: 0 });
    const name = container.querySelector('[data-testid="phases-name-field-custom"]');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(name?.getAttribute('aria-describedby')).toContain('phase-errors-custom');
    expect(container.textContent).toContain('Name is invalid');
  });

  it('keeps an unavailable configured model visible', () => {
    const phase = { ...STORED_PHASE, model: 'missing-model', modelAvailable: false };
    const { container } = mount({ phases: [phase], selectedIndex: 0 });
    expect(container.textContent).toContain('model unavailable');
    expect(container.querySelector('[data-testid="phases-model-custom"]')?.textContent)
      .toContain('missing-model (Unavailable)');
  });

  // The dropdown read `availableModels` alone until Claude and Codex started
  // reporting none — neither CLI can enumerate its models — which left a
  // Claude phase with nothing to pick but Inherit, including the ids the
  // operator had just imported into `schegent.models`.
  it('offers the operator-configured models for a backend that detects none', () => {
    const snapshot = {
      ...SNAPSHOT,
      availableModels: { claude: [], codex: [], agy: [] },
      configuredModels: { claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: [], agy: [] }
    } as unknown as WorkflowSnapshot;
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0, snapshot });

    const options = Array.from(
      container.querySelectorAll('[data-testid="phases-model-custom"] option')
    ).map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(['', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('offers configured and detected models together, configured first and deduped', () => {
    const snapshot = {
      ...SNAPSHOT,
      availableModels: { claude: [], codex: [], agy: ['gemini-3.7-flash-high', 'gemini-3.7-pro'] },
      configuredModels: { claude: [], codex: [], agy: ['my-own-id', 'gemini-3.7-pro'] }
    } as unknown as WorkflowSnapshot;
    const phase = { ...STORED_PHASE, runner: 'agy' as const };
    const { container } = mount({ phases: [phase], selectedIndex: 0, snapshot });

    const options = Array.from(
      container.querySelectorAll('[data-testid="phases-model-custom"] option')
    ).map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(['', 'my-own-id', 'gemini-3.7-pro', 'gemini-3.7-flash-high']);
  });

  it('still marks a model in neither list as unavailable', () => {
    const snapshot = {
      ...SNAPSHOT,
      availableModels: { claude: [], codex: [], agy: [] },
      configuredModels: { claude: ['claude-opus-5-5'], codex: [], agy: [] }
    } as unknown as WorkflowSnapshot;
    const phase = { ...STORED_PHASE, model: 'retired-model' };
    const { container } = mount({ phases: [phase], selectedIndex: 0, snapshot });

    expect(container.querySelector('[data-testid="phases-model-custom"]')?.textContent)
      .toContain('retired-model (Unavailable)');
  });

  // The host runs a Phase that sets no backend on the default backend the setting
  // selects, except a Phase that writes Git metadata, which keeps Claude whatever the
  // setting says (`effectiveRunnerKindForPhase`). The model list and the effort limits
  // follow the backend the Phase will run on.
  it('offers the models of the backend a Git-writing Phase runs on, not the default', () => {
    const snapshot = {
      ...SNAPSHOT,
      defaultRunnerKind: 'agy',
      availableModels: { claude: [], codex: [], agy: [] },
      configuredModels: { claude: ['claude-opus-5-5'], codex: [], agy: ['gemini-3.7-pro'] }
    } as unknown as WorkflowSnapshot;
    const modelsOf = (phase: MutablePhase): string[] => {
      const { container } = mount({ phases: [phase], selectedIndex: 0, snapshot });
      const values = Array.from(
        container.querySelectorAll('[data-testid="phases-model-custom"] option')
      ).map((option) => (option as HTMLOptionElement).value);
      cleanup();
      return values;
    };

    expect(modelsOf({ ...STORED_PHASE, sideEffects: 'git' })).toEqual(['', 'claude-opus-5-5']);
    expect(modelsOf({ ...STORED_PHASE, sideEffects: 'workspace' })).toEqual(['', 'gemini-3.7-pro']);
    expect(modelsOf({ ...STORED_PHASE, sideEffects: 'git', runner: 'agy' })).toEqual(['', 'gemini-3.7-pro']);
  });

  it('names an unset effort as the backend default, the word the model select uses', () => {
    // The host passes the backend no effort when the Phase sets none, exactly as for an
    // unset model (`LaunchPhaseSettings` calls both `backend-default`). Nothing is
    // inherited: a Workflow's execution defaults are advisory and no run applies them.
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    const firstOptionText = (testId: string): string | undefined =>
      container.querySelector(`[data-testid="${testId}"] option`)?.textContent.trim();

    expect(firstOptionText('phases-effort-custom')).toBe('Backend default');
    expect(firstOptionText('phases-model-custom')).toBe('Backend default');
  });

  it('applies the effort limits of the backend a Git-writing Phase runs on', () => {
    const snapshot = { ...SNAPSHOT, defaultRunnerKind: 'agy' } as unknown as WorkflowSnapshot;
    const xhighOf = (phase: MutablePhase): HTMLOptionElement | null =>
      mount({ phases: [phase], selectedIndex: 0, snapshot }).container.querySelector(
        '[data-testid="phases-effort-custom"] option[value="xhigh"]'
      );

    expect(xhighOf({ ...STORED_PHASE, sideEffects: 'git' })?.disabled).toBe(false);
    cleanup();
    expect(xhighOf(STORED_PHASE)?.disabled).toBe(true);
  });

  it('keeps a stored row editable and offers removal (T496f)', () => {
    // Feature 099 (T496f, FR-041, FR-043) — the `built-in` tier was the one thing
    // that made an author field read-only on a row the operator could see, and it
    // is deleted. The inversion is the claim: every stored row is editable and
    // removable, so a read-only branch surviving the collapse fails here rather
    // than presenting a definition the operator silently cannot change. The id
    // field is the exception and keeps its own case below — it is read-only
    // because the row is PERSISTED, which is about identity, not about a layer.
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    expect(container.querySelector('[data-testid="phases-name-field-custom"]')?.hasAttribute('readonly')).toBe(false);
    expect(container.querySelector('[data-testid="phases-remove"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="phases-raw-json-toggle"]')).not.toBeNull();
  });

  it('keeps a persisted custom Phase id read-only', () => {
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    const idInput = [...container.querySelectorAll('.form-field')]
      .find((field) => field.querySelector('.form-label')?.textContent === 'ID')
      ?.querySelector('input');
    expect(idInput?.hasAttribute('readonly')).toBe(true);
  });

  it('associates duplicate-id validation with the Phase id field', () => {
    const duplicate: MutablePhase = {
      ...STORED_PHASE,
      sourceStatus: 'invalid',
      sourceErrors: [{
        field: 'phaseId', code: 'duplicate-in-scope', message: 'Phase id appears twice'
      }]
    };
    const { container } = mount({ phases: [duplicate], selectedIndex: 0 });
    const idInput = [...container.querySelectorAll('.form-field')]
      .find((field) => field.querySelector('.form-label')?.textContent === 'ID')
      ?.querySelector('input');
    expect(idInput?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Phase id appears twice');
  });

  it('offers a new draft no target-scope picker (T496f)', () => {
    // Feature 099 (T496f, FR-043) — a save has one destination, so the control is
    // deleted rather than reduced to a single-option select that decides nothing.
    // Pinned by absence, and by the patch it used to emit never being emitted:
    // a `scope` reaching `onphasechange` would be a field no save carries.
    const draft = { ...STORED_PHASE, persisted: false, sourceKey: 'draft::custom' };
    const onphasechange = vi.fn();
    const mounted = mount({ phases: [draft], selectedIndex: 0, onphasechange });
    const scopePicker = [...mounted.container.querySelectorAll('select')].find((element) =>
      element.textContent?.includes('Workspace') || element.textContent?.includes('User')
    );
    expect(scopePicker).toBeUndefined();
  });

  it('switches from instruction to skill as a mutually exclusive directive', async () => {
    // The redesign sets the directive as a segmented pair of buttons rather than a
    // select; the patch the switch sends is the one the select sent.
    const onphasechange = vi.fn();
    const mounted = mount({ phases: [STORED_PHASE], selectedIndex: 0, onphasechange });
    const skill = mounted.container.querySelector(
      '[data-testid="phases-directive-skill"]'
    ) as HTMLButtonElement;
    await fireEvent.click(skill);
    expect(onphasechange).toHaveBeenCalledWith(0, { instruction: undefined, skill: '' });
  });

  it('preserves invalid authored values for repair in Raw JSON', () => {
    const row = sourceRecordToMutable({
      key: 'workspace::broken::0', phaseId: 'broken', scope: 'workspace',
      status: 'invalid', definition: null,
      display: {
        id: 'broken', name: 'Broken', version: 4, instruction: 'Run.',
        model: 'missing-model', timeoutSeconds: 9001, retryCondition: '('
      },
      errors: [{ field: 'timeoutSeconds', code: 'out-of-range', message: 'Too large' }]
    } as never);

    expect(row).toMatchObject({
      id: 'broken', model: 'missing-model', timeoutSeconds: 9001, retryCondition: '('
    });
  });

  it('makes non-target rows read-only during an atomic mutation', () => {
    const other = { ...STORED_PHASE, id: 'other', name: 'Other', sourceKey: 'workspace::other::0' };
    const editor = mount({
      phases: [STORED_PHASE, other], selectedIndex: 1, mutationActive: true,
      editableSourceKey: STORED_PHASE.sourceKey
    });

    expect(editor.container.querySelector('[data-testid="phases-name-field-other"]')
      ?.hasAttribute('readonly')).toBe(true);

    // The redesign gives the open Phase a page of its own in place of the list, and
    // "New phase" stayed on the list, so the add control is read from the list with
    // nothing open.
    const list = mount({
      phases: [STORED_PHASE, other], selectedIndex: null, mutationActive: true,
      editableSourceKey: STORED_PHASE.sourceKey
    });
    expect((list.container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

// Feature 084 T066 / Feature 326 — the exchange entry points, as the manager offers them.
// Import moved to Builder's single top-level Import… modal (PipelineBuilder.test.ts), while
// Export YAML… lives in both the Phase editor overflow menu and each Phase list row's ⋯ menu.
describe('Phase catalog exchange entry points', () => {
  it('offers Export YAML… in the editor menu and per-row list menu, with no inline import band', () => {
    const editor = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    expect(editor.container.querySelectorAll('[data-testid="process-export-button"]')).toHaveLength(1);
    expect(editor.container.querySelectorAll('[data-testid="process-import-preflight"]')).toHaveLength(0);

    const list = mount({ phases: [STORED_PHASE] });
    expect(list.container.querySelectorAll('[data-testid="process-export-button"]')).toHaveLength(1);
    expect(list.container.querySelectorAll('[data-testid="process-import-preflight"]')).toHaveLength(0);
  });

  it('keeps Export enabled where every other row control is closed', () => {
    // Export writes a file the operator names and changes no catalog state, so a
    // pending mutation is not a reason to withhold it. "New phase" stayed on the
    // list when the redesign gave the open Phase its own page, so Duplicate, beside
    // Export in that page's menu, stands for the controls a mutation closes.
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0, mutationActive: true });
    expect(isMenuItemOff(container.querySelector('[data-testid="process-export-button"]'))).toBe(false);
    expect(isMenuItemOff(container.querySelector('[data-testid="phases-duplicate"]'))).toBe(true);
  });

  it('refuses to export an unsaved draft, and says why (FR-015, FR-057)', () => {
    const draft = { ...STORED_PHASE, persisted: false, sourceKey: 'draft::workspace::custom' };
    const { container } = mount({ phases: [draft], selectedIndex: 0 });
    expect(isMenuItemOff(container.querySelector('[data-testid="process-export-button"]'))).toBe(true);
    expect(container.querySelector('[data-testid="process-export-disabled-reason"]')?.textContent)
      .toContain('Save this Phase');
  });

  it('routes empty-catalog Import… to the top-level import handler and honors importDisabledReason', async () => {
    const onopenimport = vi.fn();
    const openable = mount({ phases: [], onopenimport });
    const emptyImport = openable.container.querySelector(
      '[data-testid="catalog-empty-import-phase"]'
    ) as HTMLButtonElement;
    expect(emptyImport).not.toBeNull();
    expect(emptyImport.disabled).toBe(false);
    await fireEvent.click(emptyImport);
    expect(onopenimport).toHaveBeenCalledWith(emptyImport);
    cleanup();

    const blocked = mount({ phases: [], importDisabledReason: 'Only the primary window can import.' });
    const disabledImport = blocked.container.querySelector(
      '[data-testid="catalog-empty-import-phase"]'
    ) as HTMLButtonElement;
    expect(disabledImport.disabled).toBe(true);
    expect(blocked.container.querySelector('[data-testid="catalog-empty-import-unavailable-phase"]')?.textContent)
      .toContain('primary window');
  });

  it('offers neither control while the catalog is still loading', () => {
    // Structural, not checked: the entry points live inside the ready arm, so an
    // empty layer projection — which a commit would write as a layer erasure —
    // cannot be reached.
    const { container } = mount({
      snapshot: { ...SNAPSHOT, phaseCatalog: undefined } as WorkflowSnapshot
    });
    expect(container.querySelector('[data-testid="process-import-preflight"]')).toBeNull();
    expect(container.querySelector('[data-testid="process-export-button"]')).toBeNull();
  });
});

// Feature 186 (US1, T007) — the lifecycle facts move off the list row and onto
// the editor card for the open Phase (FR-001, FR-002, FR-003).
describe('Phase catalog lifecycle relocation (US1, T007)', () => {
  it('shows the panel on the editor card for the selected phase, and not on its list row', () => {
    const editor = mount({
      snapshot: LIFECYCLE_SNAPSHOT,
      phases: [STORED_PHASE],
      selectedIndex: 0
    });

    const editorCard = editor.container.querySelector('[data-testid="phases-editor-custom"]') as HTMLElement;
    expect(editorCard).not.toBeNull();
    for (const suffix of ['created', 'modified', 'active-version']) {
      expect(
        editorCard.querySelector(`[data-testid="definition-row-${suffix}-custom"]`),
        `expected the editor card to show the ${suffix} cell`
      ).not.toBeNull();
    }
    expect(
      editorCard.querySelector('[data-testid="definition-history-toggle-custom"]')
    ).not.toBeNull();

    // The redesign draws the list and the open Phase's editor as separate pages, so
    // the row is read from the list with nothing open, and it is a table row now.
    // The panel stays off it: its Created, Modified and Active version cells, its
    // defects and its History. The next test holds the rest of FR-003's row.
    const list = mount({ snapshot: LIFECYCLE_SNAPSHOT, phases: [STORED_PHASE] });
    const listRow = list.container.querySelector(
      '[data-testid="phases-list-item-custom"]'
    )?.closest('tr') as HTMLElement;
    expect(listRow).not.toBeNull();
    for (const suffix of ['created', 'modified', 'active-version', 'defects']) {
      expect(
        listRow.querySelector(`[data-testid="definition-row-${suffix}-custom"]`),
        `expected the list row to show no ${suffix} cell`
      ).toBeNull();
    }
    expect(
      listRow.querySelector('[data-testid="definition-history-toggle-custom"]')
    ).toBeNull();
  });

  // The aside's Issues list shows every saved defect of the open Phase, so the panel above it
  // lists none of them a second time; they stay on demand there (FR-015).
  it('lists a saved defect once, in the Issues list', () => {
    const invalid: MutablePhase = {
      ...STORED_PHASE,
      sourceStatus: 'invalid',
      sourceErrors: [{ field: 'name', code: 'invalid-length', message: 'Name is invalid' }]
    };
    const { container } = mount({ snapshot: LIFECYCLE_SNAPSHOT, phases: [invalid], selectedIndex: 0 });

    expect(container.querySelector('#phase-errors-custom')?.textContent).toContain('Name is invalid');
    expect(container.querySelector('[data-testid="definition-row-active-version-custom"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="definition-row-defects-custom"]')).toBeNull();
  });

  // Feature 326: the non-functional Order column (↑ ↓) is retired; each Phase row shows
  // Phase (name + id), Status (badges), and Actions (⋯ overflow menu: Open, Duplicate,
  // Export YAML…, divider, Deactivate…).
  it('draws a list row with Phase, Status, and per-row ⋯ Actions menu (no Order buttons)', async () => {
    const phase: MutablePhase = { ...STORED_PHASE, description: 'Checks the custom rules.', model: 'model-a' };
    const onselect = vi.fn();
    const onduplicate = vi.fn();
    const onremove = vi.fn();
    const { container } = mount({
      snapshot: LIFECYCLE_SNAPSHOT,
      phases: [phase],
      onselect,
      onduplicate,
      onremove
    });

    const headers = [...container.querySelectorAll('thead th')].map((cell) => cell.textContent.trim());
    expect(headers).toEqual(['Phase', 'Status', 'Actions']);

    const row = container.querySelector('[data-testid="phases-list-item-custom"]')?.closest('tr') as HTMLElement;
    expect(row.querySelectorAll('td')).toHaveLength(3);
    expect(row.textContent).not.toContain('Checks the custom rules.');
    expect(row.textContent).not.toContain('model-a');
    expect(row.querySelector('[data-testid="phases-move-up-custom"]')).toBeNull();
    expect(row.querySelector('[data-testid="phases-move-down-custom"]')).toBeNull();

    const menuTrigger = row.querySelector('[data-testid="phases-row-menu-custom"]');
    expect(menuTrigger?.getAttribute('aria-haspopup')).toBe('menu');

    const menu = row.querySelector('[role="menu"]') as HTMLElement;
    const itemOrder = [...menu.children].map((el) =>
      el.tagName === 'HR' ? 'hr' : el.getAttribute('data-testid')
    );
    expect(itemOrder).toEqual([
      'phases-row-open-custom',
      'phases-row-duplicate-custom',
      'process-export-button',
      'hr',
      'phases-row-remove-custom'
    ]);

    await fireEvent.click(menu.querySelector('[data-testid="phases-row-open-custom"]')!);
    expect(onselect).toHaveBeenCalledWith(0);

    await fireEvent.click(menu.querySelector('[data-testid="phases-row-duplicate-custom"]')!);
    expect(onduplicate).toHaveBeenCalledWith(0);

    const removeItem = menu.querySelector('[data-testid="phases-row-remove-custom"]') as HTMLElement;
    expect(removeItem.classList.contains('danger')).toBe(true);
    expect(removeItem.textContent.trim()).toBe('Deactivate…');
    await fireEvent.click(removeItem);
    expect(onremove).toHaveBeenCalledWith(0, removeItem);
  });

  it('marks a row whose model is unavailable beside its badges, without the model', () => {
    const phase = { ...STORED_PHASE, model: 'missing-model', modelAvailable: false };
    const { container } = mount({ phases: [phase] });
    const row = container.querySelector('[data-testid="phases-list-item-custom"]')?.closest('tr') as HTMLElement;
    expect(row.textContent).toContain('model unavailable');
    expect(row.textContent).not.toContain('missing-model');
  });
});

// A sentence in the Builder gives the Phase kind its capital, as the Builder's
// other hints, both mockups' descriptions and the glossary do. Its commands keep
// the lower case both mockups give them ("New phase", "Search phases").
describe('Phase catalog sentences name the Phase with its capital', () => {
  function textOf(node: Element | null | undefined): string {
    return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('says a saved Phase is duplicated to get a new ID', () => {
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    expect(textOf(container.querySelector('.id-hint'))).toBe(
      'ID custom is fixed once saved. Duplicate the Phase to get a new ID.'
    );
  });

  it('captions the retry toggle with the Phase it retries', () => {
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    const toggle = container.querySelector('[data-testid="phases-retry-toggle"]');
    expect(textOf(toggle?.closest('label'))).toBe('Retry this Phase while a condition holds');
  });

  it('says a retry cap outcome the Phase states is set on this Phase', () => {
    const phase: MutablePhase = { ...STORED_PHASE, retryCondition: 'tests-passed', onRetryCap: 'fail' };
    const { container } = mount({ phases: [phase], selectedIndex: 0 });
    expect(textOf(container.querySelector('[data-testid="phases-retry-cap-origin-custom"]'))).toBe(
      'Set on this Phase.'
    );
  });

  it('says no Phases match when the search hides every row', async () => {
    const { container } = mount({ phases: [STORED_PHASE] });
    await fireEvent.input(container.querySelector('[data-testid="phases-search"]') as HTMLInputElement, {
      target: { value: 'zzz' }
    });
    expect(textOf(container.querySelector('[data-testid="phases-no-match"]'))).toBe(
      'No Phases match the search or the status filter.'
    );
  });

  it('keeps the list commands in lower case', () => {
    const { container } = mount({ phases: [STORED_PHASE] });
    const search = container.querySelector('[data-testid="phases-search"]') as HTMLInputElement;
    expect(search.getAttribute('aria-label')).toBe('Search phases');
    expect(textOf(container.querySelector('[data-testid="phases-add"]'))).toBe('New phase');
  });
});

// The host runs a Phase that sets no backend on the default backend, the one the Backend setting
// selects, or on Claude when the Phase writes Git metadata. A Workflow's execution defaults are
// advisory and no run applies them, so the unset option must not name the Workflow.
describe('Phase editor names what an unset backend runs on', () => {
  it('offers the default backend first, then each backend', () => {
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    const select = container.querySelector('[data-testid="phases-runner-custom"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent.trim())).toEqual([
      'Default backend',
      'claude',
      'codex',
      'agy'
    ]);
    expect(select.value).toBe('');
  });
});

describe('Phase catalog overflow menu and list unsaved banner consistency', () => {
  it('orders Edit/Duplicate/Export/Revert before hr + danger Deactivate…, with zero move items', () => {
    const { container } = mount({ phases: [STORED_PHASE], selectedIndex: 0 });
    const menu = container.querySelector('[role="menu"]') as HTMLElement | null;
    expect(menu).not.toBeNull();
    const children = [...menu!.children];
    const testIds = children.map((el) =>
      el.tagName === 'HR' ? 'hr' : el.getAttribute('data-testid')
    );
    expect(testIds).toEqual([
      'phases-raw-json-toggle',
      'phases-duplicate',
      'process-export-button',
      'phases-revert',
      'hr',
      'phases-remove'
    ]);

    const iconOf = (testId: string): string | null | undefined =>
      menu!.querySelector(`[data-testid="${testId}"] use`)?.getAttribute('href');
    expect(iconOf('phases-raw-json-toggle')).toBe('#i-edit');
    expect(iconOf('phases-duplicate')).toBe('#i-copy');
    expect(iconOf('process-export-button')).toBe('#i-export');
    expect(iconOf('phases-revert')).toBe('#i-undo');
    expect(iconOf('phases-remove')).toBe('#i-trash');

    expect(menu!.querySelector('[data-testid^="phases-move-"]')).toBeNull();
    const removeBtn = menu!.querySelector('[data-testid="phases-remove"]');
    expect(removeBtn?.classList.contains('danger')).toBe(true);
    expect(removeBtn?.textContent.trim()).toBe('Deactivate…');
  });

  it('keeps list clean of editor Undo/Redo/Save and shows an unsaved-edits banner with Resume editing', async () => {
    const idle = mount({ phases: [STORED_PHASE], mutationActive: false });
    expect(idle.container.querySelector('[data-testid="phases-add"]')?.classList.contains('btn-primary')).toBe(true);
    expect(idle.container.querySelector('[data-testid="phases-save-all"]')).toBeNull();
    expect(idle.container.querySelector('[data-testid="phases-unsaved-banner"]')).toBeNull();
    cleanup();

    const onselect = vi.fn();
    const editing = mount({
      phases: [STORED_PHASE],
      mutationActive: true,
      editableSourceKey: STORED_PHASE.sourceKey,
      onselect
    });
    expect(editing.container.querySelector('[data-testid="phases-save-all"]')).toBeNull();
    expect(editing.container.querySelector('[aria-label="Undo"]')).toBeNull();
    expect(editing.container.querySelector('[aria-label="Redo"]')).toBeNull();

    const add = editing.container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement;
    expect(add.classList.contains('btn-primary')).toBe(true);
    expect(add.disabled).toBe(true);

    const banner = editing.container.querySelector('[data-testid="phases-unsaved-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('has unsaved changes');
    expect(banner?.textContent).toContain('Custom');

    const resume = editing.container.querySelector('[data-testid="phases-resume-editing"]') as HTMLButtonElement;
    expect(resume).not.toBeNull();
    await fireEvent.click(resume);
    expect(onselect).toHaveBeenCalledWith(0);
  });
});
