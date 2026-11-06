// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Builds a read-only opener and a content provider. It writes nothing, spawns nothing and arms no timer,
// at wiring time or afterwards; the one read it makes happens when the operator invokes "Open decision
// record", through `safe-open.ts`, and the command router is the gate for that request.
// FR-R5-F19 (feature 278, T19.1, FR-003 to FR-005) — the host side of "Open decision record".
//
// Builds the opener over this window's own queue state and shows the record in a READ-ONLY document.
// The document is served by a content provider under a dedicated scheme, so it is never an untitled
// document: the editor offers no edit and no save, and nothing is written to disk. Its text is shown as
// plain text (no language is set), so markup in a record is not rendered or followed.
//
// The provider holds the few most recent records in memory, keyed by a counter, and drops older ones, so
// a long session cannot grow it. Nothing here starts a process or reaches a backend prompt (FR-004).
import * as vscode from 'vscode';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type { SanitizedLogger } from '../lib/logger';
import {
  createDecisionRecordOpener,
  type DecisionRecordOpener,
  type RowFeatureDir
} from '../services/decision-record/decision-record-open';
import type { WorkspaceStateStore } from '../state/workspace-state';

/** The URI scheme of a presented record. Not a file scheme, so the document has no file to save to. */
export const DECISION_RECORD_SCHEME = 'schegent-decision-record';

/** Records the provider keeps; the oldest is dropped beyond it. */
export const DECISION_RECORD_DOCUMENTS_MAX = 8;

export interface DecisionRecordWiringDeps {
  readonly workspaceRoot: string;
  readonly store: Pick<WorkspaceStateStore, 'getRequest' | 'getRun'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

export interface DecisionRecordWiring {
  readonly opener: DecisionRecordOpener;
  /** Unregisters the content provider. Hand it to the extension's subscriptions. */
  readonly disposable: vscode.Disposable;
}

/** The row's Run's feature directory as persisted: `null` when the row holds no Run of its own. */
export function featureDirOfRow(store: DecisionRecordWiringDeps['store'], rowId: string): RowFeatureDir {
  const request = store.getRequest(rowId);
  if (request === null) return { found: false };
  if (request.runId === null) return { found: true, featureDir: null };
  const run = store.getRun(request.queueId ?? DEFAULT_QUEUE_ID);
  if (run === null || run.id !== request.runId) return { found: true, featureDir: null };
  return { found: true, featureDir: run.featureDir };
}

export function createDecisionRecordWiring(deps: DecisionRecordWiringDeps): DecisionRecordWiring {
  const documents = new Map<string, string>();
  let counter = 0;

  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => documents.get(uri.path) ?? ''
  };
  const registration = vscode.workspace.registerTextDocumentContentProvider(DECISION_RECORD_SCHEME, provider);

  async function present(text: string): Promise<void> {
    counter += 1;
    const key = `/decisions-${counter}.md`;
    documents.set(key, text);
    while (documents.size > DECISION_RECORD_DOCUMENTS_MAX) {
      const oldest = documents.keys().next();
      if (oldest.done === true) break;
      documents.delete(oldest.value);
    }
    const uri = vscode.Uri.from({ scheme: DECISION_RECORD_SCHEME, path: key });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  const opener = createDecisionRecordOpener({
    workspaceRoot: deps.workspaceRoot,
    isTrusted: () => vscode.workspace.isTrusted,
    featureDirOfRow: (rowId) => featureDirOfRow(deps.store, rowId),
    present,
    logger: { warn: (message) => deps.logger.warn(message) }
  });
  return { opener, disposable: registration };
}
