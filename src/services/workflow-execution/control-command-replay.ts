/**
 * Principal Review F1 — crash-between-stores idempotent replay verification for
 * `ControlCommandService.redirectLegacyRetryPhase`.
 *
 * Kept free of `workflow-launcher.ts` / `workflow-control-service.ts` imports so
 * `control-command-service.ts` stays lightweight for webview test typechecking and
 * comfortably within its LOC budget. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type {
  ControlFrame,
  ControlLedger,
  RootControlState
} from '../../contracts/control-ledger';
import {
  CONTROL_COMMAND_VERSION,
  type ControlAction,
  type ControlCommandAcknowledgement,
  type ControlCommandEnvelope,
  type ControlCommandRefusalReason
} from '../../contracts/sidebar-ipc/workflow-run';
import { lookupRecord, type ControlLedgerStore } from './control-ledger-store';

export interface LegacyRetryReplayInput {
  readonly commandId: string;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly candidateId?: string | undefined;
  readonly expectedGeneration?: number | undefined;
}

/**
 * If `controlLedger` already holds a committed receipt for `input.commandId` on this root/queue,
 * cryptographically verify that the stored `payloadDigest` matches a legal legacy-retry envelope
 * (`resume` or `try-now(candidateId)` at pre-commit generation) and return the idempotent replay
 * acknowledgement (or `invalid-command` if the same `commandId` targeted a different payload).
 * Returns `null` when no receipt for `input.commandId` exists yet.
 */
export function tryReplayLegacyRetryPhase(params: {
  readonly input: LegacyRetryReplayInput;
  readonly ledgerStore: ControlLedgerStore;
  readonly findFrame: (root: RootControlState, invocationId: string) => ControlFrame | undefined;
  readonly computeDigest: (envelope: ControlCommandEnvelope) => string;
  readonly buildProjection: (
    root: RootControlState,
    frame: ControlFrame,
    ledger: ControlLedger
  ) => ControlCommandAcknowledgement['projection'];
}): ControlCommandAcknowledgement | null {
  const { input, ledgerStore, findFrame, computeDigest, buildProjection } = params;
  const readRes = ledgerStore.read();
  if (!readRes.ok) return null;
  const initialRoot = lookupRecord(readRes.ledger.roots, input.rootRunId);
  if (initialRoot === undefined || initialRoot.queueId !== input.queueId) return null;
  const initialFrame = findFrame(initialRoot, input.invocationId);
  if (initialFrame === undefined) return null;
  const existingReceipt = (initialRoot.commandReceipts ?? []).find(
    (r) => r.commandId === input.commandId
  );
  if (existingReceipt === undefined) return null;

  const candidateChoices = new Set<string>();
  if (input.candidateId !== undefined) {
    candidateChoices.add(input.candidateId);
  } else {
    if (initialFrame.selectedCandidateId !== undefined) {
      candidateChoices.add(initialFrame.selectedCandidateId);
    }
    for (const slot of initialFrame.candidateSlots ?? []) {
      candidateChoices.add(slot.candidateId);
    }
    candidateChoices.add('default');
  }
  const legalActions: ControlAction[] = [
    { kind: 'resume' },
    ...[...candidateChoices].map((candidateId): ControlAction => ({ kind: 'try-now', candidateId }))
  ];
  const legalGens = new Set<number>([
    existingReceipt.generation,
    Math.max(0, existingReceipt.generation - 1),
    ...(input.expectedGeneration !== undefined ? [input.expectedGeneration] : [])
  ]);

  let matchedDigest = false;
  if (existingReceipt.invocationId === input.invocationId) {
    for (const expectedGeneration of legalGens) {
      for (const action of legalActions) {
        const candidateDigest = computeDigest({
          version: 1,
          commandId: input.commandId,
          rootRunId: input.rootRunId,
          queueId: input.queueId,
          invocationId: input.invocationId,
          expectedGeneration,
          action
        });
        if (candidateDigest === existingReceipt.payloadDigest) {
          matchedDigest = true;
          break;
        }
      }
      if (matchedDigest) break;
    }
  }

  const projection = buildProjection(initialRoot, initialFrame, readRes.ledger);
  if (!matchedDigest) {
    return Object.freeze({
      version: CONTROL_COMMAND_VERSION,
      commandId: input.commandId,
      outcome: 'refused' as const,
      generation: initialFrame.frameGeneration ?? initialRoot.fence.rootGeneration,
      reason: 'invalid-command' as const,
      ...(projection !== undefined ? { projection } : {})
    });
  }
  return Object.freeze({
    version: CONTROL_COMMAND_VERSION,
    commandId: input.commandId,
    outcome: existingReceipt.acknowledgement.outcome,
    generation: existingReceipt.acknowledgement.generation,
    ...(existingReceipt.acknowledgement.reason !== undefined
      ? { reason: existingReceipt.acknowledgement.reason as ControlCommandRefusalReason }
      : {}),
    ...(projection !== undefined ? { projection } : {})
  });
}

