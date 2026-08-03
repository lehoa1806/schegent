// Feature 063 (FR-022b) — single source of truth for every confirmation
// prompt's user-visible copy. The ConfirmDialog component and the
// `useConfirm` helper read from this module; no call site imports raw
// strings inline. A future i18n pass replaces the ACTION_COPY map
// without touching any call site.
//
// Contract: specs/063-clean-all-confirmations/contracts/action-copy-table.md

export type ActionKey =
  | 'queue.clean-all'
  | 'queue.clear-done'
  | 'queue.remove-item'
  | 'queue.cancel-item'
  | 'queue.pause'
  | 'queue.resume'
  | 'run.retry-phase-now'
  | 'run.restart-canceled'
  | 'run.modify-task'
  | 'history.rerun'
  | 'workspace.reset'
  | 'run.skip-phase'
  | 'catalog.remove-phase'
  | 'catalog.remove-pipeline'
  | 'catalog.remove-workflow'
  | 'catalog.reset-workflows';

export type Severity = 'info' | 'caution' | 'destructive';

export interface ActionCopyEntry {
  readonly title: string;
  readonly bodyTemplate: string;
  readonly confirmLabel: string;
  readonly severity: Severity;
}

// Typed context per action key. The `renderActionBody` helper uses
// these shapes to type-check placeholder access at compile time.
export type ActionCopyContext = {
  'queue.clean-all': {
    readonly pendingCount: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly canceledCount: number;
    readonly inflightTitle: string | null;
    readonly pauseSource: 'operator' | 'cascade' | 'retry-cap' | null;
    readonly hasActiveRun: boolean;
  };
  'queue.clear-done': { readonly completedCount: number };
  'queue.remove-item': { readonly taskTitle: string };
  'queue.cancel-item': { readonly taskTitle: string; readonly isRunning: boolean };
  'queue.pause': Record<string, never>;
  'queue.resume': Record<string, never>;
  'run.retry-phase-now': { readonly phaseName: string };
  'run.restart-canceled': { readonly taskTitle: string };
  'run.modify-task': { readonly taskTitle: string };
  'history.rerun': { readonly taskTitle: string };
  'workspace.reset': Record<string, never>;
  'run.skip-phase': { readonly phaseName: string };
  'catalog.remove-phase': {
    readonly phaseName: string;
    readonly phaseId: string;
    readonly scope: 'user' | 'workspace';
  };
  'catalog.remove-pipeline': {
    readonly pipelineName: string;
    readonly pipelineId: string;
    readonly scope: 'user' | 'workspace';
  };
  'catalog.remove-workflow': {
    readonly workflowName: string;
    readonly workflowId: string;
    readonly scope: 'user' | 'workspace';
  };
  // The count is what distinguishes this prompt from the single-row one: the
  // operator is told how many definitions the scope is about to lose.
  'catalog.reset-workflows': {
    readonly scope: 'user' | 'workspace';
    readonly workflowCount: number;
  };
};

// Authoritative copy table (v1, English). Adding a new key here AND to
// `ActionKey` AND to `ActionCopyContext` is the only required edit;
// TypeScript's `Record<ActionKey, ActionCopyEntry>` enforces parity at
// compile time and the test in `action-copy.test.ts` belt-and-braces it.
export const ACTION_COPY: Readonly<Record<ActionKey, ActionCopyEntry>> = Object.freeze({
  'queue.clean-all': {
    title: 'Clean All — wipe the queue?',
    bodyTemplate:
      'You are about to remove **{pendingCount}** pending, **{completedCount}** completed, **{failedCount}** failed, and **{canceledCount}** canceled tasks{inflightSummary}{pauseSummary}{runSummary}. This cannot be undone.',
    confirmLabel: 'Clean All',
    severity: 'destructive'
  },
  'queue.clear-done': {
    title: 'Clear Done — remove completed tasks?',
    bodyTemplate: 'Removes **{completedCount}** completed tasks from the queue.',
    confirmLabel: 'Clear Done',
    severity: 'caution'
  },
  'queue.remove-item': {
    title: 'Remove from queue?',
    bodyTemplate: 'Removes **{taskTitle}** from the queue.',
    confirmLabel: 'Remove',
    severity: 'caution'
  },
  'queue.cancel-item': {
    title: 'Cancel task?',
    bodyTemplate: 'Cancels **{taskTitle}**.{runningSuffix}',
    confirmLabel: 'Cancel Task',
    severity: 'caution'
  },
  'queue.pause': {
    title: 'Pause the queue?',
    bodyTemplate: 'No new tasks will be dispatched until you resume.',
    confirmLabel: 'Pause Queue',
    severity: 'info'
  },
  'queue.resume': {
    title: 'Resume the queue?',
    bodyTemplate: 'Queue dispatch will resume.',
    confirmLabel: 'Resume Queue',
    severity: 'info'
  },
  'run.retry-phase-now': {
    title: 'Retry phase now?',
    bodyTemplate: 'Re-runs the **{phaseName}** phase immediately.',
    confirmLabel: 'Retry Now',
    severity: 'caution'
  },
  'run.restart-canceled': {
    title: 'Restart canceled task?',
    bodyTemplate: 'Re-enqueues **{taskTitle}** as pending.',
    confirmLabel: 'Restart Task',
    severity: 'caution'
  },
  'run.modify-task': {
    title: 'Save changes?',
    bodyTemplate: 'Saves the edited payload for **{taskTitle}**.',
    confirmLabel: 'Save Changes',
    severity: 'caution'
  },
  'history.rerun': {
    title: 'Rerun from history?',
    bodyTemplate: 'Re-enqueues **{taskTitle}** as a new run.',
    confirmLabel: 'Rerun',
    severity: 'caution'
  },
  'workspace.reset': {
    title: 'Reset Workspace — wipe all state?',
    bodyTemplate:
      'Wipes all Schegent state for this workspace — queue, run history, prompt suppressions, and project-level UI preferences. This cannot be undone.',
    confirmLabel: 'Reset Workspace',
    severity: 'destructive'
  },
  'run.skip-phase': {
    title: 'Skip active phase?',
    bodyTemplate: 'Cancels the ongoing execution of **{phaseName}** and advances to the next step.',
    confirmLabel: 'Skip Phase',
    severity: 'caution'
  },
  'catalog.remove-phase': {
    title: 'Delete Phase definition?',
    bodyTemplate: 'Deletes **{phaseName}** (`{phaseId}`) from {scope} scope. A lower-precedence definition may become effective.',
    confirmLabel: 'Delete Phase',
    severity: 'destructive'
  },
  'catalog.remove-pipeline': {
    title: 'Delete Pipeline definition?',
    bodyTemplate: 'Deletes **{pipelineName}** (`{pipelineId}`) from {scope} scope. A lower-precedence definition may become effective.',
    confirmLabel: 'Delete Pipeline',
    severity: 'destructive'
  },
  'catalog.remove-workflow': {
    title: 'Delete Workflow definition?',
    bodyTemplate: 'Deletes **{workflowName}** (`{workflowId}`) from {scope} scope. A lower-precedence definition may become effective. The Pipelines it composed are not affected.',
    confirmLabel: 'Delete Workflow',
    severity: 'destructive'
  },
  'catalog.reset-workflows': {
    title: 'Reset Workflow definitions?',
    bodyTemplate: 'Deletes all {workflowCount} Workflow definitions in {scope} scope. A lower-precedence layer may become effective. The Pipelines they composed are not affected.',
    confirmLabel: 'Reset Workflows',
    severity: 'destructive'
  }
} satisfies Record<ActionKey, ActionCopyEntry>);

// Static strings — not parametrized, but live in the same module so the
// future i18n pass touches one file.
export const SUPPRESSION_CHECKBOX_LABEL = "Don't ask again for this action";
export const CLEAN_ALL_RUNNER_STILL_PENDING_TOAST =
  'Clean All completed; runner cancellation is still pending.';
export const CLEAN_ALL_LOCK_CONTENTION_TOAST =
  'Clean All could not start — another operation is in progress.';
export const CLEAN_ALL_PERSISTENCE_ERROR_TOAST =
  'Clean All could not complete — workspace state could not be written.';

// Render a body template with its typed context. The function is generic
// over `ActionKey` so the type checker rejects passing the wrong context
// shape (e.g. `{ taskTitle }` to `renderActionBody('queue.pause', …)`).
export function renderActionBody<K extends ActionKey>(
  actionKey: K,
  context: ActionCopyContext[K]
): string {
  const entry = ACTION_COPY[actionKey];
  switch (actionKey) {
    case 'queue.clean-all': {
      const ctx = context as ActionCopyContext['queue.clean-all'];
      return entry.bodyTemplate
        .replace('{pendingCount}', String(ctx.pendingCount))
        .replace('{completedCount}', String(ctx.completedCount))
        .replace('{failedCount}', String(ctx.failedCount))
        .replace('{canceledCount}', String(ctx.canceledCount))
        .replace(
          '{inflightSummary}',
          ctx.inflightTitle !== null
            ? `, abort the running task ("${ctx.inflightTitle}")`
            : ''
        )
        .replace(
          '{pauseSummary}',
          ctx.pauseSource !== null ? `, and clear the ${ctx.pauseSource} pause` : ''
        )
        .replace('{runSummary}', ctx.hasActiveRun ? ', and clear the active workflow run' : '');
    }
    case 'queue.clear-done': {
      const ctx = context as ActionCopyContext['queue.clear-done'];
      return entry.bodyTemplate.replace('{completedCount}', String(ctx.completedCount));
    }
    case 'queue.remove-item':
    case 'run.restart-canceled':
    case 'run.modify-task':
    case 'history.rerun': {
      const ctx = context as { readonly taskTitle: string };
      return entry.bodyTemplate.replace('{taskTitle}', ctx.taskTitle);
    }
    case 'queue.cancel-item': {
      const ctx = context as ActionCopyContext['queue.cancel-item'];
      return entry.bodyTemplate
        .replace('{taskTitle}', ctx.taskTitle)
        .replace(
          '{runningSuffix}',
          ctx.isRunning ? ' It is currently running and will be terminated.' : ''
        );
    }
    case 'run.retry-phase-now':
    case 'run.skip-phase': {
      const ctx = context as ActionCopyContext['run.retry-phase-now' | 'run.skip-phase'];
      return entry.bodyTemplate.replace('{phaseName}', ctx.phaseName);
    }
    case 'catalog.remove-phase': {
      const ctx = context as ActionCopyContext['catalog.remove-phase'];
      return entry.bodyTemplate
        .replace('{phaseName}', ctx.phaseName)
        .replace('{phaseId}', ctx.phaseId)
        .replace('{scope}', ctx.scope);
    }
    case 'catalog.remove-pipeline': {
      const ctx = context as ActionCopyContext['catalog.remove-pipeline'];
      return entry.bodyTemplate
        .replace('{pipelineName}', ctx.pipelineName)
        .replace('{pipelineId}', ctx.pipelineId)
        .replace('{scope}', ctx.scope);
    }
    case 'catalog.remove-workflow': {
      const ctx = context as ActionCopyContext['catalog.remove-workflow'];
      return entry.bodyTemplate
        .replace('{workflowName}', ctx.workflowName)
        .replace('{workflowId}', ctx.workflowId)
        .replace('{scope}', ctx.scope);
    }
    case 'catalog.reset-workflows': {
      const ctx = context as ActionCopyContext['catalog.reset-workflows'];
      return entry.bodyTemplate
        .replace('{workflowCount}', String(ctx.workflowCount))
        .replace('{scope}', ctx.scope);
    }
    case 'queue.pause':
    case 'queue.resume':
    case 'workspace.reset':
      return entry.bodyTemplate;
    default: {
      // Exhaustiveness check — adding a new ActionKey without a case
      // here triggers a compile-time error.
      const _exhaustive: never = actionKey;
      throw new Error(`Unhandled action key in renderActionBody: ${String(_exhaustive)}`);
    }
  }
}
