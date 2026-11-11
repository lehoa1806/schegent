/**
 * FR-R6-F12 — the change review service surface: the service, its request source over the F10
 * integration store, and the view-request gate. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export {
  createChangeReviewService,
  type ChangeReviewService,
  type ChangeReviewServiceOptions,
  type OpenReviewInput
} from './change-review-service';
export { integrationStoreSource, type ChangeReviewSource } from './review-source';
export { createViewRequestGate, type ViewRequestGate, type ViewTicket } from './view-request-gate';
