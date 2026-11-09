// FR-R6-F06 (contracts/surfaces-and-wiring.md section 4) — the headless usage accounting reads.
//
// Every function validates its input with the validator the sidebar handler and the facade use,
// then delegates to the reader and returns its `AccountingResult` unchanged. A malformed request
// is refused `invalid-query`, with the field name in `detail`, before the reader sees it.
//
// The reader is read-only: no ingest, correction or import is reachable from here (section 6).
// With no service, every read is refused `store-unavailable`; production passes `null` until the
// application store is constructed there (F01-B cutover).
//
// This module imports no editor host API (rule 13). It performs no I/O of its own and retains nothing.

import type { UsageAccountingReader } from '../contracts/sidebar-ipc/usage-accounting';
import type { AccountingResult } from '../contracts/usage-accounting/accounting-types';
import type { ProviderQualification } from '../contracts/usage-accounting/provider-qualifications';
import type { AccountingQueryResponse, ReadGapsResponse } from '../contracts/usage-accounting/query-contract';
import { validateAccountingQueryRequest, validateReadGapsRequest } from '../contracts/validators/usage-accounting';
import type { UsageAccountingService } from '../services/usage-accounting/usage-accounting-service';

/** The service surface the reader needs; a narrower type keeps fakes honest in tests. */
export type UsageAccountingApiService = Pick<UsageAccountingService, 'query' | 'readGaps' | 'readQualifications'>;

const STORE_UNAVAILABLE = Object.freeze({ ok: false, refusal: Object.freeze({ code: 'store-unavailable' }) } as const);

/** The reader the sidebar router and headless callers share. */
export function createUsageAccountingReader(service: UsageAccountingApiService | null): UsageAccountingReader {
  if (service === null) {
    return {
      query: () => STORE_UNAVAILABLE,
      readGaps: () => STORE_UNAVAILABLE,
      readQualifications: () => STORE_UNAVAILABLE
    };
  }
  return {
    query: (request, signal) => service.query(request, signal),
    readGaps: (request) => service.readGaps(request),
    readQualifications: () => service.readQualifications()
  };
}

/** One revision-pinned page of accounting rows (FR-008, FR-009). */
export function queryUsageAccounting(
  reader: UsageAccountingReader,
  request: unknown,
  signal?: AbortSignal
): AccountingResult<AccountingQueryResponse> {
  const valid = validateAccountingQueryRequest(request);
  if (!valid.ok) return valid;
  return reader.query(valid.value, signal);
}

/** One page of counted gaps (FR-015). */
export function readUsageAccountingGaps(reader: UsageAccountingReader, request?: unknown): AccountingResult<ReadGapsResponse> {
  const valid = validateReadGapsRequest(request);
  if (!valid.ok) return valid;
  return reader.readGaps(valid.value);
}

/** The static provider qualification registry (FR-020). */
export function readUsageAccountingQualifications(
  reader: UsageAccountingReader
): AccountingResult<readonly ProviderQualification[]> {
  return reader.readQualifications();
}
