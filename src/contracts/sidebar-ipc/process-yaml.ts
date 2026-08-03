// Feature 084 T021 — the Phase exchange wire contract.
//
// Governing invariant (FR-019, FR-020a, SC-016): no filesystem location
// appears in any message in either direction. The webview never supplies one
// to read or write, and is never told which one the host used. The host opens
// its own dialog. `tests/unit/contracts/process-yaml-no-paths.test.ts` asserts
// this by inspecting this module's type text, so a field added here that names
// a location fails that test rather than shipping.
//
// See specs/084-phase-yaml-exchange/contracts/process-yaml-ipc.md and
// specs/085-pipeline-package-exchange/contracts/process-yaml-ipc.md.

import type {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CommandBase
} from '../sidebar-ipc';
import type { DocumentRefusal, ImportPlan } from '../../services/process-yaml/types';

// The plan types have exactly one definition, in the service module that also
// produces them, rather than a host copy and a webview copy that can drift.
export type {
  ProcessYamlResourceKind,
  BlockedReason,
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanOutcome,
  ImportPlanRow,
  ProcessYamlLayerRevisions,
  ProcessYamlPresenceScope,
  ProcessYamlPresenceStatus
} from '../../services/process-yaml/types';

/**
 * Feature 085 (FR-012, research R8) — whether a Pipeline export carries the
 * definitions of the Phases it references.
 */
export type PipelineExportInclusion = 'references-only' | 'include-referenced';

/**
 * A discriminated union rather than an optional field: a Phase has no
 * references, so the inclusion choice does not exist for it. Encoding that in
 * the type beats documenting it in a comment.
 */
export type ExportProcessYamlRequest =
  | {
      readonly resourceKind: 'phase';
      /** The id to export. Read from the EFFECTIVE catalog (FR-014). */
      readonly resourceId: string;
    }
  | {
      readonly resourceKind: 'pipeline';
      /** The id to export. Read from the EFFECTIVE catalog (FR-014). */
      readonly resourceId: string;
      readonly inclusion: PipelineExportInclusion;
    };

export interface ExportProcessYamlCommand
  extends CommandBase<typeof CMD_EXPORT_PROCESS_YAML> {
  readonly payload: ExportProcessYamlRequest;
}

/**
 * Why no document was produced.
 *
 * A sub-union rather than a reason plus an optional identifier, because FR-017
 * requires the dependency refusal to NAME the unresolved Phase and the other two
 * reasons have no such name to give. Making the identifier optional would leave
 * both halves representable — a dependency refusal with nothing to act on, and a
 * `not-found` carrying a Phase id it cannot mean.
 *
 * Decision (085, autonomous): `contracts/process-yaml-ipc.md` §2 showed only the
 * reason-union widening, which US2 acceptance scenario 3 and FR-017 cannot be
 * satisfied by. The contract doc is amended alongside this type.
 *
 * `unresolvedPhaseId` is sanitized and bounded before it crosses the boundary,
 * like every other author-supplied string on this contract. It is an identifier,
 * never a location — `tests/unit/contracts/process-yaml-no-paths.test.ts` is what
 * keeps that true.
 */
export type ExportProcessYamlUnavailable =
  | {
      readonly outcome: 'unavailable';
      /**
       * `'not-found'` — no row carries that id in any layer, which is exactly an
       * unsaved draft. `'does-not-resolve'` — a row exists but the effective
       * catalog has no valid definition for it (FR-015).
       */
      readonly reason: 'does-not-resolve' | 'not-found';
    }
  | {
      readonly outcome: 'unavailable';
      /**
       * Feature 085 (FR-017) — the Pipeline itself resolves but one of the
       * Phases it references does not. Reachable ONLY under
       * `inclusion: 'include-referenced'`; a references-only export never
       * requires the referenced Phases to resolve (FR-018).
       */
      readonly reason: 'dependency-does-not-resolve';
      /** The first Phase, in reference order, that did not resolve (FR-017). */
      readonly unresolvedPhaseId: string;
    };

/**
 * The reason values that union admits, derived rather than restated so the ack's
 * reason string and the result's own field cannot come to disagree.
 */
export type ExportProcessYamlUnavailableReason = ExportProcessYamlUnavailable['reason'];

/**
 * `'saved'` deliberately reports nothing about where the document went
 * (FR-019). Overwrite consent belongs to the host's own save dialog, so export
 * registers no `useConfirm` action key (FR-018/085 FR-020).
 */
export type ExportProcessYamlResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'canceled' }
  | ExportProcessYamlUnavailable
  | { readonly outcome: 'failed'; readonly message: string };

/**
 * Feature 084 T027 / feature 085 T013 — preflight. No location, no bytes, no
 * scope, and as of 085 no kind either: the host opens its own dialog, reads the
 * document, and dispatches on the `kind:` the document declares (FR-055a).
 *
 * An operator must not have to classify a file before opening it, and choosing
 * the wrong per-kind action must not be a reachable failure — which is exactly
 * what a kind on the REQUEST would be. `Record<string, never>` is the empty
 * payload: it admits `{}` and rejects every field, so a later addition has to be
 * a deliberate edit here rather than an accident at a call site.
 */
export type PreflightProcessYamlRequest = Record<string, never>;

export interface PreflightProcessYamlCommand
  extends CommandBase<typeof CMD_PREFLIGHT_PROCESS_YAML> {
  readonly payload: PreflightProcessYamlRequest;
}

/**
 * A discriminated union so an illegal outcome/field combination cannot be
 * built (FR-022): a refusal never carries a plan, and a plan never carries a
 * refusal code. A document-level refusal produces NO partial plan (FR-027).
 *
 * `'failed'` covers a host-side read that neither produced bytes nor was
 * canceled — a dialog or filesystem error. Its message is generic, because an
 * underlying error string can name the location the host tried to read.
 */
export type PreflightProcessYamlResult =
  | { readonly outcome: 'canceled' }
  | { readonly outcome: 'refused'; readonly refusal: DocumentRefusal }
  | { readonly outcome: 'planned'; readonly plan: ImportPlan }
  | { readonly outcome: 'failed'; readonly message: string };
