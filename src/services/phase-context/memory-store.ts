/**
 * FR-R6-F15 (F15-A; FR-011, FR-012, FR-015, NFR-004) — the in-memory handoff store: the one
 * implementation of `HandoffStorePort` this package ships. It keeps a copy of each record,
 * rebuilt field by field and frozen, so nothing outside the store can change what was saved.
 * The durable store is F15-B.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type {
  AcceptedRevision,
  ApprovalRecord,
  DispatchRecord,
  HandoffRecord,
  HandoffStorePort
} from '../../contracts/phase-context/context-manifest';

const NEW_RECORD_VERSION = 0;

function copyRevision(revision: AcceptedRevision): AcceptedRevision {
  return Object.freeze({
    revision: revision.revision,
    manifestDigest: revision.manifestDigest,
    serializedManifest: revision.serializedManifest,
    rendererVersion: revision.rendererVersion,
    renderedDigest: revision.renderedDigest,
    renderedBytes: revision.renderedBytes,
    state: revision.state
  });
}

function copyApproval(approval: ApprovalRecord): ApprovalRecord {
  return Object.freeze({ revision: approval.revision, decisionId: approval.decisionId });
}

function copyDispatch(dispatch: DispatchRecord): DispatchRecord {
  return Object.freeze({
    revision: dispatch.revision,
    targetAttemptId: dispatch.targetAttemptId,
    representationDigest: dispatch.representationDigest,
    state: dispatch.state
  });
}

function storedCopy(record: HandoffRecord, version: number): HandoffRecord {
  return Object.freeze({
    handoffId: record.handoffId,
    version,
    revisions: Object.freeze(record.revisions.map(copyRevision)),
    approvals: Object.freeze(record.approvals.map(copyApproval)),
    dispatches: Object.freeze(record.dispatches.map(copyDispatch))
  });
}

/**
 * A store that lives as long as the value does. `save` stores only when the stored version is
 * the expected one (0 for a handoff with no record), and the stored record has the next version
 * whatever version the saved object names.
 */
export function createMemoryHandoffStore(): HandoffStorePort {
  const records = new Map<string, HandoffRecord>();
  return {
    load(handoffId) {
      return records.get(handoffId) ?? null;
    },
    save(record, expectedVersion) {
      const storedVersion = records.get(record.handoffId)?.version ?? NEW_RECORD_VERSION;
      if (storedVersion !== expectedVersion) return false;
      records.set(record.handoffId, storedCopy(record, expectedVersion + 1));
      return true;
    }
  };
}
