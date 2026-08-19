// Feature 089 (T027, T028, T030, US5, FR-028, FR-029, FR-030, FR-031) — the
// shared harness for the two trust-boundary fixtures.
//
// `untrusted-workspace` and `multi-window` make the same claim about two
// different predicates, so they drive the same router, the same command table,
// and the same write recorder. Only the gate that is closed and the token the
// refusal carries differ.
//
// **The write recorder is the point.** "Refused" could be asserted from the ack
// alone, but the requirement is refused *before any write*, and an ack cannot
// show that. So every port on `RouterDeps` through which a handler could reach
// durable state is wired to a recorder here: the VS Code command bridge, the
// queue and phase operations, the configuration writer, the guarded-run queue,
// the connected-run store, general settings, the confirmation memento, the
// audit writer, and the export adapter. A refusal leaves the
// recorder empty. A write of any kind, through any of them, does not.
//
// A recorder that is silently unwired would also leave it empty, which is why
// each fixture opens both gates and drives a command that must reach a port —
// see the positive-control test in each. Without it, deleting the gates
// entirely would still pass.

import type { CommandAckMessage, SidebarCommand } from '../../../src/ui/sidebar/messages';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../src/ui/sidebar/message-router';
import { FIXTURE_PHASE_DEFINITIONS, FIXTURE_PHASE_IDS } from '../../fixtures/process-catalog-fixture';
import { importedCatalog } from './run-harness';

/** The gate tokens, mirrored from `src/ui/sidebar/commands/constants.ts`. */
export const UNTRUSTED_REJECT = 'untrusted-workspace';
export const SECONDARY_REJECT = 'secondary-window-readonly';

/**
 * A Phase the probe's workspace layer holds, so the export command reaches its
 * adapter rather than refusing on selection and leaving the not-gated claim
 * resting on the absence of a token.
 *
 * Feature 098 (T080) — this was `speckit-plan`, described here as "a Phase every
 * build ships". No build ships a Phase now, and an id nothing resolves would
 * have turned the positive control into a silent no-op: `selectPhase` refuses
 * with `not-found` before any adapter is touched, and `writes` stays empty for a
 * reason that has nothing to do with the gate.
 */
export const EXPORTABLE_PHASE_ID = FIXTURE_PHASE_IDS.first;

export interface GateProbe {
  /** Every write port a handler touched, in call order. */
  readonly writes: readonly string[];
  /** Dispatch one command and return the ack it produced, if any. */
  dispatch(type: string, payload?: unknown): Promise<CommandAckMessage | undefined>;
}

interface GateSettings {
  readonly isTrusted?: () => boolean;
  readonly isPrimary?: () => boolean;
}

/**
 * A router whose every write-capable dependency records instead of writing.
 *
 * Nothing here throws: a handler that gets past the gates should be able to run
 * to its own conclusion, so that a fixture distinguishes "refused at the gate"
 * from "ran and then declined for its own reasons".
 */
export function makeGateProbe(gates: GateSettings): GateProbe {
  const writes: string[] = [];
  const record = <T>(label: string, value: T): T => {
    writes.push(label);
    return value;
  };

  const okFalse = { ok: false, reason: 'probe' } as const;

  const deps: RouterDeps = {
    executeCommand: <T = unknown>(commandId: string): Promise<T> =>
      Promise.resolve(record(`executeCommand:${commandId}`, undefined as T)),
    queueRemover: {
      remove: async (): Promise<boolean> => record('queueRemover.remove', false)
    },
    queueOps: {
      retry: async () => record('queueOps.retry', okFalse),
      moveUp: async () => record('queueOps.moveUp', okFalse),
      moveDown: async () => record('queueOps.moveDown', okFalse),
      clearCompleted: async () => record('queueOps.clearCompleted', { removed: 0 }),
      clearFailed: async () => record('queueOps.clearFailed', { removed: 0 }),
      setQueuePausedState: async () => record('queueOps.setQueuePausedState', okFalse),
      modifyTask: async () => record('queueOps.modifyTask', okFalse),
      removeTask: async () => record('queueOps.removeTask', okFalse),
      reorderTask: async () => record('queueOps.reorderTask', okFalse),
      reorderTaskInUnifiedQueue: async () =>
        record('queueOps.reorderTaskInUnifiedQueue', {
          outcome: 'rejected' as const,
          cause: 'no-op' as const,
          fromPosition: 0,
          toPosition: 0,
          fromGlobalPosition: 0,
          newOrder: [] as readonly string[]
        })
    },
    phaseOps: {
      skipPhase: async () => record('phaseOps.skipPhase', okFalse),
      disablePhase: async () => record('phaseOps.disablePhase', okFalse),
      enablePhase: async () => record('phaseOps.enablePhase', okFalse),
      deleteTask: async () => record('phaseOps.deleteTask', okFalse),
      removeTaskPhase: async () => record('phaseOps.removeTaskPhase', okFalse),
      setPhaseBreakpoint: async () => record('phaseOps.setPhaseBreakpoint', okFalse),
      clearPhaseBreakpoint: async () => record('phaseOps.clearPhaseBreakpoint', okFalse)
    },
    updateConfig: async (): Promise<void> => {
      record('updateConfig', undefined);
    },
    // Feature 098 (T080) — the workspace layer holds the fixture rows rather
    // than being empty, because `EXPORTABLE_PHASE_ID` has to resolve for the
    // export positive-control to mean anything. The layer split is otherwise
    // untouched: `user` is still unset, as it was.
    readPhaseConfig: () => ({ user: [], workspace: FIXTURE_PHASE_DEFINITIONS }),
    readPipelineConfig: () => ({ user: [], workspace: [] }),
    readWorkflowConfig: () => ({ user: [], workspace: [] }),
    getCatalog: () => importedCatalog().catalog,
    guardedRun: {
      scheduleOrEnqueue: async () =>
        record('guardedRun.scheduleOrEnqueue', {
          outcome: 'rejected-validation' as const,
          reason: 'probe'
        })
    },
    connectedRuns: {
      get: () => null,
      // A read, so it is not recorded: the recorder answers "did anything
      // write", and a reader that logged into it would make every refusal
      // look like a write.
      readChildState: () => null,
      compareAndSetConnectedRun: async () =>
        record('connectedRuns.compareAndSetConnectedRun', {
          outcome: 'stale' as const,
          current: null
        })
    },
    writeGeneralSettings: async () =>
      record('writeGeneralSettings', { ok: false as const, reason: 'probe' }),
    setConfirmSuppression: async (): Promise<void> => {
      record('setConfirmSuppression', undefined);
    },
    dismissMigrationNotice: async (): Promise<void> => {
      record('dismissMigrationNotice', undefined);
    },
    audit: {
      append: async () => record('audit.append', undefined)
    },
    saveProcessYamlDocument: async () =>
      record('saveProcessYamlDocument', { outcome: 'canceled' as const }),
    openProcessYamlDocument: async () =>
      record('openProcessYamlDocument', { outcome: 'canceled' as const }),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      sanitize: (value: string) => value
    },
    ...(gates.isTrusted ? { isTrusted: gates.isTrusted } : {}),
    ...(gates.isPrimary ? { isPrimary: gates.isPrimary } : {})
  };

  const router = new MessageRouter(deps);
  let dispatched = 0;

  return {
    writes,
    async dispatch(type, payload) {
      // A fresh correlation id per dispatch. `MutationCommandExecutor` caches
      // acks by correlation id for an hour, so a reused one would replay the
      // previous command's answer and every row after the first would assert
      // nothing.
      dispatched += 1;
      const command = {
        type,
        correlationId: `probe-${dispatched}-${type}`,
        payload: payload ?? {}
      } as unknown as SidebarCommand;

      let ack: CommandAckMessage | undefined;
      await router.dispatch(command, async (message) => {
        ack = message;
        return true;
      });
      return ack;
    }
  };
}
