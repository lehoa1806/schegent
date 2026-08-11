// Feature 087 — what a composed Run records about its declared outputs.
//
// The governing rule is FR-040a: a recorded output is a reference to where the
// artifact IS, never a copy of what it contains. Run state is not a document
// store, and copying content into it would put operator business documents into
// a record that other subsystems project, log, and persist.

export const RUN_OUTPUT_STATUSES = ['resolved', 'unresolved'] as const;
export type RunOutputStatus = (typeof RUN_OUTPUT_STATUSES)[number];

/**
 * One declared output port's result.
 *
 * An `unresolved` entry is recorded rather than dropped (FR-042): a declared
 * output the Phases never produced is information the operator needs, and it
 * does not by itself change the Run's terminal status.
 */
export interface RunOutputRecord {
  readonly name: string;
  readonly status: RunOutputStatus;
  /** Workspace-relative location. Absent when `status` is `unresolved`. */
  readonly reference?: string;
}

export function isRunOutputStatus(value: unknown): value is RunOutputStatus {
  return typeof value === 'string' && (RUN_OUTPUT_STATUSES as readonly string[]).includes(value);
}
