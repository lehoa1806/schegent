import type { CMD_READ_STORAGE_DETAILS, CommandBase } from '../sidebar-ipc';
import type {
  LifecycleResult,
  StorageInventoryPage,
  StoragePressureReport
} from '../artifact-lifecycle/lifecycle-types';

// FR-R6-F05 (FR-021, contract surfaces-and-wiring.md §5) — the sidebar's read of storage pressure
// and one inventory page. Read-only: it stays out of `MUTATING_COMMANDS` and takes no primacy or
// trust gate, because the read repairs, sweeps, migrates and probes nothing (C7). The answer is the
// same `LifecycleResult` the headless `getStoragePressure` and `getStorageInventory` return, so the
// two surfaces cannot disagree (SC-009). Neither direction carries a host path.
export interface ReadStorageDetailsRequest {
  /** An inventory cursor from a previous page; absent for the first page. */
  readonly cursor?: string;
}

export interface ReadStorageDetailsCommand extends CommandBase<typeof CMD_READ_STORAGE_DETAILS> {
  readonly payload: ReadStorageDetailsRequest;
}

export interface StorageDetails {
  readonly pressure: StoragePressureReport;
  readonly page: StorageInventoryPage;
}

export type ReadStorageDetailsResponse = LifecycleResult<StorageDetails>;

/** The host's storage-details read; the headless API builds it, so both surfaces give one answer. */
export interface StorageDetailsReader {
  read(cursor: string | undefined): ReadStorageDetailsResponse;
}
