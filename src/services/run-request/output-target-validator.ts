// Feature 087 (T028, US6) — declared output targets.
//
// FR-021 through FR-025. The gate an output has to pass is wider than an
// input's because an output *writes*: it can leave the workspace, land on an
// operator's existing file, collide with another output of the same Run, or
// reach something outside the machine entirely.
//
// Three properties are worth stating because they are easy to lose in a later
// edit:
//
//   * Collisions are compared on the **resolved** path. `out/a.md` and
//     `./out/nested/../a.md` are one file, and a textual comparison would let
//     two outputs quietly race for it.
//   * The **frozen** target stays exactly as the operator wrote it. The resolved
//     absolute path is used to decide and then discarded — it must not reach the
//     webview or the audit log (FR-020, FR-047).
//   * The port **type** is taken from the Pipeline, never from the request. The
//     request names a port; the catalog says what that port is.
//
// Existence is asked of an injected probe rather than of `fs` directly, so this
// module stays pure and the composing validator owns the one filesystem seam.

import * as path from 'node:path';
import type { PipelineOutputPort } from '../../contracts/pipeline-definitions';
import type {
  FrozenOutputRequest,
  RunOutputTargetRequest,
  RunRequestErrorCode,
  RunRequestFieldError
} from '../../contracts/run-request';
import { resolveWithinWorkspace } from './workspace-containment';

/** Answers whether something already occupies a resolved absolute path. */
export interface OutputTargetProbe {
  exists(absolutePath: string): Promise<boolean>;
}

export interface OutputTargetValidationInput {
  readonly requested: readonly RunOutputTargetRequest[];
  readonly ports: readonly PipelineOutputPort[];
  readonly workspaceRoot: string;
  readonly probe: OutputTargetProbe;
}

export interface OutputTargetValidationResult {
  readonly errors: readonly RunRequestFieldError[];
  readonly outputs: readonly FrozenOutputRequest[];
}

/**
 * The one output-port type whose target reaches beyond the workspace. Writing to
 * it is not undoable by deleting a file, so it needs its own confirmation on top
 * of any overwrite confirmation.
 */
const EXTERNAL_SIDE_EFFECT_PORT_TYPE = 'external-reference';

function error(field: string, code: RunRequestErrorCode, message: string): RunRequestFieldError {
  return { field, code, message };
}

export async function validateOutputTargets(
  input: OutputTargetValidationInput
): Promise<OutputTargetValidationResult> {
  const declared = new Map(input.ports.map((port) => [port.portId, port]));
  const errors: RunRequestFieldError[] = [];
  const outputs: FrozenOutputRequest[] = [];
  const targetedPorts = new Set<string>();
  const claimedPaths = new Map<string, string>();

  for (const request of input.requested) {
    const field = `outputs.${request.portId}`;
    const port = declared.get(request.portId);

    if (port === undefined || targetedPorts.has(request.portId)) {
      errors.push(
        error(
          field,
          'unknown-output-port',
          'The Pipeline declares no untargeted output port with this identifier.'
        )
      );
      continue;
    }
    targetedPorts.add(request.portId);

    if (request.target.trim().length === 0) {
      errors.push(error(field, 'output-target-missing', 'This output needs a target.'));
      continue;
    }

    const contained = resolveWithinWorkspace(input.workspaceRoot, request.target);
    if (!contained.ok) {
      errors.push(
        error(field, 'path-escapes-workspace', 'This target resolves outside the workspace.')
      );
      continue;
    }

    const key = normalizeForCollision(contained.absolutePath);
    const claimedBy = claimedPaths.get(key);
    if (claimedBy !== undefined) {
      errors.push(
        error(
          field,
          'output-target-duplicate',
          `This target is already claimed by the output "${claimedBy}".`
        )
      );
      continue;
    }
    claimedPaths.set(key, request.portId);

    // Both confirmations are reported together when both are missing: they are
    // two separate decisions, and surfacing the second only after the first is
    // confirmed is the round trip FR-013 exists to prevent.
    const overwriteConfirmed = request.overwriteConfirmed === true;
    let refused = false;
    if (!overwriteConfirmed && (await input.probe.exists(contained.absolutePath))) {
      refused = true;
      errors.push(
        error(
          field,
          'output-overwrite-unconfirmed',
          'Something already exists at this target. Confirm the overwrite to continue.'
        )
      );
    }
    if (
      port.type === EXTERNAL_SIDE_EFFECT_PORT_TYPE &&
      request.externalSideEffectConfirmed !== true
    ) {
      refused = true;
      errors.push(
        error(
          field,
          'output-side-effect-unconfirmed',
          'This output has an effect outside the workspace. Confirm it to continue.'
        )
      );
    }
    if (refused) continue;

    outputs.push({
      portId: port.portId,
      type: port.type,
      target: request.target,
      overwriteConfirmed
    });
  }

  // Reported in declaration order, after the requested entries, so the operator
  // reads "what I asked for is wrong" before "what I did not ask for is missing".
  for (const port of input.ports) {
    if (targetedPorts.has(port.portId)) continue;
    errors.push(
      error(
        `outputs.${port.portId}`,
        'output-target-missing',
        'This output needs a target.'
      )
    );
  }

  return { errors, outputs };
}

/**
 * Case-fold on the platforms whose filesystems are case-insensitive by default,
 * so `Out/A.md` and `out/a.md` are recognized as one target there. On Linux they
 * are genuinely two files and are left distinct.
 */
function normalizeForCollision(absolutePath: string): string {
  const normalized = path.normalize(absolutePath);
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}
