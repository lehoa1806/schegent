import type { CMD_READ_USAGE_ACCOUNTING, CommandBase } from '../sidebar-ipc';
import type { AccountingResult } from '../usage-accounting/accounting-types';
import type { ProviderQualification } from '../usage-accounting/provider-qualifications';
import type { AccountingQueryResponse, ReadGapsResponse } from '../usage-accounting/query-contract';

// FR-R6-F06 (contracts/surfaces-and-wiring.md section 5, clarification 6) — the sidebar's read of
// one accounting page. Read-only: it stays out of `MUTATING_COMMANDS` and takes no primacy or trust
// gate, because the read writes, repairs and ingests nothing. The answer is the same
// `AccountingResult` the headless `queryUsageAccounting` returns, so the two surfaces cannot
// disagree. The query is checked by the shared validator on the host, not by the IPC envelope, so
// an invalid query is answered with the same `invalid-query` refusal on both surfaces.
export interface ReadUsageAccountingRequest {
  /** An `AccountingQueryRequest`; validated by the host's shared validator. */
  readonly query: unknown;
}

export interface ReadUsageAccountingCommand extends CommandBase<typeof CMD_READ_USAGE_ACCOUNTING> {
  readonly payload: ReadUsageAccountingRequest;
}

export type ReadUsageAccountingResponse = AccountingResult<AccountingQueryResponse>;

/**
 * The host's accounting reads. The headless API builds it, so the sidebar and a headless caller
 * read through one object. Inputs are unvalidated JSON; the reader's callers validate first.
 */
export interface UsageAccountingReader {
  query(request: unknown, signal?: AbortSignal): AccountingResult<AccountingQueryResponse>;
  readGaps(request?: unknown): AccountingResult<ReadGapsResponse>;
  readQualifications(): AccountingResult<readonly ProviderQualification[]>;
}
