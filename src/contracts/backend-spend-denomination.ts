// FR-R3-144 (T036, FR-009) / FR-R7-06 — which spend bound is in force for which backend.
//
// Derived directly from `BACKEND_DESCRIPTORS` (`spendDenomination`) so host surfaces
// (`services/autonomy-bounds-disclosure.ts`) and the generated webview mirror read one authority.
// Runtime spend enforcement stays in `services/spend-bound.ts`.

import type { BackendRunnerKind } from './backend-kinds';
import {
  getBackendDescriptor,
  mapBackends,
  type BackendMap,
  type SpendDenomination
} from './backend-descriptors';

export type { SpendDenomination };

/** Every backend's spend denomination, derived from `BACKEND_DESCRIPTORS`. */
export const SPEND_DENOMINATION_BY_BACKEND: BackendMap<SpendDenomination> = mapBackends(
  (descriptor) => descriptor.spendDenomination
);

export function spendDenominationOf(kind: BackendRunnerKind): SpendDenomination {
  return getBackendDescriptor(kind).spendDenomination;
}

/**
 * The setting each denomination is configured through, by wire key.
 *
 * Carried here rather than at the two call sites because a surface that offers the
 * right control under the wrong key is the same defect as offering the wrong
 * control, and this is the one place both facts are stated together.
 */
export const SPEND_BOUND_KEY_BY_DENOMINATION: Readonly<Record<SpendDenomination, string>> =
  Object.freeze({
    usd: 'spend.maxUsdPerRun',
    tokens: 'spend.maxTokensPerRun'
  });
