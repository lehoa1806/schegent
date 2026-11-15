import { describe, it, expect } from 'vitest';
import {
  PHASE_STATUS_VIEWS,
  phaseCountLine,
  phaseEditorOpen,
  phaseErrorId,
  phaseRowVisible,
  phaseRunsOn,
  type PhaseRowFacts
} from '../PipelineBuilderEditors/phase-catalog-view';

function row(overrides: Partial<PhaseRowFacts> = {}): PhaseRowFacts {
  return {
    name: 'Specify',
    id: 'speckit-specify',
    description: 'Turns the request into a specification.',
    sourceStatus: 'effective',
    state: 'active',
    ...overrides
  };
}

describe('PHASE_STATUS_VIEWS', () => {
  it('lists the status views in the order the toolbar shows them', () => {
    expect(PHASE_STATUS_VIEWS.map((view) => view.label)).toEqual([
      'All',
      'Active',
      'Draft',
      'Invalid'
    ]);
  });
});

describe('phaseRowVisible', () => {
  it('shows every row under All when the search is empty', () => {
    expect(phaseRowVisible(row(), 'all', '')).toBe(true);
    expect(phaseRowVisible(row({ state: undefined, sourceStatus: 'invalid' }), 'all', '')).toBe(true);
  });

  it('keeps the active rows under Active, a draft on top included', () => {
    expect(phaseRowVisible(row({ state: 'active' }), 'active', '')).toBe(true);
    expect(phaseRowVisible(row({ state: 'active-with-draft' }), 'active', '')).toBe(true);
    expect(phaseRowVisible(row({ state: 'draft' }), 'active', '')).toBe(false);
  });

  it('keeps the rows with a draft under Draft', () => {
    expect(phaseRowVisible(row({ state: 'draft' }), 'draft', '')).toBe(true);
    expect(phaseRowVisible(row({ state: 'active-with-draft' }), 'draft', '')).toBe(true);
    expect(phaseRowVisible(row({ state: 'active' }), 'draft', '')).toBe(false);
  });

  it('keeps only the invalid rows under Invalid, whatever their state', () => {
    expect(phaseRowVisible(row({ sourceStatus: 'invalid', state: 'active' }), 'invalid', '')).toBe(true);
    expect(phaseRowVisible(row({ sourceStatus: 'invalid', state: undefined }), 'invalid', '')).toBe(true);
    expect(phaseRowVisible(row({ sourceStatus: 'effective' }), 'invalid', '')).toBe(false);
  });

  it('keeps a row with no lifecycle out of Active and Draft', () => {
    // A row the operator has added and not saved has no lifecycle yet, so it is
    // neither published nor a stored draft.
    expect(phaseRowVisible(row({ state: undefined }), 'active', '')).toBe(false);
    expect(phaseRowVisible(row({ state: undefined }), 'draft', '')).toBe(false);
  });

  it('matches the name, the id or the description, ignoring case and the spaces around it', () => {
    expect(phaseRowVisible(row(), 'all', '  SPEC ')).toBe(true);
    expect(phaseRowVisible(row({ name: 'Plan' }), 'all', 'speckit-spec')).toBe(true);
    expect(phaseRowVisible(row({ name: 'Plan', id: 'plan' }), 'all', 'specification')).toBe(true);
  });

  it('drops a row the search does not match, and a row without a description', () => {
    expect(phaseRowVisible(row(), 'all', 'review')).toBe(false);
    expect(phaseRowVisible(row({ description: undefined }), 'all', 'request')).toBe(false);
  });

  it('applies the view and the search together', () => {
    expect(phaseRowVisible(row({ state: 'draft' }), 'active', 'specify')).toBe(false);
    expect(phaseRowVisible(row({ state: 'draft' }), 'draft', 'specify')).toBe(true);
  });
});

describe('phaseRunsOn', () => {
  it('joins the backend, model and effort the phase sets', () => {
    expect(phaseRunsOn({ runner: 'claude', model: 'opus', effort: 'high' })).toBe(
      'claude · opus · high'
    );
  });

  it('leaves out the parts the phase leaves to the workflow', () => {
    expect(phaseRunsOn({ model: 'opus', effort: 'high' })).toBe('opus · high');
    expect(phaseRunsOn({ runner: 'codex' })).toBe('codex');
  });

  it('names the Workflow defaults when the phase sets none of them', () => {
    expect(phaseRunsOn({})).toBe('Workflow defaults');
    expect(phaseRunsOn({ runner: undefined, model: '', effort: undefined })).toBe(
      'Workflow defaults'
    );
  });
});

describe('phaseEditorOpen', () => {
  it('opens the editor page for a selected row of a ready catalog', () => {
    expect(phaseEditorOpen({ catalogState: 'ready', selectedIndex: 0, phaseCount: 2 })).toBe(true);
    expect(phaseEditorOpen({ catalogState: 'ready', selectedIndex: 1, phaseCount: 2 })).toBe(true);
  });

  it('shows the list when nothing is selected', () => {
    expect(phaseEditorOpen({ catalogState: 'ready', selectedIndex: null, phaseCount: 2 })).toBe(false);
  });

  it('shows the list when the selection is outside the rows', () => {
    expect(phaseEditorOpen({ catalogState: 'ready', selectedIndex: 2, phaseCount: 2 })).toBe(false);
    expect(phaseEditorOpen({ catalogState: 'ready', selectedIndex: -1, phaseCount: 2 })).toBe(false);
  });

  it('opens no editor while the catalog loads or after it failed to load', () => {
    expect(phaseEditorOpen({ catalogState: undefined, selectedIndex: 0, phaseCount: 1 })).toBe(false);
    expect(phaseEditorOpen({ catalogState: 'error', selectedIndex: 0, phaseCount: 1 })).toBe(false);
  });
});

describe('phaseErrorId', () => {
  it('names the error list of a phase with defects', () => {
    // The form's fields and the Summary's "Issues" list meet on this id: each
    // invalid field points at the list with aria-describedby.
    expect(
      phaseErrorId({ id: 'custom', sourceErrors: [{ field: 'name', message: 'Name is invalid' }] })
    ).toBe('phase-errors-custom');
  });

  it('names nothing for a phase without defects, so no field points at an absent list', () => {
    expect(phaseErrorId({ id: 'custom', sourceErrors: [] })).toBeUndefined();
  });
});

describe('phaseCountLine', () => {
  it('counts the phases when the filter hides none', () => {
    expect(phaseCountLine(6, 6)).toBe('6 phases');
    expect(phaseCountLine(1, 1)).toBe('1 phase');
  });

  it('says how many of the phases the filter and search keep', () => {
    expect(phaseCountLine(2, 6)).toBe('2 of 6 phases');
    expect(phaseCountLine(0, 1)).toBe('0 of 1 phase');
  });
});
