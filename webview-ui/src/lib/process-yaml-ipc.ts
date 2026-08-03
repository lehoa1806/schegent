// Feature 084 — the single webview call site for the Phase exchange commands.
//
// Every component in the exchange surface routes through here rather than
// calling `postCommand` inline, so the payload shape is declared once and the
// family stays greppable. `tests/lint/no-inline-process-yaml-ipc.test.ts`
// enforces that; the same convention already governs the metrics, phase-log,
// and backend-ping families.

import { CMD_EXPORT_PROCESS_YAML, CMD_PREFLIGHT_PROCESS_YAML } from './messages';
import type { PreflightProcessYamlResult, ProcessYamlResourceKind } from './messages';
import { postCommand, type PostCommandResult } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * Ask the host to export one resource as a portable document.
 *
 * No location is supplied and none comes back: the host opens its own save
 * dialog and reports only whether a document was written (FR-019).
 */
export function exportProcessYaml(
  resourceKind: ProcessYamlResourceKind,
  resourceId: string
): PostCommandResult {
  return postCommand(CMD_EXPORT_PROCESS_YAML, { resourceKind, resourceId });
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
 * The payload is the resource kind and nothing else: the host opens its own open
 * dialog and does its own read, so this call supplies no location and no bytes
 * (FR-020, FR-020a). Nothing is written — the commit is a separate, gated save.
 *
 * Resolves the wire `PreflightProcessYamlResult` verbatim; the union is declared
 * once, in the contract, so there is no webview copy to drift. Host silence past
 * five seconds resolves as `'failed'` rather than widening the wire union with a
 * synthetic outcome, so the caller has exactly one non-committal state to render.
 *
 * Decision (084, autonomous): there is no injected `postMessage` parameter, even
 * though `readWakeupSessionLog` and `saveWorkflows` take one. Those helpers had
 * to hand-roll a UUIDv4 to keep the injected path's envelope id observable, and a
 * third copy of that generator is worse than the seam it buys. Tests observe the
 * envelope through `setHostTransport`, which is the transport-level injection
 * point built for exactly this, and `postCommand` stays the only poster.
 *
 * @param resourceKind The kind being imported.
 */
export function preflightProcessYaml(
  resourceKind: ProcessYamlResourceKind
): Promise<PreflightProcessYamlResult> {
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

    const { correlationId } = postCommand(CMD_PREFLIGHT_PROCESS_YAML, { resourceKind });

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
