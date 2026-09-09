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
// Feature 193 (T034, FR-001/FR-009) — the generated mirror of the host's
// canonical `ACTION_KEYS` tuple. `ActionKey`/`ACTION_COPY` above must derive
// from this, not from a second hand-written union — the test below fails if
// a key exists in one but not the other.
import { ACTION_KEYS as GENERATED_ACTION_KEYS } from '../generated/action-keys';

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
  'queue.delete',
  // FR-R3-143 (T042) — the one key whose action is not itself destructive: it
  // turns every other prompt in this table off. Confirming on the way out only,
  // never on the way back in, which is why the module short-circuits on
  // `snapshot.confirmationsEnabled` rather than branching per direction.
  'settings.disable-confirmations',
  // FR-R3-144 (T034) — granting a backend permission to run with no sandbox. It
  // is in this table, and not a bare toggle, because it widens what an unattended
  // run may do on the machine: the enforcement refuses the spawn today, and after
  // this write it does not. The body is the refusal's own sentence, carried in as
  // a placeholder, so the prompt cannot describe a rule the runner no longer has.
  'backend.grant-uncontained',
  // Feature 195 (T064, FR-025) — asserting that a failed task's work happened
  // outside the tool. In this table because it is the one exit from a halt that
  // is not undoable: `completed` is a status no transition returns from, so the
  // prompt is where the operator learns that choosing it spends the retry.
  'queue.attest-completed'
];

describe('ActionKey — derived from the generated host mirror (T193 US2, FR-001/FR-009)', () => {
  it('ACTION_COPY has exactly one entry per generated ActionKey — none missing, none extra', () => {
    expect(Object.keys(ACTION_COPY).sort()).toEqual([...GENERATED_ACTION_KEYS].sort());
  });

  it('the generated mirror declares a non-empty set of canonical keys', () => {
    // Non-emptiness, not cardinality. `:75` above asserts the real property —
    // set equality between the copy table and the generated mirror — and that
    // assertion passes when BOTH sides are empty. These two floors are what
    // stop it: one per side, because a floor on the mirror alone leaves the
    // copy-table side unchecked (FR-021, SC-009).
    expect(GENERATED_ACTION_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(ACTION_COPY).length).toBeGreaterThan(0);
  });
});

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
      // FR-R3-144 (T034) — the one destructive key that deletes nothing, and the
      // reason the assertion's name is about irreversibility rather than deletion.
      // Granting is undoable from the same control; what it enables is not, because
      // it is not state — it is model-generated actions running with the operator's
      // local authority, for as long as the grant stands. The strongest
      // presentation in the dialog belongs to the widest permission on the tab.
      'backend.grant-uncontained',
      // Feature 100 — both remain destructive, for two different reasons. A
      // deactivation drops the definition from the launchable catalog; a discard
      // drops an edit that was never published, and of a never-published
      // definition it drops the entry itself. `caution` is for actions that only
      // interrupt, and neither of these does.
      'catalog.deactivate-definition',
      'catalog.discard-draft',
      // Feature 195 (T064, FR-025) — sorts first among the `queue.` keys.
      // Destructive on the same basis as `backend.grant-uncontained` above:
      // nothing is deleted, and nothing can be undone either. A task recorded
      // as completed cannot be returned to `failed`, so the retry the operator
      // still had before the prompt is gone after it.
      'queue.attest-completed',
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
  it('queue.clean-all: full populated context renders all summaries', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 3,
      completedCount: 5,
      failedCount: 1,
      canceledCount: 2,
      inflightTitle: 'speckit-plan',
      pauseSource: 'operator',
      hasActiveRun: true,
      hasSchedule: true
    });
    expect(body).toContain('**3** pending');
    expect(body).toContain('**5** completed');
    expect(body).toContain('**1** failed');
    expect(body).toContain('**2** canceled');
    expect(body).toContain('from **nightly**');
    expect(body).toContain('abort the running task ("speckit-plan")');
    expect(body).toContain('clear the operator pause');
    expect(body).toContain('cancel the scheduled start');
    expect(body).toContain('clear the active workflow run');
  });

  it('queue.clean-all: pendingCount=0 still renders sensibly', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: false
    });
    expect(body).toContain('**0** pending');
    expect(body).toContain('from **nightly**');
    expect(body).not.toContain('abort the running task');
    expect(body).not.toContain('clear the');
    expect(body).not.toContain('cancel the scheduled start');
  });

  it('queue.clean-all: cascade pause source renders the cascade summary', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 1,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: 'cascade',
      hasActiveRun: false,
      hasSchedule: false
    });
    expect(body).toContain('clear the cascade pause');
  });

  it('queue.clean-all: an armed schedule with nothing else to reset still names it (LC-Q-05)', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: true
    });
    expect(body).toContain('cancel the scheduled start');
  });

  it('queue.clear-done: substitutes the completedCount and queue name', () => {
    const body = renderActionBody('queue.clear-done', {
      queueId: 'q-beta',
      queueName: 'nightly',
      completedCount: 7
    });
    expect(body).toContain('**7** completed tasks');
    expect(body).toContain('from **nightly**');
  });

  // Code-review finding — `String.prototype.replace` interprets `$`-prefixed
  // sequences in a STRING replacement even when the search pattern is a plain
  // string, not a RegExp. Queue names are operator-authored with no character
  // restriction, so a name built from one of those sequences must render
  // literally, not be swallowed as a substitution directive.
  it('renders a queueName containing $-substitution sequences literally, for both templates', () => {
    const cleanAllBody = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'Prod $&',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: false
    });
    expect(cleanAllBody).toContain('from **Prod $&**');

    const clearDoneBody = renderActionBody('queue.clear-done', {
      queueId: 'q-beta',
      queueName: 'Prod $$',
      completedCount: 1
    });
    expect(clearDoneBody).toContain('from **Prod $$**');
  });

  // Code-review finding — the same `$`-substitution risk as `queueName` above,
  // for `inflightTitle`: it is an operator-authored task title with no
  // character restriction, substituted into the same STRING-replacement
  // chain. A task named e.g. "Fix $&" must render literally, not have `$&`
  // expanded to the matched `{inflightSummary}` placeholder text.
  it('renders an inflightTitle containing $-substitution sequences literally', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: 'Fix $&',
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: false
    });
    expect(body).toContain('abort the running task ("Fix $&")');
  });

  // Code-review finding (iteration 4) — a queue named or a task titled
  // exactly like a LATER placeholder token in the chain used to get
  // re-matched and corrupted by that later `.replace()` call, since each
  // call in a chain re-scans the whole accumulated string rather than only
  // the original template. The single-pass substitution fixes this
  // regardless of which placeholder the operator-authored text collides
  // with, or which order the chain used to run in.
  it('renders a queueName matching a later placeholder token literally, not re-substituted', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: '{pauseSummary}',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: 'operator',
      hasActiveRun: false,
      hasSchedule: false
    });
    expect(body).toContain('from **{pauseSummary}**');
    expect(body).toContain(', and clear the operator pause');
  });

  it('renders an inflightTitle matching a later placeholder token literally, not re-substituted', () => {
    const body = renderActionBody('queue.clean-all', {
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: '{scheduleSummary}',
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: true
    });
    expect(body).toContain('abort the running task ("{scheduleSummary}")');
    expect(body).toContain(', and cancel the scheduled start');
  });

  // Code-review finding (iteration 5) — the two cases above were the only two
  // moved onto the single pass; every other templated body still chained
  // `.replace(string, value)`, so both hazards were live everywhere else. These
  // cover the three remaining shapes: a value colliding with a LATER token, a
  // value containing a `$`-sequence, and a template whose placeholder set the
  // case did not fully cover.
  it('renders a definitionName matching a later placeholder token literally', () => {
    const body = renderActionBody('catalog.deactivate-definition', {
      definitionId: 'phase-plan',
      definitionName: '{kindLabel}',
      kindLabel: 'phase'
    });
    expect(body).toContain('Removes **{kindLabel}** (`phase-plan`)');
    expect(body).toContain('from the active phase catalog');
  });

  it('renders a taskTitle containing $-substitution sequences literally', () => {
    expect(renderActionBody('run.modify-task', { taskTitle: '$&' })).toBe(
      'Saves the edited payload for **$&**.'
    );
    expect(renderActionBody('history.rerun', { taskTitle: 'Ship $`v2' })).toBe(
      'Re-enqueues **Ship $`v2** as a new run.'
    );
  });

  it('names the queue in the delete confirmation instead of leaving the token', () => {
    const body = renderActionBody('queue.delete', {
      queueName: 'nightly',
      pendingTaskCount: 2,
      connectedRunCount: 0
    });
    expect(body).toBe(
      'Deletes **nightly**, along with **2** pending tasks. This cannot be undone.'
    );
  });

  // FR-R3-153 (FR-011, T1639) — one case per status; the wording must name
  // that status's real consequence, not a generic one.
  it('queue.remove-item (pending): names simple removal, no session-data consequence', () => {
    const body = renderActionBody('queue.remove-item', { taskTitle: 'My task', status: 'pending' });
    expect(body).toContain('**My task**');
    expect(body).not.toMatch(/session data/);
  });

  it('queue.remove-item (in-flight): names stopping the active task and session-data deletion', () => {
    const body = renderActionBody('queue.remove-item', { taskTitle: 'My task', status: 'in-flight' });
    expect(body).toContain('Stops the active task **My task**');
    expect(body).toContain('session data (logs, diagnostics)');
  });

  it('queue.remove-item (paused): names losing resumable state and session-data deletion', () => {
    const body = renderActionBody('queue.remove-item', { taskTitle: 'My task', status: 'paused' });
    expect(body).toContain('paused task **My task**');
    expect(body).toContain('session data');
  });

  it.each(['completed', 'failed', 'canceled'] as const)(
    'queue.remove-item (%s): names permanent removal and session-data deletion, sharing one branch',
    (status) => {
      const body = renderActionBody('queue.remove-item', { taskTitle: 'My task', status });
      expect(body).toContain('Permanently removes **My task**');
      expect(body).toContain('session data (logs, diagnostics)');
    }
  );

  // Code-review fix (2026-09-03) — regression test. The now-retired
  // `taskDeleteConfirmation` always truncated a long label to 45 chars +
  // "..." (see the deleted deletion-confirmation.test.ts); this branch
  // reproduced its wording without carrying that truncation over.
  it('queue.remove-item: truncates a long taskTitle to 45 chars + "..." like the retired taskDeleteConfirmation did', () => {
    const long = 'a'.repeat(60);
    const expected = 'a'.repeat(45) + '...';
    const body = renderActionBody('queue.remove-item', { taskTitle: long, status: 'paused' });
    expect(body).toContain(`**${expected}**`);
    expect(body).not.toContain(long);
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
