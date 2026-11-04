// Feature 084 T002 — the closed exchange format's types and constants.
//
// Two type families live here:
//
//   1. The wire form of a document (`PhaseYamlDocument` and friends). It is
//      CLOSED BY CONSTRUCTION: the parser builds it by naming each key, so a
//      key the format does not name never reaches the type. There is no index
//      signature and no `unknown` passthrough anywhere below (data-model
//      "Closed by construction", FR-001).
//   2. The preflight result (`ImportPlan`, `ImportPlanRow`, `DocumentRefusal`).
//      `src/contracts/sidebar-ipc/process-yaml.ts` re-exports these as the wire
//      contract, so the plan has exactly one definition rather than a host copy
//      and a webview copy that can drift.
//
// See specs/084-phase-yaml-exchange/data-model.md and
// specs/084-phase-yaml-exchange/contracts/phase-yaml-grammar.ebnf.

import type { PhaseCapability } from '../../contracts/phase-capabilities';
import type {
  PhaseDefinition,
  PhaseDefinitionEffort,
  PhaseEvidencePolicy,
  PhaseHostVerification,
  PhaseSideEffects,
  PhaseSourceStatus,
  RetryCapOutcome
} from '../../contracts/process-definitions';
import type { PipelineExecutionDefaults } from '../../contracts/pipeline-definitions';
import type {
  WorkflowBinding,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowOutputPort,
  WorkflowSourceStatus
} from '../../contracts/workflow-definitions';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';

/** The only `apiVersion` this format admits (FR-002). */
export const PHASE_YAML_API_VERSION = 'schegent/v1';

/** The only `kind` the Phase exchange format admits (FR-002). */
export const PHASE_YAML_KIND = 'Phase';

/** Decoded-text bound, checked BEFORE the scanner is entered (FR-011). */
export const PHASE_YAML_MAX_BYTES = 1048576;

/** One indent level. The format admits no other step (grammar "Layout"). */
export const PHASE_YAML_INDENT = '  ';

/**
 * Which catalog kind an exchange operation addresses.
 *
 * Feature 263 (FR-R5-F04) — `'pipeline'` is retired from the exchange format;
 * a composable Workflow package carries child Workflows and Phases directly.
 */
export type ProcessYamlResourceKind = 'phase' | 'workflow' | 'modelCatalog';

/**
 * Every resource kind, as a runtime list (feature 254, FR-041, V2; research R24).
 *
 * The union above cannot be iterated, and a check that must visit every kind needs a list to visit. Kept
 * beside the union and held equal to it at compile time: a kind added to one and not the other fails
 * `typecheck`, naming the mismatch. `undispatchedKinds` (`src/headless/process-yaml-api.ts`) and the
 * coverage gate (`tests/lint/process-yaml-coverage-seams.test.ts`) read it.
 */
export const PROCESS_YAML_RESOURCE_KINDS = ['phase', 'workflow', 'modelCatalog'] as const;

type KindListEquality<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compile-time only: `never` (an error) unless the list and the union hold the same members. */
export type ProcessYamlResourceKindListIsComplete = KindListEquality<
  (typeof PROCESS_YAML_RESOURCE_KINDS)[number],
  ProcessYamlResourceKind
> extends true
  ? true
  : never;

/** Assigning `true` here fails to compile when the list and the union drift apart. */
export const PROCESS_YAML_RESOURCE_KIND_LIST_COMPLETE: ProcessYamlResourceKindListIsComplete = true;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface PhaseYamlMetadata {
  readonly phaseId: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
}

interface PhaseYamlSpecBase {
  // The document carries text, but these fields are only ever populated from
  // the catalog's own enums — by the mapper on the way out and by the
  // validator on the way in. Typing them as `string` here would push a cast
  // into both directions of the mapper for no gain (FR-008).
  readonly runner?: BackendRunnerKind;
  /**
   * Feature 098 — the containment class the Phase's author declared. Optional in
   * the format and absent when undeclared, because the FR-005 default belongs to
   * the run-time freeze; writing a resolved value here would make an omission
   * indistinguishable from a declaration on the way back out.
   */
  readonly sideEffects?: PhaseSideEffects;
  /** Feature 098 — the evidence policy the author declared. Same optionality rule. */
  readonly evidencePolicy?: PhaseEvidencePolicy;
  /** FR-R3-058 — the second evidence axis; see `PhaseHostVerification`. */
  readonly hostVerification?: PhaseHostVerification;
  /**
   * FR-R3-086 — the declared capability set, carried through the exchange
   * format. Without it a narrowed phase round-tripped through YAML comes back
   * UNBOUNDED, which is a silent widening of a bound the operator approved.
   */
  readonly capabilities?: readonly PhaseCapability[];
  readonly model?: string;
  readonly effort?: PhaseDefinitionEffort;
  readonly timeoutSeconds?: number;
  /** FR-R3-112 — the per-phase spend bound, in USD. */
  readonly spendBoundUsd?: number;
  /** FR-R3-112 — the same bound in tokens, for backends that report no cost. */
  readonly spendBoundTokens?: number;
  readonly loopable?: boolean;
  readonly isRequired?: boolean;
  readonly forceContinueOnRetryCap?: boolean;
  /**
   * FR-R3-157 — the three-valued cap outcome that supersedes the boolean above.
   * Both may appear on one phase: this format carries what the author wrote,
   * and precedence between them is decided in exactly one place
   * (`contracts/retry-cap-outcome.ts`), never here.
   */
  readonly onRetryCap?: RetryCapOutcome;
  /** Inert text. This feature never parses, evaluates, or rewrites it (FR-012). */
  readonly retryCondition?: string;
}

export interface InstructionPhaseYamlSpec extends PhaseYamlSpecBase {
  readonly instruction: string;
  readonly skill?: never;
}

export interface SkillPhaseYamlSpec extends PhaseYamlSpecBase {
  readonly instruction?: never;
  /** A plain reference. Never resolved, inlined, or checked (FR-007). */
  readonly skill: string;
}

export type PhaseYamlSpec = InstructionPhaseYamlSpec | SkillPhaseYamlSpec;

export interface PhaseYamlDocument {
  readonly apiVersion: typeof PHASE_YAML_API_VERSION;
  readonly kind: typeof PHASE_YAML_KIND;
  readonly metadata: PhaseYamlMetadata;
  readonly spec: PhaseYamlSpec;
}

/**
 * Feature 085 T025 — a Phase document without its root declarations.
 *
 * Derived from `PhaseYamlDocument` rather than declared beside it, because
 * FR-008 says an included Phase carries the *same* `metadata` and `spec`
 * mappings the single-Phase document defines. A second declaration of those two
 * would be a thing that drifts, and the drift would only show up as a package
 * whose Phases no longer round-trip through the single-Phase reader.
 */
export type PhaseYamlDocumentBody = Omit<PhaseYamlDocument, 'apiVersion' | 'kind'>;

// ---------------------------------------------------------------------------
// Workflow package document — feature 263 (FR-R5-F04)
// ---------------------------------------------------------------------------

/** The only `kind` the Workflow package format admits (FR-R5-F04). */
export const WORKFLOW_YAML_KIND = 'Workflow';

/**
 * The root or included Workflow's identity.
 *
 * `id` rather than `workflowId`: the document already declares what it is
 * under `kind`. That rename is the ONLY one the mapping performs.
 *
 * `version` is required in both directions and is never defaulted on read
 * (FR-003a) — a document that omits it is malformed, not one that meant 1.
 */
export interface WorkflowYamlMetadata {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
}

/**
 * The Workflow's authored body, field for field from `WorkflowDefinition`
 * (FR-R5-F01, FR-R5-F04).
 *
 * List-typed fields that may be empty (`inputs`, `outputs`, `connections`,
 * `bindings`, `recommendedNext`) are omitted from the emitted bytes when empty,
 * and absent keys read back as `undefined` (or `[]` for `connections`).
 * `nodes` and `startNodeIds` are required and non-empty in both directions.
 */
export interface WorkflowYamlSpec {
  readonly inputs?: readonly WorkflowInputPort[];
  readonly outputs?: readonly WorkflowOutputPort[];
  readonly nodes: readonly WorkflowNode[];
  readonly connections: readonly WorkflowConnection[];
  readonly bindings?: readonly WorkflowBinding[];
  readonly startNodeIds: readonly string[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}

/**
 * A Workflow document without its root declarations (`apiVersion`, `kind`,
 * `included`), carried inside `included.workflows`.
 */
export type WorkflowYamlDocumentBody = Omit<
  WorkflowYamlDocument,
  'apiVersion' | 'kind' | 'included'
>;

/**
 * The optional flat dependency payload on a `kind: Workflow` package
 * (FR-R5-F04).
 *
 * Carries transitive child Workflows (`workflows`, in first-encountered
 * pre-order depth-first order) and referenced Phases (`phases`, in
 * first-encountered order across the root Workflow and `included.workflows`).
 * Neither key is ever emitted as an empty list.
 */
export interface WorkflowYamlIncluded {
  readonly workflows?: readonly WorkflowYamlDocumentBody[];
  readonly phases?: readonly PhaseYamlDocumentBody[];
}

/**
 * A Workflow package document.
 *
 * `included` is present only when the operator asked for `include-closure` AND
 * every referenced dependency resolved — a partial `included` is never written.
 * It is absent, not empty, for a `references-only` export.
 */
export interface WorkflowYamlDocument {
  readonly apiVersion: typeof PHASE_YAML_API_VERSION;
  readonly kind: typeof WORKFLOW_YAML_KIND;
  readonly metadata: WorkflowYamlMetadata;
  readonly spec: WorkflowYamlSpec;
  readonly included?: WorkflowYamlIncluded;
}

// ---------------------------------------------------------------------------
// Model Catalog document — feature 096
// ---------------------------------------------------------------------------

export const MODEL_CATALOG_YAML_KIND = 'ModelCatalog';

// FR-R3-128 (T1485) — `MODEL_ID_MAX_LEN` moved to `src/contracts/pipeline-definitions.ts`,
// beside `PIPELINE_ID_MAX_LEN`. It was imported from here by
// `src/contracts/sidebar-ipc/process-yaml.ts`, which `dependency-direction.test.ts`
// carried as a dated exception; a bound is contract-shaped. Re-exported below so
// this module's own consumers are unchanged, and re-exported rather than copied.
export { MODEL_ID_MAX_LEN } from '../../contracts/pipeline-definitions';

/**
 * One backend's group in a Model Catalog document (data-model.md §2).
 *
 * `models` is omitted, never `[]`, when the backend has no custom models —
 * the same absent-not-empty convention every other list in this file follows
 * (research R3). `backend` is carried opaquely at this layer: an unrecognized
 * value is not a parse-time defect, it is a per-row import-planner decision
 * (`ModelCatalogSkipRow` with `reason: 'unrecognized-backend'`).
 */
export interface ModelCatalogYamlGroup {
  readonly backend: string;
  readonly models?: readonly string[];
}

/**
 * A Model Catalog document. Unlike Phase/Pipeline/Workflow, there is no
 * `metadata` and no `included` — Model Catalog has one writable layer and no
 * cross-catalog references (FR-015), so neither concept applies.
 */
export interface ModelCatalogYamlDocument {
  readonly apiVersion: typeof PHASE_YAML_API_VERSION;
  readonly kind: typeof MODEL_CATALOG_YAML_KIND;
  readonly groups: readonly ModelCatalogYamlGroup[];
}

// ---------------------------------------------------------------------------
// Parse tree — the only shapes the closed subset can produce
// ---------------------------------------------------------------------------

/**
 * A scalar as it appeared in the source. `quoted` is true for the forms whose
 * source shape fixes them as text (double-quoted, block literal), so the
 * validator must not read them as a number or a boolean. This is what "no
 * implicit typing" means in practice (grammar "Scalars").
 */
export interface YamlScalarNode {
  readonly kind: 'scalar';
  readonly value: string;
  readonly quoted: boolean;
  readonly line: number;
}

export interface YamlMappingEntry {
  readonly key: string;
  readonly value: YamlNode;
  readonly line: number;
}

export interface YamlMappingNode {
  readonly kind: 'mapping';
  readonly entries: readonly YamlMappingEntry[];
  readonly line: number;
}

/**
 * Feature 085 T003 — the one production the closed subset gained.
 *
 * `items` is never empty: an empty list is not representable, because `key:`
 * with nothing under it reads back as an empty MAPPING. The serializer omits
 * the key instead, and a list-typed field reads an absent key as `[]`
 * (research R3). A sequence node therefore exists only where at least one entry
 * was read.
 *
 * Items are homogeneous in nothing. The grammar admits a list of scalars and a
 * list of mappings and does not require a list to be one or the other; deciding
 * which a given field wants is the validator's job, not the reader's.
 */
export interface YamlSequenceNode {
  readonly kind: 'sequence';
  readonly items: readonly YamlNode[];
  readonly line: number;
}

export type YamlNode = YamlScalarNode | YamlMappingNode | YamlSequenceNode;

// ---------------------------------------------------------------------------
// Refusals and plan
// ---------------------------------------------------------------------------

export type DocumentRefusalCode =
  /** Not valid UTF-8, or a leading byte-order mark. Never repaired. */
  | 'unreadable'
  /** Over PHASE_YAML_MAX_BYTES decoded, refused before parsing. */
  | 'too-large'
  /** `apiVersion` absent or not PHASE_YAML_API_VERSION. */
  | 'unsupported-version'
  /** `kind` absent or not the requested kind. */
  | 'unsupported-kind'
  /** Anchor, alias, merge key, tag, directive, flow collection, sequence, tab. */
  | 'disallowed-syntax'
  /** A second document start, an end marker, or a sequence of resources. */
  | 'multi-document'
  /**
   * Two resources of one package declare the same id (FR-031).
   *
   * Document-level rather than per-resource: naming one of the two the defect
   * would be choosing which the author meant, and the document does not say.
   */
  | 'duplicate-id'
  /**
   * A declared Workflow's node graph contains a cycle (feature 086, FR-023
   * family; data-model.md §4.4).
   *
   * Document-level rather than a row outcome, like every refusal above it: a
   * cycle is a property of the graph, so there is no one node to name as the
   * defect, and with ancestry undefined the rest of the plan cannot be computed
   * either. The detector is `validateCycles` in
   * `src/config/workflow-graph-validator.ts` — the same one the save gate runs,
   * reused rather than reimplemented so the two can never disagree.
   */
  | 'graph-cycle'
  /** No resource declared. */
  | 'empty';

/** A document-level refusal. No partial plan is ever produced with it (FR-027). */
export interface DocumentRefusal {
  readonly code: DocumentRefusalCode;
  /** Sanitized and bounded before it crosses the IPC boundary. */
  readonly message: string;
}

export interface ImportDefect {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** The closed outcome set a planned resource can land in (FR-025). */
export type ImportPlanOutcome = 'import' | 'skip' | 'blocked' | 'invalid';

/**
 * Which resource a blocked row is waiting on (FR-R5-F04).
 *
 * A composable Workflow node references either a Phase (`kind: 'phase'`) or a
 * child Workflow (`kind: 'workflow'`).
 */
export interface BlockedDependency {
  readonly kind: 'phase' | 'workflow';
  readonly resourceId: string;
}

/**
 * Feature 085 T014 (FR-030c) — the ways a well-formed resource's dependency
 * fails to resolve. The distinction is what the operator acts on: an absent
 * dependency needs supplying, an unresolvable one needs repairing, and a blocked
 * one needs neither because the fault is one level further down.
 *
 * Feature 086 T004 / Feature 263 (FR-R5-F04) — with a multi-level Workflow
 * closure a blocked row is not always a root cause: a parent Workflow can be
 * well-formed, name a child Workflow that exists in the package, and still be
 * unable to import because that child Workflow is itself blocked on a missing
 * Phase or deeper child Workflow. `via` names the root-cause dependency so the
 * operator can walk from what they selected to what is actually wrong.
 *
 * One reason per row, as before: a row reports a status, not a defect list —
 * `invalid` is the outcome that enumerates. When several dependencies fail, the
 * reason names the first in authored reference order.
 */
export type BlockedReason =
  /** Not published (absent, or held only as a draft) and not supplied by this document. */
  | { readonly code: 'dependency-absent'; readonly dependency: BlockedDependency }
  /** A stored row claims the id, but it is not EFFECTIVE — shadowed or invalid. */
  | { readonly code: 'dependency-unresolvable'; readonly dependency: BlockedDependency }
  /** The dependency resolves, but is itself blocked. Propagated, not root cause. */
  | {
      readonly code: 'dependency-blocked';
      readonly dependency: BlockedDependency;
      readonly via: BlockedDependency;
    };

/**
 * The statuses a presence scan can report. Both store-backed catalogs (`Phase`
 * and `Workflow`) use the same status vocabulary.
 *
 * Feature 099 (T490, FR-049) — `ProcessYamlPresenceScope` is gone with it. It
 * named which of `built-in`/`user`/`workspace` already held the id. There is one
 * layer, so the answer would be the same on every skip row, and the presence
 * *property* is unchanged: a scan of stored rows at every status, never the
 * effective catalog.
 */
export type ProcessYamlPresenceStatus =
  | PhaseSourceStatus
  | WorkflowSourceStatus
  /**
   * Feature 100 (FR-R3-016) T512 — a definition that exists only as an
   * unpublished draft (FR-043).
   *
   * A fourth member rather than a reuse of `invalid`: the `SourceStatus`
   * unions describe a row the resolver saw, and a draft-only entry produces no
   * row at all — its body is not active, so `storedRows` skips it and the
   * effective catalog does not contain it (FR-007). It is nonetheless a claim on
   * its id, and the strongest one there is: an operator is mid-way through
   * authoring it. Reporting it as `invalid` would tell them their draft is
   * broken; reporting nothing would let the import overwrite it (FR-044).
   */
  | 'draft';

/**
 * The definition an import row carries, verbatim, keyed by the row's kind
 * (FR-029a/b).
 *
 * The plan carries it because the commit is a `CMD_PUBLISH_PACKAGE` sent by the
 * webview (research R2) and the host retains
 * nothing past the single read that produced this plan (FR-031). The
 * alternatives were a host-side cache between preflight and commit, which is the
 * thing FR-031 forbids, and a second read at commit, which is a second dialog
 * and a window in which the file can change under the operator.
 *
 * Deliberately NOT sanitized or length-bounded, unlike every other string on the
 * row: FR-046a forbids rewriting a declared value, and the caps the displayed
 * fields use would truncate an `instruction`. Nothing renders this field — it is
 * forwarded to the save command, whose own validator is the gate, and which the
 * webview can already reach through the catalog managers. So round-tripping it
 * grants no authority the webview did not already have.
 */
/**
 * A Model Catalog import row (feature 096, data-model.md "ImportPlanRow — new
 * arms"). Not a generic `resourceKind: ProcessYamlResourceKind` shape: there is
 * no `PhaseDefinition`/`WorkflowDefinition` analog for a
 * model id, so `backend` + `modelId` stand in for `definition`.
 */
export interface ModelCatalogImportRow {
  readonly outcome: 'import';
  readonly resourceKind: 'modelCatalog';
  /** The model id itself. */
  readonly resourceId: string;
  /** As authored in the document — opaque at this layer. */
  readonly backend: string;
  readonly modelId: string;
}

/**
 * A Model Catalog skip row. A distinct arm rather than a reuse of the generic
 * `skip` arm below: `presentRowStatus` describes a stored row the catalog already
 * holds, and the Model Catalog holds no stored rows — its two skip reasons are
 * `already-exists` (FR-011) and `unrecognized-backend` (FR-013), not a presence
 * status.
 */
export interface ModelCatalogSkipRow {
  readonly outcome: 'skip';
  readonly resourceKind: 'modelCatalog';
  readonly resourceId: string;
  readonly backend: string;
  readonly modelId: string;
  readonly reason: 'already-exists' | 'unrecognized-backend';
}

export type ImportPlanRow =
  | {
      readonly outcome: 'import';
      readonly resourceKind: 'phase';
      readonly resourceId: string;
      readonly name: string;
      /** Advisory only. The gate is re-evaluated at commit time (FR-012a). */
      readonly requiresRetryConditionCapability: boolean;
      readonly definition: PhaseDefinition;
    }
  | {
      readonly outcome: 'import';
      readonly resourceKind: 'workflow';
      readonly resourceId: string;
      readonly name: string;
      readonly definition: WorkflowDefinition;
    }
  | ModelCatalogImportRow
  | {
      readonly outcome: 'skip';
      /**
       * Excludes 'modelCatalog' deliberately: `ModelCatalogSkipRow` below
       * carries that kind instead, with a disjoint field set
       * (`backend`/`modelId`/`reason` vs. `name`/`presentRowStatus`).
       * Widening this to the full `ProcessYamlResourceKind` would make the two
       * arms structurally overlap on `{outcome: 'skip', resourceKind:
       * 'modelCatalog'}`, and a reader narrowing on `resourceKind` alone could
       * no longer tell which field set it holds.
       */
      readonly resourceKind: 'phase' | 'workflow';
      readonly resourceId: string;
      readonly name: string;
      readonly presentRowStatus: ProcessYamlPresenceStatus;
    }
  | ModelCatalogSkipRow
  | {
      /**
       * The resource itself is well-formed; only its dependencies fail (FR-033).
       * Distinct from `invalid`, which means the resource is defective.
       */
      readonly outcome: 'blocked';
      readonly resourceKind: ProcessYamlResourceKind;
      readonly resourceId: string;
      readonly name: string;
      readonly reason: BlockedReason;
    }
  | {
      readonly outcome: 'invalid';
      readonly resourceKind: ProcessYamlResourceKind;
      readonly resourceId: string | null;
      /**
       * Bounded before it crosses the IPC boundary. `totalDefects` is the count
       * BEFORE that cap, so a document with more defects than the boundary
       * carries says so rather than looking like it had exactly the cap.
       */
      readonly defects: readonly ImportDefect[];
      readonly totalDefects: number;
    };

/**
 * The revision a plan was computed against, per kind.
 *
 * Feature 099 (T490, FR-043, FR-044) — was one revision per writable target,
 * because the operator chose the scope *after* preflight and a single revision
 * could not gate a choice not yet made. There is one target, so the plan records
 * the one revision the store reported when the preview was computed.
 */
export type ProcessYamlCatalogRevision = string;

/** One count per outcome. The four sum to `rows.length` (FR-028). */
export interface ImportPlanCounts {
  readonly import: number;
  readonly skip: number;
  readonly blocked: number;
  readonly invalid: number;
}

export interface ImportPlan {
  /** One row per declared resource, always a list (FR-022, FR-024). */
  readonly rows: readonly ImportPlanRow[];
  readonly counts: ImportPlanCounts;
  /** Phase catalog. Always present — every plan can write Phases. */
  readonly computedAgainstRevision: ProcessYamlCatalogRevision;
  /**
   * Workflow catalog (feature 086, FR-036; feature 263, FR-R5-F04). Present
   * exactly when the document declared a Workflow.
   *
   * A second field rather than a second use of the first: the Phase and
   * Workflow catalogs are independently mutable, so one revision cannot gate
   * both, and a confirmed package carries a layer per kind, each with its own
   * expected revision.
   */
  readonly computedAgainstWorkflowRevision?: ProcessYamlCatalogRevision;
  /**
   * Model Catalog (feature 096). Present exactly when the document declared a
   * `ModelCatalog`. Its own field rather than a reuse of the two above:
   * the Model Catalog is not in the store (FR-056), so its revision comes from a
   * different authority.
   */
  readonly computedAgainstModelsRevision?: string;
}

/** Errors are values throughout this module. Nothing here throws. */
export type ParseDocumentResult =
  | { readonly ok: true; readonly node: YamlMappingNode }
  | { readonly ok: false; readonly refusal: DocumentRefusal };
