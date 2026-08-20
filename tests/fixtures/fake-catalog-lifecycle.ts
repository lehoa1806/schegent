// Feature 100 (T514, FR-R3-016) — the six lifecycle operations over an in-memory
// store, for the caller-side suites.
//
// The three `CMD_SAVE_*` handlers the integration suites used to drive held one
// dependency: a write port. The lifecycle handlers hold two — the store AND the
// service that sequences it — because a lifecycle operation is a read, a decision,
// and a gated write rather than a single call. A suite that hand-rolled the service
// half would be asserting against a second implementation of the decision, which is
// the one thing a caller-side test must not do.
//
// So this builds the real thing: `createHostCatalogLifecycle`, the same wiring seam
// activation uses, over a `FakeCatalogStore`. What is faked is the disk; the
// validation, the reference scan, the token gate, and the two-pass package publish
// are the shipped code. A suite that wants to observe a store refusal sets one of
// the fake's verdict seams and lets the real service carry it.
//
// `defaultPipelineId` is a thunk read fresh on every call, exactly as it is in the
// host (FR-059) — a test that changes it mid-run gets the new value, and one that
// does not name it gets no configured default at all.

import { createHostCatalogLifecycle } from '../../src/activation/catalog-store-wiring';
import type { CatalogLifecycleOps } from '../../src/catalog/lifecycle-service';
import { FakeCatalogStore } from './fake-catalog-store';
import type { FakeStoreSeed } from './fake-catalog-store';

export interface FakeLifecycleOptions {
  /**
   * The `schegent.defaultPipelineId` this workspace holds, for the FR-059
   * deactivation advisory. Defaults to none configured.
   */
  readonly defaultPipelineId?: () => string;
}

/** The real six operations over `store`. Never `null` — the store exists. */
export function fakeCatalogLifecycle(
  store: FakeCatalogStore,
  options: FakeLifecycleOptions = {}
): CatalogLifecycleOps {
  const ops = createHostCatalogLifecycle(store, options.defaultPipelineId ?? (() => ''));
  if (ops === null) throw new Error('unreachable: a store was supplied');
  return ops;
}

/** A store and the operations over it, the pair every caller-side suite needs. */
export interface FakeCatalogInstallation {
  readonly store: FakeCatalogStore;
  readonly lifecycle: CatalogLifecycleOps;
}

export function fakeCatalogInstallation(
  seed: FakeStoreSeed = {},
  options: FakeLifecycleOptions = {}
): FakeCatalogInstallation {
  const store = new FakeCatalogStore(seed);
  return { store, lifecycle: fakeCatalogLifecycle(store, options) };
}
