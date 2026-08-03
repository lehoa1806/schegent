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
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';

/** The only `apiVersion` this format admits (FR-002). */
export const PHASE_YAML_API_VERSION = 'schegent/v1';

/** The only `kind` the Phase exchange format admits (FR-002). */
export const PHASE_YAML_KIND = 'Phase';

/** Decoded-text bound, checked BEFORE the scanner is entered (FR-011). */
export const PHASE_YAML_MAX_BYTES = 1048576;

/** One indent level. The format admits no other step (grammar "Layout"). */
export const PHASE_YAML_INDENT = '  ';

/** Which catalog kind an exchange operation addresses. */
export type ProcessYamlResourceKind = 'phase';

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

export type YamlNode = YamlScalarNode | YamlMappingNode;

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

export type ImportPlanRow =
  | {
      readonly outcome: 'import';
      readonly resourceId: string;
      readonly name: string;
      /** Advisory only. The gate is re-evaluated at commit time (FR-012a). */
      readonly requiresRetryConditionCapability: boolean;
      /**
       * The definition the document declared, exactly as authored (FR-046a).
       *
       * The plan carries it because the commit is a `CMD_SAVE_PHASES` sent by
       * the webview (research R2) and the host retains nothing past the single
       * read that produced this plan (FR-031). The alternatives were a host-side
       * cache between preflight and commit, which is the thing FR-031 forbids,
       * and a second read at commit, which is a second dialog and a window in
       * which the file can change under the operator.
       *
       * Deliberately NOT sanitized or length-bounded, unlike every other string
       * on this row: FR-046a forbids rewriting a declared value, and the caps
       * the displayed fields use would truncate an `instruction`. Nothing
       * renders this field — it is forwarded to the save command, whose own
       * validator is the gate, and which the webview can already reach through
       * the Phase manager. So round-tripping it grants no authority the webview
       * did not already have.
       */
      readonly definition: PhaseDefinition;
    }
  | {
      readonly outcome: 'skip';
      readonly resourceId: string;
      readonly name: string;
      readonly presentIn: PhaseDefinitionScope;
      readonly presentRowStatus: PhaseSourceStatus;
    }
  | {
      readonly outcome: 'invalid';
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

export interface ImportPlanCounts {
  readonly import: number;
  readonly skip: number;
  readonly invalid: number;
}

export interface ImportPlan {
  /** Always a list, even though this format yields at most one row (FR-022). */
  readonly rows: readonly ImportPlanRow[];
  readonly counts: ImportPlanCounts;
  readonly computedAgainstRevision: ProcessYamlLayerRevisions;
}

/** Errors are values throughout this module. Nothing here throws. */
export type ParseDocumentResult =
  | { readonly ok: true; readonly node: YamlMappingNode }
  | { readonly ok: false; readonly refusal: DocumentRefusal };
