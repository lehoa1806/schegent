// FR-R4-F04 (FR-022, FR-024, contract E3) — where an export may be written, decided before anything is created.
//
// An export is written to a place the OPERATOR names (a dialog), and the places it must never be written
// are inside the evidence store it reads from: an export copied into `.schegent/` is a loop, and a way to
// move unredacted content past a retention sweep by parking a copy where the sweep does not look for
// archives. The earlier check was a regular expression over the path's TEXT, which an alias walks around: a
// symbolic link into the store, a `..`, a case variant. The decision is now three steps, in this order:
//
//   1. The destination is a local file. A `vscode-remote:` or any other scheme is refused
//      (`destination-not-local-file`): a remote filesystem's mode and containment cannot be checked here.
//   2. Lexical containment in `<workspaceRoot>/.schegent`, with NO syscall (hard rule 53: an `lstat` at an
//      operator-supplied location answers, by existence and by timing, before anything has established the
//      host may look). A path that names the store is refused (`destination-in-evidence-store`).
//   3. `classifyDestination`, which resolves where the destination actually lands. `inside` refuses as
//      above; `unresolvable` refuses as `destination-unresolvable`.
//
// Nothing is created, opened or listed before step 3 says `outside`.

import * as path from 'node:path';

import type { ExportRefusal } from '../contracts/evidence-export-outcome';
import { classifyDestination } from '../lib/path-containment';

/** What this needs of a VS Code `Uri`: the two fields it reads. A plain object stands in for one in tests. */
export interface ExportDestinationUri {
  readonly scheme: string;
  readonly fsPath: string;
}

export type ExportDestinationResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly refusal: ExportRefusal };

const EVIDENCE_DIRECTORY = '.schegent';

/** Lexical containment of two absolute paths, with no syscall. */
function lexicallyInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  // `'..' + sep`, not a bare `'..'` prefix: `.schegent/..archive` is in the store, not beside it.
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Decide whether an export may be written to the operator's chosen destination, before anything is created. */
export async function resolveExportDestination(
  uri: ExportDestinationUri,
  workspaceRoot: string
): Promise<ExportDestinationResolution> {
  if (uri.scheme !== 'file') return { ok: false, refusal: 'destination-not-local-file' };
  const absolute = path.resolve(uri.fsPath);
  const store = path.join(workspaceRoot, EVIDENCE_DIRECTORY);
  if (lexicallyInside(absolute, store)) return { ok: false, refusal: 'destination-in-evidence-store' };
  const classified = await classifyDestination(absolute, [store]);
  if (classified === 'inside') return { ok: false, refusal: 'destination-in-evidence-store' };
  if (classified === 'unresolvable') return { ok: false, refusal: 'destination-unresolvable' };
  return { ok: true, path: absolute };
}
