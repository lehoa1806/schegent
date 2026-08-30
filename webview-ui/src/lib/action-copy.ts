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
  // Feature 100 (T509a, FR-049) — two keys replace the four catalog removal keys
  // of features 082/083. Those were one per kind plus a whole-layer reset, because
  // a removal was an omission from a whole-array write and the array was per-kind.
  // A lifecycle operation names one definition of any kind, so the kind became a
  // parameter; and a layer reset is no longer one write the store can make, so it
  // is no longer one decision the operator can take.
  | 'catalog.deactivate-definition'
  | 'catalog.discard-draft'
  | 'run.overwrite-output'
  | 'queue.delete'
  // FR-R3-143 (T042) — turning every other prompt off is itself a decision worth
  // one prompt, and only in that direction. Turning them back ON needs no
  // confirmation, and gets none for free: `useConfirm` reads
  // `snapshot.confirmationsEnabled`, which is still `true` while disabling and
  // already `false` while enabling, so the asymmetry is the existing
  // short-circuit rather than a hand-written branch beside it.
  | 'settings.disable-confirmations'
  // FR-R3-144 (T033, FR-007) — granting a backend permission to run without an
  // OS-enforced bound. One prompt per backend, because the grant is per backend:
  // accepting it for `agy` says nothing about `claude`, and a surface that asked
  // once and applied the answer to both would be the boolean FR-R3-125 removed.
  //
  // Revoking is deliberately unconfirmed (C7-3). Asking before NARROWING a
  // permission teaches operators to click through the prompt that matters.
  | 'backend.grant-uncontained';

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
  // Feature 099 (T494a, FR-043) — no `scope` on either catalog prompt. There is
  // one catalog, so naming the layer a removal targets said nothing, and the
  // promise that came with it — that a lower-precedence definition might become
  // effective — is now false.
  //
  // Feature 100 (T509a) — `kindLabel` carries what the four retired keys carried
  // in their names. It is a display word ("Phase", "Pipeline", "Workflow"), not
  // the wire `kind`, so the copy table stays the only place user-visible strings
  // are written.
  'catalog.deactivate-definition': {
    readonly kindLabel: string;
    readonly definitionName: string;
    readonly definitionId: string;
  };
  // `removesEntry` decides which of two different losses the prompt describes:
  // an unpublished edit, or the whole definition (FR-030).
  'catalog.discard-draft': {
    readonly kindLabel: string;
    readonly definitionName: string;
    readonly definitionId: string;
    readonly removesEntry: boolean;
  };
  // Feature 087 (FR-023) — the operator named a target that already holds
  // content. `target` is workspace-relative: that is the only form that crosses
  // the IPC boundary, and the only form the operator typed.
  'run.overwrite-output': {
    readonly portName: string;
    readonly target: string;
  };
  // Feature 095 (FR-002) — both counts come from the host's deletion probe, not
  // from the snapshot the operator is looking at. The prompt has to state what
  // the delete will actually do, and the snapshot may already have moved on.
  'queue.delete': {
    readonly queueName: string;
    readonly pendingTaskCount: number;
    readonly connectedRunCount: number;
  };
  // FR-R3-143 (T042) — no placeholders. The prompt describes a setting, not a
  // target, and the one number worth stating (how many prompts this silences)
  // is the size of a union this module declares, not a runtime fact.
  'settings.disable-confirmations': Record<string, never>;
  // FR-R3-144 (T033) — `refusal` is `BackendPosture.refusal`, which is
  // `judgeBackendContainment`'s own sentence, projected by the host. It is a
  // PLACEHOLDER rather than copy in the table below on purpose: the operator is
  // being asked to accept a consequence, and the wording of that consequence must
  // be the enforcement's, not a paraphrase kept in the webview that would go stale
  // the first time the policy was reworded. `label` is the backend's display name.
  'backend.grant-uncontained': {
    label: string;
    refusal: string;
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
  // FR-R3-006 — the body names all three things an operator needs before
  // deciding: what stops, what goes, what stays. The previous text named only
  // the middle one, so an operator could not tell that a running phase would be
  // cancelled, nor that their audit log and transcripts would survive.
  'workspace.reset': {
    title: 'Reset Workspace — wipe all state?',
    bodyTemplate:
      'Cancels any running phase, then wipes all Schegent state for this workspace — ' +
      'queues, runs, history, leases, schedules, prompt suppressions, and project-level ' +
      'UI preferences. The audit log and per-run transcripts are preserved. ' +
      'This cannot be undone.',
    confirmLabel: 'Reset Workspace',
    severity: 'destructive'
  },
  'run.skip-phase': {
    title: 'Skip active phase?',
    bodyTemplate: 'Cancels the ongoing execution of **{phaseName}** and advances to the next step.',
    confirmLabel: 'Skip Phase',
    severity: 'caution'
  },
  // The body has to say what survives, or the operator reads "remove" as "delete
  // forever" and never uses it. Every version is kept and publishing again brings
  // the definition back; what is lost is that it can be launched.
  'catalog.deactivate-definition': {
    title: 'Remove from the active catalog?',
    bodyTemplate:
      'Removes **{definitionName}** (`{definitionId}`) from the active {kindLabel} catalog, so it can no longer be launched. Its version history is kept, and publishing it again restores it.',
    confirmLabel: 'Remove',
    severity: 'destructive'
  },
  'catalog.discard-draft': {
    title: 'Discard unpublished changes?',
    bodyTemplate:
      'Discards the unpublished draft of **{definitionName}** (`{definitionId}`).{entrySummary}',
    confirmLabel: 'Discard Draft',
    severity: 'destructive'
  },
  'run.overwrite-output': {
    title: 'Overwrite existing content?',
    bodyTemplate:
      'The **{portName}** output is targeted at `{target}`, which already exists. Running this Pipeline replaces it. This cannot be undone.',
    confirmLabel: 'Overwrite',
    severity: 'destructive'
  },
  'queue.delete': {
    title: 'Delete queue?',
    bodyTemplate:
      'Deletes **{queueName}**{impactSummary}. This cannot be undone.',
    confirmLabel: 'Delete Queue',
    severity: 'destructive'
  },
  // `caution`, not `destructive`: nothing is lost, and the change is reversible
  // by the same control. What it costs is every later prompt, including the ones
  // in front of actions that ARE destructive — which is what the body says
  // instead of borrowing the severity of the actions it silences.
  'settings.disable-confirmations': {
    title: 'Turn off confirmation prompts?',
    bodyTemplate:
      'Destructive actions — deleting a queue, Clean All, discarding a draft — will run ' +
      'immediately, with no prompt. You can turn prompts back on from this setting at ' +
      'any time.',
    confirmLabel: 'Turn Off Prompts',
    severity: 'caution'
  },
  // FR-R3-144 (T033, FR-007) — the body is almost entirely `{refusal}`, and the
  // two sentences around it are the only ones this table owns: what the operator
  // is about to do, and how to undo it. Everything about WHY it matters is the
  // policy's own wording, because that is the sentence the spawn refuses with and
  // the one the section already shows.
  //
  // `destructive`, not `caution`. Nothing is deleted by granting; the severity is
  // for what the grant ENABLES — model-generated actions executing with the
  // operator's local authority, on every workspace in the installation. The
  // dialog's strongest presentation belongs to the widest permission on the tab.
  'backend.grant-uncontained': {
    // Not templated: `useConfirm` renders only the BODY through
    // `renderActionBody`, so a placeholder here would reach the operator as the
    // literal `{label}`. The backend is named twice in the body instead — once by
    // the policy's own sentence, once by the scope line under it.
    title: 'Allow this backend to run without a sandbox?',
    bodyTemplate:
      '{refusal}\n\nGranting this applies to **{label}** only, and you can revoke it ' +
      'from this section at any time.',
    confirmLabel: 'Allow Uncontained',
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

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

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
    case 'catalog.deactivate-definition': {
      const ctx = context as ActionCopyContext['catalog.deactivate-definition'];
      return entry.bodyTemplate
        .replace('{definitionName}', ctx.definitionName)
        .replace('{definitionId}', ctx.definitionId)
        .replace('{kindLabel}', ctx.kindLabel);
    }
    case 'catalog.discard-draft': {
      const ctx = context as ActionCopyContext['catalog.discard-draft'];
      return entry.bodyTemplate
        .replace('{definitionName}', ctx.definitionName)
        .replace('{definitionId}', ctx.definitionId)
        .replace(
          '{entrySummary}',
          ctx.removesEntry
            ? ` This ${ctx.kindLabel} has never been published, so discarding removes it entirely.`
            : ` The published ${ctx.kindLabel} stays active and is not affected.`
        );
    }
    case 'run.overwrite-output': {
      const ctx = context as ActionCopyContext['run.overwrite-output'];
      return entry.bodyTemplate
        .replace('{portName}', ctx.portName)
        .replace('{target}', ctx.target);
    }
    case 'queue.delete': {
      const ctx = context as ActionCopyContext['queue.delete'];
      // An empty queue with no bound runs says nothing beyond its name — the
      // alternative reads "0 pending tasks and 0 connected runs", which is
      // noise on the one case where the delete is uncontroversial.
      const parts: string[] = [];
      if (ctx.pendingTaskCount > 0) {
        parts.push(`**${ctx.pendingTaskCount}** pending ${plural(ctx.pendingTaskCount, 'task')}`);
      }
      if (ctx.connectedRunCount > 0) {
        parts.push(
          `**${ctx.connectedRunCount}** bound connected ${plural(ctx.connectedRunCount, 'run')}`
        );
      }
      return entry.bodyTemplate.replace(
        '{impactSummary}',
        parts.length === 0 ? '' : `, along with ${parts.join(' and ')}`
      );
    }
    case 'backend.grant-uncontained': {
      const ctx = context as ActionCopyContext['backend.grant-uncontained'];
      return entry.bodyTemplate
        .replace('{refusal}', ctx.refusal)
        .replace('{label}', ctx.label);
    }
    case 'queue.pause':
    case 'queue.resume':
    case 'workspace.reset':
    case 'settings.disable-confirmations':
      return entry.bodyTemplate;
    default: {
      // Exhaustiveness check — adding a new ActionKey without a case
      // here triggers a compile-time error.
      const _exhaustive: never = actionKey;
      throw new Error(`Unhandled action key in renderActionBody: ${String(_exhaustive)}`);
    }
  }
}
