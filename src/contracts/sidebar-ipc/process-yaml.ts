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

import { MODEL_ID_MAX_LEN } from '../pipeline-definitions';
import { PHASE_ID_MAX_LEN } from '../process-definitions';
import { WORKFLOW_ID_MAX_LEN } from '../workflow-definitions';
import type {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CommandBase
} from '../sidebar-ipc';
import type { DocumentRefusal, ImportPlan, ProcessYamlResourceKind } from '../../services/process-yaml/types';

// The plan types have exactly one definition, in the service module that also
// produces them, rather than a host copy and a webview copy that can drift.
export type {
  ProcessYamlResourceKind,
  BlockedDependency,
  BlockedReason,
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanOutcome,
  ImportPlanRow,
  ProcessYamlCatalogRevision,
  ProcessYamlPresenceStatus
} from '../../services/process-yaml/types';

/**
 * Feature 089 (FR-037) — how long an operator-authored identifier may be when it
 * is carried into a bounded field: an IPC payload, a plan row, an unresolved
 * dependency, or a structured audit record.
 *
 * Each kind's bound is its own catalog's, not a shared maximum. They are all 64
 * today; reading each from the contract that declares it means a catalog that
 * widens its own bound does not silently widen the others.
 *
 * The bounds come from the `contracts/` leaf modules rather than from the
 * `config/*-definition-validator` modules that re-export them, because this
 * barrel is bundled into the webview and a validator pulls the host runner graph
 * (`runner/backend-runner-factory` -> `child_process`) behind it.
 *
 * Declared once, here, because FR-037 forbids a second limit for the same class
 * of value. `tests/integration/process-platform/audit-boundary.test.ts` scans the
 * exchange boundary sources for a re-declaration.
 */
export const RESOURCE_ID_MAX_LEN: Readonly<Record<ProcessYamlResourceKind, number>> = Object.freeze(
  {
    phase: PHASE_ID_MAX_LEN,
    workflow: WORKFLOW_ID_MAX_LEN,
    modelCatalog: MODEL_ID_MAX_LEN
  }
);

/**
 * Feature 086 (FR-013) / Feature 263 (FR-R5-F04) — two inclusion modes for a
 * composable Workflow export: either only the root Workflow (`references-only`)
 * or the root Workflow together with its complete transitive child Workflow and
 * Phase closure (`include-closure`).
 */
export type WorkflowExportInclusion =
  /** No dependency payload at all. */
  | 'references-only'
  /** Transitive child Workflows plus their referenced Phases. */
  | 'include-closure';

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
      readonly resourceKind: 'workflow';
      /** The id to export. Read from the EFFECTIVE catalog (FR-014). */
      readonly resourceId: string;
      readonly inclusion: WorkflowExportInclusion;
    }
  | {
      readonly resourceKind: 'modelCatalog';
      /**
       * No `resourceId` — there is exactly one Model Catalog, nothing to
       * identify — and no `inclusion` — FR-015 rules out cross-catalog
       * references, so there is nothing to include or exclude (contract §3).
       */
    };

export interface ExportProcessYamlCommand
  extends CommandBase<typeof CMD_EXPORT_PROCESS_YAML> {
  readonly payload: ExportProcessYamlRequest;
}

/**
 * The inclusion vocabulary as a value, and the one function that decides
 * whether a kind admits a mode.
 *
 * Feature 086 (T068) / Feature 263 (FR-R5-F04). Both runtime gates — the
 * published `isCmdExportProcessYaml` guard and `validateExportProcessYaml` at
 * the transport boundary — call `admitsExportInclusion`.
 */
export const WORKFLOW_EXPORT_INCLUSIONS: readonly WorkflowExportInclusion[] = Object.freeze([
  'references-only',
  'include-closure'
]);

export function admitsExportInclusion(resourceKind: unknown, inclusion: unknown): boolean {
  if (resourceKind === 'phase') return inclusion === undefined;
  if (resourceKind === 'workflow') {
    return WORKFLOW_EXPORT_INCLUSIONS.includes(inclusion as WorkflowExportInclusion);
  }
  if (resourceKind === 'modelCatalog') return inclusion === undefined;
  return false;
}

/**
 * Which dependency an export could not resolve (FR-R5-F04).
 *
 * A Workflow export in `include-closure` mode can fail on an unresolved child
 * Workflow (`kind: 'workflow'`) or an unresolved Phase (`kind: 'phase'`). Same
 * shape as `BlockedDependency` on the import side.
 *
 * `resourceId` is sanitized and bounded to 64 characters before it crosses the
 * boundary, like every other author-supplied string here. It is an identifier,
 * never a location — `tests/unit/contracts/process-yaml-no-paths.test.ts` is
 * what keeps that true.
 */
export interface UnresolvedDependency {
  readonly kind: 'phase' | 'workflow';
  readonly resourceId: string;
}

/**
 * Why no document was produced.
 *
 * A sub-union rather than a reason plus an optional identifier, because FR-017
 * requires the dependency refusal to NAME the unresolved dependency and the
 * other two reasons have no such name to give. Making the identifier optional
 * would leave both halves representable — a dependency refusal with nothing to
 * act on, and a `not-found` carrying an id it cannot mean.
 *
 * Decision (085, autonomous): `contracts/process-yaml-ipc.md` §2 showed only the
 * reason-union widening, which US2 acceptance scenario 3 and FR-017 cannot be
 * satisfied by. The contract doc is amended alongside this type.
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
       * Feature 085 (FR-017) — the resource itself resolves but one of the
       * things it references does not. Reachable ONLY under an inclusion mode
       * that requires that level to resolve; a references-only export never
       * requires any dependency to resolve (FR-018, contract §2.2).
       */
      readonly reason: 'dependency-does-not-resolve';
      /** The first unresolved dependency, in reference order (FR-017, FR-022). */
      readonly unresolvedDependency: UnresolvedDependency;
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
