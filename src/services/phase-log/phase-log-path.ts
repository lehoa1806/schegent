// Feature 020 T023 — pure path composition for phase-log artifacts.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §1.
//
// Feature 034 T002 — added two new pure helpers:
//   - resolveSessionRootPath({ workspaceRoot, runId })
//       → <workspaceRoot>/.schegent/sessions/<runId>
//   - resolveRawTranscriptPath({ workspaceRoot, runId })
//       → <workspaceRoot>/.schegent/sessions/raw-<runId>.log
// `resolvePhaseDirPath` is refactored to delegate the session-root
// prefix composition to `resolveSessionRootPath` so the on-disk layout
// is composed in exactly one place. The refactor is behavior-preserving.
// See specs/034-task-deletion-cleanup/contracts/path-helpers.md.
//
// No I/O. Existence checks happen at the call site; missing paths
// surface as empty states / banner states, not exceptions.

import * as path from 'node:path';
import { isSafePathSegment } from '../../contracts/validators/shared';

const DIAGNOSTICS_ROOT_SEGMENTS = ['.schegent', 'sessions'] as const;
const DIAGNOSTICS_LEAF_SEGMENT = 'diagnostics';
const RAW_TRANSCRIPT_PREFIX = 'raw-';
const RAW_TRANSCRIPT_SUFFIX = '.log';
const STREAM_FILE = 'stream.jsonl';

interface SessionAddress {
  readonly workspaceRoot: string;
  readonly runId: string;
}

interface PhaseAddress extends SessionAddress {
  readonly pipelineId: string;
  readonly phaseId: string;
}

interface IterationAddress extends PhaseAddress {
  readonly iterationN: number;
}

function requireNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * FR-R3-080 (T1074) — the grammar, re-applied where the identifier becomes a
 * path component.
 *
 * The contracts validator applies the same rule at the IPC boundary. This is
 * not redundant with it, and the redundancy is the point: the validator covers
 * what crosses IPC, and this covers every OTHER route into a path — a
 * host-internal caller, a value read back from persisted state, a future call
 * site nobody has written yet. One check is a filter; two independent checks
 * against one shared oracle is a grammar.
 *
 * Shares `isSafePathSegment` with the validator rather than restating the rule,
 * because two implementations of one grammar drift, and the drift is silent
 * until something composes a path the validator would have refused.
 *
 * Throws, matching `requireNonEmptyString` above: a malformed segment reaching
 * composition is a programming error at the call site, and returning a value
 * would make it the caller's option to ignore.
 */
function requireSafeSegment(name: string, value: unknown): asserts value is string {
  requireNonEmptyString(name, value);
  if (!isSafePathSegment(value)) {
    // The name, never the value: this is called with operator-influenced input
    // and the message reaches a log.
    throw new TypeError(`${name} is not a safe path segment`);
  }
}

function validateSessionAddress(args: SessionAddress): void {
  // The root is a host-owned absolute path and is a ROOT, not a segment — it
  // legitimately contains separators. The runId is a segment.
  requireNonEmptyString('workspaceRoot', args.workspaceRoot);
  requireSafeSegment('runId', args.runId);
}

function validatePhaseAddress(args: PhaseAddress): void {
  validateSessionAddress(args);
  requireSafeSegment('pipelineId', args.pipelineId);
  requireSafeSegment('phaseId', args.phaseId);
}

/**
 * Feature 034 — pure path composer for the per-runId session root
 * directory. Returns `<workspaceRoot>/.schegent/sessions/<runId>`.
 * The canonical source of truth for the session-root layout — every
 * downstream consumer that needs the path (phase-log dir composer,
 * session cleanup helper) MUST delegate to this function.
 */
export function resolveSessionRootPath(args: SessionAddress): string {
  validateSessionAddress(args);
  return path.join(args.workspaceRoot, ...DIAGNOSTICS_ROOT_SEGMENTS, args.runId);
}

/**
 * Feature 034 — pure path composer for the per-runId raw transcript
 * file. Returns `<workspaceRoot>/.schegent/sessions/raw-<runId>.log`.
 * Matches the on-disk convention enforced by `RawTranscriptWriter`.
 */
export function resolveRawTranscriptPath(args: SessionAddress): string {
  validateSessionAddress(args);
  return path.join(
    args.workspaceRoot,
    ...DIAGNOSTICS_ROOT_SEGMENTS,
    `${RAW_TRANSCRIPT_PREFIX}${args.runId}${RAW_TRANSCRIPT_SUFFIX}`
  );
}

export function resolvePhaseDirPath(args: PhaseAddress): string {
  validatePhaseAddress(args);
  return path.join(
    resolveSessionRootPath({ workspaceRoot: args.workspaceRoot, runId: args.runId }),
    DIAGNOSTICS_LEAF_SEGMENT,
    args.pipelineId,
    args.phaseId
  );
}

export function resolveStreamJsonlPath(args: IterationAddress): string {
  validatePhaseAddress(args);
  if (!Number.isInteger(args.iterationN) || args.iterationN < 1) {
    throw new RangeError('iterationN must be >= 1');
  }
  return path.join(resolvePhaseDirPath(args), `iter-${args.iterationN}`, STREAM_FILE);
}
