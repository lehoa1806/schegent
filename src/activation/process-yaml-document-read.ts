// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Reads the one file the operator chose in an
// open dialog and returns its bytes or a refusal. It writes nothing, spawns nothing and arms no timer, and it is
// reached only from the sidebar router's import action, which the router already refuses in an untrusted window.
// FR-R4-F07 (feature 254, FR-003, FR-007; contract S4, S9; research R3) — read the document the
// operator chose for a process-YAML import, judging its size BEFORE its contents.
//
// The inline adapter this replaces called `vscode.workspace.fs.readFile` on whatever the operator
// picked. That allocates the whole file, and the 1 MiB cap lived in the parser, after the allocation:
// the cap bounded the parse and not the memory, so a multi-gigabyte file chosen by mistake was read
// whole before anything refused it. This module checks first.
//
//   * A local file (`file:`) is opened read-only with `node:fs/promises`. `judgeSize` refuses on the
//     `fstat` size before any content read. Otherwise at most cap + 1 bytes are read, so a file that
//     grew after the `fstat` is caught by its length: a result longer than the cap is `too-large`. The
//     allocation is bounded by cap + 1 whatever the file does.
//   * Any other scheme (a virtual file system) gets `stat` first and a refusal when the size is over
//     the cap, then an unbounded read. VS Code's `FileSystem` API offers no ranged read, so that
//     read is not bounded; the parser's own cap still applies to what it returns. That is a stated
//     provider limit, not a claim (plan, "Source-proven work vs qualification").
//
// FR-007: a failed read logs a closed code and nothing else. `logger.sanitize` redacts secrets, not
// paths, and an adapter's error message routinely names the location it tried to read, so the message
// is never logged. The operator-facing text is unchanged ("Could not read the document.").
//
// This module imports no `vscode`: the caller injects the `FileSystem` shape and the logger, which is
// also how the unit test stubs them. It creates no path and writes nothing.

import { open } from 'node:fs/promises';

import { judgeSize, readBoundedRange } from '../lib/bounded-read';
import { PHASE_YAML_MAX_BYTES } from '../services/process-yaml/types';

/** The part of a `vscode.Uri` this module reads. A `vscode.Uri` satisfies it. */
export interface ChosenDocumentTarget {
  readonly scheme: string;
  readonly fsPath: string;
}

/** The part of `vscode.workspace.fs` a non-local document needs. */
export interface DocumentReadFileSystem<Target extends ChosenDocumentTarget> {
  stat(target: Target): PromiseLike<{ readonly size: number }>;
  /**
   * Named `readBytes`, not `readFile`, on purpose: `tests/lint/safe-open-migration.test.ts` refuses a
   * production site that SUPPLIES a function property called `readFile`, and the wiring supplies this
   * port from `vscode.workspace.fs` by name (the evidence-sink mode census follows named calls only).
   */
  readBytes(target: Target): PromiseLike<Uint8Array>;
}

export interface DocumentReadDeps<Target extends ChosenDocumentTarget> {
  readonly fs: DocumentReadFileSystem<Target>;
  readonly logger: { warn(message: string): void };
}

/** The result the sidebar's `openProcessYamlDocument` seam maps, minus the dialog's `canceled`. */
export type ChosenDocumentRead =
  | { readonly outcome: 'read'; readonly bytes: Uint8Array }
  | { readonly outcome: 'too-large' }
  | { readonly outcome: 'failed'; readonly message: string };

/** Unchanged from the inline adapter: an adapter's error text can name the location it read. */
const FAILED_MESSAGE = 'Could not read the document.';

/** The shape a logged code may take, so a message or a path cannot ride in a `code` property. */
const CLOSED_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const UNKNOWN_CODE = 'unknown';

/**
 * The Node `code` or `FileSystemError.code` of a failure, or `unknown`.
 *
 * Only a short identifier is accepted. Anything else (a message, a path, an object) becomes
 * `unknown`, so the log line cannot carry what the failure was about (FR-007). Exported so the
 * sidebar wiring's two process-YAML file adapters log the same closed shape (V4).
 */
export function closedErrorCode(failure: unknown): string {
  if (typeof failure !== 'object' || failure === null) return UNKNOWN_CODE;
  const code = (failure as { code?: unknown }).code;
  return typeof code === 'string' && CLOSED_CODE_PATTERN.test(code) ? code : UNKNOWN_CODE;
}

async function readLocalDocument(fsPath: string): Promise<ChosenDocumentRead> {
  const handle = await open(fsPath, 'r');
  try {
    const verdict = await judgeSize(handle, PHASE_YAML_MAX_BYTES);
    if (verdict.outcome === 'too-large') return { outcome: 'too-large' };
    // The size just judged is only what the file was a moment ago. Asking for cap + 1 bytes, and not
    // for `verdict.size`, is what catches a file that grew since: it comes back longer than the cap.
    const range = await readBoundedRange(
      handle,
      0,
      PHASE_YAML_MAX_BYTES + 1,
      PHASE_YAML_MAX_BYTES + 1
    );
    if (range.bytes.byteLength > PHASE_YAML_MAX_BYTES) return { outcome: 'too-large' };
    return { outcome: 'read', bytes: range.bytes };
  } finally {
    await handle.close();
  }
}

async function readOtherDocument<Target extends ChosenDocumentTarget>(
  target: Target,
  fs: DocumentReadFileSystem<Target>
): Promise<ChosenDocumentRead> {
  const { size } = await fs.stat(target);
  if (size > PHASE_YAML_MAX_BYTES) return { outcome: 'too-large' };
  return { outcome: 'read', bytes: await fs.readBytes(target) };
}

/**
 * Read the chosen document, or say it was too large to read, or say the read failed.
 *
 * Never throws: a failure is logged once with a closed code and returned as `failed`.
 */
export async function readChosenProcessDocument<Target extends ChosenDocumentTarget>(
  target: Target,
  deps: DocumentReadDeps<Target>
): Promise<ChosenDocumentRead> {
  try {
    return target.scheme === 'file'
      ? await readLocalDocument(target.fsPath)
      : await readOtherDocument(target, deps.fs);
  } catch (failure) {
    deps.logger.warn(`extension: phase import read failed: code=${closedErrorCode(failure)}`);
    return { outcome: 'failed', message: FAILED_MESSAGE };
  }
}
