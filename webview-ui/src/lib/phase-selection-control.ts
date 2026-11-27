// FR-R5-F19 (spec 278, T19.3, US3; FR-012, FR-013) — Disable and Enable on the selected phase.
//
// Both act on the tile the operator selected, not the Run's current phase, so an answer can arrive
// after the operator has selected another tile. The menu shows one line of text for the controls it
// owns, and that line belongs to whichever control the operator is looking at: an answer for a
// control the selection has left is dropped, and never written over another control's text.
//
// The runner holds the one thing a component cannot get from the intent ledger. The ledger re-posts
// an unresolved intent under its original identity, which is right for a retry and wrong for a
// double click, so a click on a control whose first send is still unanswered posts nothing.
//
// The text itself is the ledger path's: `lifecycleMessage` for an answer, and the wait options'
// `onLateOutcome` for an answer after the 5000 ms wait, so an interim "not yet known" is replaced by
// the host's answer through the same code path as an on-time one.
import { disablePhase, enablePhase } from './phase-control';
import { lifecycleMessage } from './lifecycle-control-ipc';

export type SelectionControlKind = 'disable' | 'enable';

export interface SelectionControlRequest {
  readonly kind: SelectionControlKind;
  readonly phaseId: string;
  readonly queueId: string;
  /** True while the control this request came from is still the one the operator has selected. */
  readonly isCurrent: () => boolean;
  /** Shows one sentence, or clears the line with `null`. */
  readonly show: (message: string | null) => void;
  /** Aborted when the owning surface unmounts; a late answer is then owed to no one. */
  readonly signal: AbortSignal;
}

export interface SelectionControlRunner {
  run(request: SelectionControlRequest): Promise<void>;
}

export function createSelectionControlRunner(): SelectionControlRunner {
  const unanswered = new Set<string>();

  return {
    async run(request) {
      const { kind, phaseId, queueId, isCurrent, show, signal } = request;
      const key = JSON.stringify([kind, queueId, phaseId]);
      if (unanswered.has(key)) return;
      unanswered.add(key);

      const dispatch = kind === 'disable' ? disablePhase : enablePhase;
      const wait = {
        signal,
        onLateOutcome: (late: Parameters<typeof lifecycleMessage>[0]): void => {
          if (isCurrent()) show(lifecycleMessage(late));
        }
      };
      try {
        const result = await dispatch(phaseId, queueId, wait);
        if (isCurrent()) show(lifecycleMessage(result));
      } finally {
        unanswered.delete(key);
      }
    }
  };
}
