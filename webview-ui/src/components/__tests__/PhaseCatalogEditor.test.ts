import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import PhaseCatalogEditor from '../PipelineBuilderEditors/PhaseCatalogEditor.svelte';
import { sourceRecordToMutable } from '../PipelineBuilderEditors/phase-catalog-state';
import type { MutablePhase } from '../PipelineBuilderEditors/types';

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

const WORKSPACE_PHASE: MutablePhase = {
  id: 'custom', name: 'Custom', version: 2, instruction: 'Run.',
  sourceKey: 'workspace::custom::0', scope: 'workspace', sourceStatus: 'effective',
  sourceErrors: [], persisted: true
};

function mount(options: {
  snapshot?: WorkflowSnapshot;
  phases?: MutablePhase[];
  selectedIndex?: number | null;
  mutationActive?: boolean;
  editableSourceKey?: string | null;
  onphasechange?: (index: number, patch: Partial<MutablePhase>) => void;
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
      onselect: vi.fn(), onadd: vi.fn(), onremove: vi.fn(), onreset: vi.fn(),
      onphasechange: options.onphasechange ?? vi.fn(), onmoveup: vi.fn(), onmovedown: vi.fn(),
      onundo: vi.fn(), onredo: vi.fn(), onsave: vi.fn(),
      ondismisssaveerror: vi.fn(), ontoggleraw: vi.fn(), onrawsave: vi.fn(),
      ontoggleretry: vi.fn(), onretrychange: vi.fn(), onduplicate: vi.fn()
    }
  });
}

describe('Phase catalog source editor states', () => {
  it('renders a non-authoritative loading state and no mutation toolbar', () => {
    const { container } = mount({ snapshot: { ...SNAPSHOT, phaseCatalog: undefined } as WorkflowSnapshot });
    expect(container.querySelector('[data-testid="phase-catalog-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="phases-add"]')).toBeNull();
  });

  it('renders source scope and effective status badges', () => {
    const { container } = mount({ phases: [WORKSPACE_PHASE] });
    expect(container.textContent).toContain('workspace');
    expect(container.textContent).toContain('effective');
  });

  it('renders invalid source errors and associates them with fields', () => {
    const invalid: MutablePhase = {
      ...WORKSPACE_PHASE,
      sourceStatus: 'invalid',
      sourceErrors: [{ field: 'name', code: 'invalid-length', message: 'Name is invalid' }]
    };
    const { container } = mount({ phases: [invalid], selectedIndex: 0 });
    const name = container.querySelector('[data-testid="phases-name-field-custom"]');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(name?.getAttribute('aria-describedby')).toContain('phase-errors-workspace-custom');
    expect(container.textContent).toContain('Name is invalid');
  });

  it('keeps an unavailable configured model visible', () => {
    const phase = { ...WORKSPACE_PHASE, model: 'missing-model', modelAvailable: false };
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
      configuredModels: { claude: ['claude-opus-5', 'claude-sonnet-5'], codex: [], agy: [] }
    } as unknown as WorkflowSnapshot;
    const { container } = mount({ phases: [WORKSPACE_PHASE], selectedIndex: 0, snapshot });

    const options = Array.from(
      container.querySelectorAll('[data-testid="phases-model-custom"] option')
    ).map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(['', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('offers configured and detected models together, configured first and deduped', () => {
    const snapshot = {
      ...SNAPSHOT,
      availableModels: { claude: [], codex: [], agy: ['gemini-3.7-flash-high', 'gemini-3.7-pro'] },
      configuredModels: { claude: [], codex: [], agy: ['my-own-id', 'gemini-3.7-pro'] }
    } as unknown as WorkflowSnapshot;
    const phase = { ...WORKSPACE_PHASE, runner: 'agy' as const };
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
      configuredModels: { claude: ['claude-opus-5'], codex: [], agy: [] }
    } as unknown as WorkflowSnapshot;
    const phase = { ...WORKSPACE_PHASE, model: 'retired-model' };
    const { container } = mount({ phases: [phase], selectedIndex: 0, snapshot });

    expect(container.querySelector('[data-testid="phases-model-custom"]')?.textContent)
      .toContain('retired-model (Unavailable)');
  });

  it('keeps built-in author fields read-only and hides removal', () => {
    const builtIn: MutablePhase = {
      ...WORKSPACE_PHASE,
      scope: 'built-in',
      sourceKey: 'built-in::custom::0'
    };
    const { container } = mount({ phases: [builtIn], selectedIndex: 0 });
    expect(container.querySelector('[data-testid="phases-name-field-custom"]')?.hasAttribute('readonly')).toBe(true);
    expect(container.querySelector('[data-testid="phases-remove"]')).toBeNull();
    expect(container.querySelector('[data-testid="phases-raw-json-toggle"]')).toBeNull();
  });

  it('keeps a persisted custom Phase id read-only', () => {
    const { container } = mount({ phases: [WORKSPACE_PHASE], selectedIndex: 0 });
    const idInput = [...container.querySelectorAll('.form-field')]
      .find((field) => field.querySelector('.form-label')?.textContent === 'ID')
      ?.querySelector('input');
    expect(idInput?.hasAttribute('readonly')).toBe(true);
  });

  it('associates duplicate-id validation with the Phase id field', () => {
    const duplicate: MutablePhase = {
      ...WORKSPACE_PHASE,
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

  it('lets a new draft select a writable target scope', async () => {
    const draft = { ...WORKSPACE_PHASE, persisted: false, sourceKey: 'draft::workspace::custom' };
    const onphasechange = vi.fn();
    const mounted = mount({ phases: [draft], selectedIndex: 0, onphasechange });
    const select = [...mounted.container.querySelectorAll('select')].find((element) =>
      element.textContent?.includes('Workspace') && element.textContent?.includes('User')
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'user' } });
    expect(onphasechange).toHaveBeenCalledWith(0, { scope: 'user' });
  });

  it('switches from instruction to skill as a mutually exclusive directive', async () => {
    const onphasechange = vi.fn();
    const mounted = mount({ phases: [WORKSPACE_PHASE], selectedIndex: 0, onphasechange });
    const select = [...mounted.container.querySelectorAll('select')].find((element) =>
      element.textContent?.includes('Instruction') && element.textContent?.includes('Skill reference')
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'skill' } });
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
    const other = { ...WORKSPACE_PHASE, id: 'other', name: 'Other', sourceKey: 'workspace::other::0' };
    const { container } = mount({
      phases: [WORKSPACE_PHASE, other], selectedIndex: 1, mutationActive: true,
      editableSourceKey: WORKSPACE_PHASE.sourceKey
    });

    expect(container.querySelector('[data-testid="phases-name-field-other"]')
      ?.hasAttribute('readonly')).toBe(true);
    expect((container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

// Feature 084 T066 — the exchange entry points, as the manager offers them. The
// decisions themselves are pinned in process-exchange-entry.test.ts; what is
// asserted here is that the surface is wired to them.
describe('Phase catalog exchange entry points', () => {
  // Export moved from the sidebar row to the editor header, so it is offered for
  // the selected Phase rather than once per row; Import stays with the catalog.
  it('offers Export for the selected Phase and Import once for the catalog', () => {
    const { container } = mount({ phases: [WORKSPACE_PHASE], selectedIndex: 0 });
    expect(container.querySelectorAll('[data-testid="process-export-button"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="process-import-preflight"]')).toHaveLength(1);
  });

  it('keeps Export enabled where every other row control is closed', () => {
    // Export writes a file the operator names and changes no catalog state, so a
    // pending mutation is not a reason to withhold it.
    const { container } = mount({ phases: [WORKSPACE_PHASE], selectedIndex: 0, mutationActive: true });
    expect((container.querySelector('[data-testid="process-export-button"]') as HTMLButtonElement)
      .disabled).toBe(false);
    expect((container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('refuses to export an unsaved draft, and says why (FR-015, FR-057)', () => {
    const draft = { ...WORKSPACE_PHASE, persisted: false, sourceKey: 'draft::workspace::custom' };
    const { container } = mount({ phases: [draft], selectedIndex: 0 });
    expect((container.querySelector('[data-testid="process-export-button"]') as HTMLButtonElement)
      .disabled).toBe(true);
    expect(container.querySelector('[data-testid="process-export-disabled-reason"]')?.textContent)
      .toContain('Save this Phase');
  });

  it('closes Import while a Phase mutation is outstanding, and says why', () => {
    // The commit sends the whole persisted layer, so an import started now would
    // ask the operator to confirm a write that excludes their pending edit.
    const { container } = mount({ phases: [WORKSPACE_PHASE], mutationActive: true });
    expect((container.querySelector('[data-testid="process-import-inspect"]') as HTMLButtonElement)
      .disabled).toBe(true);
    expect(container.querySelector('[data-testid="process-import-unavailable"]')?.textContent)
      .toContain('pending');
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
