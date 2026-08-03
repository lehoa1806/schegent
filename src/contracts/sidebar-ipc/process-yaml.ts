// Feature 084 T021 — the Phase exchange wire contract.
//
// Governing invariant (FR-019, FR-020a, SC-016): no filesystem location
// appears in any message in either direction. The webview never supplies one
// to read or write, and is never told which one the host used. The host opens
// its own dialog. `tests/unit/contracts/process-yaml-no-paths.test.ts` asserts
// this by inspecting this module's type text, so a field added here that names
// a location fails that test rather than shipping.
//
// See specs/084-phase-yaml-exchange/contracts/process-yaml-ipc.md.

import type {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CommandBase
} from '../sidebar-ipc';
import type {
  DocumentRefusal,
  ImportPlan,
  ProcessYamlResourceKind
} from '../../services/process-yaml/types';

// The plan types have exactly one definition, in the service module that also
// produces them, rather than a host copy and a webview copy that can drift.
export type {
  ProcessYamlResourceKind,
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  ProcessYamlLayerRevisions
} from '../../services/process-yaml/types';

export interface ExportProcessYamlRequest {
  readonly resourceKind: ProcessYamlResourceKind;
  /** The id to export. Read from the EFFECTIVE catalog (FR-014). */
  readonly resourceId: string;
}

export interface ExportProcessYamlCommand
  extends CommandBase<typeof CMD_EXPORT_PROCESS_YAML> {
  readonly payload: ExportProcessYamlRequest;
}

/**
 * `'saved'` deliberately reports nothing about where the document went
 * (FR-019). Overwrite consent belongs to the host's own save dialog, so export
 * registers no `useConfirm` action key (FR-018).
 *
 * `'unavailable'` separates the two ways an id can fail to produce a document:
 * `'not-found'` — no row carries that id in any layer; `'does-not-resolve'` —
 * a row exists but the effective catalog has no valid definition for it
 * (FR-015).
 */
export type ExportProcessYamlResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'canceled' }
  | { readonly outcome: 'unavailable'; readonly reason: 'does-not-resolve' | 'not-found' }
  | { readonly outcome: 'failed'; readonly message: string };

/**
 * Feature 084 T027 — preflight. No location, no bytes, no scope: the webview
 * asks what kind it is importing and nothing else, and the host opens its own
 * open dialog and does its own read (FR-020, FR-020a).
 */
export interface PreflightProcessYamlRequest {
  readonly resourceKind: ProcessYamlResourceKind;
}

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
