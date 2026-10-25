// FR-R3-200 — the one answer to "was Node started on this module?", for every script under
// `scripts/` that does its work only when started and is otherwise imported for its exports.
//
// Each of those scripts used to decide for itself, by comparing its own `import.meta.url` with
// `process.argv[1]`. The secret scan's comparison was false whenever the checkout's path needed
// percent-encoding or passed through a symlink, so the scan did nothing and exited 0. The link
// checker alone had it right, in a private function; this is that function, shared, and
// `tests/lint/entry-checks-use-the-shared-function.test.ts` keeps it the only place the start
// path is read.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when Node was started on the module `moduleUrl` names, by any path to its file. A caller
 * passes its own `import.meta.url`. Both sides are resolved, because a module URL is
 * percent-encoded and names the file with its symlinks resolved, and `process.argv[1]` is
 * neither: compared directly, the two differ under any path a URL encodes and through any
 * symlinked directory, macOS's `/tmp` included, and the script then exits 0 having done nothing.
 *
 * False when Node was started on another file, when there is no start path (`node -e`), when
 * either side cannot be resolved (a URL that is not a `file:` URL included), and when Node
 * completed the start path, by adding an extension or resolving a directory to its main file:
 * `process.argv[1]` then names neither the file nor a link to it, so start such a script by its
 * file name. Never throws.
 */
export function invokedAsScript(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
