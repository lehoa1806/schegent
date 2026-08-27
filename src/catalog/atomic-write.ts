// Feature 099 (FR-R3-015) T479 — the write *order*, and the temp-name shape.
//
// There is no cross-file transaction (FR-023). A save touches two files — one new
// version record and the manifest — and a crash between them is a real state the
// store must land in on purpose rather than by accident. The order decides which
// one:
//
//   - **record, then manifest** — a crash leaves a record no manifest entry names.
//     That is a collectable record: reported, not a fault, and the definition still
//     resolves at its previous version (FR-024, FR-026).
//   - manifest, then record — a crash leaves a manifest entry naming a record that
//     is not there. That is a dangling reference, and it makes the definition
//     unreadable (FR-027).
//
// Both are recoverable and neither loses history, but only one of them leaves the
// catalog working, so the order is a correctness property and lives here, in one
// place, tested (FR-025).
//
// Note the shape of `runWriteSequence`: it stops at the first failure and reports
// the prefix that landed. It has no rollback branch, because there is no
// compensating delete on any path (FR-029) — the landed prefix stays written and
// becomes the `partial` outcome the caller reports.
//
// The `rename` itself is deliberately **not** here. `tests/lint/destructive-fs-requires-containment.test.ts`
// requires any module calling `.rename(` to import the containment oracle and prove
// containment, which would pull `node:fs` into the directory whose purity FR-058
// pins. The sequencing is pure; the rename lives in `src/host-services/catalog-fs-adapter.ts`.

import type { CatalogFsPort, StoreSegments } from './ports';

/** Written to a sibling of the target, then renamed over it. Never left behind on success. */
export const TEMP_SUFFIX = '.tmp';

/**
 * The name of the temp sibling for a file named `name`.
 *
 * A **sibling**, not a system temp directory: a rename is only atomic within one
 * filesystem, and a workspace on a different volume from the OS temp directory
 * would silently degrade to a copy. `token` is supplied by the caller rather than
 * generated here — this module is pure, and the uniqueness a concurrent writer
 * needs is the adapter's to provide.
 *
 * Leading dot so a half-written record is hidden from a casual listing of the
 * definition's directory, and paired with `isTempName` in this one module: the
 * writer and the recogniser disagreeing is how a temp file gets reported as a
 * collectable record while another window is still renaming it.
 */
export function tempNameFor(name: string, token: string): string {
  return `.${name}.${token}${TEMP_SUFFIX}`;
}

/** Is this a leftover temp file rather than a store file? Used to skip them when listing. */
export function isTempName(name: string): boolean {
  return name.endsWith(TEMP_SUFFIX);
}

export type WriteMode =
  /** Refuse if the target exists. Version records only (FR-030). */
  | 'if-absent'
  /** Replace whatever is there, atomically. `manifest.json` only (FR-002). */
  | 'replace';

export interface WriteStep {
  readonly at: StoreSegments;
  readonly contents: string;
  readonly mode: WriteMode;
  /** What landed, for the caller's `partial` report. Never a path (FR-061). */
  readonly label: string;
}

export type WriteSequenceOutcome =
  | { readonly outcome: 'written'; readonly wrote: readonly string[] }
  /** A step reported the target already exists. Nothing after it was attempted. */
  | { readonly outcome: 'exists'; readonly wrote: readonly string[]; readonly at: string }
  /**
   * A step failed. Everything before it **stays written** (FR-028).
   *
   * `wrote` is the landed prefix in order, which is what makes the caller's
   * `partial` outcome honest about what is on disk.
   */
  | { readonly outcome: 'failed'; readonly wrote: readonly string[]; readonly errno: string };

/**
 * Run steps in order, stopping at the first that does not land.
 *
 * Order is the caller's, and for a save it is record-then-manifest. Nothing is
 * undone: this function has no path that removes a file.
 */
export async function runWriteSequence(
  fs: CatalogFsPort,
  steps: readonly WriteStep[]
): Promise<WriteSequenceOutcome> {
  const wrote: string[] = [];

  for (const step of steps) {
    if (step.mode === 'if-absent') {
      const written = await fs.writeFileIfAbsent(step.at, step.contents);
      if (written.outcome === 'exists') return { outcome: 'exists', wrote, at: step.label };
      if (written.outcome === 'failed') {
        return { outcome: 'failed', wrote, errno: written.errno };
      }
    } else {
      const written = await fs.writeFileAtomic(step.at, step.contents);
      if (written.outcome === 'failed') {
        return { outcome: 'failed', wrote, errno: written.errno };
      }
    }
    wrote.push(step.label);
  }

  return { outcome: 'written', wrote };
}
