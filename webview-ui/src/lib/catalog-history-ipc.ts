// Feature 101 (US4, T054) — the SINGLE call site of `CMD_READ_DEFINITION_VERSION`.
//
// Mirrors `metrics-ipc.ts`: post, correlate on the acknowledgement, project the
// result, and time out rather than hang. Builder components MUST NOT post this
// command inline; `tests/lint/no-inline-catalog-history-ipc.test.ts` (T055)
// fails the build on drift, as every other read family in this repo does.
//
// `ack.result` is `unknown`, and this is the only place a definition body
// re-enters the webview outside the snapshot, so the validator is not optional.
// Nothing downstream can make that check later: by then the body is already
// bound into a component.
//
// Three outcomes and no fourth (FR-012b). A failure never carries a body — not
// `{}`, not `null` — because an empty body renders identically to a definition
// with no content, and the whole point of an explicit error state is that the
// operator can tell the two apart.

import { CMD_READ_DEFINITION_VERSION, type ReadDefinitionVersionRequest } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidReadDefinitionVersionResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

export type ReadDefinitionVersionResult =
  | { readonly outcome: 'success'; readonly body: Readonly<Record<string, unknown>> }
  /** The host said no, or said nothing this helper could trust. `reason` is for the operator. */
  | { readonly outcome: 'failure'; readonly reason: string };

/** The reason shown when the host rejected without one, or the ack never came. */
const UNSPECIFIED = 'internal-error';

/**
 * Read one past version's body by coordinate — never by path (FR-034).
 *
 * Resolves with the validated body on an accepted ack, or a failure carrying
 * the host's reason. Never rejects: a thrown promise here would leave the
 * panel's pending state with nothing to replace it.
 */
export function readDefinitionVersion(
  req: ReadDefinitionVersionRequest
): Promise<ReadDefinitionVersionResult> {
  return new Promise<ReadDefinitionVersionResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: ReadDefinitionVersionResult): void => {
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
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    // The post-and-correlate sequence runs synchronously inside the executor so
    // concurrent reads never cross-resolve — a history panel can have one read
    // in flight per definition, and two of them landing on each other's
    // listener would show one version's body under another version's heading.
    const { correlationId } = postCommand(CMD_READ_DEFINITION_VERSION, req);
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      if (ack.status === 'accepted' && isValidReadDefinitionVersionResponse(ack.result)) {
        finalise({ outcome: 'success', body: ack.result.body });
        return;
      }
      finalise({ outcome: 'failure', reason: ack.reason ?? UNSPECIFIED });
    });

    timer = setTimeout(() => finalise({ outcome: 'failure', reason: 'timeout' }), ACK_TIMEOUT_MS);
  });
}
