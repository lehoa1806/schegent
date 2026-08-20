// Feature 063 T012 — unit coverage for the action-copy table and the
// `renderActionBody` placeholder resolver. The ActionKey union is the
// single source of truth for every confirmation prompt (FR-022b); this
// test pins both the table membership and the authoritative render
// output per the contract in
// specs/063-clean-all-confirmations/contracts/action-copy-table.md.
//
// The union's size is deliberately not stated here. It has changed with every
// feature that added or retired a confirmed action, and a number in a comment
// goes stale silently — the membership assertion below is the live statement of
// it.
import { describe, expect, it } from 'vitest';
import {
  ACTION_COPY,
  CLEAN_ALL_LOCK_CONTENTION_TOAST,
  CLEAN_ALL_PERSISTENCE_ERROR_TOAST,
  CLEAN_ALL_RUNNER_STILL_PENDING_TOAST,
  SUPPRESSION_CHECKBOX_LABEL,
  renderActionBody,
  type ActionKey
} from '../action-copy';

const EXPECTED_KEYS: readonly ActionKey[] = [
  // Feature 100 (T509a, FR-049) — two keys where features 082/083 had four. The
  // four were one per kind plus a whole-layer reset, because a removal was an
  // omission from a per-kind whole-array write. A lifecycle operation names one
  // definition of any kind, so the kind became a parameter rather than part of
  // the key; and a layer reset is no longer a write the store can make, so it is
  // no longer a decision the operator can take. The second key is new rather
  // than renamed: discarding a draft is a different loss from deactivating an
  // active definition, and the prompt has to say which.
  'catalog.deactivate-definition',
  'catalog.discard-draft',
  'queue.clean-all',
  'queue.clear-done',
  'queue.remove-item',
  'queue.cancel-item',
  'queue.pause',
  'queue.resume',
  'run.retry-phase-now',
  'run.restart-canceled',
  'run.modify-task',
  'history.rerun',
  'workspace.reset',
  'run.skip-phase',
  // Feature 087 (FR-023) — a run whose declared output targets existing content
  // replaces it, and the operator confirms that during composition, before any
  // durable state exists. Launching a run is not itself destructive; only this
  // one decision inside it is, which is why the key is scoped to the overwrite
  // rather than to the launch.
  'run.overwrite-output',
  // Feature 095 (FR-003) — deleting a queue drops its pending Tasks with no
  // undo, and the queue-scoped analogue of `queue.clean-all`.
  'queue.delete'
];

describe('ACTION_COPY exhaustiveness (FR-022b)', () => {
  it('contains every contractual ActionKey entry', () => {
    expect(Object.keys(ACTION_COPY).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('every entry carries a non-empty title, body template, and confirm label', () => {
    for (const key of EXPECTED_KEYS) {
      const entry = ACTION_COPY[key];
      expect(entry.title.length, `${key}.title`).toBeGreaterThan(0);
      expect(entry.bodyTemplate.length, `${key}.bodyTemplate`).toBeGreaterThan(0);
      expect(entry.confirmLabel.length, `${key}.confirmLabel`).toBeGreaterThan(0);
      expect(['info', 'caution', 'destructive']).toContain(entry.severity);
    }
  });

  it('destructive severity covers irreversible catalog and workspace actions', () => {
    const destructive = EXPECTED_KEYS.filter((k) => ACTION_COPY[k].severity === 'destructive');
    expect(destructive.sort()).toEqual([
      // Feature 100 — both remain destructive, for two different reasons. A
      // deactivation drops the definition from the launchable catalog; a discard
      // drops an edit that was never published, and of a never-published
      // definition it drops the entry itself. `caution` is for actions that only
      // interrupt, and neither of these does.
      'catalog.deactivate-definition',
      'catalog.discard-draft',
      'queue.clean-all',
      // Feature 095 — dropping a queue drops the pending Tasks on it. Sorts
      // after `queue.clean-all` and before `run.overwrite-output`.
      'queue.delete',
      // Feature 087 — replacing existing content has no undo, which is what
      // `destructive` means here.
      'run.overwrite-output',
      'workspace.reset'
    ]);
  });

  it('exposes the four static strings', () => {
    expect(SUPPRESSION_CHECKBOX_LABEL).toBe("Don't ask again for this action");
    expect(CLEAN_ALL_RUNNER_STILL_PENDING_TOAST).toContain('runner cancellation is still pending');
    expect(CLEAN_ALL_LOCK_CONTENTION_TOAST).toContain('another operation is in progress');
    expect(CLEAN_ALL_PERSISTENCE_ERROR_TOAST).toContain('workspace state could not be written');
  });
});

describe('renderActionBody — placeholder resolution', () => {
  it('queue.clean-all: full populated context renders all four summaries', () => {
    const body = renderActionBody('queue.clean-all', {
      pendingCount: 3,
      completedCount: 5,
      failedCount: 1,
      canceledCount: 2,
      inflightTitle: 'speckit-plan',
      pauseSource: 'operator',
      hasActiveRun: true
    });
    expect(body).toContain('**3** pending');
    expect(body).toContain('**5** completed');
    expect(body).toContain('**1** failed');
    expect(body).toContain('**2** canceled');
    expect(body).toContain('abort the running task ("speckit-plan")');
    expect(body).toContain('clear the operator pause');
    expect(body).toContain('clear the active workflow run');
  });

  it('queue.clean-all: pendingCount=0 still renders sensibly', () => {
    const body = renderActionBody('queue.clean-all', {
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false
    });
    expect(body).toContain('**0** pending');
    expect(body).not.toContain('abort the running task');
    expect(body).not.toContain('clear the');
  });

  it('queue.clean-all: cascade pause source renders the cascade summary', () => {
    const body = renderActionBody('queue.clean-all', {
      pendingCount: 1,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: 'cascade',
      hasActiveRun: false
    });
    expect(body).toContain('clear the cascade pause');
  });

  it('queue.clear-done: substitutes the completedCount', () => {
    const body = renderActionBody('queue.clear-done', { completedCount: 7 });
    expect(body).toContain('**7** completed tasks');
  });

  it('queue.remove-item: substitutes the taskTitle', () => {
    const body = renderActionBody('queue.remove-item', { taskTitle: 'My task' });
    expect(body).toContain('**My task**');
  });

  it('queue.cancel-item: omits running suffix when isRunning=false', () => {
    const body = renderActionBody('queue.cancel-item', {
      taskTitle: 'T-1',
      isRunning: false
    });
    expect(body).toContain('Cancels **T-1**.');
    expect(body).not.toContain('currently running');
  });

  it('queue.cancel-item: appends running suffix when isRunning=true', () => {
    const body = renderActionBody('queue.cancel-item', {
      taskTitle: 'T-2',
      isRunning: true
    });
    expect(body).toContain('currently running and will be terminated');
  });

  it('queue.pause/resume: returns the static template unchanged', () => {
    expect(renderActionBody('queue.pause', {})).toBe(ACTION_COPY['queue.pause'].bodyTemplate);
    expect(renderActionBody('queue.resume', {})).toBe(ACTION_COPY['queue.resume'].bodyTemplate);
  });

  it('run.retry-phase-now / run.skip-phase: substitutes the phaseName', () => {
    const body1 = renderActionBody('run.retry-phase-now', { phaseName: 'speckit-plan' });
    expect(body1).toContain('**speckit-plan**');
    const body2 = renderActionBody('run.skip-phase', { phaseName: 'speckit-plan' });
    expect(body2).toContain('**speckit-plan**');
  });

  it('run.restart-canceled / run.modify-task / history.rerun: substitute taskTitle', () => {
    expect(renderActionBody('run.restart-canceled', { taskTitle: 'X' })).toContain('**X**');
    expect(renderActionBody('run.modify-task', { taskTitle: 'Y' })).toContain('**Y**');
    expect(renderActionBody('history.rerun', { taskTitle: 'Z' })).toContain('**Z**');
  });

  it('workspace.reset: returns the static template unchanged', () => {
    expect(renderActionBody('workspace.reset', {})).toBe(
      ACTION_COPY['workspace.reset'].bodyTemplate
    );
  });

  // Feature 100 (T509a, FR-049) — the two catalog prompts, which the four retired
  // keys never had render coverage for. They need it now: `kindLabel` is a
  // parameter where it used to be part of the key, so a resolver that dropped it
  // would leave the operator reading "the active catalog" with no idea which one,
  // and the discard body chooses between two different losses at render time.
  it('catalog.deactivate-definition: names the definition and its kind', () => {
    const body = renderActionBody('catalog.deactivate-definition', {
      kindLabel: 'Pipeline',
      definitionName: 'Spec Kit',
      definitionId: 'speckit'
    });
    expect(body).toContain('**Spec Kit**');
    expect(body).toContain('`speckit`');
    expect(body).toContain('active Pipeline catalog');
    // The half an operator has to be told, or "remove" reads as "delete forever":
    // the history survives and publishing again brings it back.
    expect(body).toContain('version history is kept');
    expect(body).not.toContain('{');
  });

  it('catalog.discard-draft: describes the whole-definition loss when nothing is published', () => {
    const body = renderActionBody('catalog.discard-draft', {
      kindLabel: 'Workflow',
      definitionName: 'Draft Flow',
      definitionId: 'draft-flow',
      removesEntry: true
    });
    expect(body).toContain('**Draft Flow**');
    expect(body).toContain('never been published');
    expect(body).toContain('removes it entirely');
    expect(body).not.toContain('{');
  });

  it('catalog.discard-draft: says the published definition survives when one exists', () => {
    // The other arm, asserted separately because the two are the difference
    // between losing an edit and losing the definition (FR-030) — a resolver that
    // rendered one body for both would pass a single-arm test.
    const body = renderActionBody('catalog.discard-draft', {
      kindLabel: 'Phase',
      definitionName: 'Specify',
      definitionId: 'specify',
      removesEntry: false
    });
    expect(body).toContain('published Phase stays active');
    expect(body).not.toContain('removes it entirely');
    expect(body).not.toContain('{');
  });

  it('run.overwrite-output: substitutes the port name and the relative target', () => {
    const body = renderActionBody('run.overwrite-output', {
      portName: 'Report',
      target: 'docs/report.md'
    });
    expect(body).toContain('**Report**');
    expect(body).toContain('`docs/report.md`');
    expect(body).not.toContain('{');
  });

  it('run.overwrite-output: leaves an absolute-looking target to the caller, never resolving one', () => {
    // The composer only ever holds workspace-relative targets (FR-020), so the
    // renderer has nothing to resolve; this pins that it does not try.
    const body = renderActionBody('run.overwrite-output', {
      portName: 'Report',
      target: 'out/nested/report.md'
    });
    expect(body).toContain('`out/nested/report.md`');
  });
});
