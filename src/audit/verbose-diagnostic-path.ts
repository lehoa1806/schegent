// Feature 044 — pure path composer for the verbose-diagnostic sibling
// sink. Mirrors the discipline established by
// `src/services/phase-log/phase-log-path.ts` (feature 020 T20):
// per-segment regex validation, post-composition `path.relative`
// traversal-defense assertion, no `vscode` import, no I/O.
//
// Threat-model: T10 (verbose-diag intentionally unredacted) + T17
// (path traversal). Operator-supplied `pipelineId` and `phaseId`
// flow from the catalog store, whose ids a cloned repository can
// supply; a malicious or accidentally-misconfigured `..` segment
// would let the writer escape the `.schegent/sessions/` sandbox.
//
// On invalid input the composer throws; the caller in
// `PhaseRunner.buildVerboseTarget` catches and disables the
// verbose-diag opt-in for the failing invocation (one-shot warning,
// no run-level impact). See specs/044-verbose-diag-path-defense.

import * as path from 'node:path';

import type { VerboseDiagnosticTarget } from '../runner/invocation-result';

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DIAGNOSTICS_ROOT_SEGMENTS = ['.schegent', 'sessions'] as const;
const DIAGNOSTICS_LEAF_SEGMENT = 'diagnostics';
const DEBUG_FILE = 'debug.json';
const STREAM_FILE = 'stream.jsonl';
const VERBOSE_LOG_FILE = 'verbose.log';

export interface VerboseDiagnosticAddress {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iterationN: number;
}

function requireNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireSafeSegment(name: string, value: unknown): asserts value is string {
  requireNonEmptyString(name, value);
  if (!SEGMENT_PATTERN.test(value)) {
    throw new TypeError(
      `${name} must match ${SEGMENT_PATTERN.source} (got: ${JSON.stringify(value)})`
    );
  }
}

function requireIterationN(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(
      `iterationN must be a positive safe integer (got: ${JSON.stringify(value)})`
    );
  }
}

/**
 * Compose the absolute paths for the three verbose-diagnostic sibling
 * sinks under
 * `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`.
 *
 * Throws `TypeError` / `RangeError` on any segment that fails the
 * per-component validator. Throws `Error` if a synthetic regex
 * bypass ever produced a `directory` that escapes the
 * `<workspaceRoot>/.schegent/sessions/` root (defense-in-depth — the
 * regex makes the assertion unreachable in practice).
 */
export function composeVerboseDiagnosticPath(
  address: VerboseDiagnosticAddress
): VerboseDiagnosticTarget {
  requireNonEmptyString('workspaceRoot', address.workspaceRoot);
  requireSafeSegment('runId', address.runId);
  requireSafeSegment('pipelineId', address.pipelineId);
  requireSafeSegment('phaseId', address.phaseId);
  requireIterationN(address.iterationN);

  const diagnosticsRoot = path.join(
    address.workspaceRoot,
    ...DIAGNOSTICS_ROOT_SEGMENTS
  );
  const directory = path.join(
    diagnosticsRoot,
    address.runId,
    DIAGNOSTICS_LEAF_SEGMENT,
    address.pipelineId,
    address.phaseId,
    `iter-${address.iterationN}`
  );

  const rel = path.relative(diagnosticsRoot, directory);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `verbose-diagnostic path escaped sandbox (rel=${JSON.stringify(rel)})`
    );
  }

  return {
    directory,
    debugFile: path.join(directory, DEBUG_FILE),
    streamFile: path.join(directory, STREAM_FILE),
    verboseLogFile: path.join(directory, VERBOSE_LOG_FILE)
  };
}
