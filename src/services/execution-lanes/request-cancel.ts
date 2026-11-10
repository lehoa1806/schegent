/**
 * FR-R6-F10 (spec US6, contract §5 `cancelRequest`; data-model, integration lifecycle): ending an
 * integration request the operator no longer wants.
 *
 * `queued`, `awaiting-review`, `blocked` and `uncertain` move to `canceled`. A request mid-check
 * (`verifying`) or mid-landing (`landing`) refuses `request-state-invalid`, as does one already
 * `landed` or `canceled`. Canceling an `uncertain` request records that the operator acknowledged
 * the unknown outcome: one `cancel` journal entry, outcome `canceled`, reason
 * `acknowledged-uncertain`, written in the same fenced transaction as the move. Cancel touches no
 * Git state, no lane and no other request.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneRefused, type IntegrationState, type LaneResult } from '../../contracts/execution-lanes';
import type { IntegrationStore, RequestRecord } from './integration-store';
import type { LaneStore } from './lane-store';

export interface CancelContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

/** The states a request may be canceled from (data-model, integration lifecycle). */
export const CANCELABLE_REQUEST_STATES: readonly IntegrationState[] = Object.freeze([
  'queued',
  'awaiting-review',
  'blocked',
  'uncertain'
]);

export const ACKNOWLEDGED_UNCERTAIN = 'acknowledged-uncertain';
const ID_BYTES = 16;

/** Contract §5: the request in `canceled`, or `request-not-found`, `request-state-invalid` or `ownership-superseded`. */
export function cancelRequest(ctx: CancelContext, requestId: string): LaneResult<RequestRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const request = ctx.integrations.getRequest(ctx.workspaceId, requestId);
    if (request === null) return laneRefused<RequestRecord>('request-not-found');
    if (!CANCELABLE_REQUEST_STATES.includes(request.state)) return laneRefused<RequestRecord>('request-state-invalid');

    const now = new Date(ctx.clock()).toISOString();
    const moved = ctx.integrations.transitionRequest(ctx.workspaceId, requestId, [request.state], 'canceled', {
      reason: null,
      now,
      generation: ctx.generation
    });
    if (!moved.ok || request.state !== 'uncertain') return moved;

    ctx.integrations.appendJournal({
      entryId: ctx.random(ID_BYTES).toString('hex'),
      requestId,
      kind: 'cancel',
      method: null,
      candidateCommit: request.candidateCommit,
      expectedCommit: request.expectedTargetCommit,
      observedTip: null,
      outcome: 'canceled',
      reason: ACKNOWLEDGED_UNCERTAIN,
      generation: ctx.generation,
      now
    });
    return moved;
  });
}
