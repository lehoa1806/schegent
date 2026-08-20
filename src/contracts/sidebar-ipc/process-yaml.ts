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

import { PIPELINE_ID_MAX_LEN } from '../pipeline-definitions';
import { PHASE_ID_MAX_LEN } from '../process-definitions';
import { WORKFLOW_ID_MAX_LEN } from '../workflow-definitions';
import type {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CommandBase
} from '../sidebar-ipc';
import { MODEL_ID_MAX_LEN } from '../../services/process-yaml/types';
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
 * widens its own bound does not silently widen the other two.
 *
 * The three come from the `contracts/` leaf modules rather than from the three
 * `config/*-definition-validator` modules that re-export them, because this
 * barrel is bundled into the webview and a validator pulls the host runner graph
 * (`runner/backend-runner-factory` -> `child_process`) behind it.
 *
 * Declared once, here, because FR-037 forbids a second limit for the same class
 * of value. Four modules used to hold their own `RESOURCE_ID_MAX = 64` — they
 * agreed by coincidence, and the day one catalog widened its id length every one
 * of them would have started truncating identifiers the catalog itself accepts.
 * `tests/integration/process-platform/audit-boundary.test.ts` scans the exchange
 * boundary sources for a re-declaration.
 */
export const RESOURCE_ID_MAX_LEN: Readonly<Record<ProcessYamlResourceKind, number>> = Object.freeze(
  {
    phase: PHASE_ID_MAX_LEN,
    pipeline: PIPELINE_ID_MAX_LEN,
    workflow: WORKFLOW_ID_MAX_LEN,
    modelCatalog: MODEL_ID_MAX_LEN
  }
);

/**
 * Feature 085 (FR-012, research R8) — whether a Pipeline export carries the
 * definitions of the Phases it references.
 */
export type PipelineExportInclusion = 'references-only' | 'include-referenced';

/**
 * Feature 086 (FR-013) — three modes, not two, because a Workflow's closure is
 * two levels deep. The middle mode is the one a Pipeline export has no use for:
 * carrying the referenced Pipelines but not their Phases is a coherent thing to
 * want when the Phases are already shared and only the composition is being
 * moved.
 */
export type WorkflowExportInclusion =
  /** No dependency payload at all. */
  | 'references-only'
  /** The directly referenced Pipelines, without their Phases. */
  | 'include-pipelines'
  /** Those Pipelines plus their transitive Phases. */
  | 'include-closure';

/**
 * A discriminated union rather than an optional field: a Phase has no
 * references, so the inclusion choice does not exist for it. Encoding that in
 * the type beats documenting it in a comment.
 *
 * Feature 086 adds the third arm on the same principle — a Pipeline has one
 * level of dependency and a Workflow has two, so they do not share an inclusion
 * type and no illegal kind/mode pair is constructible.
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
 * The two inclusion vocabularies as values, and the one function that decides
 * whether a kind admits a mode.
 *
 * Feature 086 (T068). The union above makes an illegal kind/mode pair
 * unrepresentable in TypeScript, but a message arriving from the webview is
 * `unknown` and both runtime gates — the published `isCmdExportProcessYaml` guard
 * and `validateExportProcessYaml` at the transport boundary — narrow it
 * structurally, with no exhaustiveness check to fail when an arm is added. 085
 * left the Pipeline vocabulary written out twice, once in each gate, so widening
 * the type to three arms compiled cleanly while leaving the Workflow arm rejected
 * at both gates and unreachable in the shipped extension.
 *
 * One function rather than two copies of a list is the fix, because the failure
 * mode was never a typo in a literal — it was a second place that had to be
 * remembered. It lives beside the union it enforces so a fourth arm changes the
 * type and its enforcement in one edit.
 *
 * A Phase is part of the same decision, not an exception to it: its arm has no
 * `inclusion` field, so the only mode it admits is the absence of one.
 */
export const PIPELINE_EXPORT_INCLUSIONS: readonly PipelineExportInclusion[] = Object.freeze([
  'references-only',
  'include-referenced'
]);

export const WORKFLOW_EXPORT_INCLUSIONS: readonly WorkflowExportInclusion[] = Object.freeze([
  'references-only',
  'include-pipelines',
  'include-closure'
]);

export function admitsExportInclusion(resourceKind: unknown, inclusion: unknown): boolean {
  if (resourceKind === 'phase') return inclusion === undefined;
  if (resourceKind === 'pipeline') {
    return PIPELINE_EXPORT_INCLUSIONS.includes(inclusion as PipelineExportInclusion);
  }
  if (resourceKind === 'workflow') {
    return WORKFLOW_EXPORT_INCLUSIONS.includes(inclusion as WorkflowExportInclusion);
  }
  if (resourceKind === 'modelCatalog') return inclusion === undefined;
  return false;
}

/**
 * Which dependency an export could not resolve (feature 086, contract §2.1).
 *
 * Feature 085 named it `unresolvedPhaseId`, because with a one-level closure the
 * only dependency an export could fail on was a Phase. A Workflow export in
 * `include-pipelines` mode fails on an unresolved PIPELINE and has no `phaseId`
 * to give, so the field has to say which catalog it means. Same shape as
 * `BlockedDependency` on the import side, and narrower than
 * `ProcessYamlResourceKind` for the same reason: nothing depends on a Workflow.
 *
 * `resourceId` is sanitized and bounded to 64 characters before it crosses the
 * boundary, like every other author-supplied string here. It is an identifier,
 * never a location — `tests/unit/contracts/process-yaml-no-paths.test.ts` is
 * what keeps that true.
 */
export interface UnresolvedDependency {
  readonly kind: 'phase' | 'pipeline';
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
