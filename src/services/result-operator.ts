// FR-R5-F24 (D2, SPEC-02) — Host result operator: workspace-contained
// regular-file evidence reader, terminable worker-thread execution with a hard
// 2,000 ms deadline, and three-tier AttemptOutcome precedence normalizer.

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  ATTEMPT_OUTCOME_VERSION,
  MAX_EVIDENCE_REF_BYTES,
  MAX_RESULT_SOURCE_BYTES,
  RESULT_OPERATOR_DEADLINE_MS,
  RESULT_OPERATOR_VERSION,
  utf8ByteLength,
  validateAttemptOutcome,
  type AttemptOutcome,
  type AttemptOutcomeReason,
  type AttemptOutcomeRecovery,
  type AttemptOutcomeStatus,
  type AttemptProvenanceOperator,
  type AttemptProvenanceSource,
  type Primitive,
  type ResultContract
} from '../contracts/decision-results';
import { readBoundedRange } from '../lib/bounded-read';
import { openWithinRoot } from '../lib/safe-open';
import {
  workerEvaluateMain,
  type WorkerEvaluationInput,
  type WorkerEvaluationOutput
} from './result-operator-worker';

export type HostControlReason =
  | 'cancelled'
  | 'manual-pause'
  | 'trust-denied'
  | 'spend-limit'
  | 'wall-clock-timeout'
  | 'uncertain-effects';

export type CanonicalBackendDiagnosticKind =
  | 'credits'
  | 'rate-limit'
  | 'authentication'
  | 'top-up-required'
  | 'incompatible-backend'
  | 'process-failure'
  | 'startup-failure';

export interface CanonicalBackendDiagnosticInput {
  readonly kind: CanonicalBackendDiagnosticKind;
  readonly retryable?: boolean;
  readonly detail?: string;
}

export interface EvaluateAttemptOutcomeInput {
  readonly attemptId: string;
  readonly workspaceRoot: string;
  readonly resultContract: ResultContract;
  /** Map of declared output keys to workspace-relative file paths for `declared-output` sources. */
  readonly declaredOutputsByKey?: Readonly<Record<string, string>>;
  /** Host-attributed backend result payload for `backend-result` sources. */
  readonly backendResultText?: string;
  /** Canonical adapter-tagged diagnostic records text (JSONL) for `diagnostic-records` sources. */
  readonly diagnosticRecordsText?: string;
  readonly backendDiagnostic?: CanonicalBackendDiagnosticInput;
  /** Conflicting canonical diagnostics within the same tier invalidate the outcome (`D2`). */
  readonly conflictingBackendDiagnostic?: CanonicalBackendDiagnosticInput;
  readonly evidenceRef?: string;
  readonly evaluatedAt?: number;
  readonly deadlineMs?: number;
  readonly simulateWorkerHangMs?: number;
  /** Test hook invoked between `openWithinRoot` and post-read identity verification. */
  readonly onDuringReadHook?: () => Promise<void> | void;
}

export type PrecedenceEvaluationResult =
  | {
      readonly kind: 'host-control';
      readonly attemptId: string;
      readonly hostControl: HostControlReason;
      readonly evaluatedAt: number;
    }
  | {
      readonly kind: 'outcome';
      readonly outcome: AttemptOutcome;
    };

export type ContainedEvidenceReadResult =
  | {
      readonly ok: true;
      readonly rawText: string;
      readonly sourceBytes: number;
      readonly evidenceRef: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'missing-evidence'
        | 'malformed-evidence'
        | 'unattributed-evidence'
        | 'evidence-too-large';
      readonly diagnostic: string;
    };

const MAX_RELATIVE_PATH_BYTES = 512;

function parseLexicalRelativeSegments(relativeFilePath: string): readonly string[] | null {
  if (
    relativeFilePath.length === 0 ||
    utf8ByteLength(relativeFilePath) > MAX_RELATIVE_PATH_BYTES ||
    relativeFilePath.includes('\0') ||
    relativeFilePath.includes('\\') ||
    /^[A-Za-z]:/.test(relativeFilePath) ||
    path.isAbsolute(relativeFilePath)
  ) {
    return null;
  }
  const segments = relativeFilePath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return null;
    }
  }
  return segments;
}

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function deriveOpaqueEvidenceRef(attemptId: string, label: string): string {
  const digest = createHash('sha256').update(`${attemptId}:${label}`).digest('hex').slice(0, 32);
  const candidate = `ev-${digest}`;
  return candidate.slice(0, MAX_EVIDENCE_REF_BYTES);
}

/**
 * Read a structured result file under `workspaceRoot` enforcing:
 *   1. Lexical containment before any filesystem access.
 *   2. Component-by-component `lstat` walk rejecting symlinks and non-regular
 *      files (including FIFOs, sockets, directories, and device nodes) before opening.
 *   3. `openWithinRoot` (`O_RDONLY | O_NOFOLLOW`) + `fstat` regular-file proof +
 *      inode/device identity continuity check before and after reading.
 *   4. Bounded read (`maxBytes + 1`) rejecting oversize files without unbounded memory allocation.
 */
export async function readContainedEvidenceFile(
  workspaceRoot: string,
  relativeFilePath: string,
  maxBytes: number = MAX_RESULT_SOURCE_BYTES,
  options?: {
    readonly attemptId?: string;
    readonly onDuringReadHook?: () => Promise<void> | void;
  }
): Promise<ContainedEvidenceReadResult> {
  const segments = parseLexicalRelativeSegments(relativeFilePath);
  if (segments === null) {
    return {
      ok: false,
      reason: 'malformed-evidence',
      diagnostic: 'Result file path must be a workspace-contained relative path.'
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fsp.realpath(path.resolve(workspaceRoot));
  } catch {
    return {
      ok: false,
      reason: 'missing-evidence',
      diagnostic: 'Active workspace root does not exist or could not be resolved.'
    };
  }

  let current = canonicalRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = path.join(current, segments[i]!);
    let dirStat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      dirStat = await fsp.lstat(current);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          ok: false,
          reason: 'missing-evidence',
          diagnostic: 'Result file directory does not exist.'
        };
      }
      return {
        ok: false,
        reason: 'malformed-evidence',
        diagnostic: `Result file directory could not be inspected (${code}).`
      };
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return {
        ok: false,
        reason: 'malformed-evidence',
        diagnostic: 'Result path traverses a symbolic link or non-directory component.'
      };
    }
  }

  const leafPath = path.join(current, segments[segments.length - 1]!);
  let preOpenStat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    preOpenStat = await fsp.lstat(leafPath);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ok: false,
        reason: 'missing-evidence',
        diagnostic: 'Declared result file was not found.'
      };
    }
    return {
      ok: false,
      reason: 'malformed-evidence',
      diagnostic: `Declared result file could not be stat'd (${code}).`
    };
  }

  if (preOpenStat.isSymbolicLink() || !preOpenStat.isFile()) {
    return {
      ok: false,
      reason: 'malformed-evidence',
      diagnostic: 'Declared result file must be a regular file (symlinks, FIFOs, and directories are rejected).'
    };
  }

  const opened = await openWithinRoot(canonicalRoot, segments, { flags: 'r' });
  if (opened.outcome === 'refused') {
    return {
      ok: false,
      reason: 'malformed-evidence',
      diagnostic: `Result file rejected by safe-open (${opened.reason}).`
    };
  }

  const handle = opened.handle;
  try {
    const fstat = await handle.stat();
    if (!fstat.isFile()) {
      return {
        ok: false,
        reason: 'malformed-evidence',
        diagnostic: 'Opened result descriptor is not a regular file.'
      };
    }
    if (fstat.dev !== preOpenStat.dev || fstat.ino !== preOpenStat.ino) {
      return {
        ok: false,
        reason: 'unattributed-evidence',
        diagnostic: 'Result file identity changed before open.'
      };
    }
    if (fstat.size > maxBytes) {
      return {
        ok: false,
        reason: 'evidence-too-large',
        diagnostic: `Result file size (${fstat.size} bytes) exceeds ceiling (${maxBytes} bytes).`
      };
    }

    const readLimit = maxBytes + 1;
    const range = await readBoundedRange(handle, 0, readLimit, readLimit);
    if (options?.onDuringReadHook !== undefined) {
      await options.onDuringReadHook();
    }

    let postReadStat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      postReadStat = await fsp.lstat(leafPath);
    } catch {
      return {
        ok: false,
        reason: 'unattributed-evidence',
        diagnostic: 'Result file disappeared or became inaccessible during read.'
      };
    }
    if (
      postReadStat.isSymbolicLink() ||
      !postReadStat.isFile() ||
      postReadStat.dev !== fstat.dev ||
      postReadStat.ino !== fstat.ino ||
      postReadStat.size !== fstat.size ||
      postReadStat.mtimeMs !== fstat.mtimeMs
    ) {
      return {
        ok: false,
        reason: 'unattributed-evidence',
        diagnostic: 'Result file identity or content changed concurrently during read.'
      };
    }

    if (range.bytes.byteLength > maxBytes) {
      return {
        ok: false,
        reason: 'evidence-too-large',
        diagnostic: `Result file bytes exceed ceiling (${maxBytes} bytes).`
      };
    }

    // Validate strict UTF-8 decoding
    let rawText: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      rawText = decoder.decode(range.bytes);
    } catch {
      return {
        ok: false,
        reason: 'malformed-evidence',
        diagnostic: 'Result file contains invalid UTF-8 byte sequences.'
      };
    }

    return {
      ok: true,
      rawText,
      sourceBytes: range.bytes.byteLength,
      evidenceRef: deriveOpaqueEvidenceRef(options?.attemptId ?? 'attempt', segments.join('/'))
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Execute `workerEvaluateMain` inside a terminable `node:worker_threads` Worker
 * bounded by `deadlineMs` (`RESULT_OPERATOR_DEADLINE_MS` = 2,000 ms).
 */
export async function executeResultContractInWorker(
  workerInput: WorkerEvaluationInput,
  deadlineMs: number = RESULT_OPERATOR_DEADLINE_MS
): Promise<WorkerEvaluationOutput> {
  const bootstrapScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const evaluate = (${workerEvaluateMain.toString()});
    const output = evaluate(workerData);
    parentPort.postMessage(output);
  `;

  return new Promise<WorkerEvaluationOutput>((resolve) => {
    let settled = false;
    const worker = new Worker(bootstrapScript, {
      eval: true,
      workerData: workerInput
    });

    const finish = (output: WorkerEvaluationOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().finally(() => {
        resolve({
          status: 'invalid-result',
          reason: 'operator-timeout',
          recovery: 'block-intervention',
          values: {},
          diagnostics: [
            `Result operator exceeded ${deadlineMs}ms deadline and worker thread was terminated.`
          ]
        });
      });
    }, deadlineMs);

    worker.once('message', (msg: WorkerEvaluationOutput) => {
      finish(msg);
      void worker.terminate();
    });

    worker.once('error', (err: Error) => {
      finish({
        status: 'invalid-result',
        reason: 'malformed-evidence',
        recovery: 'block-intervention',
        values: {},
        diagnostics: [`Result operator worker error: ${err.message.slice(0, 200)}`]
      });
      void worker.terminate();
    });

    worker.once('exit', (code: number) => {
      if (!settled) {
        finish({
          status: 'invalid-result',
          reason: code === 0 ? 'malformed-evidence' : 'operator-timeout',
          recovery: 'block-intervention',
          values: {},
          diagnostics: [`Result operator worker exited unexpectedly with code ${code}.`]
        });
      }
    });
  });
}

function buildOutcome(params: {
  readonly attemptId: string;
  readonly status: AttemptOutcomeStatus;
  readonly reason: AttemptOutcomeReason;
  readonly recovery: AttemptOutcomeRecovery;
  readonly values?: Readonly<Record<string, Primitive>>;
  readonly operator: AttemptProvenanceOperator;
  readonly source: AttemptProvenanceSource;
  readonly evidenceRef?: string;
  readonly evaluatedAt: number;
}): AttemptOutcome {
  const values =
    params.status === 'done' || params.status === 'incomplete'
      ? Object.freeze({ ...(params.values ?? {}) })
      : Object.freeze({});
  const provenance = Object.freeze({
    operator: params.operator,
    operatorVersion: RESULT_OPERATOR_VERSION,
    source: params.source,
    ...(params.evidenceRef !== undefined ? { evidenceRef: params.evidenceRef } : {}),
    evaluatedAt: params.evaluatedAt
  });
  const candidate: AttemptOutcome = Object.freeze({
    version: ATTEMPT_OUTCOME_VERSION,
    attemptId: params.attemptId,
    status: params.status,
    reason: params.reason,
    recovery: params.recovery,
    values,
    provenance
  });
  const validated = validateAttemptOutcome(candidate);
  if (validated.ok) return validated.value;
  return candidate;
}

function mapCanonicalBackendDiagnostic(
  attemptId: string,
  diagnostic: CanonicalBackendDiagnosticInput,
  evaluatedAt: number,
  evidenceRef?: string
): AttemptOutcome {
  const base = {
    attemptId,
    operator: 'canonical-diagnostic' as const,
    source: 'host' as const,
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    evaluatedAt
  };
  switch (diagnostic.kind) {
    case 'credits':
      return buildOutcome({
        ...base,
        status: 'temporarily-unavailable',
        reason: 'credits',
        recovery: 'reselect'
      });
    case 'rate-limit':
      return buildOutcome({
        ...base,
        status: 'temporarily-unavailable',
        reason: 'rate-limit',
        recovery: 'reselect'
      });
    case 'authentication':
      return buildOutcome({
        ...base,
        status: 'failed',
        reason: 'authentication',
        recovery: 'candidate-intervention'
      });
    case 'top-up-required':
      return buildOutcome({
        ...base,
        status: 'failed',
        reason: 'top-up-required',
        recovery: 'candidate-intervention'
      });
    case 'incompatible-backend':
      return buildOutcome({
        ...base,
        status: 'failed',
        reason: 'incompatible-backend',
        recovery: 'retire'
      });
    case 'startup-failure':
      return buildOutcome({
        ...base,
        status: 'failed',
        reason: 'startup-failure',
        recovery: 'retry-current'
      });
    case 'process-failure':
      return buildOutcome({
        ...base,
        status: 'failed',
        reason: 'process-failure',
        recovery: diagnostic.retryable === false ? 'retire' : 'retry-current'
      });
  }
}

/**
 * Evaluate a single Phase or candidate attempt with full D2 precedence:
 *   1. Host control (`cancelled`, `manual-pause`, `trust-denied`, `spend-limit`, `wall-clock-timeout`, `uncertain-effects`) — separate from `AttemptOutcome` and always wins.
 *   2. Canonical backend diagnostics (`credits`, `rate-limit`, `authentication`, `top-up-required`, `incompatible-backend`, `process-failure`, `startup-failure`).
 *   3. Configured `resultContract` (`structured-result` or `diagnostic-result`) in a terminable worker.
 */
export async function evaluateAttemptWithPrecedence(
  input: EvaluateAttemptOutcomeInput & { readonly hostControl?: HostControlReason }
): Promise<PrecedenceEvaluationResult> {
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  if (input.hostControl !== undefined) {
    return Object.freeze({
      kind: 'host-control',
      attemptId: input.attemptId,
      hostControl: input.hostControl,
      evaluatedAt
    });
  }
  const outcome = await evaluateAttemptOutcome(input);
  return Object.freeze({ kind: 'outcome', outcome });
}

/**
 * Evaluate a single Phase or candidate attempt into a normalized `AttemptOutcome`
 * enforcing D2 precedence:
 *   - Canonical adapter diagnostics precede parsing truncated/malformed output.
 *   - Conflicting canonical diagnostics within the same tier yield `invalid-result` / `conflicting-evidence`.
 *   - Otherwise evaluate the configured `resultContract` in a bounded worker thread.
 */
export async function evaluateAttemptOutcome(
  input: EvaluateAttemptOutcomeInput
): Promise<AttemptOutcome> {
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const { resultContract: contract } = input;

  if (
    input.backendDiagnostic !== undefined &&
    input.conflictingBackendDiagnostic !== undefined &&
    input.backendDiagnostic.kind !== input.conflictingBackendDiagnostic.kind
  ) {
    return buildOutcome({
      attemptId: input.attemptId,
      status: 'invalid-result',
      reason: 'conflicting-evidence',
      recovery: 'block-intervention',
      operator: 'canonical-diagnostic',
      source: 'host',
      ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
      evaluatedAt
    });
  }

  if (input.backendDiagnostic !== undefined) {
    return mapCanonicalBackendDiagnostic(
      input.attemptId,
      input.backendDiagnostic,
      evaluatedAt,
      input.evidenceRef
    );
  }

  let rawText: string;
  let evidenceRef: string | undefined = input.evidenceRef;

  if (contract.source.kind === 'declared-output') {
    const relativePath =
      input.declaredOutputsByKey !== undefined
        ? input.declaredOutputsByKey[contract.source.outputKey]
        : contract.source.outputKey;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: 'missing-evidence',
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'declared-output',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    const readResult = await readContainedEvidenceFile(
      input.workspaceRoot,
      relativePath,
      MAX_RESULT_SOURCE_BYTES,
      {
        attemptId: input.attemptId,
        ...(input.onDuringReadHook !== undefined ? { onDuringReadHook: input.onDuringReadHook } : {})
      }
    );
    if (!readResult.ok) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: readResult.reason,
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'declared-output',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    rawText = readResult.rawText;
    evidenceRef = evidenceRef ?? readResult.evidenceRef;
  } else if (contract.source.kind === 'backend-result') {
    if (typeof input.backendResultText !== 'string' || input.backendResultText.length === 0) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: 'missing-evidence',
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'backend-result',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    if (utf8ByteLength(input.backendResultText) > MAX_RESULT_SOURCE_BYTES) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: 'evidence-too-large',
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'backend-result',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    rawText = input.backendResultText;
    evidenceRef = evidenceRef ?? deriveOpaqueEvidenceRef(input.attemptId, 'backend-result');
  } else {
    if (typeof input.diagnosticRecordsText !== 'string' || input.diagnosticRecordsText.length === 0) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: 'missing-evidence',
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'diagnostic-records',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    if (utf8ByteLength(input.diagnosticRecordsText) > MAX_RESULT_SOURCE_BYTES) {
      return buildOutcome({
        attemptId: input.attemptId,
        status: 'invalid-result',
        reason: 'evidence-too-large',
        recovery: 'block-intervention',
        operator: contract.operator,
        source: 'diagnostic-records',
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
    rawText = input.diagnosticRecordsText;
    evidenceRef =
      evidenceRef ?? deriveOpaqueEvidenceRef(input.attemptId, `diag:${contract.source.recordType}`);
  }

  const workerOutput = await executeResultContractInWorker(
    {
      contract,
      rawText,
      currentAttemptId: input.attemptId,
      ...(input.simulateWorkerHangMs !== undefined ? { simulateHangMs: input.simulateWorkerHangMs } : {})
    },
    input.deadlineMs ?? RESULT_OPERATOR_DEADLINE_MS
  );

  return buildOutcome({
    attemptId: input.attemptId,
    status: workerOutput.status,
    reason: workerOutput.reason,
    recovery: workerOutput.recovery,
    values: workerOutput.values,
    operator: contract.operator,
    source: contract.source.kind,
    evidenceRef,
    evaluatedAt
  });
}

export class ResultOperator {
  public async evaluate(input: EvaluateAttemptOutcomeInput): Promise<AttemptOutcome> {
    return evaluateAttemptOutcome(input);
  }

  public async evaluateWithPrecedence(
    input: EvaluateAttemptOutcomeInput & { readonly hostControl?: HostControlReason }
  ): Promise<PrecedenceEvaluationResult> {
    return evaluateAttemptWithPrecedence(input);
  }
}
