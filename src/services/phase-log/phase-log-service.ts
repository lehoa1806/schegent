// Feature 020 T031 — phase-log service adapter. Sits between the
// MessageRouter and `phase-log-reader.ts`: resolves the selection tuple
// against the current snapshot, derives `isInFlight`, threads the
// sanitize callback + verbose-setting reader, and translates the
// reader's `PhaseLogReadResult` into the IPC wire format.
//
// Sanitization for body strings happens inside `readIterationManifest`
// at the IPC boundary (research.md §5); the on-disk bytes are never
// altered (010 T10 hard rule). The audit-event payload is paths-free
// — only the selection tuple + counts + outcome cross the audit log
// boundary (contracts/phase-log-ipc.md §1).

import { readPhaseLog } from './phase-log-reader';
import type { ReadPhaseLogRequest, ReadPhaseLogResponse } from '../../contracts/sidebar-ipc';

export interface PhaseLogSnapshotView {
  readonly queue: {
    readonly inFlight: { readonly id: string } | null;
    readonly pending: readonly { readonly id: string }[];
    readonly recent: readonly { readonly id: string }[];
    readonly queues: readonly { readonly id: string }[];
  };
  readonly history: readonly { readonly runId: string }[];
  readonly availablePipelines: readonly { readonly id: string }[];
  readonly availablePhases: readonly { readonly id: string }[];
}

export interface PhaseLogServiceDeps {
  readonly workspaceRoot: string;
  readonly sanitize: (s: string) => string;
  readonly readVerboseSetting: () => boolean;
  readonly getSnapshot: () => PhaseLogSnapshotView;
  /**
   * Look up the on-disk session `runId` for a given queue task id.
   * `FeatureRequest.id` (the task id visible in the UI) differs from
   * `FeatureRequest.runId` (the UUID that names the session directory).
   * Returns `null` when the task cannot be found or has no runId yet
   * (e.g. still pending, or already cleared from queue).
   */
  readonly resolveRunId: (taskId: string) => string | null;
  readonly caps?: {
    readonly perFieldBytes?: number;
    readonly maxEntries?: number;
  };
}

const DEFAULT_PER_FIELD_BYTES = 65536;
const DEFAULT_MAX_ENTRIES = 500;

export interface PhaseLogService {
  read(req: ReadPhaseLogRequest): Promise<ReadPhaseLogResponse>;
}

export function createPhaseLogService(deps: PhaseLogServiceDeps): PhaseLogService {
  return {
    async read(req) {
      const { selection } = req;
      const validation = validateSelection(selection, deps.getSnapshot());
      if (validation.outcome === 'failure') {
        return validation;
      }
      const isInFlight = validation.isInFlight;
      // The webview passes FeatureRequest.id as `taskId`, but the
      // session directory on disk is named after the WorkflowRun.id
      // (stored as FeatureRequest.runId). Resolve the actual runId
      // before constructing the filesystem path. When the task is not
      // found in the queue (e.g. history entries already carry the
      // runId directly), fall through with the original taskId.
      const runId = deps.resolveRunId(selection.taskId) ?? selection.taskId;
      const resolvedSelection = { ...selection, taskId: runId };
      const result = await readPhaseLog({
        workspaceRoot: deps.workspaceRoot,
        selection: resolvedSelection,
        isInFlight,
        caps: {
          perFieldBytes: deps.caps?.perFieldBytes ?? DEFAULT_PER_FIELD_BYTES,
          maxEntries: deps.caps?.maxEntries ?? DEFAULT_MAX_ENTRIES
        },
        sanitize: deps.sanitize,
        readSetting: deps.readVerboseSetting
      });
      return result;
    }
  };
}

type SelectionValidation =
  | { readonly outcome: 'success'; readonly isInFlight: boolean }
  | {
      readonly outcome: 'failure';
      readonly reason: 'unknown-tuple';
    };

function validateSelection(
  selection: ReadPhaseLogRequest['selection'],
  snapshot: PhaseLogSnapshotView
): SelectionValidation {
  if (
    !nonEmpty(selection.queueId) ||
    !nonEmpty(selection.taskId) ||
    !nonEmpty(selection.pipelineId) ||
    !nonEmpty(selection.phaseId)
  ) {
    return { outcome: 'failure', reason: 'unknown-tuple' };
  }
  const queueKnown = snapshot.queue.queues.some((q) => q.id === selection.queueId);
  if (!queueKnown) return { outcome: 'failure', reason: 'unknown-tuple' };

  const inFlightMatch = snapshot.queue.inFlight?.id === selection.taskId;
  const pendingMatch = snapshot.queue.pending.some((t) => t.id === selection.taskId);
  const recentMatch = snapshot.queue.recent.some((t) => t.id === selection.taskId);
  const historyMatch = snapshot.history.some((h) => h.runId === selection.taskId);
  if (!inFlightMatch && !pendingMatch && !recentMatch && !historyMatch) {
    return { outcome: 'failure', reason: 'unknown-tuple' };
  }

  // pipelineId / phaseId membership is a catalog lookup. The catalog
  // can evolve mid-run; we accept the tuple when EITHER the catalog
  // currently lists it OR the task is in-flight (the runtime pipeline
  // may include phases the catalog no longer surfaces). The disk
  // existence check downstream is the real authority — an unknown
  // tuple resolves to an empty manifest, not a hard failure.
  const pipelineKnown = snapshot.availablePipelines.some((p) => p.id === selection.pipelineId);
  const phaseKnown = snapshot.availablePhases.some((p) => p.id === selection.phaseId);
  if (!inFlightMatch && (!pipelineKnown || !phaseKnown)) {
    return { outcome: 'failure', reason: 'unknown-tuple' };
  }

  return { outcome: 'success', isInFlight: inFlightMatch };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
