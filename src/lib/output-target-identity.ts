// FR-R3-079 (T1055) — canonical identity for an output target, present or absent.
//
// `output-target-validator.ts` compared targets on `path.normalize` plus a
// case-fold, which is lexical: two names for one file through a symlink are two
// different claims, and the Run then races itself for a single file while the
// duplicate check reports nothing. `53_FR-R3-053` §5 recorded the gap as "no
// canonical-identity collision detection for absent outputs" and left it filed;
// this is its home, because the dispatch-time re-walk is already resolving the
// same paths.
//
// THE ABSENT-TARGET PROBLEM. `realpath` needs the file to exist, and an output
// target usually does not — that is the point of declaring it. So identity is
// taken in two parts: the deepest ancestor that DOES exist, canonicalized, plus
// the remaining literal segments. A symlink can only alias two names through a
// component that exists, so canonicalizing the existing ancestry is exactly the
// part where aliasing can happen; the rest is literal by construction.
//
// No I/O beyond `realpath` on directories, and no containment judgement: this
// module answers "are these the same file", never "is this file allowed". The
// containment answer belongs to the checked walk, which has its own vocabulary.

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export interface OutputTargetIdentity {
  /** The canonicalized deepest existing ancestor. */
  readonly anchor: string;
  /** The segments below it that do not exist yet, literal and normalized. */
  readonly rest: readonly string[];
  /** `anchor` + `rest`, folded for the platform. Two equal keys are one file. */
  readonly key: string;
}

/**
 * Case folding matches what the validator has always done: Linux is
 * case-sensitive, macOS and Windows are not by default. Folding on the
 * case-sensitive platform would merge two genuinely different files.
 */
function fold(value: string): string {
  return process.platform === 'linux' ? value : value.toLowerCase();
}

export async function outputTargetIdentity(
  workspaceRoot: string,
  target: string
): Promise<OutputTargetIdentity> {
  const absolute = path.resolve(workspaceRoot, target);
  const rest: string[] = [];
  let candidate = absolute;

  // Walk up until something exists. The loop terminates at the filesystem root,
  // whose parent is itself — the `parent === candidate` guard, not a counter,
  // because the depth is the operator's to choose and a counter would silently
  // give a wrong answer on a deep tree rather than a slow one.
  for (;;) {
    try {
      const resolved = await fs.realpath(candidate);
      return finish(resolved, rest);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return finish(candidate, rest);
      rest.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function finish(anchor: string, rest: readonly string[]): OutputTargetIdentity {
  const key = fold(rest.length === 0 ? anchor : path.join(anchor, ...rest));
  return { anchor, rest: [...rest], key };
}
