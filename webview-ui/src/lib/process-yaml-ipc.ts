// Feature 084 — the single webview call site for the Phase exchange commands.
//
// Every component in the exchange surface routes through here rather than
// calling `postCommand` inline, so the payload shape is declared once and the
// family stays greppable. `tests/lint/no-inline-process-yaml-ipc.test.ts`
// enforces that; the same convention already governs the metrics, phase-log,
// and backend-ping families.

import { CMD_EXPORT_PROCESS_YAML, CMD_PREFLIGHT_PROCESS_YAML } from './messages';
import type {
  ExportProcessYamlRequest,
  PipelineExportInclusion,
  PreflightProcessYamlResult,
  WorkflowExportInclusion
} from './messages';
import { postCommand, type PostCommandResult } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

/**
 * A liveness backstop, not a latency budget — which is why it is minutes where
 * every other correlated-request helper in this webview uses five seconds.
 *
 * Those helpers post to handlers that compute an answer and ack.
 * `CMD_PREFLIGHT_PROCESS_YAML` does not: its handler awaits
 * `openProcessYamlDocument()` — a native `showOpenDialog` — before it can ack
 * anything, so this budget spans an operator browsing a file picker. At five
 * seconds a healthy host reported "The host did not respond." whenever picking
 * a file took longer than that, and the real ack arriving afterwards was
 * dropped by the already-unsubscribed listener: the operator's document was
 * read and planned, and the plan was discarded.
 *
 * Every branch of `cmd-preflight-process-yaml.ts` acks — including `canceled`
 * when the dialog is dismissed — so silence past this point means the host is
 * gone, which is the only thing this timer is a backstop for. It stays finite
 * so a dead host resolves the promise rather than leaving the import surface
 * stuck in `validating` for the rest of the session.
 */
const ACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Ask the host to export one Phase as a portable document.
 *
 * No location is supplied and none comes back: the host opens its own save
 * dialog and reports only whether a document was written (FR-019).
 */
export function exportPhaseYaml(resourceId: string): PostCommandResult {
  const request: ExportProcessYamlRequest = { resourceKind: 'phase', resourceId };
  return postCommand(CMD_EXPORT_PROCESS_YAML, request);
}

/**
 * Ask the host to export one Pipeline as a portable package document.
 *
 * `inclusion` is the operator's choice and travels with the request rather than
 * being inferred host-side: the same Pipeline is legitimately exported both ways
 * (FR-012), and only the operator knows which the recipient needs.
 */
export function exportPipelineYaml(
  resourceId: string,
  inclusion: PipelineExportInclusion
): PostCommandResult {
  const request: ExportProcessYamlRequest = {
    resourceKind: 'pipeline',
    resourceId,
    inclusion
  };
  return postCommand(CMD_EXPORT_PROCESS_YAML, request);
}

/**
 * Ask the host to export one Workflow as a portable package document.
 *
 * `inclusion` travels with the request for the same reason it does for a Pipeline:
 * the same Workflow is legitimately exported at more than one depth, and only the
 * operator knows how much the recipient already has. Its union is the Workflow's
 * own — three depths rather than two — because a Workflow has two layers of
 * dependency below it, not one.
 */
export function exportWorkflowYaml(
  resourceId: string,
  inclusion: WorkflowExportInclusion
): PostCommandResult {
  const request: ExportProcessYamlRequest = {
    resourceKind: 'workflow',
    resourceId,
    inclusion
  };
  return postCommand(CMD_EXPORT_PROCESS_YAML, request);
}

/**
 * Ask the host to export the Model Catalog as a portable document.
 *
 * No `resourceId` and no `inclusion`: there is exactly one Model Catalog and
 * no cross-catalog references to include or omit (contract §3, FR-015).
 */
export function exportModelCatalogYaml(): PostCommandResult {
  const request: ExportProcessYamlRequest = { resourceKind: 'modelCatalog' };
  return postCommand(CMD_EXPORT_PROCESS_YAML, request);
}

/**
 * A host ack whose `result` is not a recognizable preflight outcome cannot be
 * rendered, so it is reported as a failure rather than shown as an empty plan
 * (FR-055: no plan is displayed unless validation actually produced one).
 */
function asPreflightResult(value: unknown): PreflightProcessYamlResult | null {
  if (value === null || typeof value !== 'object') return null;
  const outcome = (value as { outcome?: unknown }).outcome;
  if (
    outcome !== 'canceled' &&
    outcome !== 'refused' &&
    outcome !== 'planned' &&
    outcome !== 'failed'
  ) {
    return null;
  }
  return value as PreflightProcessYamlResult;
}

/**
 * Ask the host what importing a document would do, and resolve its answer.
 *
 * The payload is empty. The host opens its own open dialog and does its own
 * read, so this call supplies no location and no bytes (FR-020, FR-020a) — and
 * as of feature 085 it supplies no resource kind either: the document declares
 * its own `kind` and preflight dispatches on that (FR-055a, research R8). A kind
 * on the request would be a second, unauthoritative claim about what the file is,
 * and the only thing it could do is disagree with the file.
 *
 * Nothing is written — the commit is a separate, gated save.
 *
 * Resolves the wire `PreflightProcessYamlResult` verbatim; the union is declared
 * once, in the contract, so there is no webview copy to drift. Host silence past
 * `ACK_TIMEOUT_MS` resolves as `'failed'` rather than widening the wire union
 * with a synthetic outcome, so the caller has exactly one non-committal state to
 * render — see that constant for why its budget is minutes rather than the five
 * seconds this family's other helpers use.
 *
 * Decision (084, autonomous): there is no injected `postMessage` parameter, even
 * though the lifecycle senders take one. Those had to hand-roll a UUIDv4 to keep
 * the injected path's envelope id observable, and a second copy of that generator
 * is worse than the seam it buys. Tests observe the
 * envelope through `setHostTransport`, which is the transport-level injection
 * point built for exactly this, and `postCommand` stays the only poster.
 */
export function preflightProcessYaml(): Promise<PreflightProcessYamlResult> {
  return new Promise<PreflightProcessYamlResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: PreflightProcessYamlResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // unsubscribe errors must not leak; the listener is one-shot.
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const { correlationId } = postCommand(CMD_PREFLIGHT_PROCESS_YAML, {});

    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      const result = asPreflightResult(ack.result);
      finalise(
        result ?? { outcome: 'failed', message: 'The host did not report a usable result.' }
      );
    });

    timer = setTimeout(() => {
      finalise({ outcome: 'failed', message: 'The host did not respond.' });
    }, ACK_TIMEOUT_MS);
  });
}
