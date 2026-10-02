import * as path from 'node:path';

import { narrowMode, noticeFor, type NarrowingNotice } from './narrow-mode';
import { resolveContainedLink, type ContainmentFs } from './path-containment';

/**
 * Feature 217 (FR-003, FR-004, FR-005) — the policy the evidence sinks share
 * around the one narrowing mechanism in `narrow-mode.ts`.
 *
 * `openWithinRoot` narrows what a writing open walks through and opens, and
 * hands back what it did as path-free notices. Three things are left over, and
 * each would drift if every sink wrote its own: the words an operator reads,
 * saying each thing once rather than on every append, and the rotated files no
 * open ever reaches. A generation (`<live>.1`) or an audit archive was renamed
 * into place, and a rename keeps the mode a file was born with, so a log an
 * earlier release created under the umask leaves widened generations behind it
 * until something narrows them where they lie.
 */

const OCTAL_RADIX = 8;
const MODE_DIGITS = 3;

/** A rotated generation's suffix. `<live>.keep-me` belongs to the operator. */
const GENERATION_SUFFIX = /^\d+$/;

/**
 * One notice, in the words an operator reads. Path-free because the notice is:
 * it carries a scope and a mode, never a location.
 */
export function describeNarrowing(notice: NarrowingNotice): string {
  switch (notice.outcome) {
    case 'narrowed':
      return (
        `an evidence ${notice.scope} granted access beyond its owner ` +
        `(mode ${octal(notice.previousMode)}); narrowed to owner-only`
      );
    case 'refused-symlink':
      return `an evidence ${notice.scope} is a symbolic link; its mode was left unchanged`;
    case 'unsupported':
      return (
        `could not narrow an evidence ${notice.scope} to owner-only (${notice.code}); ` +
        `it may be readable by other local accounts`
      );
  }
}

function octal(mode: number): string {
  return mode.toString(OCTAL_RADIX).padStart(MODE_DIGITS, '0');
}

/**
 * Says each distinct thing once per sink instance.
 *
 * Keyed on the rendered message, so two widened files at the same mode are one
 * line and a file and its directory are two. A sink appends on every log line;
 * one WARN per append would bury the log in the report of its own repair.
 */
export class NarrowingReporter {
  private readonly reported = new Set<string>();

  /** `subject` names the sink (`[cli-transport]`), never a path. */
  constructor(
    private readonly subject: string,
    private readonly warn: (message: string) => void
  ) {}

  report(notices: readonly NarrowingNotice[]): void {
    for (const notice of notices) {
      const message = `${this.subject} ${describeNarrowing(notice)}`;
      if (this.reported.has(message)) continue;
      this.reported.add(message);
      this.warn(message);
    }
  }
}

/**
 * The rotated generations beside `livePath`: `<live>.<n>` for a purely numeric
 * `n`, the same rule each sink's stale-generation sweep applies. An unreadable
 * directory lists nothing; narrowing is a repair, never a reason to stop
 * writing.
 */
export async function listGenerations(
  livePath: string,
  readdir: (directory: string) => Promise<readonly string[]>
): Promise<string[]> {
  const directory = path.dirname(livePath);
  const prefix = `${path.basename(livePath)}.`;
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix) && GENERATION_SUFFIX.test(name.slice(prefix.length)))
    .map((name) => path.join(directory, name));
}

/**
 * Narrow rotated files where they lie, each proven inside `roots` first.
 *
 * Link form, because the entry is what is judged: a generation slot holding a
 * symlink stays contained here and is then refused by `narrowMode`'s own
 * `lstat`, so the file it points at keeps its mode (FR-003). A file outside
 * every root is skipped silently; the sink's rotation path is what reports
 * containment.
 */
export async function narrowRotatedFiles(
  files: readonly string[],
  desired: number,
  roots: readonly string[],
  containmentFs?: ContainmentFs
): Promise<NarrowingNotice[]> {
  const notices: NarrowingNotice[] = [];
  for (const file of files) {
    const verdict = await resolveContainedLink(file, roots, containmentFs);
    if (verdict.outcome !== 'contained') continue;
    const notice = noticeFor('file', await narrowMode(verdict.resolved, desired));
    if (notice !== null) notices.push(notice);
  }
  return notices;
}
