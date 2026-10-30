// FR-R4-F04 (FR-005, FR-006, data-model §2) — the two transport size bounds, in one place both sides read.
//
// WHY `contracts/`. The writers (`src/monitor/transport/`) enforce these and the privacy profiles
// (`src/contracts/privacy-profiles.ts`) and the retention disclosure state them. A contract is a leaf
// layer that may not value-import the monitor, so a bound the profile text is built from cannot live in
// the monitor; it lives here and the monitor imports it. A bound typed in the profile text and again in
// the writer is two bounds the first time one is edited.
//
// The per-file bound is today's shared-log bound, kept: it now bounds each Run file and each stage file.

/** Per Run file and per stage file. A record that alone passes it is replaced by a placeholder. */
export const TRANSPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Run files plus legacy generations. Staging is excluded: it is transient and removed at a Run's end. */
export const TRANSPORT_WORKSPACE_MAX_BYTES = 20 * 1024 * 1024;

const BYTES_PER_MIB = 1024 * 1024;

/** A bound in whole MiB, for text built from the constants above. */
export function transportBoundMiB(bytes: number): number {
  return bytes / BYTES_PER_MIB;
}
