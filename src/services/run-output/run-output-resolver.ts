// Feature 087 (T063, US6) — what a completed Run recorded about its outputs.
//
// FR-040: on completion, resolve each declared output target and record every
// one that resolves. FR-040a: the record is a *location*, never a copy of the
// artifact. FR-041: nothing undeclared is recorded. FR-042: one output that did
// not resolve is reported as unresolved and does not suppress the rest.
//
// Two structural properties carry most of those requirements, and both are
// worth naming because a later edit could lose them without any test obviously
// breaking:
//
//   * There is **no discovery pass**. This walks the frozen plan's declared
//     outputs and asks about each one. It never enumerates a directory, so
//     FR-041 holds because there is no code path by which an undeclared file
//     could be seen at all — not because a filter removes it afterwards.
//   * The seam is `exists`, not `read`. Content cannot reach a record through
//     this module because the only question it can ask is whether something is
//     there. FR-040a is a property of the interface, not a discipline.
//
// The recorded reference is workspace-relative and normalized, which is a
// deliberate difference from `FrozenOutputRequest.target` — that stays exactly
// as the operator wrote it, because the plan is the record of what was asked
// for. This is the record of what exists, and `out/a.md` and
// `./out/nested/../a.md` are one file, so they must read as one reference. An
// absolute path never appears: it is host-internal (FR-020) and must not reach
// Run details, the audit log (FR-047), or a later Run that feeds this one
// forward.

import * as path from 'node:path';
import type { FrozenOutputRequest } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';
import { resolveWithinWorkspace } from '../run-request/workspace-containment';

/**
 * Answers whether something occupies a resolved absolute path.
 *
 * Structurally identical to the validator's `OutputTargetProbe` and kept
 * separate on purpose: they are asked at different times, about different
 * things — "is this target already taken?" before the Run, "did this target get
 * written?" after it — and a shared type would tie the two questions together.
 */
export interface RunOutputProbe {
  exists(absolutePath: string): Promise<boolean>;
}

export interface ResolveRunOutputsContext {
  readonly workspaceRoot: string;
  readonly probe: RunOutputProbe;
}

/**
 * Resolve the declared outputs of a completed Run, in declaration order.
 *
 * A target that resolves outside the workspace is reported unresolved and is
 * never probed. Validation refuses such a target before a Run exists, so this
 * is the defensive half of the same rule: whatever a plan carries, the probe is
 * not pointed outside the root.
 */
export async function resolveRunOutputs(
  outputs: readonly FrozenOutputRequest[],
  context: ResolveRunOutputsContext
): Promise<readonly RunOutputRecord[]> {
  const records: RunOutputRecord[] = [];

  for (const output of outputs) {
    const contained = resolveWithinWorkspace(context.workspaceRoot, output.target);
    if (!contained.ok) {
      records.push(unresolved(output.portId));
      continue;
    }

    // Feature 091 (T010) — R2/R4. One check that cannot answer is recorded
    // unresolved and the loop continues. Without this the first probe rejection
    // would abort every check after it, and FR-006's "recorded rather than
    // raised" would hold only for the failures the probe chose to report as
    // `false`. Catching here rather than in the adapter means the guarantee
    // holds for every probe the resolver is handed, not just the bounded one.
    let present: boolean;
    try {
      present = await context.probe.exists(contained.absolutePath);
    } catch {
      records.push(unresolved(output.portId));
      continue;
    }

    if (!present) {
      records.push(unresolved(output.portId));
      continue;
    }

    records.push({
      name: output.portId,
      status: 'resolved',
      reference: path.relative(path.resolve(context.workspaceRoot), contained.absolutePath)
    });
  }

  return records;
}

/** No `reference` key at all — an unresolved output has no location to carry. */
function unresolved(portId: string): RunOutputRecord {
  return { name: portId, status: 'unresolved' };
}
