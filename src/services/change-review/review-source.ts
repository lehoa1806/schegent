/**
 * FR-R6-F12 (research R3) — where a change review reads its F10 request and receipt.
 *
 * The review only reads: it never writes a request, a receipt or a journal row.
 */

import type { IntegrationStore } from '../execution-lanes/integration-store';
import type { ReceiptRecord, RequestRecord } from '../execution-lanes/integration-store-rows';

export interface ChangeReviewSource {
  getRequest(requestId: string): RequestRecord | null;
  getReceipt(requestId: string): ReceiptRecord | null;
}

/** The source over one workspace's F10 integration store. */
export function integrationStoreSource(store: IntegrationStore, workspaceId: string): ChangeReviewSource {
  return {
    getRequest: (requestId) => store.getRequest(workspaceId, requestId),
    getReceipt: (requestId) => store.getReceipt(requestId)
  };
}
