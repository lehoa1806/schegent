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

import type {
  PhaseDefinition,
  PhaseDefinitionEffort,
  PhaseDefinitionScope,
  PhaseSourceStatus
} from '../../contracts/process-definitions';
import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineDefinitionScope,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort,
  PipelineSourceStatus
} from '../../contracts/pipeline-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowDefinitionScope,
  WorkflowNode,
  WorkflowSourceStatus
} from '../../contracts/workflow-definitions';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';

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
 * Feature 085 T013 — `'pipeline'` joins `'phase'`. A single document may declare
 * resources of both kinds, so this is a property of a plan ROW rather than of
 * the request that produced it (FR-055a).
 *
 * Feature 086 T004 — `'workflow'` joins them, and the closure it heads is the
 * first that is two levels deep: a Workflow depends on Pipelines, which depend
 * on Phases (data-model.md §3.1).
 */
export type ProcessYamlResourceKind = 'phase' | 'pipeline' | 'workflow';

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
  // The document carries text, but these two fields are only ever populated
  // from the catalog's own enums — by the mapper on the way out and by the
  // validator on the way in. Typing them as `string` here would push a cast
  // into both directions of the mapper for no gain (FR-008).
  readonly runner?: BackendRunnerKind;
  readonly model?: string;
  readonly effort?: PhaseDefinitionEffort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly isRequired?: boolean;
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
// Package document — feature 085 (data-model.md §2)
// ---------------------------------------------------------------------------

/** The only `kind` the Pipeline package format admits (FR-002, FR-055a). */
export const PIPELINE_YAML_KIND = 'Pipeline';

/**
 * The root Pipeline's identity. `id` rather than `pipelineId`: the document
 * already declares what it is under `kind`, so the key does not repeat it
 * (data-model.md §2.2). That rename is the ONLY one the mapping performs.
 */
export interface PipelineYamlMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
}

/**
 * The root Pipeline's authored body, field for field from the shipped
 * `PipelineDefinition` (research R4). The port, binding, and defaults shapes are
 * the catalog's own types rather than copies — a second declaration of the same
 * shape is a thing that drifts, and the round trip is what would break.
 *
 * The three list-typed fields are always present here and may be empty; export
 * omits an empty one from the bytes and import reads an absent key as `[]`
 * (data-model.md §2.5).
 */
export interface PipelineYamlSpec {
  /** Order is authoritative and a repeat is meaningful (FR-019). */
  readonly phaseIds: readonly string[];
  readonly inputs: readonly PipelineInputPort[];
  readonly outputs: readonly PipelineOutputPort[];
  readonly bindings: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext: readonly string[];
}

/**
 * The optional dependency payload (data-model.md §2.4, FR-015).
 *
 * A mapping with one key rather than a bare list, so a later dependency class
 * is an added key here instead of a change to what `included` means.
 *
 * `phases` is never empty. A references-only document omits `included` entirely
 * (FR-013), and a present-but-childless key would read back as an empty mapping
 * — the same round-trip hazard as an empty list (research R3).
 */
export interface PipelineYamlIncluded {
  readonly phases: readonly PhaseYamlDocumentBody[];
}

export interface PipelineYamlDocument {
  readonly apiVersion: typeof PHASE_YAML_API_VERSION;
  readonly kind: typeof PIPELINE_YAML_KIND;
  readonly metadata: PipelineYamlMetadata;
  readonly spec: PipelineYamlSpec;
  /**
   * Absent for a references-only export (FR-013). Present only when the
   * operator asked for dependency inclusion AND every referenced Phase resolved
   * — a partial `included` is never written (FR-017).
   */
  readonly included?: PipelineYamlIncluded;
}

/**
 * Feature 086 T022 — a Pipeline document without its root declarations.
 *
 * Derived from `PipelineYamlDocument` for the reason `PhaseYamlDocumentBody` is:
 * FR-008 says an included Pipeline carries the *same* `metadata` and `spec`
 * mappings the single-Pipeline document defines, and a second declaration of
 * those two is a thing that drifts.
 *
 * `included` is omitted as well as the two declarations, because the payload does
 * not nest. A Workflow package's `included` is flat and names both dependency
 * classes itself, so a Pipeline inside one has no dependencies of its own to
 * carry — and a nested `included` would put the same Phase at two depths with no
 * rule for which one wins on read.
 */
export type PipelineYamlDocumentBody = Omit<
  PipelineYamlDocument,
  'apiVersion' | 'kind' | 'included'
>;

/** The only `kind` the Workflow package format admits (feature 086, FR-002). */
export const WORKFLOW_YAML_KIND = 'Workflow';

/**
 * The root Workflow's identity (feature 086 data-model.md §2.2).
 *
 * `id` rather than `workflowId`, for the same reason the Pipeline document
 * renames: the document already declares what it is under `kind`. That rename is
 * the ONLY one the mapping performs.
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
 * The root Workflow's authored body, field for field from the shipped
 * `WorkflowDefinition` (data-model.md §2.3). The node and connection shapes are
 * the catalog's own types rather than copies — a second declaration of the same
 * shape is a thing that drifts, and the round trip is what would break.
 *
 * `connections` is always present here and may be empty; export omits an empty
 * one from the bytes and import reads an absent key as `[]` (data-model.md §2.5).
 * `nodes` and `startNodeIds` are exempt from that rule in both directions: a
 * Workflow with neither is not a Workflow, so their absence is a defect rather
 * than an emptiness.
 *
 * There is deliberately no `inputs` and no `outputs`. A Workflow's ports are the
 * unbound ports of its nodes' Pipelines, derived on read and never stored, so a
 * serialized copy would be a second source of truth that goes stale the moment a
 * node's Pipeline changes shape (FR-012, and the standing hard rule).
 */
export interface WorkflowYamlSpec {
  readonly nodes: readonly WorkflowNode[];
  readonly connections: readonly WorkflowConnection[];
  readonly startNodeIds: readonly string[];
}

/**
 * The optional dependency payload (feature 086 data-model.md §2.4, FR-015).
 *
 * Two keys rather than one, because a Workflow has two dependency classes and the
 * operator can ask for the first without the second (FR-017 vs FR-019). The
 * payload is FLAT: a Phase is named here, never nested inside the Pipeline that
 * references it, so no Phase can appear at two depths with no rule for which one
 * wins on read.
 *
 * Neither key is ever empty. A references-only document omits `included` entirely
 * (FR-015), and a present-but-childless key would read back as an empty mapping —
 * the same round-trip hazard as an empty list (research R3). `phases` is absent
 * rather than empty in the `include-pipelines` mode, which is what makes the two
 * inclusion modes distinguishable in the bytes.
 */
export interface WorkflowYamlIncluded {
  readonly pipelines: readonly PipelineYamlDocumentBody[];
  readonly phases?: readonly PhaseYamlDocumentBody[];
}

/**
 * A Workflow package document.
 *
 * `included` is present only when the operator asked for dependency inclusion AND
 * every referenced dependency resolved — a partial `included` is never written
 * (FR-022). It is absent, not empty, for a references-only export (FR-015).
 */
export interface WorkflowYamlDocument {
  readonly apiVersion: typeof PHASE_YAML_API_VERSION;
  readonly kind: typeof WORKFLOW_YAML_KIND;
  readonly metadata: WorkflowYamlMetadata;
  readonly spec: WorkflowYamlSpec;
  readonly included?: WorkflowYamlIncluded;
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
 * Which resource a blocked row is waiting on (feature 086 T004,
 * data-model.md §3.3).
 *
 * Feature 085 named the dependency `phaseId`, because with a one-level closure
 * a blocked resource was always a Pipeline waiting on a Phase. A Workflow
 * blocked by an unresolvable PIPELINE has no `phaseId` to put there, so the
 * dependency has to say which catalog it belongs to. `kind` is deliberately
 * narrower than `ProcessYamlResourceKind`: nothing depends on a Workflow, so
 * `'workflow'` is not a value a dependency can take.
 */
export interface BlockedDependency {
  readonly kind: 'phase' | 'pipeline';
  readonly resourceId: string;
}

/**
 * Feature 085 T014 (FR-030c) — the ways a well-formed resource's dependency
 * fails to resolve. The distinction is what the operator acts on: an absent
 * dependency needs supplying, an unresolvable one needs repairing, and a blocked
 * one needs neither because the fault is one level further down.
 *
 * Feature 086 T004 adds that third arm. With a two-level closure a blocked row
 * is no longer always a root cause: a Workflow can be well-formed, name a
 * Pipeline that exists, and still be unable to import because that Pipeline is
 * itself blocked on a missing Phase. `via` names the intermediate so the
 * operator can walk from what they selected to what is actually wrong (FR-040).
 *
 * One reason per row, as before: a row reports a status, not a defect list —
 * `invalid` is the outcome that enumerates. When several dependencies fail, the
 * reason names the first in authored reference order.
 */
export type BlockedReason =
  /** In no catalog layer, and not supplied by this document. */
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
 * The scopes and statuses a presence scan can report. All three catalogs use the
 * same three of each; the union is written out so a row's `resourceKind` and its
 * presence fields cannot silently disagree about which catalog was scanned.
 */
export type ProcessYamlPresenceScope =
  | PhaseDefinitionScope
  | PipelineDefinitionScope
  | WorkflowDefinitionScope;
export type ProcessYamlPresenceStatus =
  | PhaseSourceStatus
  | PipelineSourceStatus
  | WorkflowSourceStatus;

/**
 * The definition an import row carries, verbatim, keyed by the row's kind
 * (FR-029a/b).
 *
 * The plan carries it because the commit is a `CMD_SAVE_PHASES` /
 * `CMD_SAVE_PIPELINES` sent by the webview (research R2) and the host retains
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
      readonly resourceKind: 'pipeline';
      readonly resourceId: string;
      readonly name: string;
      readonly definition: PipelineDefinition;
    }
  | {
      readonly outcome: 'import';
      readonly resourceKind: 'workflow';
      readonly resourceId: string;
      readonly name: string;
      readonly definition: WorkflowDefinition;
    }
  | {
      readonly outcome: 'skip';
      readonly resourceKind: ProcessYamlResourceKind;
      readonly resourceId: string;
      readonly name: string;
      readonly presentIn: ProcessYamlPresenceScope;
      readonly presentRowStatus: ProcessYamlPresenceStatus;
    }
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
 * One revision per writable target. The operator may still choose the scope
 * after preflight, so recording a single revision would leave the staleness
 * gate unable to fire for whichever scope they actually pick (FR-033).
 */
export interface ProcessYamlLayerRevisions {
  readonly user: string;
  readonly workspace: string;
}

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
  readonly computedAgainstRevision: ProcessYamlLayerRevisions;
  /**
   * Pipeline catalog (feature 085, FR-043). Present exactly when the document
   * declared a Pipeline, which is the only case a Pipeline layer is written.
   *
   * A second field rather than a second use of the first: the two layers are
   * independently mutable, so one revision cannot gate both, and a confirmed
   * package is two ordered writes each carrying its OWN expected revision. It is
   * carried on the plan rather than read live at confirm time because FR-040 is
   * about the catalog the operator's PREVIEW described — reading the current
   * revision at the moment of the write would make the gate unable to fire.
   */
  readonly computedAgainstPipelineRevision?: ProcessYamlLayerRevisions;
  /**
   * Workflow catalog (feature 086, FR-036). Present exactly when the document
   * declared a Workflow.
   *
   * A third field for the same reason there is a second: three independently
   * mutable layers cannot share one gate, and a confirmed package is three
   * ordered writes each carrying its own expected revision (data-model.md §3.4).
   */
  readonly computedAgainstWorkflowRevision?: ProcessYamlLayerRevisions;
}

/** Errors are values throughout this module. Nothing here throws. */
export type ParseDocumentResult =
  | { readonly ok: true; readonly node: YamlMappingNode }
  | { readonly ok: false; readonly refusal: DocumentRefusal };
