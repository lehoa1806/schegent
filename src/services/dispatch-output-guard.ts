// FR-R3-079 (T1056) — re-walk every declared output target at dispatch.
//
// `SEC-04` of the 2026-08-24 register, and the one row of it that reached
// neither an item nor a written deferral. The shape: an operator names an output
// inside the workspace, the host validates it LEXICALLY (`path.resolve` plus
// `path.relative`, no `realpath`), the operator confirms, the target is frozen
// into the plan — and nothing checks it again. The CLI then writes it. For the
// enabled Claude and Agy runners that CLI is uncontained and runs under the
// operator's full local authority, so a parent component swapped for a symlink
// after the confirmation writes an "inside the workspace" file outside it.
//
// The window is the whole life of the request: validation happens when the
// operator composes it, and the write happens when the child runs. This module
// closes the host's half of that window by re-judging immediately before the
// frozen plan reaches the runner.
//
// WHAT IT DOES NOT CLOSE, stated because the alternative is implying otherwise:
// the child still writes later. Between this walk and the child's `open` there
// is a residual interval that no host-side check can remove — only the sandbox
// can, and only for the runner that has one. That asymmetry is `FR-R3-032`'s and
// the operations record points at it rather than restating it.
//
// The walk CREATES NOTHING. An output that does not exist yet must not be
// brought into existence by its own check, so only the parent chain is walked.

import * as path from 'node:path';
import type { FrozenOutputRequest } from '../contracts/run-request';
import { segmentsUnderRoot, walkDirectoriesWithinRoot, judgeLeafRedirect, platformLacksNoFollow } from '../lib/safe-open';
import type { SafeOpenRefusal } from '../lib/safe-open';

export type DispatchOutputVerdict =
  | { readonly outcome: 'contained' }
  | {
      readonly outcome: 'refused';
      readonly portId: string;
      readonly reason: SafeOpenRefusal;
    };

const CONTAINED: DispatchOutputVerdict = { outcome: 'contained' };

/**
 * FR-R3-079 (T1057) — the Run-level failure a refused target produces.
 *
 * A typed error rather than a returned outcome because the dispatch seam it is
 * raised from returns a phase output, and there is no phase output to return: the
 * runner was never called. The driver's existing failure handling turns this into
 * a failed Run with the message below, which names the port and the refusal
 * class — never the path, which does not belong in the record.
 */
export class OutputTargetRefusedAtDispatch extends Error {
  public readonly portId: string;
  public readonly reason: SafeOpenRefusal;

  constructor(portId: string, reason: SafeOpenRefusal) {
    super(`output target refused at dispatch: port ${portId} (${reason})`);
    this.name = 'OutputTargetRefusedAtDispatch';
    this.portId = portId;
    this.reason = reason;
  }
}

/**
 * The one output-port type whose target reaches beyond the workspace by design.
 *
 * Its externality is the operator's decision and it was already taken, at
 * request time, behind its own confirmation. Turning that deliberate path into a
 * refusal here would be this item breaking a feature rather than closing a
 * window — `FR-R3-079`'s acceptance says so explicitly.
 */
const EXTERNAL_SIDE_EFFECT_PORT_TYPE = 'external-reference';

export async function judgeOutputTargetsAtDispatch(
  workspaceRoot: string,
  outputs: readonly FrozenOutputRequest[]
): Promise<DispatchOutputVerdict> {
  for (const output of outputs) {
    if (output.type === EXTERNAL_SIDE_EFFECT_PORT_TYPE) continue;
    const absolute = path.resolve(workspaceRoot, output.target);
    const segments = segmentsUnderRoot(workspaceRoot, absolute);
    if (segments === null || segments.length === 0) {
      // Lexically outside already. Request-time validation refuses this, so
      // reaching it here means the plan was composed by something that did not
      // validate — which is a refusal, not a pass.
      return { outcome: 'refused', portId: output.portId, reason: 'escapes-root' };
    }
    // The PARENT chain only: the leaf is what the child will create.
    const walked = await walkDirectoriesWithinRoot(workspaceRoot, segments.slice(0, -1));
    if (walked.outcome === 'refused') {
      // A component that does not exist is not a refusal. The walk verified every
      // component ABOVE the missing one — none of them was a symlink or a
      // non-directory — and a path that stops existing partway through has
      // nothing to be redirected through. The child (or the phase) creates the
      // rest. Refusing here would fail every run whose output directory has not
      // been created yet, which is most of them.
      if (walked.reason === 'io-failed' && walked.errno === 'ENOENT') continue;
      return { outcome: 'refused', portId: output.portId, reason: walked.reason };
    }
    // The LEAF, which the parent walk deliberately skips. Skipping it entirely
    // was the hole: a declared output that does not exist at request time (so it
    // is confirmed without an overwrite prompt) and is then created as a symlink
    // before dispatch passed this check untouched, and the child's write
    // followed it out of the workspace — `SEC-04` with one more step.
    //
    // `lstat` and not `stat`: the question is whether this NAME is a link, not
    // what it points at. Absent is the ordinary case and stays a pass — the
    // child creates it — and nothing here creates anything, so the
    // "judges without creating" property is unchanged.
    //
    // FR-R3-083 — the REASON is chosen the way `safe-open` chooses it, through the
    // same predicate and the same platform question. On Windows `lstat` reports a
    // junction as a link exactly as it does here, and `safe-open`'s leaf check
    // answers `reparse-point-leaf` for that arrangement; naming it `symlink-leaf`
    // here would tell an operator the atomic kernel refusal answered on a platform
    // that has no such refusal. Two names for one arrangement, in one product.
    //
    // What neither name covers is a reparse TAG other than symlink or mount point;
    // `lstat` reports those as ordinary files and telling them apart needs a native
    // call, declined on the record in
    // `docs/architecture/native-binding-decision.md`. A permanent stated limit,
    // and the same one `safe-open.ts` carries.
    const leaf = path.join(walked.directory, segments[segments.length - 1]!);
    // FR-R3-083 — ONE leaf policy, in `safe-open.ts`. This site and the walk's own
    // leaf check used to hold two copies with different error tolerance, and the
    // only thing they shared was the `isSymbolicLink()` call — none of the policy
    // that actually differed. The tolerance is now an explicit argument, so the
    // difference between the two callers is declared rather than accidental.
    //
    // `ENOTDIR` is tolerated HERE and not in the walk: this guard judges a declared
    // output target that may not exist yet, at any depth, so a component that is a
    // file means "there is nothing here to be redirected through". The walk has
    // already proved every component above its leaf, so the same code there would
    // mean something changed underneath it — a refusal, not an absence.
    const judged = await judgeLeafRedirect(leaf, ['ENOENT', 'ENOTDIR'], platformLacksNoFollow());
    if (judged.outcome === 'refused') {
      return { outcome: 'refused', portId: output.portId, reason: judged.reason };
    }
  }
  return CONTAINED;
}
