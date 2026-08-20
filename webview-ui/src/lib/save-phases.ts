// Feature 026 T012 — shared savePhases helper.
// Feature 100 (FR-R3-016) T509b — rewritten onto the lifecycle IPC.
//
// `CMD_SAVE_PHASES` is retired. What it did — take a whole layer plus the
// revision it was based on, and make every row in it effective — is what
// `CMD_PUBLISH_PACKAGE` does for one layer, gated on the same `expectedRevision`
// (FR-036). So this file is now a translation, not a transport: it keeps the
// request shape the Builder already builds and hands it to the one dispatch
// module, `catalog-lifecycle.ts`.
//
// The `mutation` tag no longer travels. Intent is declared by being the command
// it is (FR-051), and the host derives what changed from the layer diff. It is
// still read *here*, for the one thing a publish cannot express: a `remove` is an
// omission from a whole-array write, and omitting a definition from a package
// leaves it exactly as it was. A removal is therefore routed to
// `deactivateDefinition`, which is the operation that actually removes it.
//
// This translation exists so the authoring surface keeps working while the store
// changes underneath it. FR-R3-017 replaces the surface with one that speaks the
// lifecycle directly, and deletes this file with it.

import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import type { PhaseDefinition } from './snapshot-types';
import {
  deactivateDefinition,
  publishDefinitionPackage,
  EMPTY_LAYER,
  type LifecycleResult,
  type PostMessage
} from './catalog-lifecycle';

export interface SavePhaseRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: PhaseDefinition['effort'];
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: string;
}

export type SavePhasesMutation =
  | { readonly kind: 'create'; readonly phaseId: string }
  /**
   * Feature 084 (FR-046a) — a `create` whose row came from a portable document,
   * so its declared `version` is stored as authored instead of being renumbered.
   * A `create` in every other respect, including the gates it passes.
   */
  | { readonly kind: 'import'; readonly phaseId: string }
  /**
   * Feature 085 (FR-043) — the Phase half of a package import: a set of rows
   * added under ONE intent, each keeping the version its document declared.
   */
  | { readonly kind: 'import-package'; readonly phaseIds: readonly string[] }
  | { readonly kind: 'edit'; readonly phaseId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourcePhaseId: string;
      readonly phaseId: string;
    }
  | { readonly kind: 'remove'; readonly phaseId: string }
  | { readonly kind: 'reset' };

export interface SavePhasesRequest {
  readonly expectedRevision: string;
  readonly mutation: SavePhasesMutation;
  readonly phases: readonly SavePhaseRow[];
  /**
   * Feature 100 (T509b) — shown in the removal prompt, which is now raised inside
   * `deactivateDefinition` rather than at the call site. Optional because only a
   * `remove` reads it; the id is the fallback when the caller has no better name.
   */
  readonly removedName?: string;
  /** Focus returns here when the removal prompt closes. */
  readonly originatingElement?: HTMLElement | null;
}

export type SavePhasesResult = LifecycleResult;

/**
 * Make the authored Phase layer effective.
 *
 * @param request      The revision the draft was based on, the mutation intent,
 *                     and the full layer snapshot.
 * @param postMessage  Optional injection point for tests.
 */
export function savePhases(
  request: SavePhasesRequest,
  postMessage?: PostMessage
): Promise<SavePhasesResult> {
  const { expectedRevision, mutation, phases } = request;
  if (mutation.kind === 'remove') {
    return deactivateDefinition(
      { kind: 'phase', id: mutation.phaseId, expectedDraftVersion: NO_DRAFT },
      {
        definitionName: request.removedName ?? mutation.phaseId,
        originatingElement: request.originatingElement ?? null
      },
      postMessage
    );
  }
  if (phases.length === 0) return Promise.resolve(EMPTY_LAYER);
  return publishDefinitionPackage(
    {
      layers: [
        {
          kind: 'phase',
          expectedRevision,
          definitions: phases.map((row) => ({ id: row.id, body: row }))
        }
      ]
    },
    postMessage
  );
}
