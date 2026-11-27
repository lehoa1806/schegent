// FR-R4-F06 (FR-029, FR-033; contract Q, Q3; K3) / FR-R7-06 — the capability flags an
// installed CLI was SHOWN to list, projected from `BACKEND_DESCRIPTORS` (`confirmedFlags`).
//
// `tests/lint/containment-qualification-parity.test.ts` fails a record whose observed rows
// and this table disagree. Update `confirmedFlags` in `src/contracts/backend-descriptors.ts`
// alongside `docs/architecture/backend-containment-qualification.md` sections 7 and 8.
import { mapBackends, type BackendMap } from '../contracts/backend-descriptors';

export const CONFIRMED_FLAGS: BackendMap<readonly string[]> = mapBackends(
  (descriptor) => descriptor.confirmedFlags
);
