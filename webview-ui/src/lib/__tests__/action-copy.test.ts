// Feature 063 T012 — unit coverage for the action-copy table and the
// `renderActionBody` placeholder resolver. The 11-entry ActionKey
// union is the single source of truth for every confirmation prompt
// (FR-022b); this test pins both the table membership and the
// authoritative render output per the contract in
// specs/063-clean-all-confirmations/contracts/action-copy-table.md.
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
  'run.skip-phase'
];

describe('ACTION_COPY exhaustiveness (FR-022b)', () => {
  it('contains exactly the 12 contractual ActionKey entries', () => {
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

  it('destructive severity is reserved for clean-all and workspace.reset', () => {
    const destructive = EXPECTED_KEYS.filter((k) => ACTION_COPY[k].severity === 'destructive');
    expect(destructive.sort()).toEqual(['queue.clean-all', 'workspace.reset']);
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
});
