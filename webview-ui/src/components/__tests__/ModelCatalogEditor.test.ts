import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

// Feature 096 T017 — mirrors `PipelineCatalogEditor.test.ts`'s mock of the
// shared exchange helper: the spy has to be declared before the mock factory
// closes over it, and the factory runs before the component import below.
const exportSpy = vi.fn<() => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportModelCatalogYaml: () => exportSpy()
}));

import ModelCatalogEditor from '../PipelineBuilderEditors/ModelCatalogEditor.svelte';

const baseProps = {
  availableModels: { claude: ['claude-sonnet'] },
  models: { claude: ['claude-sonnet'] },
  newModelInput: { claude: '' },
  onnewmodelinput: vi.fn(),
  onmodelchange: vi.fn(),
  onadd: vi.fn(),
  onremove: vi.fn(),
  onsave: vi.fn(),
  ondetect: vi.fn()
};

beforeEach(() => exportSpy.mockReset());
afterEach(() => cleanup());

describe('ModelCatalogEditor accessibility', () => {
  it('gives new and existing model inputs explicit accessible names', async () => {
    const { container, getByRole, getByLabelText } = render(ModelCatalogEditor, { props: baseProps });

    // Builder redesign: the new-model input sits behind its section's "Add model" button, and
    // Remove is an icon button. The names under test are unchanged.
    await fireEvent.click(getByRole('button', { name: 'Add model' }));

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.getAttribute('aria-label')).toBe('New claude model name');
    expect(inputs[1]?.getAttribute('aria-label')).toBe('claude model 1');
    expect(getByLabelText('Remove claude model claude-sonnet').tagName).toBe('BUTTON');
  });
});

describe('ModelCatalogEditor export (feature 096 T017)', () => {
  it('asks the host to export the Model Catalog, with no resourceId or location', async () => {
    const { getByRole } = render(ModelCatalogEditor, { props: baseProps });

    // Builder redesign: the button reads "Export…" and keeps "Export Model Catalog" as its name.
    await fireEvent.click(getByRole('button', { name: 'Export Model Catalog' }));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith();
  });

  it('does not call export when Save is clicked', async () => {
    const { getByRole } = render(ModelCatalogEditor, { props: baseProps });

    // Builder redesign: "Save All Models" reads "Save", as on the other Builder tabs.
    await fireEvent.click(getByRole('button', { name: 'Save' }));

    expect(baseProps.onsave).toHaveBeenCalledTimes(1);
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

// Feature 096 T027 — regression coverage for pre-existing per-backend
// grouping and removal (research.md Decision 9: no source change expected,
// confirmed by T028 via these tests passing unmodified).
describe('ModelCatalogEditor regression — per-backend grouping and removal (feature 096 T027)', () => {
  const twoBackendProps = {
    ...baseProps,
    availableModels: { claude: ['claude-sonnet'], codex: ['codex-mini'] },
    models: { claude: ['claude-model-a', 'claude-model-b'], codex: ['codex-model-a'] },
    newModelInput: { claude: '', codex: '' }
  };

  it('groups models under 2+ backends independently, with no cross-backend leakage', () => {
    const { getAllByRole, getByRole } = render(ModelCatalogEditor, { props: twoBackendProps });

    expect(getAllByRole('region')).toHaveLength(2);

    const valuesIn = (section: Element) =>
      Array.from(section.querySelectorAll('.model-list-item input')).map(
        (input) => (input as HTMLInputElement).value
      );

    // Builder redesign: each backend's section is a region named by its heading, which holds the
    // backend key alone, so the sections are found by name rather than by their text. `text-transform:
    // capitalize` is a display style — the name is still the raw (lowercase) key.
    expect(valuesIn(getByRole('region', { name: 'claude' }))).toEqual(['claude-model-a', 'claude-model-b']);
    expect(valuesIn(getByRole('region', { name: 'codex' }))).toEqual(['codex-model-a']);
  });

  it('removing a model reports its own backend and index, never the other backend', async () => {
    const onremove = vi.fn();
    const { getByLabelText } = render(ModelCatalogEditor, {
      props: { ...twoBackendProps, onremove }
    });

    await fireEvent.click(getByLabelText('Remove codex model codex-model-a'));

    expect(onremove).toHaveBeenCalledTimes(1);
    expect(onremove).toHaveBeenCalledWith('codex', 0);
  });

  it('a removal reflected in props updates only its own backend, leaving the other intact for the next save/export', () => {
    const { getByRole, rerender } = render(ModelCatalogEditor, { props: twoBackendProps });

    // The component holds no catalog state of its own — the parent applies the
    // removal and passes down the new `models`, exactly as `onremove`'s
    // (backend, index) pair would drive it.
    void rerender({
      ...twoBackendProps,
      models: { claude: ['claude-model-b'], codex: ['codex-model-a'] }
    });

    const valuesIn = (section: Element) =>
      Array.from(section.querySelectorAll('.model-list-item input')).map(
        (input) => (input as HTMLInputElement).value
      );

    // Builder redesign: sections are found by their region name, as in the test above.
    expect(valuesIn(getByRole('region', { name: 'claude' }))).toEqual(['claude-model-b']);
    expect(valuesIn(getByRole('region', { name: 'codex' }))).toEqual(['codex-model-a']);
  });
});

// Feature 096 T029 — FR-005 changes pre-096 behavior: a duplicate add used to
// silently no-op. `onadd` is this component's only path to a catalog
// mutation (and from there to the parent's Save write), so
// proving it was never called proves neither happened.
//
// Builder redesign: the add form opens from its section's "Add model" button,
// and its submit button reads "Add".
describe('ModelCatalogEditor duplicate-add guard (feature 096 T029, FR-005)', () => {
  it('surfaces a message and does not call onadd when the id already exists for the backend', async () => {
    const onadd = vi.fn();
    const { getByRole, getByText } = render(ModelCatalogEditor, {
      props: { ...baseProps, newModelInput: { claude: 'claude-sonnet' }, onadd }
    });

    await fireEvent.click(getByRole('button', { name: 'Add model' }));
    await fireEvent.click(getByRole('button', { name: 'Add' }));

    expect(onadd).not.toHaveBeenCalled();
    expect(getByText(/already exists/i)).toBeTruthy();
  });

  it('does not block adding a new, non-duplicate id', async () => {
    const onadd = vi.fn();
    const { getByRole, queryByText } = render(ModelCatalogEditor, {
      props: { ...baseProps, newModelInput: { claude: 'claude-new-model' }, onadd }
    });

    await fireEvent.click(getByRole('button', { name: 'Add model' }));
    await fireEvent.click(getByRole('button', { name: 'Add' }));

    expect(onadd).toHaveBeenCalledTimes(1);
    expect(onadd).toHaveBeenCalledWith('claude');
    expect(queryByText(/already exists/i)).toBeNull();
  });
});

// The editor used to derive its sections from `availableModels`, which is the
// capability service's detected list. Claude and Codex now report no models —
// neither CLI can enumerate them — so deriving from it collapsed the very
// sections the operator types into. Sections are the union of what is
// configured and what was detected.
describe('ModelCatalogEditor sections survive an empty detected list', () => {
  // Builder redesign: each section's heading is an h2 holding the backend key alone; it read
  // "<key> Models" in an h3 before.
  it('renders a section for a backend that has configured models but no detected ones', () => {
    const { getAllByRole } = render(ModelCatalogEditor, {
      props: {
        ...baseProps,
        availableModels: { claude: [], codex: [], agy: ['gemini-3.7-flash-high'] },
        models: { claude: ['claude-opus-5-5'], codex: [], agy: [] },
        newModelInput: { claude: '', codex: '', agy: '' }
      }
    });

    const headings = getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['claude', 'codex', 'agy']);
  });

  it('still renders a section for a backend present only in the detected list', () => {
    const { getAllByRole } = render(ModelCatalogEditor, {
      props: {
        ...baseProps,
        availableModels: { agy: ['gemini-3.7-flash-high'] },
        models: { claude: [] },
        newModelInput: {}
      }
    });

    const headings = getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['claude', 'agy']);
  });
});

describe('ModelCatalogEditor detect control', () => {
  const detectProps = {
    ...baseProps,
    availableModels: { claude: [], agy: ['gemini-3.7-flash-high'] },
    models: { claude: ['claude-opus-5-5'], agy: [] },
    newModelInput: { claude: '', agy: '' }
  };

  it('asks the parent to merge the detected list for that backend alone', async () => {
    const ondetect = vi.fn();
    const { getByLabelText } = render(ModelCatalogEditor, {
      props: { ...detectProps, ondetect }
    });

    await fireEvent.click(getByLabelText('Detect agy models'));

    expect(ondetect).toHaveBeenCalledTimes(1);
    expect(ondetect).toHaveBeenCalledWith('agy');
  });

  it('disables detect for a backend whose CLI reported no models, and says why', () => {
    const { getByLabelText } = render(ModelCatalogEditor, { props: detectProps });

    const claudeDetect = getByLabelText('Detect claude models') as HTMLButtonElement;
    expect(claudeDetect.disabled).toBe(true);
    expect(claudeDetect.title).toMatch(/cannot list its models/i);

    expect((getByLabelText('Detect agy models') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not call ondetect when the control is disabled', async () => {
    const ondetect = vi.fn();
    const { getByLabelText } = render(ModelCatalogEditor, {
      props: { ...detectProps, ondetect }
    });

    await fireEvent.click(getByLabelText('Detect claude models'));

    expect(ondetect).not.toHaveBeenCalled();
  });
});

// ── Feature 101 (US1, T038, FR-041, SC-011) ─────────────────────────────────

describe('ModelCatalogEditor stays out of the lifecycle (US1, T038, FR-041)', () => {
  // Model configuration is not in the versioned catalog store, so the Builder's
  // lifecycle chrome has nothing to say about it: no state badge, no created or
  // modified time, no active version, no history, no changed-field summary.
  //
  // "Unchanged" is the kind of requirement that holds until someone mounts the
  // shared row in all the tabs and this one comes along for the ride. Feature
  // 101 still has six stories to land on the other three tabs, and this is what
  // turns red if any of them reaches this one.
  const LIFECYCLE_MARKERS: readonly string[] = [
    'definition-row-',
    'state-badge',
    'row-defects',
    'lifecycle'
  ];

  it('renders no lifecycle chrome of any kind', () => {
    const { container } = render(ModelCatalogEditor, { props: baseProps });

    for (const marker of LIFECYCLE_MARKERS) {
      expect(container.innerHTML, `Models tab must not carry "${marker}"`).not.toContain(marker);
    }
    expect(container.querySelector('[data-testid^="definition-row-"]')).toBeNull();
  });

  it('says nothing about Draft, Active, Publish, or versions', () => {
    const { container } = render(ModelCatalogEditor, { props: baseProps });
    const text = container.textContent ?? '';

    for (const word of ['Draft', 'Active with draft', 'Publish', 'Active version', 'Modified']) {
      expect(text, `Models tab must not read "${word}"`).not.toContain(word);
    }
  });

  it('holds its rendered markup as the baseline the rest of the feature must not move', () => {
    // SC-011 wants byte-identical, and a byte comparison needs something to
    // compare against. This is that something: the tab's markup as it stands
    // before US3 onward touch the other three tabs. It is not a claim about the
    // markup's contents — it is a tripwire, and a diff here means a change
    // reached the one tab the feature said it would not.
    //
    // The Builder redesign re-recorded it on purpose: the tab now draws each
    // backend as a section with a table, after the design mockup.
    const { container } = render(ModelCatalogEditor, { props: baseProps });

    expect(container.innerHTML).toMatchSnapshot();
  });
});

// ── Builder redesign: the Models tab's sections, tables and add form ─────────

describe('ModelCatalogEditor sections and add form (Builder redesign)', () => {
  const sectionProps = {
    ...baseProps,
    availableModels: { claude: ['claude-sonnet'], codex: ['codex-mini'], agy: [] },
    models: { claude: ['claude-sonnet', 'claude-typed'], codex: [], agy: [] },
    newModelInput: { claude: '', codex: '', agy: '' }
  };

  it('says where each id came from and how many each backend has', () => {
    const { getByRole } = render(ModelCatalogEditor, { props: sectionProps });

    const claude = getByRole('region', { name: 'claude' });
    const sources = Array.from(claude.querySelectorAll('tbody tr')).map(
      (row) => row.querySelector('td:nth-child(2)')?.textContent
    );
    expect(sources).toEqual(['Detected', 'Added by you']);
    expect(claude.querySelector('.mhead')?.textContent).toContain('2 models');
  });

  it('draws a backend with no ids as an empty card, not an empty table', () => {
    const { getByRole } = render(ModelCatalogEditor, { props: sectionProps });

    const codex = getByRole('region', { name: 'codex' });
    expect(codex.querySelector('table')).toBeNull();
    expect(codex.querySelector('.empty strong')?.textContent).toBe('No codex models yet');
    expect(codex.querySelector('.mhead')?.textContent).toContain('no models');
  });

  it('keeps a row, and the focus in its id, while the id is edited', async () => {
    const { getByLabelText, rerender } = render(ModelCatalogEditor, { props: sectionProps });
    const id = getByLabelText('claude model 1');
    id.focus();

    // The parent writes every keystroke back into `models` (PipelineBuilder's
    // `withModelReplaced`), so the id changes while the operator is typing it.
    await rerender({
      ...sectionProps,
      models: { claude: ['claude-sonnetx', 'claude-typed'], codex: [], agy: [] }
    });

    expect(getByLabelText('claude model 1')).toBe(id);
    expect(document.activeElement).toBe(id);
  });

  it('opens one add form at a time and focuses its input', async () => {
    const onnewmodelinput = vi.fn();
    const { getByRole, getByLabelText, queryByLabelText } = render(ModelCatalogEditor, {
      props: { ...sectionProps, onnewmodelinput }
    });

    const claudeAdd = getByRole('region', { name: 'claude' }).querySelector('[aria-expanded]');
    const codexAdd = getByRole('region', { name: 'codex' }).querySelector('[aria-expanded]');
    if (!(claudeAdd instanceof HTMLButtonElement) || !(codexAdd instanceof HTMLButtonElement)) {
      throw new Error('each section should have an Add model button');
    }

    await fireEvent.click(claudeAdd);
    expect(claudeAdd.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(getByLabelText('New claude model name'));

    await fireEvent.click(codexAdd);
    expect(queryByLabelText('New claude model name')).toBeNull();
    expect(claudeAdd.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(getByLabelText('New codex model name'));
    // The closed form's draft goes with it.
    expect(onnewmodelinput).toHaveBeenCalledWith('claude', '');
  });

  it('closes on Cancel or Escape, drops the draft and returns focus to its button', async () => {
    const onnewmodelinput = vi.fn();
    const { getByRole, getByLabelText, queryByLabelText } = render(ModelCatalogEditor, {
      props: { ...sectionProps, onnewmodelinput }
    });
    const claudeAdd = getByRole('region', { name: 'claude' }).querySelector('[aria-expanded]');
    if (!(claudeAdd instanceof HTMLButtonElement)) throw new Error('claude should have an Add model button');

    await fireEvent.click(claudeAdd);
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(queryByLabelText('New claude model name')).toBeNull();
    expect(document.activeElement).toBe(claudeAdd);
    expect(onnewmodelinput).toHaveBeenCalledTimes(1);
    expect(onnewmodelinput).toHaveBeenCalledWith('claude', '');

    await fireEvent.click(claudeAdd);
    await fireEvent.keyDown(getByLabelText('New claude model name'), { key: 'Escape' });
    expect(queryByLabelText('New claude model name')).toBeNull();
    expect(document.activeElement).toBe(claudeAdd);
    expect(onnewmodelinput).toHaveBeenCalledTimes(2);
  });

  it('ties the duplicate message to the input it is about', async () => {
    const { getByRole, getByLabelText } = render(ModelCatalogEditor, {
      props: { ...sectionProps, newModelInput: { claude: 'claude-typed', codex: '', agy: '' } }
    });

    await fireEvent.click(getByRole('region', { name: 'claude' }).querySelector('[aria-expanded]') as HTMLButtonElement);
    await fireEvent.click(getByRole('button', { name: 'Add' }));

    const input = getByLabelText('New claude model name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const message = getByRole('alert');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    expect(message.textContent).toBe('"claude-typed" already exists for claude.');
  });
});
